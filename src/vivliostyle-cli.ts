// src/vivliostyle-cli.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

import { Command } from "commander";
import { resolve, dirname, posix, join, basename, relative, isAbsolute, sep } from "node:path";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { JSDOM } from "jsdom";
import log, { type LogLevelDesc } from "loglevel";
import { VIEWER_PAGE_NAME, startStaticServer, type AssetBaseMapping, type SettleGate, type StaticMap } from "./server.js";
import { buildViewerUrl, renderPdf, type ViewerParams } from "./render/pdf.js";
import { resolveViewerLibDir } from "./render/viewer.js";

type OutputFormat = "pdf";
type LogLevel = "silent" | "info" | "verbose" | "debug";
type Mode = "build" | "preview";

type CliOptions = {
  input: string;
  output: string;
  title?: string;
  author?: string;
  language?: string;
  static: string[];
  scripts: boolean;
  format: string;
  logLevel: string;
  debug?: boolean;
  assetBase: string[];
  ignoreAsset: string[];
  mode: string;
  preview?: boolean;
  allowRemote?: boolean;
  fetchMissing?: boolean;
  dumpHtml?: string;
  waitForContent?: string | boolean;
  pixelRatio?: string;
  timeout?: string;
  quietMs?: string;
};

/**
 * Options shared by the build-mode and preview-mode HTML rewriters.
 */
export type HtmlRewriteOptions = {
  /** Keep references that would be fetched from the network. Off by default. */
  allowRemote?: boolean;
  /** Write the rewritten HTML here (and keep it) instead of a temp file. */
  dumpDir?: string | null;
  /** Let the browser load references without a local file from the web. */
  fetchMissing?: boolean;
  /** Delay pagination until the page's own async work finished. */
  settle?: SettleGate | null;
  /** Origin that page-script requests are routed to. */
  shimOrigin?: string | null;
  /** Base that page-relative URLs resolve against (the page's directory). */
  documentBaseUrl?: string | null;
  /** Remote references that turned out not to exist. */
  unavailableUrls?: Set<string>;
  /** Extra CSS handed to the viewer (`@page` rules, print tweaks). */
  css?: string;
  /** Additional user stylesheet for the viewer. */
  userStyle?: string;
};

const validFormats: readonly OutputFormat[] = ["pdf"];
const validLogLevels: readonly LogLevel[] = ["silent", "info", "verbose", "debug"];
const validModes: readonly Mode[] = ["build", "preview"];

/**
 * Wrapper log levels mapped onto loglevel. Diagnostics are written to the trace
 * channel, so `--log-level verbose` stays quiet while `debug` shows them.
 */
const LOG_LEVELS: Record<LogLevel, LogLevelDesc> = {
  silent: log.levels.SILENT,
  info: log.levels.INFO,
  verbose: log.levels.DEBUG,
  debug: log.levels.TRACE
};

/**
 * Send every level to the console channel the CLI contract uses: progress to
 * stdout, diagnostics and problems to stderr. The method is resolved per call so
 * that patched consoles stay visible.
 */
const CONSOLE_CHANNEL: Record<string, "log" | "warn" | "error"> = {
  trace: "error",
  debug: "error",
  info: "log",
  warn: "warn",
  error: "error"
};

log.methodFactory =
  (methodName: string) =>
  (...args: unknown[]): void => {
    (console[CONSOLE_CHANNEL[methodName] ?? "log"] as (...values: unknown[]) => void)(...args);
  };

// ---------------------------------------------------------------------------
// Site path + settle gate helpers
// ---------------------------------------------------------------------------

/** Directory part of a site path, without a trailing slash (`""` for the root). */
export function siteDirectory(sitePath: string): string {
  const dir = posix.dirname(sitePath);
  return dir === "/" ? "" : dir;
}

/**
 * Path the document has on the mapped site, e.g. `/post/tag-pairs/article.html`
 * for `<localBase>/post/tag-pairs/article.html`. Used as the URL Vivliostyle
 * loads, so page-relative and root-relative references resolve like they do on
 * the real site.
 */
export function deriveSitePath(inputAbs: string, assetBases: AssetBaseMapping[]): string | null {
  for (const ab of assetBases) {
    const relativePath = relative(resolve(ab.localBase), resolve(inputAbs));
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
    return `/${relativePath.split(sep).join("/")}`;
  }
  return null;
}

/**
 * Tracker injected into the document. It wraps fetch/XHR, watches the document
 * for late content and reports back once nothing is pending and the height has
 * been stable for `quietMs` — or when the deadline is reached.
 */
export type RuntimeScriptOptions = {
  origin: string;
  documentBaseUrl: string;
  gate: SettleGate | null;
  /**
   * Open every `<details>` element. Vivliostyle loads the page's scripts itself
   * and only re-dispatches `DOMContentLoaded` on the window, so scripts that
   * wait for it on the document — the usual way to expand collapsible content —
   * never run and their content would be missing from the PDF.
   */
  expandDetails?: boolean;
};

/**
 * Opens every `<details>` element, now and for any the page adds later.
 *
 * Print output has to contain the collapsed content too, and the page's own
 * print script cannot do it: Vivliostyle re-dispatches `DOMContentLoaded` on
 * the window rather than on the document, so a `document`-level listener never
 * runs.
 */
export const EXPAND_DETAILS_SNIPPET = `function expandDetails(root){
  var open=function(el){
    if(el.tagName!=="DETAILS"||el.open)return;
    el.open=true;
    el.setAttribute("data-viv-details-expanded","");
  };
  if(root.nodeType!==1)return;
  [].forEach.call(root.querySelectorAll("details"),open);
  open(root);
}
expandDetails(document);
try{new MutationObserver(function(records){
  for(var i=0;i<records.length;i++){
    var added=records[i].addedNodes;
    for(var j=0;j<added.length;j++)expandDetails(added[j]);
  }
}).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}
`;

/** Gate image Vivliostyle waits for before it paginates. */
export function buildSettleGateImage(origin: string): string {
  // Out of flow and invisible, but rendered: Vivliostyle only loads resources of
  // elements that end up in the render tree, so `display:none` would be skipped.
  return `<img src="${origin}/__viv-settle" alt="" width="1" height="1" style="position:absolute;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none" data-vivliostyle-settle-gate>`;
}

/**
 * The script injected into the document: it routes the URLs that page scripts
 * create to our server and tracks whether the page has finished.
 *
 * Everything lives in one scope on purpose — the settle tracker wraps the same
 * `fetch`/XHR that the routing patches.
 */
export function buildRuntimeScript(options: RuntimeScriptOptions): string {
  const { origin, documentBaseUrl, gate } = options;
  const expandDetails = options.expandDetails === true ? EXPAND_DETAILS_SNIPPET : "";
  // Vivliostyle paginates incrementally, so collapsed content has to be opened
  // again while it lays the document out, not just once up front.
  const expandDetailsTick = options.expandDetails === true ? "expandDetails(document);" : "";

  return `(function(){
var ORIGIN=${JSON.stringify(origin)},BASE=${JSON.stringify(documentBaseUrl)};
var QUIET=${gate?.quietMs ?? 400},DEADLINE=${gate?.deadlineMs ?? 10000},FRAME_GRACE=3000;
var pending=0,frames=0,last=0,mutations=0,done=false;
var state=window.__vivSettle={done:false,reason:null,at:0,pending:0,frames:0,mutations:0,dpr:window.devicePixelRatio};

// Root-relative URLs resolve against the site root, document-relative ones
// against the directory the page has on the site (e.g. model/x.glb next to it).
function fix(u){
  if(typeof u!=="string"||u==="")return u;
  if(u.slice(0,2)==="//"||u.charAt(0)==="#"||u.charAt(0)==="?")return u;
  if(/^[a-z][a-z0-9+.-]*:/i.test(u))return u;
  return u.charAt(0)==="/"?ORIGIN+u:BASE+u;
}

function canvases(){
  try{return[].map.call(document.querySelectorAll("canvas"),function(c){
    return c.width+"x"+c.height+"@"+Math.round(c.clientWidth)+"x"+Math.round(c.clientHeight);}).join(",");}catch(e){return"";}
}
// Canvases with real backing pixels and layout size: the minimum for charts,
// three.js, maps and OSD tiles to survive print-to-PDF as sharp raster.
function paintedCanvases(){
  try{return[].filter.call(document.querySelectorAll("canvas"),function(c){
    return c.width>2&&c.height>2&&c.clientWidth>0&&c.clientHeight>0;}).length;}catch(e){return 0;}
}
// Sizes of the containers pages fill at runtime; zero means the layout has not
// happened yet, which is what breaks canvas and chart initialisation.
function containers(){
  try{return[].map.call(document.querySelectorAll(".script,[class*=script]"),function(el){
    return (el.id||el.className)+"@"+Math.round(el.clientWidth)+"x"+Math.round(el.clientHeight);}).join(",");}catch(e){return"";}
}

function signal(why){
  if(done)return;done=true;
  var at=Math.round(performance.now());
  state.done=true;state.reason=why;state.at=at;state.pending=pending;state.frames=frames;state.mutations=mutations;
  var url=ORIGIN+"/__viv-settle-ready?reason="+encodeURIComponent(why)+"&ms="+at+
    "&pending="+pending+"&frames="+frames+"&mutations="+mutations+"&dpr="+window.devicePixelRatio+
    "&painted="+paintedCanvases()+"&ready="+(window.__vivReady===true?1:0)+
    "&canvases="+encodeURIComponent(canvases())+"&containers="+encodeURIComponent(containers());
  try{navigator.sendBeacon?navigator.sendBeacon(url):fetch(url,{keepalive:true});}catch(e){}
}

// An embed that never fires load must not hold the layout open forever.
function watchFrame(frame){
  if(frame.__vivWatched)return;frame.__vivWatched=true;frames++;
  var settled=false;
  function finish(){if(settled)return;settled=true;frames--;last=performance.now();}
  frame.addEventListener("load",finish);
  frame.addEventListener("error",finish);
  try{ if(frame.contentDocument&&frame.contentDocument.readyState==="complete"){finish();return;} }catch(e){}
  setTimeout(finish,FRAME_GRACE);
}
function watchFrames(root){
  try{
    [].forEach.call(root.querySelectorAll("iframe"),watchFrame);
    if(root.tagName==="IFRAME")watchFrame(root);
  }catch(e){}
}

var of=window.fetch;
if(of){window.fetch=function(input,init){
  try{
    if(typeof input==="string")input=fix(input);
    else if(input&&typeof input.url==="string")input=new Request(fix(input.url),input);
  }catch(e){}
  pending++;last=performance.now();
  return of.call(this,input,init).then(function(v){pending--;last=performance.now();return v;},
    function(e){pending--;last=performance.now();throw e;});};}
var XHR=window.XMLHttpRequest;
if(XHR){var open=XHR.prototype.open,send=XHR.prototype.send;
  XHR.prototype.open=function(m,u){this.__vscounted=true;return open.apply(this,arguments);};
  XHR.prototype.send=function(){if(this.__vscounted&&!this.__vsdone){this.__vsdone=true;pending++;last=performance.now();
    this.addEventListener("loadend",function(){pending--;last=performance.now();});}
    return send.apply(this,arguments);};}
["Image","Audio"].forEach(function(n){
  var Orig=window[n];if(!Orig)return;
  var Wrapped=function(u){return new Orig(fix(u));};
  Wrapped.prototype=Orig.prototype;
  try{window[n]=Wrapped;}catch(e){}
});
["HTMLImageElement","HTMLIFrameElement","HTMLScriptElement","HTMLSourceElement","HTMLVideoElement","HTMLAudioElement"].forEach(function(n){
  var C=window[n];if(!C)return;
  var d=Object.getOwnPropertyDescriptor(C.prototype,"src");
  if(!d||!d.set)return;
  try{Object.defineProperty(C.prototype,"src",{configurable:true,enumerable:d.enumerable,get:d.get,
    set:function(v){d.set.call(this,fix(v));if(n==="HTMLIFrameElement")watchFrame(this);}});}catch(e){}
});
try{Object.defineProperty(document,"baseURI",{configurable:true,get:function(){return BASE;}});}catch(e){}
try{new MutationObserver(function(){mutations++;watchFrames(document.documentElement);last=performance.now();})
  .observe(document.documentElement,{childList:true,subtree:true});}catch(e){}
try{new ResizeObserver(function(){last=performance.now();}).observe(document.documentElement);}catch(e){}
${expandDetails}watchFrames(document.documentElement);
last=performance.now();
(function check(){
  if(done)return;
  ${expandDetailsTick}
  var now=performance.now();
  if(now>=DEADLINE){signal("deadline");return;}
  // Deterministic pages (charts, WebGL, OSD fixtures) set __vivReady when
  // painted instead of making the gate guess from network quietness. Shader
  // compile and tile decode finish after the last fetch, so readiness wins.
  if(window.__vivReady===true&&pending===0&&frames===0){signal("ready");return;}
  if(pending===0&&frames===0&&now-last>=QUIET){signal("quiet");return;}
  setTimeout(check,50);
})();
})();`;
}

/**
 * Injects the runtime script as the first thing in `<head>` (so it wraps `fetch`
 * before any page script runs) and the gate image at the end of `<body>`.
 */
export function injectRuntimeScriptInDom(document: Document, options: RuntimeScriptOptions): void {
  const head = document.head;
  const anchor = head.firstChild;

  const base = document.createElement("base");
  base.setAttribute("href", options.documentBaseUrl);
  head.insertBefore(base, anchor);

  const script = document.createElement("script");
  script.textContent = buildRuntimeScript(options);
  head.insertBefore(script, anchor);

  if (options.gate === null) return;
  document.body?.insertAdjacentHTML("beforeend", buildSettleGateImage(options.origin));
}

// ---------------------------------------------------------------------------
// HTML input detection
// ---------------------------------------------------------------------------

export function isHtmlInput(inputAbs: string): boolean {
  return /\.html?$/i.test(inputAbs);
}

// ---------------------------------------------------------------------------
// Arg splitting
// ---------------------------------------------------------------------------

export function splitArgsAtDoubleDash(argv: string[]): {
  cliArgv: string[];
  extraArgs: string[];
} {
  const dd = argv.indexOf("--");
  if (dd === -1) return { cliArgv: argv, extraArgs: [] };
  return { cliArgv: argv.slice(0, dd), extraArgs: argv.slice(dd + 1) };
}

// ---------------------------------------------------------------------------
// Static mappings
// ---------------------------------------------------------------------------

/**
 * Serve a single local file directly, bypassing Vite's transform pipeline.
 * Returns true if the file was served, false if it should fall through.
 */

// ---------------------------------------------------------------------------
// DOM-level rewriters
// ---------------------------------------------------------------------------

const URL_ATTR_SELECTORS: Array<[string, string]> = [
  ["link[href]", "href"],
  ["script[src]", "src"],
  ["img[src]", "src"],
  ["source[src]", "src"],
  ["video[src]", "src"],
  ["audio[src]", "src"],
  ["video[poster]", "poster"],
  ["input[src]", "src"]
];

/**
 * Subresource attributes that would trigger a network request. Hyperlink
 * attributes (`<a href>`) are deliberately absent: a link is not fetched.
 */
const SUBRESOURCE_ATTR_SELECTORS: Array<[string, string]> = [
  ...URL_ATTR_SELECTORS,
  ["img[srcset]", "srcset"],
  ["source[srcset]", "srcset"],
  ["iframe[src]", "src"],
  ["object[data]", "data"],
  ["embed[src]", "src"],
  // A-Frame keeps its assets in custom elements
  ["a-asset-item[src]", "src"]
];

/** URL schemes that never leave the document. */
const INLINE_URL_SCHEME_RE = /^(?:data|blob|about|javascript|mailto|tel):/i;

/**
 * Applies `transform` to every URL of every subresource attribute.
 *
 * A `srcset` candidate list is transformed candidate by candidate, keeping the
 * descriptors (`1x`, `480w`). Returning `null` drops the candidate; an attribute
 * without any remaining candidate is removed.
 */
export function rewriteUrlAttributes(document: Document, transform: (url: string) => string | null): boolean {
  let changed = false;

  const apply = (el: Element, attr: string): void => {
    const raw = el.getAttribute(attr);
    if (raw === null) return;

    if (attr !== "srcset") {
      const current = raw.trim();
      const next = transform(current);
      if (next === null) {
        el.removeAttribute(attr);
        changed = true;
        return;
      }
      if (next === current) return;
      el.setAttribute(attr, next);
      changed = true;
      return;
    }

    const candidates = raw
      .split(",")
      .map((candidate) => candidate.trim())
      .filter(Boolean);

    const kept: string[] = [];
    let touched = false;

    for (const candidate of candidates) {
      const [url, ...descriptor] = candidate.split(/\s+/);
      const next = transform(url);
      if (next === null) {
        touched = true;
        continue;
      }
      if (next !== url) touched = true;
      kept.push([next, ...descriptor].join(" "));
    }

    if (!touched) return;
    changed = true;
    if (kept.length === 0) el.removeAttribute(attr);
    else el.setAttribute(attr, kept.join(", "));
  };

  for (const [selector, attr] of SUBRESOURCE_ATTR_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) apply(el, attr);
  }

  return changed;
}

/**
 * True when the browser would have to fetch the URL over the network.
 */
export function isRemoteUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("//")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !INLINE_URL_SCHEME_RE.test(trimmed);
}

/**
 * Drops subresource references that are not available locally so nothing is
 * fetched from the web. `srcset` candidates are filtered individually; an
 * attribute whose candidates are all remote is removed entirely.
 *
 * `isAllowed` exempts URLs that are served by the wrapper itself, e.g. the
 * static server URLs produced by the virtual-path rewrite.
 *
 * Returns every dropped URL.
 */
export function dropRemoteReferencesInDom(document: Document, isAllowed: (url: string) => boolean = () => false): string[] {
  const dropped: string[] = [];

  const droppedSet = new Set<string>();
  rewriteUrlAttributes(document, (url) => {
    if (isAllowed(url) || !isRemoteUrl(url)) return url;
    droppedSet.add(url);
    return null;
  });
  dropped.push(...droppedSet);

  // A meta refresh navigates the document, which is a fetch just like a
  // subresource. Redirect stubs are dropped as well.
  for (const el of document.querySelectorAll("meta[http-equiv]")) {
    if ((el.getAttribute("http-equiv") ?? "").toLowerCase() !== "refresh") continue;
    const target = parseMetaRefreshTarget(el.getAttribute("content") ?? "");
    if (target === null || !isRemoteUrl(target) || isAllowed(target)) continue;
    el.remove();
    dropped.push(target);
  }

  return dropped;
}

/**
 * Extracts the target of `<meta http-equiv="refresh" content="0; url=…">`.
 */
export function parseMetaRefreshTarget(content: string): string | null {
  const match = /^\s*[\d.]*\s*;?\s*url\s*=\s*(.*)$/i.exec(content);
  if (match === null) return null;
  const target = match[1].trim().replace(/^["']|["']$/g, "");
  return target === "" ? null : target;
}

/**
 * Root-relative subresource paths that survive the rewrites and therefore end
 * up resolved against the file system location of the input document. They are
 * broken unless something else provides them (e.g. the input is served over
 * HTTP), so they are worth reporting.
 */
export function collectUnservedVirtualPaths(
  document: Document,
  staticMapKeys: string[],
  isServable?: (virtualPath: string) => boolean
): string[] {
  const isMapped = (path: string): boolean =>
    staticMapKeys.some((virtual) => path === virtual || path.startsWith(virtual.endsWith("/") ? virtual : `${virtual}/`));

  const unserved = new Set<string>();

  for (const [selector, attr] of SUBRESOURCE_ATTR_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      const raw = el.getAttribute(attr);
      if (raw === null) continue;

      const values = attr === "srcset" ? raw.split(",").map((entry) => entry.trim().split(/\s+/)[0] ?? "") : [raw.trim()];
      for (const value of values) {
        if (!value.startsWith("/")) continue;
        if (isMapped(value)) continue;
        if (isServable !== undefined && isServable(value)) continue;
        unserved.add(value);
      }
    }
  }

  return [...unserved];
}

/** Remote subresource URLs a document would have to fetch. */
export function collectRemoteReferences(document: Document): string[] {
  const urls = new Set<string>();

  for (const [selector, attr] of SUBRESOURCE_ATTR_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      const raw = el.getAttribute(attr);
      if (raw === null) continue;
      const values = attr === "srcset" ? raw.split(",").map((entry) => entry.trim().split(/\s+/)[0] ?? "") : [raw.trim()];
      for (const value of values) {
        if (isRemoteUrl(value)) urls.add(value);
      }
    }
  }

  return [...urls];
}

/**
 * Whether a remote reference is worth probing on the live site.
 *
 * A reference that resolves to a local file is served from disk, so only that
 * file decides whether it stays: the live site may have moved on (a new CSS
 * hash, a rotated upload) while our copy of the page still has what it needs.
 */
export function referencesToProbe(url: string, assetBases: AssetBaseMapping[]): boolean {
  const mapped = mapAbsoluteUrlToLocal(url, assetBases);
  return mapped.kind === "mapped" ? !existsSync(mapped.localPath) : true;
}

/**
 * Checks which remote references actually exist, so that content that is gone
 * (a deleted slide deck, a retired CSS file) is dropped instead of leaving a
 * broken embed that never finishes loading.
 */
export async function probeRemoteReferences(urls: string[], timeoutMs = 8000): Promise<Set<string>> {
  const unavailable = new Set<string>();

  await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        // Only a definite "gone" counts: servers that reject HEAD still have the file.
        if (response.status === 404 || response.status === 410) unavailable.add(url);
        log.trace("probeRemoteReferences", { url, status: response.status });
      } catch (err) {
        // A failed probe is no proof that the resource is gone: Chromium loads
        // it with a browser user agent, which many sites accept where a HEAD
        // request from Node is rejected or blocked outright.
        log.trace("probeRemoteReferences failed", { url, error: String(err) });
      }
    })
  );

  return unavailable;
}

/** Removes the attributes that point at the given URLs. */
export function dropUnavailableReferencesInDom(document: Document, unavailable: Set<string>): string[] {
  if (unavailable.size === 0) return [];
  const dropped: string[] = [];

  for (const [selector, attr] of SUBRESOURCE_ATTR_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      const raw = el.getAttribute(attr);
      if (raw === null) continue;
      const values = attr === "srcset" ? raw.split(",").map((entry) => entry.trim().split(/\s+/)[0] ?? "") : [raw.trim()];
      const hit = values.filter((value) => unavailable.has(value));
      if (hit.length === 0) continue;

      dropped.push(...hit);
      const kept =
        attr === "srcset"
          ? raw
              .split(",")
              .map((e) => e.trim())
              .filter((c) => !unavailable.has(c.split(/\s+/)[0] ?? ""))
          : [];
      if (kept.length === 0) el.removeAttribute(attr);
      else el.setAttribute(attr, kept.join(", "));
    }
  }

  for (const url of new Set(dropped)) {
    log.warn(`[fetch] Dropped unavailable remote reference: ${url}`);
  }
  return dropped;
}

/**
 * Exempts the wrapper's own static server from the offline pass: URLs pointing
 * at it are served from the local file system, never from the web.
 */
export function isStaticServerUrl(serverBaseUrl: string): (url: string) => boolean {
  return (url: string): boolean => serverBaseUrl !== "" && url.startsWith(serverBaseUrl);
}

function reportDroppedRemoteRefs(dropped: string[]): void {
  for (const url of new Set(dropped)) {
    log.info(`[offline] Dropped remote reference: ${url}`);
  }
  log.trace("dropRemoteReferencesInDom: dropped", dropped);
}

function reportUnservedVirtualPaths(unserved: string[]): void {
  for (const path of unserved) {
    log.warn(`[html] Warning: reference is not available and will not resolve: ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Asset base match result
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by mapAbsoluteUrlToLocal.
 *
 * - "mapped"    — the URL matched an asset-base prefix and has a sub-path that
 *                 can be mapped to a local file.
 * - "root-only" — the URL matched a prefix but carried no sub-path (i.e. the
 *                 URL is exactly the base root).  The caller should skip it
 *                 with a precise message rather than treating it as an
 *                 unrecognised external URL.
 * - "no-match"  — no asset-base prefix matched; caller handles as usual.
 */
type AssetBaseMatch = { kind: "mapped"; virtualPath: string; localPath: string } | { kind: "root-only" } | { kind: "no-match" };

export function mapAbsoluteUrlToLocal(url: string, assetBases: AssetBaseMapping[]): AssetBaseMatch {
  for (const mapping of assetBases) {
    if (!url.startsWith(mapping.urlBase)) continue;

    let cleanRelative: string;
    try {
      cleanRelative = new URL(url).pathname.slice(1);
    } catch {
      const noQuery = url.slice(mapping.urlBase.length).split("?")[0];
      cleanRelative = noQuery.split("#")[0];
    }

    if (!cleanRelative) {
      // The URL points to the asset-base root itself
      // (e.g. https://cdn.example.com/ with no sub-path).
      return { kind: "root-only" };
    }

    const virtualPath = posix.resolve("/", cleanRelative);
    const localPath = resolve(mapping.localBase, cleanRelative);
    return { kind: "mapped", virtualPath, localPath };
  }
  return { kind: "no-match" };
}

export function rewriteAbsoluteUrlsInDom(document: Document, assetBases: AssetBaseMapping[], keepMissing = false): boolean {
  if (assetBases.length === 0) return false;

  // "root-only" and "no-match" — leave the URL unchanged. With `keepMissing`,
  // URLs whose local file does not exist keep their absolute form so the browser
  // can load them from the mapped origin.
  return rewriteUrlAttributes(document, (url) => {
    const match = mapAbsoluteUrlToLocal(url, assetBases);
    if (match.kind !== "mapped") return url;
    if (keepMissing && !existsSync(match.localPath)) return url;
    return match.virtualPath;
  });
}

export function rewriteVirtualPathsToServerInDom(
  document: Document,
  staticMapKeys: string[],
  serverBaseUrl: string,
  isServable?: (virtualPath: string) => boolean
): boolean {
  const shouldRewrite = (path: string): boolean => {
    if (!path.startsWith("/")) return false;
    if (staticMapKeys.some((virtual) => path === virtual || path.startsWith(virtual.endsWith("/") ? virtual : `${virtual}/`))) return true;
    return isServable !== undefined && isServable(path);
  };

  return rewriteUrlAttributes(document, (url) => (shouldRewrite(url) ? `${serverBaseUrl}${url}` : url));
}

/**
 * Returns a predicate that reports whether a root-relative path can be served
 * from one of the configured asset-base local roots.
 *
 * Absolute URLs that were rewritten to root-relative virtual paths (see
 * rewriteAbsoluteUrlsInDom) are not necessarily part of the static map — an
 * `<img src>` is never collected by extractUrlsFromHtml — but the static server
 * resolves any request path against an asset-base localBase, so those paths are
 * servable and must be pointed at the server instead of being resolved against
 * the file system location of the input document.
 */
export function createAssetBasePathProbe(assetBases: AssetBaseMapping[]): (virtualPath: string) => boolean {
  return (virtualPath: string): boolean => {
    for (const ab of assetBases) {
      const localPath = resolve(ab.localBase, virtualPath.replace(/^\//, ""));
      if (existsSync(localPath)) {
        log.trace("createAssetBasePathProbe: servable via asset-base", { virtualPath, localPath });
        return true;
      }
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// String-level wrappers (kept for external callers / tests)
// ---------------------------------------------------------------------------

export function rewriteAbsoluteUrls(htmlContent: string, assetBases: AssetBaseMapping[]): string {
  if (assetBases.length === 0) return htmlContent;
  const dom = new JSDOM(htmlContent);
  const changed = rewriteAbsoluteUrlsInDom(dom.window.document, assetBases);
  return changed ? dom.serialize() : htmlContent;
}

export function rewriteVirtualPathsToServer(htmlContent: string, staticMap: Record<string, string>, serverBaseUrl: string): string {
  const keys = Object.keys(staticMap);
  if (keys.length === 0) return htmlContent;
  const dom = new JSDOM(htmlContent);
  const changed = rewriteVirtualPathsToServerInDom(dom.window.document, keys, serverBaseUrl);
  return changed ? dom.serialize() : htmlContent;
}

// ---------------------------------------------------------------------------
// HTML asset extraction
// ---------------------------------------------------------------------------

export function extractUrlsFromHtml(htmlPath: string, includeScripts = true, doc?: Document): string[] {
  let document: Document;

  if (doc) {
    document = doc;
  } else {
    let content: string;
    try {
      content = readFileSync(htmlPath, "utf-8");
    } catch (err) {
      throw new Error(`Error reading HTML file: ${htmlPath}\n${String(err)}`);
    }
    document = new JSDOM(content).window.document;
  }

  const urls = new Set<string>();

  // Every subresource is collected, not just <link> and <script>: an <img> that
  // is not part of the static map can only be resolved by the fallback roots of
  // the static server, and a missing one would fail silently.
  for (const [selector, attr] of SUBRESOURCE_ATTR_SELECTORS) {
    if (selector === "script[src]" && !includeScripts) continue;

    for (const el of document.querySelectorAll(selector)) {
      const raw = el.getAttribute(attr);
      if (raw === null) continue;

      if (attr !== "srcset") {
        const url = raw.trim();
        if (url) urls.add(url);
        continue;
      }

      for (const candidate of raw.split(",")) {
        const url = candidate.trim().split(/\s+/)[0] ?? "";
        if (url) urls.add(url);
      }
    }
  }

  return [...urls];
}

// ---------------------------------------------------------------------------
// Preview HTML builder
// ---------------------------------------------------------------------------

export function buildPreviewHtml(
  inputAbs: string,
  assetBases: AssetBaseMapping[],
  options: HtmlRewriteOptions = {}
): {
  htmlPath: string;
  extraStatic: Record<string, string>;
  cleanup: () => void;
} {
  let content: string;
  try {
    content = readFileSync(inputAbs, "utf-8");
  } catch (err) {
    throw new Error(`Error reading HTML file: ${inputAbs}\n${String(err)}`);
  }

  const extraStatic: Record<string, string> = {};
  for (const ab of assetBases) {
    let virtualPrefix: string;
    try {
      virtualPrefix = new URL(ab.urlBase).pathname;
    } catch {
      virtualPrefix = "/";
    }
    if (!virtualPrefix.endsWith("/")) virtualPrefix = `${virtualPrefix}/`;
    const mapKey = virtualPrefix === "/" ? "/" : virtualPrefix.slice(0, -1);
    if (Object.hasOwn(extraStatic, mapKey)) {
      log.warn(
        `[buildPreviewHtml] Duplicate assetBase virtual prefix "${mapKey}" — overwriting "${extraStatic[mapKey]}" with "${resolve(ab.localBase)}"`
      );
    }
    extraStatic[mapKey] = resolve(ab.localBase);
    log.trace("buildPreviewHtml: assetBase extra static mount", { mapKey, local: ab.localBase });
  }

  const dom = new JSDOM(content);
  const document = dom.window.document;
  const changed = rewriteAbsoluteUrlsInDom(document, assetBases);
  if (changed) log.trace("buildPreviewHtml: rewrote absolute URLs → virtual paths");

  const dropped = options.allowRemote ? [] : dropRemoteReferencesInDom(document);
  if (dropped.length > 0) reportDroppedRemoteRefs(dropped);

  if (!changed && dropped.length === 0) {
    log.trace("buildPreviewHtml: no URL rewrites needed, using original file");
    return { htmlPath: inputAbs, extraStatic, cleanup: () => undefined };
  }

  const dumpDir = options.dumpDir ? resolve(options.dumpDir) : null;
  const htmlPath =
    dumpDir === null ? join(dirname(inputAbs), `_vivliostyle_preview_${basename(inputAbs)}`) : join(dumpDir, basename(inputAbs));

  if (dumpDir !== null) mkdirSync(dumpDir, { recursive: true });
  writeFileSync(htmlPath, dom.serialize(), "utf-8");
  log.trace("buildPreviewHtml: wrote rewritten HTML", htmlPath);
  log.info(`[preview] Wrote rewritten HTML: ${htmlPath}`);

  const cleanup = (): void => {
    if (dumpDir !== null) {
      log.trace("buildPreviewHtml: keeping dumped HTML", htmlPath);
      return;
    }
    try {
      rmSync(htmlPath, { force: true });
      log.trace("buildPreviewHtml: removed rewritten HTML", htmlPath);
    } catch (err) {
      log.warn(`[preview] Warning: could not remove ${htmlPath}\n${String(err)}`);
    }
  };

  return { htmlPath, extraStatic, cleanup };
}

// ---------------------------------------------------------------------------
// Build HTML builder
// ---------------------------------------------------------------------------

export function prepareInputHtmlForBuild(
  inputAbs: string,
  assetBases: AssetBaseMapping[],
  staticMap: Record<string, string>,
  serverBaseUrl: string,
  options: HtmlRewriteOptions = {}
): { vivliostyleInput: string; cleanup: () => void } {
  let content: string;
  try {
    content = readFileSync(inputAbs, "utf-8");
  } catch (err) {
    throw new Error(`Error reading HTML file: ${inputAbs}\n${String(err)}`);
  }

  const dom = new JSDOM(content);
  const document = dom.window.document;
  const staticMapKeys = Object.keys(staticMap);

  const absChanged = rewriteAbsoluteUrlsInDom(document, assetBases, options.fetchMissing === true);
  if (absChanged) log.trace("prepareInputHtmlForBuild: rewrote absolute URLs → virtual paths");

  const probe = assetBases.length > 0 ? createAssetBasePathProbe(assetBases) : undefined;
  const srvChanged = rewriteVirtualPathsToServerInDom(document, staticMapKeys, serverBaseUrl, probe);
  if (srvChanged) log.trace("prepareInputHtmlForBuild: rewrote virtual paths → server URLs");

  const gone = options.unavailableUrls === undefined ? [] : dropUnavailableReferencesInDom(document, options.unavailableUrls);

  const dropped = options.allowRemote ? [] : dropRemoteReferencesInDom(document, isStaticServerUrl(serverBaseUrl));
  if (dropped.length > 0) reportDroppedRemoteRefs(dropped);

  const unserved = collectUnservedVirtualPaths(document, staticMapKeys, probe);
  if (unserved.length > 0) reportUnservedVirtualPaths(unserved);

  // The runtime script only matters for pages that run scripts; injecting it
  // into a plain document would rewrite the file for nothing.
  const hasScripts = document.querySelector("script") !== null;
  const wantsRuntime = (options.shimOrigin != null && hasScripts) || options.settle != null;
  if (wantsRuntime) {
    const origin = options.shimOrigin ?? serverBaseUrl;
    const documentBaseUrl = options.documentBaseUrl ?? `${origin}/`;
    // Only the PDF run expands `<details>`; the preview stays interactive.
    injectRuntimeScriptInDom(document, { origin, documentBaseUrl, gate: options.settle ?? null, expandDetails: true });
    log.trace("prepareInputHtmlForBuild: injected runtime script", { origin, documentBaseUrl, gate: options.settle });
  }

  if (!absChanged && !srvChanged && dropped.length === 0 && gone.length === 0 && options.settle == null && !wantsRuntime) {
    log.trace("prepareInputHtmlForBuild: no changes, using original file");
    return { vivliostyleInput: inputAbs, cleanup: () => undefined };
  }

  const dumpDir = options.dumpDir ? resolve(options.dumpDir) : null;
  let tmpDir: string | null = null;
  let tmpHtml: string;

  if (dumpDir !== null) {
    mkdirSync(dumpDir, { recursive: true });
    tmpHtml = join(dumpDir, basename(inputAbs));
  } else {
    tmpDir = mkdtempSync(join(tmpdir(), "vivliostyle-"));
    tmpHtml = join(tmpDir, "index.html");
  }

  writeFileSync(tmpHtml, dom.serialize(), "utf-8");
  log.info(`[html] ${dumpDir === null ? "Prepared" : "Dumped"} input HTML → ${tmpHtml}`);
  log.trace("prepareInputHtmlForBuild: written", tmpHtml);

  const cleanup = (): void => {
    if (tmpDir === null) {
      log.trace("prepareInputHtmlForBuild: keeping dumped HTML", tmpHtml);
      return;
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      log.trace("prepareInputHtmlForBuild: removed temp dir", tmpDir);
    } catch (err) {
      log.warn(`[html] Warning: could not remove temp dir ${tmpDir}\n${String(err)}`);
    }
  };

  return { vivliostyleInput: tmpHtml, cleanup };
}

// ---------------------------------------------------------------------------
// Asset base / ignore helpers
// ---------------------------------------------------------------------------

export function normalizeUrlBase(urlBase: string): string {
  return urlBase.endsWith("/") ? urlBase : `${urlBase}/`;
}

export function normalizeIgnoreAssetPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) throw new Error("Invalid --ignore-asset value: must not be empty");
  return trimmed.startsWith("/") ? posix.normalize(trimmed) : posix.resolve("/", trimmed);
}

export function shouldIgnoreVirtualPath(virtualPath: string, ignoredAssets: Set<string>): boolean {
  return ignoredAssets.has(posix.normalize(virtualPath));
}

export function parseAssetBaseMapping(value: string): AssetBaseMapping {
  const eqIdx = value.indexOf("=");
  if (eqIdx === -1) {
    throw new Error(`Invalid --asset-base value: "${value}"\nExpected format: <urlBase>=<localBase>`);
  }
  const urlBase = value.slice(0, eqIdx).trim();
  const localBase = value.slice(eqIdx + 1).trim();
  if (!urlBase || !localBase) {
    throw new Error(`Invalid --asset-base value: "${value}"\nBoth urlBase and localBase are required`);
  }
  return { urlBase: normalizeUrlBase(urlBase), localBase };
}

// ---------------------------------------------------------------------------
// MappingResult + urlToStaticMapping
// ---------------------------------------------------------------------------

type MappingResult = { kind: "mapped"; mapping: string } | { kind: "skipped"; url: string; reason: string };

export function urlToStaticMapping(
  url: string,
  htmlDir: string,
  assetBases: AssetBaseMapping[],
  ignoredAssets: Set<string>
): MappingResult {
  const trimmed = url.trim();
  if (!trimmed) return { kind: "skipped", url, reason: "empty URL" };
  if (trimmed.startsWith("#")) return { kind: "skipped", url, reason: "fragment-only URL" };

  const assetMatch = mapAbsoluteUrlToLocal(trimmed, assetBases);

  if (assetMatch.kind === "root-only") {
    return {
      kind: "skipped",
      url,
      reason: "URL matches an asset-base prefix but has no path component (root URL)"
    };
  }

  if (assetMatch.kind === "mapped") {
    if (shouldIgnoreVirtualPath(assetMatch.virtualPath, ignoredAssets)) {
      log.trace("urlToStaticMapping: ignored (asset-base match)", { url, ...assetMatch });
      return {
        kind: "skipped",
        url,
        reason: `matches --ignore-asset "${assetMatch.virtualPath}"`
      };
    }
    if (!existsSync(assetMatch.localPath)) {
      log.warn(
        `[html] Warning: asset-base mapped path does not exist\n` +
          `         url     : ${url}\n` +
          `         virtual : ${assetMatch.virtualPath}\n` +
          `         local   : ${assetMatch.localPath}`
      );
    }
    return {
      kind: "mapped",
      mapping: `${assetMatch.virtualPath}:${assetMatch.localPath}`
    };
  }

  // assetMatch.kind === "no-match" — proceed to local / external handling

  if (trimmed.startsWith("//")) {
    return { kind: "skipped", url, reason: "protocol-relative external URL" };
  }

  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmed)) {
    const protocol = trimmed.slice(0, trimmed.indexOf(":"));
    return {
      kind: "skipped",
      url,
      reason: `external URL (protocol: ${protocol}:) — add --asset-base to map it locally`
    };
  }

  const [cleanUrl] = trimmed.split(/[?#]/);
  if (!cleanUrl) {
    return {
      kind: "skipped",
      url,
      reason: "URL is empty after stripping query/fragment"
    };
  }

  const localPath = resolve(htmlDir, cleanUrl);
  const virtualPath = cleanUrl.startsWith("/") ? posix.normalize(cleanUrl) : posix.resolve("/", posix.relative(htmlDir, localPath));

  if (shouldIgnoreVirtualPath(virtualPath, ignoredAssets)) {
    log.trace("urlToStaticMapping: ignored (ignore-asset match)", { url, virtualPath });
    return {
      kind: "skipped",
      url,
      reason: `matches --ignore-asset "${virtualPath}"`
    };
  }

  if (!existsSync(localPath)) {
    log.warn(
      `[html] Warning: referenced path does not exist\n` +
        `         url     : ${url}\n` +
        `         virtual : ${virtualPath}\n` +
        `         local   : ${localPath}`
    );
  }

  return { kind: "mapped", mapping: `${virtualPath}:${localPath}` };
}

export function parseStaticMapping(mapping: string): { virtual: string; local: string } {
  if (!mapping.startsWith("/")) {
    throw new Error(`Invalid --static mapping: "${mapping}"\nExpected format: /virtual/path:/local/path`);
  }
  const colonIdx = mapping.indexOf(":", 1);
  if (colonIdx === -1) {
    throw new Error(`Invalid --static mapping: "${mapping}"\nExpected format: /virtual/path:/local/path`);
  }
  const virtual = mapping.slice(0, colonIdx);
  const local = mapping.slice(colonIdx + 1);
  if (!local) throw new Error(`Local path missing in --static mapping: "${mapping}"`);
  return { virtual, local };
}

// ---------------------------------------------------------------------------
// Static map builder
// ---------------------------------------------------------------------------

function buildStaticMap(rawMappings: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const mapping of rawMappings) {
    const { virtual, local } = parseStaticMapping(mapping);
    if (Object.hasOwn(map, virtual)) {
      log.warn(`[static] Warning: duplicate virtual path "${virtual}" — ` + `"${map[virtual]}" overwritten by "${local}"`);
    }
    map[virtual] = local;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Extra args parser
// ---------------------------------------------------------------------------

/**
 * Vivliostyle's config object uses camelCase keys (`viewerParam`, `userStyle`)
 * and typed values, so `--viewer-param` has to arrive as `viewerParam` and
 * `--timeout 60000` as the number 60000.
 */
export function normalizeExtraKey(key: string): string {
  return key.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

export function coerceExtraValue(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  // Only plain integers, so that version-like strings ("1.9.2") stay strings.
  return /^-?\d+$/.test(value) ? Number.parseInt(value, 10) : value;
}

export function parseExtraArgs(extraArgs: string[]): Record<string, unknown> {
  const extraConfig: Record<string, unknown> = {};

  const assign = (rawKey: string, rawValue: string | boolean): void => {
    extraConfig[normalizeExtraKey(rawKey)] = typeof rawValue === "boolean" ? rawValue : coerceExtraValue(rawValue);
  };

  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i];

    if (!arg.startsWith("--")) {
      if (arg.startsWith("-")) {
        log.warn(
          `[extra-args] Warning: short flag "${arg}" after -- is not supported and will be ignored.\n` +
            `             Use the long-form --flag equivalent instead.`
        );
      }
      continue;
    }

    if (arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      assign(arg.slice(2, eqIdx), arg.slice(eqIdx + 1));
      continue;
    }

    const key = arg.slice(2);
    const next = extraArgs[i + 1];

    if (next === "true" || next === "false") {
      assign(key, next === "true");
      i++;
    } else if (next !== undefined && !next.startsWith("-")) {
      assign(key, next);
      i++;
    } else {
      extraConfig[normalizeExtraKey(key)] = true;
    }
  }

  return extraConfig;
}

// ---------------------------------------------------------------------------
// Shared option helpers
// ---------------------------------------------------------------------------

function pickDefinedStrings<K extends string>(source: Partial<Record<K, string | undefined>>, keys: K[]): Partial<Record<K, string>> {
  const result: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const val = source[key];
    if (val !== undefined && val !== "") result[key] = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Program definition
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  return new Command()
    .name("vivliostyle-cli")
    .description(
      [
        "Vivliostyle CLI wrapper with extended static-asset and HTML-parsing support.",
        "",
        "Examples:",
        "  # Build a PDF from an HTML file",
        "  vivliostyle-cli -i index.html -o out.pdf",
        "",
        "  # Preview an HTML file in browser",
        "  vivliostyle-cli -i index.html --preview",
        "",
        "  # Build with explicit static asset mapping",
        "  vivliostyle-cli -i index.html -o out.pdf \\",
        "    --static /assets:/home/user/project/assets",
        "",
        "  # Map an absolute CDN URL to a local directory",
        "  vivliostyle-cli -i index.html -o out.pdf \\",
        "    --asset-base https://cdn.example.com/=/home/user/cdn-cache",
        "",
        "  # Pass extra Vivliostyle options after --",
        "  vivliostyle-cli -i index.html -o out.pdf -- --timeout 60000"
      ].join("\n")
    )
    .requiredOption("-i, --input <input>", "Input HTML or publication manifest file")
    .option("-o, --output <file>", "Output file path", "output.pdf")
    .option("--title <title>", "Document title (overrides the one in the source)")
    .option("--author <author>", "Document author")
    .option("--language <lang>", "Document language tag (e.g. en, de, ja)", "de")
    .option(
      "--static <mapping>",
      [
        "Map a virtual path to a local directory or file.",
        "Format: /virtual/path:/absolute/local/path",
        "Repeatable: --static /css:/dist/css --static /fonts:/dist/fonts"
      ].join("\n      "),
      (val: string, prev: string[]) => prev.concat(val),
      []
    )
    .option(
      "--no-scripts",
      [
        "Do not map <script src> tags as static assets.",
        "Recommended for PDF builds to avoid JS identifier conflicts",
        "in the Vivliostyle viewer.",
        "Only applies when the input is an HTML file."
      ].join("\n      ")
    )
    .option(
      "--asset-base <urlBase=localBase>",
      [
        "Map all asset URLs that start with <urlBase> to files under <localBase>.",
        "Format: <urlBase>=<localBase>",
        "Example: https://cdn.example.com/=/home/user/cdn-cache",
        "The localBase is also used as fallback root for secondary assets.",
        "Repeatable. Only applies when the input is an HTML file."
      ].join("\n      "),
      (val: string, prev: string[]) => prev.concat(val),
      []
    )
    .option(
      "--ignore-asset <path>",
      [
        "Skip a specific virtual path when deriving static mappings.",
        "Example: --ignore-asset /livereload.js",
        "Repeatable. Only applies when the input is an HTML file."
      ].join("\n      "),
      (val: string, prev: string[]) => prev.concat(val),
      []
    )
    .option(
      "--allow-remote",
      [
        "Keep subresource references that would be fetched from the network.",
        "By default every reference without a local file is removed from the",
        "input HTML so that nothing is loaded from the web.",
        "Hyperlinks (<a href>) are never touched. Alias of --fetch-missing."
      ].join("\n      ")
    )
    .option(
      "--fetch-missing",
      [
        "Load references without a local file from the mapped origin instead of",
        "dropping them. The local server redirects missing files to the site",
        "origin, which also covers data that page scripts fetch by relative URL.",
        "Implies --allow-remote, so remote iframes and scripts are loaded too.",
        "Nothing is written to the input directory."
      ].join("\n      ")
    )
    .option(
      "--wait-for-content [ms]",
      [
        "Delay pagination until the page's own async work finished: no request in",
        "flight and the document height stable for --quiet-ms (default 400).",
        "Falls back to the hard limit (default 10000ms, capped at 25000ms)."
      ].join("\n      ")
    )
    .option("--quiet-ms <ms>", "Quiet period before the layout gate opens (default 400)")
    .option(
      "--timeout <ms>",
      ["Give up on a page after <ms> (Vivliostyle default: 300000).", "Lower it for pages with embeds that never finish loading."].join(
        "\n      "
      )
    )
    .option(
      "--pixel-ratio <n>",
      [
        "Render at n times the output resolution (Vivliostyle pixelRatio), e.g. 2.",
        "Layout and raster resolution increase while the page keeps its size,",
        "which removes pixel artifacts in canvas and WebGL content.",
        "Pages exposing window.__vivResize(factor) are also redrawn at n×",
        "backing pixels before printing, so output past 96dpi stays sharp."
      ].join("\n      ")
    )
    .option(
      "--dump-html <dir>",
      [
        "Write the rewritten input HTML into <dir> and keep it, instead of a",
        "temporary file. Use it to inspect what Vivliostyle actually renders."
      ].join("\n      ")
    )
    .option("--format <format>", `Output format: ${validFormats.join(" | ")}`, "pdf")
    .option("--log-level <level>", `Vivliostyle log level: ${validLogLevels.join(" | ")}`, "info")
    .option("--mode <mode>", `Execution mode: ${validModes.join(" | ")}`, "build")
    .option("--preview", "Shorthand for --mode preview — open result in browser")
    .option("-d, --debug", "Print every resolved config value to stderr before running")
    .addHelpText(
      "after",
      [
        "",
        "Notes:",
        "  • HTML input (.html/.htm) is detected automatically from the file extension.",
        "  • For HTML input, <link href> and <script src> are parsed and auto-mapped.",
        "  • References without a local file are dropped (offline by default); use --allow-remote to keep them.",
        "  • Options after -- are forwarded verbatim to Vivliostyle.",
        "  • --debug sets --log-level to debug automatically.",
        "  • --preview and --mode preview are equivalent.",
        "  • A local HTTP server serves the document, its assets and the Vivliostyle viewer;",
        "  • the browser prints that page to PDF, so canvases and iframes stay real content.",
        "  • Collapsed <details> content is opened for the PDF; the preview keeps the page as it is.",
        "  • --asset-base localBase is also a fallback root for CSS-referenced assets."
      ].join("\n")
    );
}

export function printHelp(): void {
  buildProgram().help({ error: false });
}

export function parseArgs(argv: string[]): {
  options: CliOptions;
  extraArgs: string[];
} | null {
  const { cliArgv, extraArgs } = splitArgsAtDoubleDash(argv);
  if (cliArgv.slice(2).length === 0) return null;

  const program = buildProgram();
  program.exitOverride();

  try {
    program.parse(cliArgv);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? "";
    if (code === "commander.helpDisplayed" || code === "commander.version") return null;
    throw err;
  }

  return { options: program.opts<CliOptions>(), extraArgs };
}

// ---------------------------------------------------------------------------
// Build runner helper
// ---------------------------------------------------------------------------

type RenderParams = {
  documentUrl: string;
  viewerPageUrl: string;
  outputAbs: string;
  metaFields: Partial<Record<"title" | "author" | "language", string>>;
  viewerParams: ViewerParams;
  timeoutMs?: number;
  waitForSettle: boolean;
  chromeExecutable?: string;
  canvasScale?: number;
};

async function runRender(params: RenderParams): Promise<void> {
  const request = {
    documentUrl: params.documentUrl,
    viewerPageUrl: params.viewerPageUrl,
    output: params.outputAbs,
    viewerParams: params.viewerParams,
    timeoutMs: params.timeoutMs,
    waitForSettle: params.waitForSettle,
    ...(params.chromeExecutable === undefined ? {} : { chromeExecutable: params.chromeExecutable }),
    ...(params.canvasScale === undefined ? {} : { canvasScale: params.canvasScale }),
    ...(params.metaFields.title === undefined ? {} : { title: params.metaFields.title }),
    ...(params.metaFields.author === undefined ? {} : { author: params.metaFields.author }),
    ...(params.metaFields.language === undefined ? {} : { language: params.metaFields.language })
  };

  log.trace("renderPdf request", request);
  const result = await renderPdf(request);
  log.trace("renderPdf result", { pageCount: result.pageCount, bytes: result.bytes, settle: result.settle });
  log.info(`✓ Document created: ${result.output} (${result.pageCount} pages)`);
}

// ---------------------------------------------------------------------------
// Core execute
// ---------------------------------------------------------------------------

/**
 * Log level for the wrapper's own output. `-d` wins over `--log-level`, which
 * is also forwarded to Vivliostyle unchanged.
 */
function resolveInternalLogLevel(options: CliOptions): LogLevel {
  if (options.debug === true) return "debug";
  const level = options.logLevel as LogLevel;
  return validLogLevels.includes(level) ? level : "info";
}

/**
 * `--wait-for-content [ms]`: hold the document's load event until the page's own
 * async work finished. Vivliostyle stops waiting for images after 30s, so the
 * hard limit is capped below that.
 */
const MAX_SETTLE_DEADLINE_MS = 25_000;

export function resolveSettleGate(options: CliOptions): SettleGate | null {
  const raw = options.waitForContent;
  if (raw === undefined || raw === false) return null;

  const requested = typeof raw === "string" && raw !== "" ? Number.parseInt(raw, 10) : MAX_SETTLE_DEADLINE_MS;
  if (!Number.isFinite(requested) || requested <= 0) throw new Error(`Invalid --wait-for-content: "${String(raw)}"`);

  const quietRaw = options.quietMs === undefined ? 400 : Number.parseInt(options.quietMs, 10);
  if (!Number.isFinite(quietRaw) || quietRaw <= 0) throw new Error(`Invalid --quiet-ms: "${String(options.quietMs)}"`);

  return {
    quietMs: quietRaw,
    deadlineMs: Math.min(requested, MAX_SETTLE_DEADLINE_MS)
  };
}

export async function execute(options: CliOptions, extraArgs: string[] = []): Promise<void> {
  log.setLevel(LOG_LEVELS[resolveInternalLogLevel(options)]);
  log.trace("raw CLI options", options);
  log.trace("extra args (after --)", extraArgs);

  if (!options.input) throw new Error("Missing required option: --input");

  const inputAbs = resolve(options.input);
  log.trace("resolved input", inputAbs);
  if (!existsSync(inputAbs)) throw new Error(`Input file does not exist: ${inputAbs}`);

  const outputAbs = resolve(options.output);
  log.trace("resolved output", outputAbs);

  if (!validFormats.includes(options.format as OutputFormat)) {
    throw new Error(`Invalid format: "${options.format}". Allowed: ${validFormats.join(", ")}`);
  }
  const format = options.format as OutputFormat;

  if (!validLogLevels.includes(options.logLevel as LogLevel)) {
    throw new Error(`Invalid log level: "${options.logLevel}". Allowed: ${validLogLevels.join(", ")}`);
  }
  const logLevel: LogLevel = options.debug ? "debug" : (options.logLevel as LogLevel);
  log.trace("logLevel", logLevel);

  const mode = (options.preview ? "preview" : options.mode) as Mode;
  if (!validModes.includes(mode)) {
    throw new Error(`Invalid mode: "${mode}". Allowed: ${validModes.join(", ")}`);
  }
  log.trace("mode", mode);

  const htmlMode = isHtmlInput(inputAbs);
  log.trace("htmlMode (auto-detected)", htmlMode);

  if (!htmlMode) {
    if (options.assetBase.length > 0) {
      log.warn(`[warn] --asset-base has no effect for non-HTML input "${inputAbs}".`);
    }
    if (options.ignoreAsset.length > 0) {
      log.warn(`[warn] --ignore-asset has no effect for non-HTML input "${inputAbs}".`);
    }
  }

  const assetBases = options.assetBase.map(parseAssetBaseMapping);
  log.trace("parsed assetBases", assetBases);

  const ignoredAssets = new Set(options.ignoreAsset.map(normalizeIgnoreAssetPath));
  log.trace("ignoredAssets", [...ignoredAssets]);

  // ── HTML-derived mappings ────────────────────────────────────────────────
  const derivedMappings: string[] = [];

  if (htmlMode) {
    const htmlDir = dirname(inputAbs);
    log.info(`[html] Analysing input as HTML: ${inputAbs}`);

    const includeScripts = mode === "preview" ? true : options.scripts;
    const urls = extractUrlsFromHtml(inputAbs, includeScripts);

    if (urls.length === 0) {
      log.info("[html] No URLs found in input HTML");
    } else {
      log.info(`[html] Found URLs (${urls.length}):`);
    }

    for (const url of urls) {
      const result = urlToStaticMapping(url, htmlDir, assetBases, ignoredAssets);
      if (result.kind === "skipped") {
        log.info(`  → Skipped (${result.reason}): ${url}`);
        continue;
      }
      log.info(`  → Mapping: ${result.mapping}`);
      derivedMappings.push(result.mapping);
    }

    log.trace("derived static mappings from HTML", derivedMappings);
  }

  // ── static map ────────────────────────────────────────────────────────────
  const allStaticMappings = [...options.static, ...derivedMappings];
  log.trace("all raw static mappings", allStaticMappings);

  const staticMap = buildStaticMap(allStaticMappings);
  log.trace("assembled staticMap", staticMap);

  // Mappings derived from the HTML have already been reported by
  // urlToStaticMapping; only explicit --static mounts are checked here.
  const derivedVirtualPaths = new Set(derivedMappings.map((mapping) => parseStaticMapping(mapping).virtual));

  for (const [virtualPath, localPath] of Object.entries(staticMap)) {
    if (derivedVirtualPaths.has(virtualPath)) continue;
    if (!existsSync(localPath)) {
      log.warn(
        `[static] Warning: mapped local path does not exist\n` + `         virtual : ${virtualPath}\n` + `         local   : ${localPath}`
      );
    }
  }

  const extraConfig = parseExtraArgs(extraArgs);
  log.trace("extraConfig (parsed from -- args)", extraConfig);

  const metaFields = pickDefinedStrings(options, ["title", "author", "language"]);

  const fetchMissing = options.fetchMissing === true || options.allowRemote === true;
  const settle = resolveSettleGate(options);
  const htmlOptions: HtmlRewriteOptions = {
    allowRemote: fetchMissing,
    fetchMissing,
    dumpDir: options.dumpHtml ?? null,
    settle,
    ...(typeof extraConfig.css === "string" ? { css: extraConfig.css } : {}),
    ...(typeof extraConfig.userStyle === "string" ? { userStyle: extraConfig.userStyle } : {})
  };
  log.trace("htmlRewriteOptions", htmlOptions);

  if (options.timeout !== undefined) {
    const timeoutMs = Number.parseInt(options.timeout, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`Invalid --timeout: "${options.timeout}"`);
    extraConfig.timeout = timeoutMs;
    log.info(`[render] timeout=${timeoutMs}ms`);
  }

  if (options.pixelRatio !== undefined) {
    const ratio = Number.parseFloat(options.pixelRatio);
    if (!Number.isFinite(ratio) || ratio <= 0) throw new Error(`Invalid --pixel-ratio: "${options.pixelRatio}"`);
    const existing = typeof extraConfig.viewerParam === "string" ? extraConfig.viewerParam : "";
    extraConfig.viewerParam = existing === "" ? `pixelRatio=${ratio}` : `${existing}&pixelRatio=${ratio}`;
    log.info(`[render] pixelRatio=${ratio}`);
  }
  // Canvas/WebGL backing-store upscale follows --pixel-ratio: layout keeps its
  // CSS size while JS-painted pixels are redrawn at n× resolution so print
  // output past 96dpi stays sharp. Pages opt in via window.__vivResize(factor).
  const canvasScale =
    options.pixelRatio === undefined
      ? undefined
      : (() => {
          const ratio = Number.parseFloat(options.pixelRatio);
          return Number.isFinite(ratio) && ratio > 1 ? ratio : undefined;
        })();

  log.info(`Starting Vivliostyle in mode: ${mode}`);

  // ── BUILD mode ───────────────────────────────────────────────────────────────
  if (mode === "build") {
    if (format !== "pdf") throw new Error(`Unsupported format: ${format}. This renderer produces PDF only.`);

    const sitePath = deriveSitePath(inputAbs, assetBases) ?? "/index.html";
    const viewerLibDir = resolveViewerLibDir();
    log.trace("viewerLibDir", viewerLibDir);
    log.trace("sitePath", sitePath);

    const entry: { localPath: string | null; sitePath: string } = { localPath: null, sitePath };
    const server = await startStaticServer({
      staticMap,
      assetBases,
      entry,
      fetchMissing: htmlOptions.fetchMissing === true,
      settle: htmlOptions.settle ?? null,
      viewerLibDir,
      viewerFilePath: join(viewerLibDir, "index.html"),
      log: (message) => log.info(message),
      onSettled: ({ reason, waitedMs, detail }) => {
        const line = `[wait] layout gate ${reason} after ${waitedMs}ms`;
        if (reason === "settled") log.info(detail === undefined ? line : `${line} ${JSON.stringify(detail)}`);
        else log.warn(`${line} — content may be incomplete`);
      }
    });

    const htmlResource = { cleanup: (): void => undefined };

    try {
      // Remote references are only worth keeping if they still exist.
      const remoteReferences = collectRemoteReferences(new JSDOM(readFileSync(inputAbs, "utf-8")).window.document).filter((url) =>
        referencesToProbe(url, assetBases)
      );
      const unavailableUrls = htmlOptions.fetchMissing === true ? await probeRemoteReferences(remoteReferences) : undefined;
      if (unavailableUrls !== undefined && unavailableUrls.size > 0) {
        log.warn(`[fetch] ${unavailableUrls.size} remote reference(s) are unavailable and will be dropped`);
      }

      const prepared = prepareInputHtmlForBuild(inputAbs, assetBases, staticMap, server.baseUrl, {
        ...htmlOptions,
        unavailableUrls,
        shimOrigin: server.baseUrl,
        // The viewer is served next to the document, so scripts the page runs
        // resolve their relative URLs against the document's own directory.
        documentBaseUrl: `${server.baseUrl}${siteDirectory(sitePath)}/`
      });
      htmlResource.cleanup = prepared.cleanup;
      entry.localPath = prepared.vivliostyleInput;

      const documentUrl = `${server.baseUrl}${sitePath}`;
      const viewerPageUrl = `${server.baseUrl}${siteDirectory(sitePath)}/${VIEWER_PAGE_NAME}`;
      log.info(`[html] Serving document at ${documentUrl}`);

      await runRender({
        documentUrl,
        viewerPageUrl,
        outputAbs,
        metaFields,
        viewerParams: buildRenderViewerParams(extraConfig, htmlOptions),
        timeoutMs: typeof extraConfig.timeout === "number" ? extraConfig.timeout : undefined,
        waitForSettle: htmlOptions.settle != null,
        chromeExecutable: typeof extraConfig.executableBrowser === "string" ? extraConfig.executableBrowser : undefined,
        canvasScale
      });
    } finally {
      htmlResource.cleanup();
      await server.close();
    }
    return;
  }

  // ── PREVIEW mode ─────────────────────────────────────────────────────────────
  {
    const preview = await startPreview(inputAbs, assetBases, staticMap, htmlOptions, extraConfig);
    log.info(`[preview] ${preview.url}`);
    await openInBrowser(preview.url);

    await new Promise<void>((resolvePromise) => {
      const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolvePromise();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });

    await preview.close();
  }
}

export type PreviewTarget = {
  /** URL of the viewer, showing the document. */
  url: string;
  /** URL the viewer loads the document from. */
  documentUrl: string;
  close: () => Promise<void>;
};

/**
 * Serves the rewritten document next to the viewer and returns the URL to open.
 *
 * The viewer page lives in the document's own directory, so the preview shows
 * exactly what the PDF render would lay out.
 */
export async function startPreview(
  inputAbs: string,
  assetBases: AssetBaseMapping[],
  staticMap: StaticMap,
  htmlOptions: HtmlRewriteOptions,
  extraConfig: Record<string, unknown>
): Promise<PreviewTarget> {
  const sitePath = deriveSitePath(inputAbs, assetBases) ?? "/index.html";
  const viewerLibDir = resolveViewerLibDir();
  const entry: { localPath: string | null; sitePath: string } = { localPath: null, sitePath };

  const server = await startStaticServer({
    staticMap,
    assetBases,
    entry,
    fetchMissing: htmlOptions.fetchMissing === true,
    viewerLibDir,
    viewerFilePath: join(viewerLibDir, "index.html"),
    log: (message) => log.info(message)
  });

  const prepared = buildPreviewHtml(inputAbs, assetBases, htmlOptions);
  entry.localPath = prepared.htmlPath;

  const viewerPageUrl = `${server.baseUrl}${siteDirectory(sitePath)}/${VIEWER_PAGE_NAME}`;
  const documentUrl = `${server.baseUrl}${sitePath}`;
  const url = buildViewerUrl(viewerPageUrl, {
    src: documentUrl,
    bookMode: false,
    renderAllPages: false,
    ...buildRenderViewerParams(extraConfig, htmlOptions)
  });

  return {
    url,
    documentUrl,
    close: async () => {
      prepared.cleanup();
      await server.close();
    }
  };
}

/** Opens a URL in the user's browser; preview mode is a plain server. */
async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch (err) {
    log.warn(`[preview] Could not open a browser: ${String(err)}`);
  }
}

/**
 * Viewer parameters for the render: layout overrides from `--` plus the options
 * the wrapper owns (page size, output resolution, user stylesheet).
 */
function buildRenderViewerParams(extraConfig: Record<string, unknown>, htmlOptions: HtmlRewriteOptions): ViewerParams {
  const params: ViewerParams = {};

  if (typeof extraConfig.size === "string") params.size = extraConfig.size;
  if (typeof extraConfig.viewerParam === "string") {
    for (const pair of extraConfig.viewerParam.split("&")) {
      if (pair === "") continue;
      const eq = pair.indexOf("=");
      if (eq === -1) params[pair] = true;
      else params[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  if (htmlOptions.css !== undefined) params.style = htmlOptions.css;
  if (htmlOptions.userStyle !== undefined) params.userStyle = htmlOptions.userStyle;

  return params;
}

// ---------------------------------------------------------------------------
// Direct execution
// ---------------------------------------------------------------------------

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const realEntry = realpathSync(entry);
    const realSelf = realpathSync(fileURLToPath(import.meta.url));
    return realEntry === realSelf;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  if (process.argv.slice(2).length === 0) {
    printHelp();
  }

  const parsed = parseArgs(process.argv);

  if (!parsed) {
    process.exit(0);
  }

  execute(parsed.options, parsed.extraArgs).catch((err: unknown) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
