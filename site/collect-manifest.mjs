// site/collect-manifest.mjs

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * Collects the render-fixture showcase inputs.
 *
 * Real mode (CI): PDFs were rendered into `--out` and per-fixture logs sit in
 * `--logs`. Copies fixture inputs, vendor libraries and tiles into `--out`,
 * rewrites the copies' absolute `/vendor/` URLs to relative ones (the Pages
 * base path is not `/`), parses settle/capability markers out of the logs and
 * writes `--out/manifest.json` for the Vite app in `site/`. Exits non-zero
 * when a fixture misses its marker or PDF.
 *
 * Sample mode (`--sample`): same copies, manifest with `pdf: null` so
 * `npm run site:dev` works without rendering anything.
 *
 * Nothing is vendored into git: everything under `--out` is generated
 * (gitignored) from `node_modules` and `test/render-fixtures/`.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES_DIR = join(REPO_ROOT, "test/render-fixtures/pages");
const TILES_DIR = join(REPO_ROOT, "test/render-fixtures/tiles");

/** Fixture table shared with the CI workflow's render steps. */
export const FIXTURES = [
  {
    id: "hires",
    title: "Canvas HiDPI dynamic resize",
    lib: "canvas 2d",
    page: "06-canvas-hires.html",
    pdf: "hires.pdf",
    log: "hires.log",
    probeName: "canvas-hires",
    marker: /resized=\[1200x600/
  },
  {
    id: "echarts",
    title: "Bar + line chart",
    lib: "echarts",
    page: "03-echarts.html",
    pdf: "echarts.pdf",
    log: "echarts.log",
    probeName: "echarts",
    marker: /resized=/
  },
  {
    id: "d3",
    title: "SVG bars + canvas scatter",
    lib: "d3",
    page: "04-d3.html",
    pdf: "d3.pdf",
    log: "d3.log",
    probeName: "d3",
    marker: /resized=/
  },
  {
    id: "three",
    title: "Mocked box scene (WebGL)",
    lib: "three.js",
    page: "02-threejs.html",
    pdf: "three.pdf",
    log: "three.log",
    probeName: "threejs",
    marker: /Document created/
  },
  {
    id: "osd",
    title: "Tiled image viewer",
    lib: "openseadragon",
    page: "05-openseadragon.html",
    pdf: "osd.pdf",
    log: "osd.log",
    probeName: "openseadragon",
    marker: /Document created/
  },
  {
    id: "iframe",
    title: "srcdoc + same-origin iframes",
    lib: "iframe",
    page: "01-iframe.html",
    pdf: "iframe.pdf",
    log: "iframe.log",
    probeName: "iframe",
    marker: /iframes=2/
  }
];

/** Vendor files copied from node_modules into the deploy artifact. */
export const VENDOR_FILES = [
  "three/build/three.module.js",
  "echarts/dist/echarts.min.js",
  "d3/dist/d3.min.js",
  "openseadragon/build/openseadragon/openseadragon.min.js"
];

export const VENDOR_DIRS = ["openseadragon/build/openseadragon/images"];

/**
 * Rewrites an input-page copy for the showcase base path: absolute
 * `/vendor/…` URLs (script src, importmap, OSD prefixUrl) become relative to
 * `fixtures/inputs/`. Tag order (importmap before module) is untouched.
 */
export function rewriteInputHtml(html) {
  return html.replaceAll('"/vendor/', '"../vendor/').replaceAll("'/vendor/", "'../vendor/");
}

/** True when a rewritten copy has no absolute vendor URL left. */
export function hasAbsoluteVendorUrl(html) {
  return html.includes('"/vendor/') || html.includes("'/vendor/");
}

export function parseWaitDetail(logText) {
  const match = /\[wait\] layout gate (\S+) after (\d+)ms(?: (\{.*\}))?/.exec(logText);
  if (match === null) return { gateState: null, reason: null, canvases: null, dpr: null };
  let detail = null;
  if (match[3] !== undefined) {
    try {
      detail = JSON.parse(match[3]);
    } catch {
      detail = null;
    }
  }
  return {
    gateState: match[1],
    reason: typeof detail?.reason === "string" ? detail.reason : null,
    canvases: typeof detail?.canvases === "string" && detail.canvases !== "" ? detail.canvases : null,
    dpr: typeof detail?.dpr === "number" ? detail.dpr : null
  };
}

/**
 * Parses one frame segment of a `[render] frames: …` line. Returns nulls when
 * the fixture's frame is absent (e.g. cross-origin embeds refusing evaluate).
 */
export function parseFramesSegment(logText, probeName) {
  const empty = { canvases: null, resized: null, webgl: null, webgl2: null, webgpu: null, iframeCount: null };
  const line = logText.split("\n").find((candidate) => candidate.includes("[render] frames:"));
  if (line === undefined) return empty;
  const segments = line
    .slice(line.indexOf("[render] frames:") + "[render] frames:".length)
    .split(" | ")
    .map((segment) => segment.trim());
  const segment = segments.find((candidate) => candidate === probeName || candidate.startsWith(`${probeName} `));
  if (segment === undefined) return empty;
  const get = (pattern) => {
    const hit = pattern.exec(segment);
    return hit === null ? null : hit[1];
  };
  const bool = (raw) => (raw === "true" ? true : raw === "false" ? false : null);
  const count = (raw) => (raw === null || raw === "" || !Number.isFinite(Number(raw)) ? null : Number(raw));
  return {
    canvases: get(/canvases=\[(.*?)\]/),
    resized: get(/resized=\[(.*?)\]/),
    webgl: bool(get(/webgl=(\w+)/)),
    webgl2: bool(get(/\/2=(\w+)/)),
    webgpu: bool(get(/webgpu=(\w+)/)),
    iframeCount: count(get(/iframes=(\d+)/))
  };
}

function copyInputs(outDir) {
  const inputsDir = join(outDir, "inputs");
  mkdirSync(inputsDir, { recursive: true });
  for (const name of readdirSync(PAGES_DIR)) {
    if (!name.endsWith(".html")) continue;
    const rewritten = rewriteInputHtml(readFileSync(join(PAGES_DIR, name), "utf-8"));
    if (hasAbsoluteVendorUrl(rewritten)) {
      throw new Error(`Unresolved absolute vendor URL in ${name}`);
    }
    writeFileSync(join(inputsDir, name), rewritten, "utf-8");
  }
}

function copyVendor(outDir) {
  for (const file of VENDOR_FILES) {
    const src = join(REPO_ROOT, "node_modules", file);
    if (!existsSync(src)) throw new Error(`Missing vendor file: ${file} (run npm install)`);
    const dest = join(outDir, "vendor", file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
  for (const dir of VENDOR_DIRS) {
    cpSync(join(REPO_ROOT, "node_modules", dir), join(outDir, "vendor", dir), { recursive: true });
  }
}

function nullEntry(fixture, inputHtml) {
  return {
    id: fixture.id,
    title: fixture.title,
    lib: fixture.lib,
    inputHtml,
    pdf: null,
    bytes: 0,
    pass: null,
    settleReason: null,
    canvases: null,
    resized: null,
    dpr: null,
    webgl: null,
    webgl2: null,
    webgpu: null,
    iframeCount: null,
    logExcerpt: ""
  };
}

function excerpt(logText) {
  const lines = logText.split("\n").filter((line) => line.includes("[wait] layout gate") || line.includes("[render] frames:"));
  return lines.join("\n").slice(0, 2000);
}

function collectReal(outDir, logsDir) {
  const entries = [];
  const failures = [];
  for (const fixture of FIXTURES) {
    const logPath = join(logsDir, fixture.log);
    const pdfPath = join(outDir, fixture.pdf);
    const entry = nullEntry(fixture, `fixtures/inputs/${fixture.page}`);
    if (!existsSync(logPath) || !existsSync(pdfPath)) {
      failures.push(`${fixture.id}: missing log or PDF`);
      entries.push(entry);
      continue;
    }
    const logText = readFileSync(logPath, "utf-8");
    const wait = parseWaitDetail(logText);
    const frame = parseFramesSegment(logText, fixture.probeName);
    const bytes = statSync(pdfPath).size;
    const markerOk = fixture.marker.test(logText);
    const sizeOk = bytes >= 15000;
    entry.pdf = `fixtures/${fixture.pdf}`;
    entry.bytes = bytes;
    entry.settleReason = wait.reason ?? wait.gateState;
    entry.canvases = wait.canvases ?? frame.canvases;
    entry.resized = frame.resized;
    entry.dpr = wait.dpr;
    entry.webgl = frame.webgl;
    entry.webgl2 = frame.webgl2;
    entry.webgpu = frame.webgpu;
    entry.iframeCount = frame.iframeCount;
    entry.logExcerpt = excerpt(logText);
    entry.pass = markerOk && sizeOk;
    if (entry.pass === false) failures.push(`${fixture.id}: marker=${markerOk} sizeOk=${sizeOk} (${bytes} bytes)`);
    entries.push(entry);
  }
  return { entries, failures };
}

function parseArgs(argv) {
  const opts = { out: join(REPO_ROOT, "site/public/fixtures"), logs: "", commit: null, runUrl: null, sample: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sample") opts.sample = true;
    else if ((arg === "--out" || arg === "--logs" || arg === "--commit" || arg === "--run-url") && i + 1 < argv.length) {
      i++;
      if (arg === "--out") opts.out = resolve(argv[i]);
      else if (arg === "--logs") opts.logs = resolve(argv[i]);
      else if (arg === "--commit") opts.commit = argv[i];
      else if (arg === "--run-url") opts.runUrl = argv[i];
    }
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  mkdirSync(opts.out, { recursive: true });
  copyInputs(opts.out);
  copyVendor(opts.out);
  cpSync(TILES_DIR, join(opts.out, "tiles"), { recursive: true });

  let entries;
  if (opts.sample) {
    entries = FIXTURES.map((fixture) => nullEntry(fixture, `fixtures/inputs/${fixture.page}`));
  } else {
    if (opts.logs === "") throw new Error("Missing required option: --logs <dir>");
    const { entries: real, failures } = collectReal(opts.out, opts.logs);
    entries = real;
    writeFileSync(
      join(opts.out, "manifest.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), commit: opts.commit, runUrl: opts.runUrl, fixtures: entries }, null, 2),
      "utf-8"
    );
    for (const entry of entries) {
      console.log(`${entry.pass === true ? "ok" : "FAIL"}: ${entry.id} (${entry.bytes} bytes, settle=${entry.settleReason ?? "?"})`);
    }
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL: ${failure}`);
      process.exitCode = 1;
      return;
    }
    return;
  }
  writeFileSync(
    join(opts.out, "manifest.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), commit: null, runUrl: null, fixtures: entries }, null, 2),
    "utf-8"
  );
  console.log(`sample manifest: ${entries.length} fixtures (no PDFs)`);
}

function isDirectExecution() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
