// src/render/pdf.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * PDF rendering on top of the Vivliostyle viewer and Chrome's print-to-PDF.
 *
 * The viewer page is served by our own static server (see src/server.ts), so
 * the document's origin — and therefore the base URI of the scripts the page
 * runs — is the site we serve, not an internal viewer base.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import puppeteer from "puppeteer-core";
import { PDFDocument } from "pdf-lib";
import log from "loglevel";
import { chromeArgs, resolveBrowserExecutable } from "./chrome.js";

export type ViewerParams = Record<string, string | number | boolean | undefined>;

/** URL of the viewer page, with the publication and layout parameters. */
export function buildViewerUrl(viewerPageUrl: string, params: ViewerParams): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    parts.push(`${key}=${String(value).replaceAll("&", "%26")}`);
  }

  const query = parts.join("&");
  return query === "" ? viewerPageUrl : `${viewerPageUrl}#${query}`;
}

export type RenderPdfRequest = {
  /** Absolute URL of the document on our static server. */
  documentUrl: string;
  /** Absolute URL of the viewer page on our static server. */
  viewerPageUrl: string;
  /** Absolute path of the PDF to write. */
  output: string;
  viewerParams?: ViewerParams;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  language?: string;
  /** Hard limit for the whole render. */
  timeoutMs?: number;
  /** Wait for the page to report that it settled before printing. */
  waitForSettle?: boolean;
  /**
   * Redraw canvas/WebGL content at `clientSize * canvasScale` backing pixels
   * before printing (layout/CSS size unchanged). Values `<= 1` skip the step.
   * Wired from `--pixel-ratio` so `--pixel-ratio 2` stays sharp past 96dpi.
   */
  canvasScale?: number;
  /** Pause after the upscale call so charts can repaint (default 500ms). */
  canvasSettleMs?: number;
  chromeExecutable?: string;
  extraChromeArgs?: string[];
};

export type RenderPdfResult = {
  output: string;
  bytes: number;
  pageCount: number;
  settle: { reason: string; waitedMs: number } | null;
};

const DEFAULT_TIMEOUT_MS = 300_000;

/** Writes the PDF and stamps the metadata Vivliostyle would have written. */
export async function writePdfWithMetadata(pdf: Uint8Array, meta: RenderPdfRequest): Promise<Uint8Array> {
  const hasMetadata = meta.title !== undefined || meta.author !== undefined || meta.subject !== undefined || meta.language !== undefined;
  if (!hasMetadata) return pdf;

  const document = await PDFDocument.load(pdf, { updateMetadata: false });
  if (meta.title !== undefined) document.setTitle(meta.title);
  if (meta.author !== undefined) document.setAuthor(meta.author);
  if (meta.subject !== undefined) document.setSubject(meta.subject);
  if (meta.keywords !== undefined) document.setKeywords([meta.keywords]);
  if (meta.language !== undefined) document.setLanguage(meta.language);
  document.setProducer("vivliostyle-batch-cli");
  document.setCreator("vivliostyle-batch-cli");
  return document.save();
}

type SettleState = { reason: string; at: number };

export type FrameRenderCapability = {
  url: string;
  ready: boolean;
  fixture: string | null;
  webgl: boolean;
  webgl2: boolean;
  webgpu: boolean;
  canvasCount: number;
  canvases: string;
  iframeCount: number | null;
  dpr: number;
  resized: string | null;
  /** A-Frame scenes materialized into 2D overlay canvases for print. */
  materialized?: number;
  /** Scene-graph state at print time (debug aid). */
  sceneDiag?: string | null;
};

/**
 * Runs inside one frame (viewer window or a document/iframe within it):
 * scrolls JS-painted elements into view so out-of-process iframes rasterize,
 * reports GPU capabilities and canvas sizes, and — when the page exposes the
 * `window.__vivResize(factor)` hook — redraws at HiDPI backing resolution.
 *
 * Blindly rewriting `canvas.width` here would blank WebGL contexts without
 * `preserveDrawingBuffer`, so generic canvases are left for the page to redraw
 * via the dispatched `resize` event; only the explicit hook changes pixels.
 */
export function buildFrameProbeScript(factor: number): string {
  return `(async function(factor){
  function nextFrame(){ return new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); }); }
  var canvases = Array.prototype.slice.call(document.querySelectorAll("canvas"));
  var iframes = Array.prototype.slice.call(document.querySelectorAll("iframe"));
  canvases.forEach(function(c){ try{ c.scrollIntoView({block:"nearest"}); }catch(e){} });
  iframes.forEach(function(f){ try{ f.scrollIntoView({block:"nearest"}); }catch(e){} });
  function canvasSizes(){
    return Array.prototype.slice.call(document.querySelectorAll("canvas")).map(function(c){
      return c.width+"x"+c.height+"@"+Math.round(c.clientWidth)+"x"+Math.round(c.clientHeight);
    }).join(",");
  }
  var resized = null;
  if (factor > 1 && typeof window.__vivResize === "function") {
    try { window.__vivResize(factor); } catch(e){ resized = "error:"+String(e); }
  }
  try { window.dispatchEvent(new Event("resize")); } catch(e){}
  // Bridge the viewer's broken page lifecycle. A-Frame scenes can end up
  // loaded-but-never-playing in the paginated tree (render loop, default
  // lights and asset loads all missed their window) while the same page
  // renders fine in a real browser. Start the scene's own loop and give
  // collapsed scenes a box (their display:block stylesheet does not reach
  // the re-parented tree, so unsized unknown elements stay inline).
  try {
    var bridgeScenes = document.querySelectorAll("a-scene");
    for (var bi = 0; bi < bridgeScenes.length; bi++) {
      var bridgeScene = bridgeScenes[bi];
      if (!bridgeScene.isPlaying && typeof bridgeScene.play === "function") {
        try { bridgeScene.play(); } catch (e) {}
      }
      if (bridgeScene.clientWidth === 0 || bridgeScene.clientHeight === 0) {
        var sized = bridgeScene.parentElement;
        while (sized && (sized.clientWidth === 0 || sized.clientHeight === 0)) sized = sized.parentElement;
        if (sized) {
          bridgeScene.style.display = "block";
          bridgeScene.style.width = sized.clientWidth + "px";
          bridgeScene.style.height = sized.clientHeight + "px";
          if (typeof bridgeScene.resize === "function") bridgeScene.resize();
        }
      }
    }
    await nextFrame();
  } catch(e){}
  // Give each scene what it needs to render like the browser does, then
  // materialize its WebGL canvas into a 2D overlay (2D canvases always
  // survive print-to-PDF): re-kick unloaded assets, swap unlit materials for
  // flat ones when no lights exist, render, and blit synchronously.
  var materialized = 0;
  var sceneDiag = "";
  try {
    var scenes = document.querySelectorAll("a-scene");
    for (var si = 0; si < scenes.length; si++) {
      var sceneEl = scenes[si];
      // The viewer clones scenes into its page boxes; only the VISIBLE one
      // (with a box) is what the PDF will show. The hidden original's render
      // would materialize nothing.
      if (!(sceneEl.clientWidth > 0 && sceneEl.clientHeight > 0)) continue;
      if (!sceneEl.renderer || !sceneEl.camera) continue;
      try {
        var gltfEl = sceneEl.querySelector("[gltf-model]");
        if (gltfEl) {
          var gmObj = gltfEl.object3D;
          sceneDiag += " gmKids=" + gmObj.children.length + "/" + (gltfEl.components["gltf-model"] ? String(gltfEl.components["gltf-model"].model !== null) : "nocomp");
        }
        sceneDiag += " tree=" + sceneEl.object3D.children.map(function (c) { return c.type + (c.children ? ":" + c.children.length : ""); }).join("|").slice(0, 110);
      } catch (e) {
        sceneDiag += " diagErr " + String(e).slice(0, 50);
      }
      try {
        var assetItems = sceneEl.querySelectorAll("a-asset-item");
        var assetWaits = [];
        for (var ai = 0; ai < assetItems.length; ai++) {
          var assetEl = assetItems[ai];
          if (assetEl.hasLoaded) continue;
          assetWaits.push(
            new Promise(function (resolve) {
              var settled = false;
              var finish = function () {
                if (settled) return;
                settled = true;
                resolve();
              };
              assetEl.addEventListener("loaded", finish, { once: true });
              assetEl.addEventListener("error", finish, { once: true });
              setTimeout(finish, 8000);
              var src = assetEl.getAttribute("src");
              if (src) assetEl.setAttribute("src", src);
            })
          );
        }
        if (assetWaits.length > 0) {
          await Promise.race([Promise.all(assetWaits), new Promise(function (r) { setTimeout(r, 9000); })]);
        }
      } catch (e) {}
      try {
        var lightsFound = 0;
        sceneEl.object3D.traverse(function (n) { if (n.isLight) lightsFound++; });
        if (lightsFound === 0) {
          var basicCtor = null;
          sceneEl.object3D.traverse(function (n) {
            if (n.isMesh && n.material && n.material.isMeshBasicMaterial && basicCtor === null) basicCtor = n.material.constructor;
          });
          if (basicCtor) {
            sceneEl.object3D.traverse(function (n) {
              if (!n.isMesh || !n.material || n.material.isMeshBasicMaterial) return;
              try {
                var m = n.material;
                var flat = new basicCtor({ color: m.color ? m.color.clone() : undefined });
                flat.side = m.side;
                flat.transparent = m.transparent;
                flat.opacity = m.opacity;
                if (m.map) flat.map = m.map;
                n.material = flat;
              } catch (e) {}
            });
          }
        }
      } catch(e){}
      try {
        sceneEl.renderer.render(sceneEl.object3D, sceneEl.camera);
        var glCanvas = sceneEl.canvas;
        if (!glCanvas || glCanvas.width === 0 || glCanvas.height === 0) continue;
        var overlay = document.createElement("canvas");
        overlay.setAttribute("data-viv-gl-overlay", "");
        overlay.width = glCanvas.width;
        overlay.height = glCanvas.height;
        overlay.style.position = "absolute";
        overlay.style.pointerEvents = "none";
        overlay.style.width = glCanvas.clientWidth + "px";
        overlay.style.height = glCanvas.clientHeight + "px";
        var cr = glCanvas.getBoundingClientRect();
        var pr = (glCanvas.offsetParent || document.body).getBoundingClientRect();
        overlay.style.left = cr.left - pr.left + "px";
        overlay.style.top = cr.top - pr.top + "px";
        overlay.style.zIndex = "1";
        (glCanvas.parentNode || document.body).appendChild(overlay);
        overlay.getContext("2d").drawImage(glCanvas, 0, 0);
        // Empty capture = the scene never initialized in this tree (its
        // framework lifecycle was lost to the viewer's re-parenting). Replace
        // it with a fresh copy: the custom-element upgrade re-runs the full
        // framework lifecycle (assets, lights, render loop) in the now-sized
        // tree.
        var empty = true;
        try {
          var dd = overlay.getContext("2d").getImageData(0, 0, overlay.width, overlay.height).data;
          for (var di = 3; di < dd.length; di += 256) {
            if (dd[di] > 0) {
              empty = false;
              break;
            }
          }
        } catch (e) {
          empty = false;
        }
        if (empty) {
          var fresh = sceneEl.cloneNode(true);
          sceneEl.parentNode.replaceChild(fresh, sceneEl);
          sceneEl = fresh;
          // Enough time for the fresh scene's asset fetches (a real GLB over
          // the network) + first renders.
          await new Promise(function (r) {
            setTimeout(r, 8000);
          });
          if (!sceneEl.renderer || !sceneEl.camera) continue;
        }
        sceneEl.renderer.render(sceneEl.object3D, sceneEl.camera);
        var gl2 = sceneEl.canvas;
        if (!gl2 || gl2.width === 0 || gl2.height === 0) continue;
        overlay.width = gl2.width;
        overlay.height = gl2.height;
        overlay.getContext("2d").drawImage(gl2, 0, 0);
        materialized++;
        try {
          var od = overlay.getContext("2d").getImageData(0, 0, overlay.width, overlay.height).data;
          var alphaN = 0;
          var orangeN = 0;
          for (var oi = 3; oi < od.length; oi += 16) {
            if (od[oi] > 0) alphaN++;
            if (od[oi - 3] > 150 && od[oi - 2] > 60 && od[oi - 2] < 200 && od[oi - 1] < 110 && od[oi - 3] > od[oi - 2] + 40) orangeN++;
          }
          glSample = [alphaN, orangeN];
        } catch (e) {}
      } catch (e) {}
    }
  } catch(e){}
  // Hooks like echarts re-init dispose the canvas synchronously; let layout
  // settle a frame before measuring so sizes reflect the repainted state.
  // This also lets render loops refill their drawing buffers after the
  // resize above — drawImage on a just-resized WebGL canvas would read the
  // cleared buffer.
  try { await nextFrame(); } catch(e){}
  if (resized === null && factor > 1 && typeof window.__vivResize === "function") resized = canvasSizes();
  var webgl = false, webgl2 = false;
  try {
    var t = document.createElement("canvas");
    webgl = !!t.getContext("webgl");
    var t2 = document.createElement("canvas");
    webgl2 = !!t2.getContext("webgl2");
  } catch(e){}
  return {
    url: String(location.href),
    ready: window.__vivReady === true,
    fixture: typeof window.__vivFixture === "string" ? window.__vivFixture : null,
    webgl: webgl, webgl2: webgl2,
    webgpu: typeof navigator !== "undefined" && "gpu" in navigator,
    canvasCount: document.querySelectorAll("canvas").length, canvases: canvasSizes(),
    iframeCount: document.querySelectorAll("iframe").length,
    dpr: typeof window.devicePixelRatio === "number" ? window.devicePixelRatio : 1,
    resized: resized,
    materialized: materialized,
    sceneDiag: sceneDiag
  };
})(${JSON.stringify(factor)})`;
}

/** Best-effort capability + HiDPI pass over every frame before `page.pdf()`. */
export async function prepareForPrint(
  page: {
    frames: () => Array<{ url?: () => string; evaluate: (script: string) => Promise<unknown> }>;
  },
  options: { canvasScale?: number; settleMs?: number } = {}
): Promise<FrameRenderCapability[]> {
  const factor = options.settleMs !== undefined && options.canvasScale === undefined ? 1 : (options.canvasScale ?? 1);
  const scale = Number.isFinite(factor) && factor > 1 ? factor : 1;
  const script = buildFrameProbeScript(scale);
  const out: FrameRenderCapability[] = [];
  for (const frame of page.frames()) {
    try {
      out.push((await frame.evaluate(script)) as FrameRenderCapability);
    } catch (err) {
      // Cross-origin embeds that refuse evaluation still print as pixels.
      log.trace("frame probe failed", frame.url?.() ?? "(frame)", err instanceof Error ? err.message : String(err));
      continue;
    }
  }
  if (scale > 1) {
    await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 500));
  }
  return out;
}

/** One-line summary for logs: capabilities per frame that owns content. */
export function summarizeCapabilities(caps: FrameRenderCapability[]): string {
  return caps
    .filter((c) => c.canvasCount > 0 || (c.iframeCount ?? 0) > 0 || c.fixture !== null)
    .map(
      (c) =>
        `${c.fixture ?? c.url} canvases=[${c.canvases}] iframes=${c.iframeCount} ` +
        `webgl=${String(c.webgl)}/2=${String(c.webgl2)} webgpu=${String(c.webgpu)}` +
        (c.resized !== null ? ` resized=[${c.resized}]` : "") +
        (c.materialized ? ` materialized=${c.materialized} ${c.sceneDiag ?? ""}` : "")
    )
    .join(" | ");
}

export async function renderPdf(request: RenderPdfRequest): Promise<RenderPdfResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const executablePath = resolveBrowserExecutable(request.chromeExecutable);

  if (executablePath === null) {
    throw new Error(
      "No Chrome/Chromium found. Install one (e.g. `npx @puppeteer/browsers install chrome@stable`) or pass --executable-browser <path>."
    );
  }

  const viewerUrl = buildViewerUrl(request.viewerPageUrl, {
    src: request.documentUrl,
    bookMode: false,
    renderAllPages: true,
    ...request.viewerParams
  });
  log.trace("viewerUrl", viewerUrl);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: chromeArgs(request.extraChromeArgs ?? []),
    acceptInsecureCerts: true
  });

  const startedAt = Date.now();
  let settle: RenderPdfResult["settle"] = null;

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);

    page.on("pageerror", (err: unknown) => log.warn(`[render] page error: ${err instanceof Error ? err.message : String(err)}`));
    // Viewer and page errors are the usual reason a render produces nothing.
    // Debug/info console messages (fetch traces from the runtime script) are
    // shown at debug level, so -d traces every page-side request.
    const debugConsole = log.getLevel() <= log.levels.DEBUG;
    page.on("console", (message) => {
      const type = message.type();
      if (type !== "error" && type !== "warn" && !(debugConsole && (type === "debug" || type === "info"))) return;
      const where = message.location();
      log[debugConsole && type !== "error" && type !== "warn" ? "trace" : "warn"](
        `[render] console.${type}: ${message.text()}${where.url === "" ? "" : ` (${where.url})`}`
      );
    });
    page.on("requestfailed", (request) => {
      log.warn(`[render] request failed: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`);
    });

    // Print media has to be active *before* the document loads: the page's print
    // stylesheet is what gives JS-driven containers their size, and a chart that
    // initialises against a zero-sized box never recovers.
    await page.emulateMediaType("print");

    await page.goto(viewerUrl, { waitUntil: "domcontentloaded" });

    // The viewer's contract: coreViewer exists and has finished typesetting.
    await page.waitForFunction(() => (window as { coreViewer?: unknown }).coreViewer !== undefined);
    await page.waitForFunction(() => (window as { coreViewer?: { readyState?: string } }).coreViewer?.readyState === "complete", {
      polling: 500
    });

    if (request.waitForSettle === true) {
      const handle = await page.waitForFunction(
        () => {
          const settleState = (window as { __vivSettle?: { done?: boolean; reason?: string; at?: number } }).__vivSettle;
          // Pages with mocked/measured async work set __vivReady when painted;
          // Vivliostyle re-runs document scripts in the viewer context, so both
          // live on the same window the renderer polls here.
          const ready = (window as { __vivReady?: boolean }).__vivReady === true;
          if (ready) return { reason: "ready", at: 0 };
          return settleState?.done === true ? { reason: settleState.reason ?? "settled", at: settleState.at ?? 0 } : false;
        },
        { polling: 200, timeout: timeoutMs }
      );
      const state = (await handle.jsonValue()) as SettleState;

      settle = { reason: state.reason, waitedMs: Date.now() - startedAt };
      log.trace("settle", settle);
    }

    // Iframes/canvas/WebGL/WebGPU rasterize as pixels in print-to-PDF: force
    // off-screen frames to paint, redraw HiDPI-aware pages at backing scale.
    try {
      const caps = await prepareForPrint(page, {
        canvasScale: request.canvasScale,
        settleMs: request.canvasSettleMs
      });
      const summary = summarizeCapabilities(caps);
      if (summary !== "") log.info(`[render] frames: ${summary}`);
      if (caps.length > 0 && caps.every((c) => !c.webgpu)) {
        log.trace("[render] WebGPU unavailable in this Chrome (best-effort software rendering)");
      }
    } catch (err) {
      log.warn(`[render] pre-print probe failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }

    const pdf = await page.pdf({
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
      printBackground: true,
      preferCSSPageSize: true,
      tagged: true
    });

    const stamped = await writePdfWithMetadata(pdf, request);
    mkdirSync(dirname(request.output), { recursive: true });
    writeFileSync(request.output, stamped);

    const pageCount = await PDFDocument.load(stamped).then((doc) => doc.getPageCount());

    return { output: request.output, bytes: stamped.length, pageCount, settle };
  } finally {
    await browser.close();
  }
}
