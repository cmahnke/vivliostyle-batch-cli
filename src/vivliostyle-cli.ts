import { Command } from "commander";
import { build, preview } from "@vivliostyle/cli";
import { resolve, dirname, posix, join } from "node:path";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { lookup as mimeLookup } from "mime-types";
import express from "express";
import serveStatic from "serve-static";
import { JSDOM } from "jsdom";

type BuildConfig = Parameters<typeof build>[0];
type PreviewConfig = Parameters<typeof preview>[0];
type VivliostyleConfigSchema = NonNullable<PreviewConfig["configData"]>;
type StaticMap = VivliostyleConfigSchema extends { static?: infer S } ? NonNullable<S> : Record<string, string>;

type OutputFormat = "pdf" | "epub" | "webpub";
type LogLevel = "silent" | "info" | "verbose" | "debug";
type Mode = "build" | "preview";

type AssetBaseMapping = {
  urlBase: string;
  localBase: string;
};

type CliOptions = {
  input: string;
  output: string;
  title?: string;
  author?: string;
  language?: string;
  static: string[];
  scripts: boolean;
  cwd?: string;
  format: string;
  logLevel: string;
  debug?: boolean;
  assetBase: string[];
  ignoreAsset: string[];
  mode: string;
  preview?: boolean;
};

// ---------------------------------------------------------------------------
// Shared debug callback type
// ---------------------------------------------------------------------------

type Dbg = (_label: string, _value?: unknown) => void;

const validFormats: readonly OutputFormat[] = ["pdf", "epub", "webpub"];
const validLogLevels: readonly LogLevel[] = ["silent", "info", "verbose", "debug"];
const validModes: readonly Mode[] = ["build", "preview"];

// ---------------------------------------------------------------------------
// HTML input detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the input file should be treated as HTML.
 * Vivliostyle also accepts publication manifests (JSON/TOML/JS config files);
 * we detect HTML by extension to avoid trying to parse those as markup.
 */
export function isHtmlInput(inputAbs: string): boolean {
  return /\.html?$/i.test(inputAbs);
}

// ---------------------------------------------------------------------------
// Debug logger
// ---------------------------------------------------------------------------

function makeDbg(enabled: boolean): Dbg {
  return (_label: string, _value?: unknown): void => {
    if (!enabled) return;
    if (_value === undefined) {
      console.error(`[debug] ${_label}`);
    } else {
      console.error(`[debug] ${_label}`, JSON.stringify(_value, null, 2));
    }
  };
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
// Static HTTP server (build mode only)
// ---------------------------------------------------------------------------

type StaticServer = {
  baseUrl: string;
  close: () => void;
};

function makeMimeHeaders(res: express.Response, filePath: string): void {
  const mime = mimeLookup(filePath);
  if (mime) res.setHeader("Content-Type", mime);
}

function isFile(localPath: string): boolean {
  try {
    return statSync(localPath).isFile();
  } catch {
    return false;
  }
}

function applyStaticMounts(app: express.Express, staticMap: Record<string, string>, assetBases: AssetBaseMapping[], dbg: Dbg): void {
  for (const [virtual, localBase] of Object.entries(staticMap)) {
    const absLocal = resolve(localBase);
    if (isFile(absLocal)) {
      app.get(virtual, (_req, res) => {
        dbg("[static-server] serving file", { virtual, absLocal });
        const mime = mimeLookup(absLocal);
        if (mime) res.type(mime);
        res.sendFile(absLocal);
      });
      console.log(`[static-server] File route: GET ${virtual} → ${absLocal}`);
    } else {
      const mountPath = virtual.endsWith("/") ? virtual : `${virtual}/`;
      app.use(mountPath, serveStatic(absLocal, { fallthrough: true, setHeaders: makeMimeHeaders }));
      console.log(`[static-server] Dir mount: ${mountPath} → ${absLocal}`);
    }
    dbg("[static-server] mount", { virtual, absLocal });
  }

  for (const ab of assetBases) {
    const absLocal = resolve(ab.localBase);
    app.use("/", serveStatic(absLocal, { fallthrough: true, setHeaders: makeMimeHeaders }));
    dbg("[static-server] assetBase fallback mount", absLocal);
    console.log(`[static-server] Fallback mount: / → ${absLocal}`);
  }
}

export function startStaticServer(
  staticMap: Record<string, string>,
  assetBases: AssetBaseMapping[],
  htmlFilePath: string | null,
  dbg: Dbg,
  port = 0
): Promise<StaticServer> {
  const app = express();
  app.disable("x-powered-by");

  if (htmlFilePath !== null) {
    const absHtmlPath = resolve(htmlFilePath);
    app.get("/index.html", (_req, res) => {
      dbg("[static-server] serving HTML entry", absHtmlPath);
      res.type("text/html").sendFile(absHtmlPath);
    });
    console.log(`[static-server] HTML entry: /index.html → ${absHtmlPath}`);
  }

  applyStaticMounts(app, staticMap, assetBases, dbg);

  app.use((req: express.Request, res: express.Response) => {
    dbg("[static-server] 404", req.url);
    res.status(404).type("text").send(`404 Not Found: ${req.url}`);
  });

  return new Promise((resolvePromise, reject) => {
    const httpServer = app.listen(port, "127.0.0.1", () => {
      const addr = httpServer.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      console.log(`[static-server] Listening on ${baseUrl}`);
      dbg("[static-server] staticMap", staticMap);
      dbg(
        "[static-server] assetBase roots",
        assetBases.map((ab) => ab.localBase)
      );

      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        httpServer.close((err) => {
          if (err) console.warn(`[static-server] close error: ${err.message}`);
          else dbg("[static-server] stopped");
        });
      };

      resolvePromise({ baseUrl, close });
    });
    httpServer.once("error", reject);
  });
}

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

export function rewriteAbsoluteUrlsInDom(document: Document, assetBases: AssetBaseMapping[]): boolean {
  if (assetBases.length === 0) return false;
  let changed = false;

  for (const [selector, attr] of URL_ATTR_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      const val = el.getAttribute(attr) ?? "";
      const mapped = mapAbsoluteUrlToLocal(val, assetBases);
      if (mapped) {
        el.setAttribute(attr, mapped.virtualPath);
        changed = true;
      }
    }
  }

  return changed;
}

export function rewriteVirtualPathsToServerInDom(document: Document, staticMapKeys: string[], serverBaseUrl: string): boolean {
  let changed = false;

  const shouldRewrite = (path: string): boolean => {
    if (!path.startsWith("/")) return false;
    return staticMapKeys.some((virtual) => path === virtual || path.startsWith(virtual.endsWith("/") ? virtual : `${virtual}/`));
  };

  for (const [selector, attr] of URL_ATTR_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      const val = el.getAttribute(attr) ?? "";
      if (shouldRewrite(val)) {
        el.setAttribute(attr, `${serverBaseUrl}${val}`);
        changed = true;
      }
    }
  }

  return changed;
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

  for (const el of document.querySelectorAll("link[href]")) {
    const href = el.getAttribute("href")?.trim();
    if (href) urls.add(href);
  }

  if (includeScripts) {
    for (const el of document.querySelectorAll("script[src]")) {
      const src = el.getAttribute("src")?.trim();
      if (src) urls.add(src);
    }
  }

  return [...urls];
}

// ---------------------------------------------------------------------------
// Preview HTML builder
// ---------------------------------------------------------------------------

/**
 * Rewrites absolute external URLs to root-relative virtual paths and writes
 * the result as a sibling of the original input file so that
 * cwd = dirname(inputAbs) remains valid for Vivliostyle's path resolution.
 *
 * The output filename uses a non-dotfile prefix so Vite's static server
 * (which ignores dotfiles by default) can serve it correctly.
 *
 * Also derives extra static mounts from each assetBase so that secondary
 * assets referenced from CSS (fonts, images) are served by Vivliostyle's
 * own Vite server without needing Express.
 *
 * Returns:
 *  - htmlPath    – sibling file path, or inputAbs if no rewriting was needed
 *  - extraStatic – virtual→local entries for assetBase roots to merge into
 *                  the static map passed to Vivliostyle
 *  - cleanup     – deletes the sibling file (no-op if inputAbs was returned)
 */
export function buildPreviewHtml(
  inputAbs: string,
  assetBases: AssetBaseMapping[],
  dbg: Dbg
): { htmlPath: string; extraStatic: Record<string, string>; cleanup: () => void } {
  let content: string;
  try {
    content = readFileSync(inputAbs, "utf-8");
  } catch (err) {
    throw new Error(`Error reading HTML file: ${inputAbs}\n${String(err)}`);
  }

  // Derive extra static mounts for each assetBase root so secondary assets
  // referenced from CSS are also reachable through Vivliostyle's Vite server.
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
      console.warn(
        `[buildPreviewHtml] Duplicate assetBase virtual prefix "${mapKey}" — overwriting "${extraStatic[mapKey]}" with "${resolve(ab.localBase)}"`
      );
    }
    extraStatic[mapKey] = resolve(ab.localBase);
    dbg("buildPreviewHtml: assetBase extra static mount", { mapKey, local: ab.localBase });
  }

  const dom = new JSDOM(content);
  const document = dom.window.document;
  const changed = rewriteAbsoluteUrlsInDom(document, assetBases);
  if (changed) dbg("buildPreviewHtml: rewrote absolute URLs → virtual paths");

  if (!changed) {
    dbg("buildPreviewHtml: no URL rewrites needed, using original file");
    return { htmlPath: inputAbs, extraStatic, cleanup: () => undefined };
  }

  const inputDir = dirname(inputAbs);
  const inputBase = inputAbs.slice(inputDir.length + 1);
  const outputBase = `_vivliostyle_preview_${inputBase}`;
  const htmlPath = join(inputDir, outputBase);

  writeFileSync(htmlPath, dom.serialize(), "utf-8");
  dbg("buildPreviewHtml: wrote rewritten HTML alongside original", htmlPath);
  console.log(`[preview] Wrote rewritten HTML: ${htmlPath}`);

  const cleanup = (): void => {
    try {
      rmSync(htmlPath, { force: true });
      dbg("buildPreviewHtml: removed rewritten HTML", htmlPath);
    } catch (err) {
      console.warn(`[preview] Warning: could not remove ${htmlPath}\n${String(err)}`);
    }
  };

  return { htmlPath, extraStatic, cleanup };
}

// ---------------------------------------------------------------------------
// Build HTML builder
// ---------------------------------------------------------------------------

/**
 * Prepares the HTML for BUILD mode.
 * Both rewrite passes (absolute → virtual, virtual → absolute server URL)
 * are applied in a single DOM parse.
 * If nothing changed the original file path is returned with a no-op cleanup.
 */
export function prepareInputHtmlForBuild(
  inputAbs: string,
  assetBases: AssetBaseMapping[],
  staticMap: Record<string, string>,
  serverBaseUrl: string,
  dbg: Dbg
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

  const absChanged = rewriteAbsoluteUrlsInDom(document, assetBases);
  if (absChanged) dbg("prepareInputHtmlForBuild: rewrote absolute URLs → virtual paths");

  const srvChanged = rewriteVirtualPathsToServerInDom(document, staticMapKeys, serverBaseUrl);
  if (srvChanged) dbg("prepareInputHtmlForBuild: rewrote virtual paths → server URLs");

  if (!absChanged && !srvChanged) {
    dbg("prepareInputHtmlForBuild: no changes, using original file");
    return { vivliostyleInput: inputAbs, cleanup: () => undefined };
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "vivliostyle-"));
  const tmpHtml = join(tmpDir, "index.html");
  writeFileSync(tmpHtml, dom.serialize(), "utf-8");
  console.log(`[html] Prepared input HTML → ${tmpHtml}`);
  dbg("prepareInputHtmlForBuild: written to temp file", tmpHtml);

  const cleanup = (): void => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      dbg("prepareInputHtmlForBuild: removed temp dir", tmpDir);
    } catch (err) {
      console.warn(`[html] Warning: could not remove temp dir ${tmpDir}\n${String(err)}`);
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

export function mapAbsoluteUrlToLocal(url: string, assetBases: AssetBaseMapping[]): { virtualPath: string; localPath: string } | null {
  for (const mapping of assetBases) {
    if (!url.startsWith(mapping.urlBase)) continue;

    let cleanRelative: string;
    try {
      cleanRelative = new URL(url).pathname.slice(1);
    } catch {
      const noQuery = url.slice(mapping.urlBase.length).split("?")[0];
      cleanRelative = noQuery.split("#")[0];
    }

    if (!cleanRelative) return null;

    const virtualPath = posix.resolve("/", cleanRelative);
    const localPath = resolve(mapping.localBase, cleanRelative);
    return { virtualPath, localPath };
  }
  return null;
}

// ---------------------------------------------------------------------------
// MappingResult + urlToStaticMapping
// ---------------------------------------------------------------------------

type MappingResult = { kind: "mapped"; mapping: string } | { kind: "skipped"; url: string; reason: string };

export function urlToStaticMapping(
  url: string,
  htmlDir: string,
  assetBases: AssetBaseMapping[],
  ignoredAssets: Set<string>,
  dbg: Dbg
): MappingResult {
  const trimmed = url.trim();
  if (!trimmed) return { kind: "skipped", url, reason: "empty URL" };
  if (trimmed.startsWith("#")) return { kind: "skipped", url, reason: "fragment-only URL" };

  const absoluteMapped = mapAbsoluteUrlToLocal(trimmed, assetBases);
  if (absoluteMapped) {
    if (shouldIgnoreVirtualPath(absoluteMapped.virtualPath, ignoredAssets)) {
      dbg("urlToStaticMapping: ignored (asset-base match)", { url, ...absoluteMapped });
      return {
        kind: "skipped",
        url,
        reason: `matches --ignore-asset "${absoluteMapped.virtualPath}"`
      };
    }
    if (!existsSync(absoluteMapped.localPath)) {
      console.warn(
        `[html] Warning: asset-base mapped path does not exist\n` +
          `         url     : ${url}\n` +
          `         virtual : ${absoluteMapped.virtualPath}\n` +
          `         local   : ${absoluteMapped.localPath}`
      );
    }
    return {
      kind: "mapped",
      mapping: `${absoluteMapped.virtualPath}:${absoluteMapped.localPath}`
    };
  }

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
    return { kind: "skipped", url, reason: "URL is empty after stripping query/fragment" };
  }

  const localPath = resolve(htmlDir, cleanUrl);
  const virtualPath = cleanUrl.startsWith("/") ? posix.normalize(cleanUrl) : posix.resolve("/", posix.relative(htmlDir, localPath));

  if (shouldIgnoreVirtualPath(virtualPath, ignoredAssets)) {
    dbg("urlToStaticMapping: ignored (ignore-asset match)", { url, virtualPath });
    return {
      kind: "skipped",
      url,
      reason: `matches --ignore-asset "${virtualPath}"`
    };
  }

  if (!existsSync(localPath)) {
    console.warn(
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
      console.warn(`[static] Warning: duplicate virtual path "${virtual}" — ` + `"${map[virtual]}" overwritten by "${local}"`);
    }
    map[virtual] = local;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Extra args parser
// ---------------------------------------------------------------------------

export function parseExtraArgs(extraArgs: string[]): Record<string, unknown> {
  const extraConfig: Record<string, unknown> = {};

  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i];

    if (!arg.startsWith("--")) {
      if (arg.startsWith("-")) {
        console.warn(
          `[extra-args] Warning: short flag "${arg}" after -- is not supported and will be ignored.\n` +
            `             Use the long-form --flag equivalent instead.`
        );
      }
      continue;
    }

    if (arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      const key = arg.slice(2, eqIdx);
      const val = arg.slice(eqIdx + 1);
      extraConfig[key] = val === "true" ? true : val === "false" ? false : val;
      continue;
    }

    const key = arg.slice(2);
    const next = extraArgs[i + 1];

    if (next === "true") {
      extraConfig[key] = true;
      i++;
    } else if (next === "false") {
      extraConfig[key] = false;
      i++;
    } else if (next && !next.startsWith("-")) {
      extraConfig[key] = next;
      i++;
    } else {
      extraConfig[key] = true;
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
    .option("--cwd <dir>", "Working directory for Vivliostyle (default: directory of --input)")
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
        "  • Options after -- are forwarded verbatim to Vivliostyle.",
        "  • --debug sets --log-level to debug automatically.",
        "  • --preview and --mode preview are equivalent.",
        "  • In preview mode Vivliostyle serves everything via its own Vite server.",
        "  • In build mode an Express server is started to serve assets.",
        "  • --asset-base localBase is also a fallback root for CSS-referenced assets."
      ].join("\n")
    );
}

export function printHelp(): void {
  buildProgram().help();
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
// Core execute
// ---------------------------------------------------------------------------

export async function execute(options: CliOptions, extraArgs: string[] = []): Promise<void> {
  const debugEnabled = !!(options.debug || options.logLevel === "debug");
  const dbg = makeDbg(debugEnabled);

  dbg("raw CLI options", options);
  dbg("extra args (after --)", extraArgs);

  if (!options.input) throw new Error("Missing required option: --input");

  const inputAbs = resolve(options.input);
  dbg("resolved input", inputAbs);
  if (!existsSync(inputAbs)) throw new Error(`Input file does not exist: ${inputAbs}`);

  const cwd = options.cwd ? resolve(options.cwd) : dirname(inputAbs);
  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  dbg("cwd", cwd);

  const outputAbs = resolve(options.output);
  dbg("resolved output", outputAbs);

  if (!validFormats.includes(options.format as OutputFormat)) {
    throw new Error(`Invalid format: "${options.format}". Allowed: ${validFormats.join(", ")}`);
  }
  const format = options.format as OutputFormat;

  if (!validLogLevels.includes(options.logLevel as LogLevel)) {
    throw new Error(`Invalid log level: "${options.logLevel}". Allowed: ${validLogLevels.join(", ")}`);
  }
  const logLevel: LogLevel = options.debug ? "debug" : (options.logLevel as LogLevel);
  dbg("logLevel", logLevel);

  const mode = (options.preview ? "preview" : options.mode) as Mode;
  if (!validModes.includes(mode)) {
    throw new Error(`Invalid mode: "${mode}". Allowed: ${validModes.join(", ")}`);
  }
  dbg("mode", mode);

  const htmlMode = isHtmlInput(inputAbs);
  dbg("htmlMode (auto-detected)", htmlMode);

  if (!htmlMode) {
    if (options.assetBase.length > 0) {
      console.warn(`[warn] --asset-base has no effect for non-HTML input "${inputAbs}".`);
    }
    if (options.ignoreAsset.length > 0) {
      console.warn(`[warn] --ignore-asset has no effect for non-HTML input "${inputAbs}".`);
    }
  }

  const assetBases = options.assetBase.map(parseAssetBaseMapping);
  dbg("parsed assetBases", assetBases);

  const ignoredAssets = new Set(options.ignoreAsset.map(normalizeIgnoreAssetPath));
  dbg("ignoredAssets", [...ignoredAssets]);

  // ── HTML-derived mappings ────────────────────────────────────────────────
  const derivedMappings: string[] = [];

  if (htmlMode) {
    const htmlDir = dirname(inputAbs);
    console.log(`[html] Analysing input as HTML: ${inputAbs}`);

    const includeScripts = mode === "preview" ? true : options.scripts;
    const urls = extractUrlsFromHtml(inputAbs, includeScripts);

    if (urls.length === 0) {
      console.log("[html] No URLs found in input HTML");
    } else {
      console.log(`[html] Found URLs (${urls.length}):`);
    }

    for (const url of urls) {
      const result = urlToStaticMapping(url, htmlDir, assetBases, ignoredAssets, dbg);
      if (result.kind === "skipped") {
        console.log(`  → Skipped (${result.reason}): ${url}`);
        continue;
      }
      console.log(`  → Mapping: ${result.mapping}`);
      derivedMappings.push(result.mapping);
    }

    dbg("derived static mappings from HTML", derivedMappings);
  }

  // ── static map ────────────────────────────────────────────────────────────
  const allStaticMappings = [...options.static, ...derivedMappings];
  dbg("all raw static mappings", allStaticMappings);

  const staticMap = buildStaticMap(allStaticMappings);
  dbg("assembled staticMap", staticMap);

  const hasStatic = Object.keys(staticMap).length > 0;

  for (const [virtualPath, localPath] of Object.entries(staticMap)) {
    if (!existsSync(localPath)) {
      console.warn(
        `[static] Warning: mapped local path does not exist\n` + `         virtual : ${virtualPath}\n` + `         local   : ${localPath}`
      );
    }
  }

  const extraConfig = parseExtraArgs(extraArgs);
  dbg("extraConfig (parsed from -- args)", extraConfig);

  const metaFields = pickDefinedStrings(options, ["title", "author", "language"]);

  console.log(`Starting Vivliostyle in mode: ${mode}`);

  // ── BUILD mode ─────────────────────────────────────────────────────────────
  if (mode === "build") {
    let vivliostyleInput = inputAbs;
    let htmlCleanup = (): void => undefined;

    if (hasStatic || assetBases.length > 0) {
      const server = await startStaticServer(staticMap, assetBases, null, dbg);

      try {
        if (htmlMode) {
          ({ vivliostyleInput, cleanup: htmlCleanup } = prepareInputHtmlForBuild(inputAbs, assetBases, staticMap, server.baseUrl, dbg));
        }

        dbg("vivliostyleInput (final)", vivliostyleInput);

        const config: BuildConfig = {
          cwd,
          input: vivliostyleInput,
          output: [{ path: outputAbs, format }],
          ...metaFields,
          logLevel,
          ...(options.debug ? { debug: true } : {}),
          ...extraConfig
        };
        dbg("final BuildConfig", config);
        await build(config);
        console.log(`✓ Document created: ${outputAbs}`);
      } finally {
        htmlCleanup();
        server.close();
      }
    } else {
      dbg("vivliostyleInput (final)", vivliostyleInput);

      const config: BuildConfig = {
        cwd,
        input: vivliostyleInput,
        output: [{ path: outputAbs, format }],
        ...metaFields,
        logLevel,
        ...(options.debug ? { debug: true } : {}),
        ...extraConfig
      };
      dbg("final BuildConfig", config);
      await build(config);
      console.log(`✓ Document created: ${outputAbs}`);
    }

    // ── PREVIEW mode ───────────────────────────────────────────────────────────
  } else {
    let previewInput = inputAbs;
    let htmlCleanup = (): void => undefined;
    const previewStaticMap: Record<string, string> = { ...staticMap };

    if (htmlMode) {
      const { htmlPath, extraStatic, cleanup } = buildPreviewHtml(inputAbs, assetBases, dbg);
      previewInput = htmlPath;
      htmlCleanup = cleanup;

      for (const [virtual, local] of Object.entries(extraStatic)) {
        if (!Object.hasOwn(previewStaticMap, virtual)) {
          previewStaticMap[virtual] = local;
          console.log(`[preview] AssetBase static mount: ${virtual} → ${local}`);
        } else {
          dbg("preview: skipping assetBase mount shadowed by explicit --static", {
            virtual,
            local
          });
        }
      }

      if (htmlPath !== inputAbs) {
        console.log(`[preview] Using rewritten HTML: ${htmlPath}`);
      }
    }

    dbg("preview input (final)", previewInput);
    dbg("previewStaticMap (final)", previewStaticMap);

    const hasPreviewStatic = Object.keys(previewStaticMap).length > 0;

    const previewCwd = dirname(previewInput);
    dbg("previewCwd", previewCwd);

    const previewEntry = previewInput.slice(previewCwd.length + 1);
    dbg("previewEntry (relative, for configData only)", previewEntry);

    const config: PreviewConfig = {
      cwd: previewCwd,
      input: previewInput,
      logLevel,
      enableStaticServe: true,
      openViewer: true,
      singleDoc: true,
      ...(hasPreviewStatic
        ? {
            configData: [
              {
                entry: previewEntry,
                ...metaFields,
                static: previewStaticMap as StaticMap
              }
            ]
          }
        : {}),
      ...(options.debug ? { debug: true } : {}),
      ...extraConfig
    };

    dbg("final PreviewConfig", config);

    const shutdown = (): void => {
      htmlCleanup();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    try {
      await preview(config);
    } catch (err) {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      htmlCleanup();
      console.error("[preview] Full error:", err);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`preview() failed:\n${message}`);
    }

    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    htmlCleanup();
  }
}

// ---------------------------------------------------------------------------
// Direct execution
// ---------------------------------------------------------------------------

let _resolvedEntry: string | null = null;
try {
  _resolvedEntry = resolve(fileURLToPath(import.meta.url));
} catch {
  // ESM import.meta.url not available — not a direct invocation
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry || _resolvedEntry === null) return false;
  try {
    return resolve(entry) === _resolvedEntry;
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
    printHelp();
  } else {
    execute(parsed.options, parsed.extraArgs).catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
  }
}
