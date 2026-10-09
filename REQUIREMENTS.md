# Requirements — vivliostyle-batch-cli

Feature summary of what the CLI does today. This is the contract new changes
must keep; it is extracted from `README.md`, `src/` and `test/`.

## 1. Purpose

Batch-oriented wrapper around [Vivliostyle](https://vivliostyle.org/) that
renders HTML pages to PDF with full control over where assets come from. It
runs the Vivliostyle viewer in Chrome and prints the rendered page to PDF.
Nothing is downloaded or installed at render time beyond the browser found on
the machine.

## 2. Input and output

- Accepts an HTML file via `-i, --input` (auto-detected by `.html`/`.htm`
  extension); output defaults to `output.pdf` (`-o, --output`).
- Output format is PDF only (`--format pdf`); other values are rejected.
- Stamps PDF metadata: `--title`, `--author`, `--language` (default `de`);
  producer/creator are `vivliostyle-batch-cli`.
- Two modes: `build` (default, writes PDF) and `preview` (`--preview` /
  `--mode preview`, serves the document and opens the viewer URL in a browser).

## 3. Rendering engine (real browser → PDF)

- Serves the rewritten document, mapped assets and the stock Vivliostyle viewer
  from a local HTTP server; the viewer page sits in the document's own
  directory so page-relative URLs resolve like on the live site.
- Prints with Chrome headless `page.pdf()` using `printBackground: true`,
  `preferCSSPageSize: true`, `tagged: true`, zero margins.
- Print media is emulated **before** the document loads, so JS-driven
  containers measure their print size instead of `0x0`.
- Waits for `coreViewer !== undefined` and `coreViewer.readyState ===
"complete"` before printing.
- Renders with the real engine, so canvas charts, WebGL scenes and
  cross-origin iframes end up in the PDF as they appear on screen (rasterized,
  must stay sharp — see §4). A frame needing interaction or cookies shows what
  an anonymous visitor would see.
- Software rendering is best-effort without a GPU: Chrome flags include
  `--enable-unsafe-swiftshader`, `--use-angle=swiftshader`,
  `--enable-unsafe-webgpu`; WebGPU absence is logged, not fatal.
- Before printing, every frame is probed: embeds are scrolled into view (so
  out-of-process iframes rasterize), capabilities (`webgl/webgl2/webgpu`,
  canvas sizes, iframe count, `devicePixelRatio`) are logged, and pages
  exposing `window.__vivResize(factor)` are redrawn at HiDPI backing
  resolution. Failures here warn and continue, never block the PDF.

## 4. Resolution (sharp past 96dpi)

- `--pixel-ratio <n>` forwards Vivliostyle `pixelRatio=n`: layout keeps its CSS
  size while raster resolution increases (removes canvas/WebGL pixelation).
- The same factor drives the pre-print canvas upscale: pages implementing
  `window.__vivResize(factor)` redraw `clientSize × factor` backing pixels
  (e.g. `600px` CSS → `1200px` canvas at `--pixel-ratio 2`); CSS size and
  pagination are unchanged. Factors `<= 1` skip the step.
- Generic canvases without the hook are never blindly resized (that would blank
  WebGL without `preserveDrawingBuffer`); a `resize` event is dispatched so
  chart libraries can re-layout themselves.
- Synthetic proof: `test/render-fixtures/pages/06-canvas-hires.html` draws a
  1px grid + hairline and asserts `1200x600` backing pixels at factor 2.

## 5. Async content readiness

- `--wait-for-content [ms]` injects a gate image (`/__viv-settle`) that the
  server holds open until the page reports settled; Vivliostyle waits for
  document images before paginating, so layout is postponed until charts and
  canvases painted. Hard limit capped at 25000ms (Vivliostyle gives up on
  images after 30s).
- Tracker wraps `fetch`/XHR, watches `iframe` load/error (+3s grace),
  `MutationObserver` + `ResizeObserver`; signals `quiet` (no request in flight,
  no pending frames, height stable for `--quiet-ms`, default 400ms),
  `ready` (page set `window.__vivReady === true` with no pending work — used by
  deterministic chart/WebGL/OSD pages), or `deadline`.
- Settle detail logs `devicePixelRatio`, canvas sizes
  (`widthxheight@clientW×clientH`), painted-canvas count, container sizes,
  `pending/frames/mutations` — making resolution problems visible.
- `--timeout <ms>` (default 300000) bounds the whole render; lower it for
  embeds that never finish. `--quiet-ms <ms>` tunes the quiet period.
- Collapsed `<details>` are auto-opened for the PDF (now + via
  `MutationObserver` + per layout tick); preview stays interactive.

## 6. Assets and offline behavior

- Automatic detection and mapping of static assets from HTML (`<link>`,
  `<script>`, `<img>`, `<source>`, `<video>`, `poster`, `srcset`, `<iframe>`,
  `<object>`, `<embed>`, `a-asset-item`, etc.).
- `--static /virtual:/local` maps virtual paths to local files (repeatable);
  duplicates warn, missing targets warn.
- `--asset-base <urlBase>=<localBase>` maps absolute URLs (CDNs, site origin)
  to local directories (repeatable); local roots double as fallback for
  CSS-referenced fonts/images. Root-only URLs (no sub-path) are skipped with a
  precise message.
- `--ignore-asset <path>` skips virtual paths when deriving mappings.
- `--no-scripts` excludes `<script src>` from auto-mapping (avoids JS
  identifier clashes in the viewer for PDF builds).
- Offline by default: subresource references without a local file are removed
  and reported as `[offline] Dropped remote reference: <url>`; hyperlinks
  (`<a href>`) and meta-refresh to local targets are never touched, remote
  meta-refresh stubs are dropped.
- `--allow-remote` / `--fetch-missing` keeps/loads missing references from the
  mapped origin via server redirect (nothing written to input dir);
  `--fetch-missing` HEAD-probes remote refs and drops only definite 404/410,
  never probing refs that resolve locally.
- Unserved root-relative paths are reported as warnings
  (`reference is not available and will not resolve`).
- `--dump-html <dir>` writes the rewritten input HTML there and keeps it
  (debugging aid); otherwise temp files are cleaned up.

## 7. Viewer passthrough and modes

- Options after `--` are forwarded to the viewer as-is; `--size`, `--style`,
  `--user-style`, `--viewer-param key=value` become viewer parameters;
  `--timeout`/`--executable-browser` map to render options. Short flags after
  `--` warn and are ignored.
- Preview serves the rewritten document next to the viewer (`renderAllPages:
false`) and returns the viewer URL; build renders all pages to PDF.
- Page scripts' relative requests are routed to the local server via runtime
  URL patching (`fetch`, `XHR`, `Image/Audio`, `src` setters, `baseURI`).

## 8. Browser resolution

- `--executable-browser <path>` overrides; otherwise search order is
  `CHROME_PATH` env → puppeteer cache (`~/.cache/puppeteer`) → system
  Chrome/Chromium. Missing browser is a hard error with install hint.
- Extra Chrome args append to the hardened default set (field-trial/cache
  disabled, `disable-web-security`, `hide-scrollbars`, `mute-audio`,
  `force-device-scale-factor=1`).

## 9. Observability

- `--log-level silent|info|verbose|debug` (default `info`); `-d, --debug`
  forces `debug` (trace diagnostics to stderr, progress to stdout).
- `--dump-html` + `--debug` show rewritten HTML, resolved mappings, viewer URL,
  settle detail and per-frame capability lines (`[render] frames: …`).

## 10. Synthetic render fixtures (test contract)

- `test/render-fixtures/pages/`: `01-iframe.html` (srcdoc + same-origin child),
  `02-threejs.html` (mocked box, importmap → `/vendor/three`, freeze after one
  frame), `03-echarts.html` (mocked bar+line, canvas, `animation:false`),
  `04-d3.html` (mocked SVG bars + canvas scatter), `05-openseadragon.html`
  (mocked local single-image source), `06-canvas-hires.html` (dynamic-resize
  proof). All data inline/mocked; no network.
- Libraries are resolved from `node_modules` (`three`, `echarts`, `d3`,
  `openseadragon` devDependencies) via `/vendor/*` → `--static` mappings at
  test runtime; nothing is vendored into the repo. `docs/` is gitignored scratch
  data and must not be referenced.
- Fixture contract: deterministic, fixed print-safe container sizes,
  `break-inside: avoid`, `window.__vivReady/__vivFixture` set when painted,
  `window.__vivResize(factor)` where resolution-dependent.

## 11. Showcase site (GitHub Pages)

- `site/` is a Vite app: one card per fixture with the input page in a
  sandboxed iframe (`allow-scripts allow-same-origin`, no top navigation),
  the rendered PDF embedded, plus metrics (bytes, settle reason, canvas
  sizes, DPR, GPU flags) and the render-log excerpt.
- `site/collect-manifest.mjs` stages `site/public/fixtures/` (generated,
  gitignored): input copies with absolute `/vendor/` URLs rewritten to
  relative, vendor builds + OSD images copied from `node_modules`, tiles
  copied from `test/`, and `manifest.json` parsed from render logs. Exits
  non-zero when a marker or PDF is missing. `--sample` writes placeholder
  entries for `npm run site:dev`.
- CI (`render-fixtures` job) renders all fixtures to PDF, collects the
  manifest, builds the site and uploads the Pages artifact; `deploy-site`
  (push-gated) publishes it on every `main` push. PRs run the render checks
  without deploying.
