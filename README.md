# Vivliostyle Batch CLI

A batch-oriented wrapper around [Vivliostyle](https://vivliostyle.org/) that renders HTML pages to PDF with full control over where their assets come from.

It runs the [Vivliostyle viewer](https://www.npmjs.com/package/@vivliostyle/viewer) in Chrome and prints the rendered page to PDF. Nothing is downloaded or installed at render time beyond the browser it finds on the machine.

## Features

- Build PDF output from an HTML file
- Preview documents in the browser
- Render with the real browser engine, so canvas charts, WebGL scenes and cross-origin iframes end up in the PDF
- Stay sharp past 96dpi: `--pixel-ratio` redraws JS-painted content at higher backing resolution
- Per-push showcase page (GitHub Pages) with the render fixtures next to their PDFs
- Automatic detection and mapping of static assets from HTML (`<link>`, `<script>`, `<img>`, etc.)
- Support for custom static asset mappings via `--static`
- Map external URLs (CDNs, etc.) to local directories using `--asset-base`
- Ignore specific assets with `--ignore-asset`
- Forward extra viewer options using `--`
- Debug mode with detailed logging
- Temporary file management and cleanup

## Installation

```bash
npm install -g @projektemacher/vivliostyle-batch-cli
```

Rendering needs a Chrome or Chromium binary. The CLI looks for a browser cached by `puppeteer` (`~/.cache/puppeteer`), then for a system installation; `--executable-browser <path>` overrides the search.

## Usage

### Build a PDF from an HTML file

```bash
vivliostyle-cli -i index.html -o output.pdf
```

### Preview an HTML file in the browser

```bash
vivliostyle-cli -i index.html --preview
```

### Build with custom static asset mappings

```bash
vivliostyle-cli -i index.html -o output.pdf \
  --static /assets:/home/user/project/assets \
  --static /fonts:/home/user/project/fonts
```

### Map an external CDN URL to a local cache

```bash
vivliostyle-cli -i index.html -o output.pdf \
  --asset-base https://cdn.example.com/=/home/user/cdn-cache
```

### Pass extra viewer options after `--`

```bash
vivliostyle-cli -i index.html -o output.pdf -- --size A4 --viewer-param pixelRatio=2
```

## Options

| Option                              | Description                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `-i, --input <input>`               | Input HTML or publication manifest file (required)                                                                  |
| `-o, --output <file>`               | Output file path (default: `output.pdf`)                                                                            |
| `--title <title>`                   | Document title (overrides source)                                                                                   |
| `--author <author>`                 | Document author                                                                                                     |
| `--language <lang>`                 | Document language tag (e.g. `en`, `de`, `ja`) (default: `de`)                                                       |
| `--static <mapping>`                | Map virtual path to local path: `/virtual/path:/local/path` (repeatable)                                            |
| `--no-scripts`                      | Do not map `<script src>` tags as static assets                                                                     |
| `--asset-base <urlBase=localBase>`  | Map URLs starting with `urlBase` to files under `localBase` (repeatable)                                            |
| `--ignore-asset <path>`             | Skip specific virtual paths when deriving static mappings (repeatable)                                              |
| `--allow-remote`                    | Keep subresource references that would be fetched from the network (default: drop)                                  |
| `--executable-browser <path>`       | Chrome/Chromium binary to render with (default: search puppeteer cache, then system)                                |
| `--dump-html <dir>`                 | Write the rewritten input HTML into `<dir>` and keep it (debugging aid)                                             |
| `--fetch-missing`                   | Load references without a local file from the web (implies `--allow-remote`; drops gone remotes after a HEAD probe) |
| `--wait-for-content [ms]` --------- | Delay pagination until the page finished its own async work (default limit 25000ms)                                 |
| `--quiet-ms <ms>` ----------------- | Quiet period before the layout gate opens (default 400) ---------------------------                                 |
| `--pixel-ratio <n>` --------------- | Render at `n` times the output resolution; redraws `__vivResize` pages at `n`× backing pixels                       |
| `--timeout <ms>` ------------------ | Give up on a page after `<ms>` (default: 300000) ---------------------------------                                  |
| `--format <format>`                 | Output format: `pdf` (default: `pdf`)                                                                               |
| `--log-level <level>`               | Log level: `silent`, `info`, `verbose`, or `debug` (default: `info`)                                                |
| `--mode <mode>`                     | Execution mode: `build` or `preview` (default: `build`)                                                             |
| `--preview`                         | Shorthand for `--mode preview` — open result in browser                                                             |
| `-d, --debug`                       | Enable debug mode (sets log level to `debug`)                                                                       |

## Notes

- HTML input (`.html`/`.htm`) is auto-detected by file extension.
- For HTML input, `<link href>` and `<script src>` tags are parsed and automatically mapped.
- Everything else the document references (`<img src>`, `<source>`, `<iframe>`, `srcset`, …) is rewritten to the local static server as well, so only files from `--static` / `--asset-base` roots are ever loaded.
- **Offline by default**: any subresource reference without a local file is removed from the document and reported as `[offline] Dropped remote reference: <url>`. Use `--allow-remote` to keep them and let the browser fetch them. Hyperlinks (`<a href>`) are never touched — a link is not a fetch.
- Options after `--` are forwarded to the viewer as-is; `--size`, `--style`, `--user-style` and `--viewer-param key=value` are turned into viewer parameters.
- `--debug` automatically sets `--log-level` to `debug`.
- `--preview` and `--mode preview` are equivalent.
- Both modes run a local HTTP server that serves the rewritten document, the mapped assets and the stock Vivliostyle viewer. The viewer page sits in the document's own directory, so URLs that page scripts build from relative paths resolve the way they do on the live site.
- `--asset-base` local directories are also used as fallback roots for CSS-referenced assets (fonts, images, etc.).
- `--dump-html` keeps the rewritten HTML outside the input directory, which is handy when a page does not render as expected.
- `--wait-for-content` injects a gate image that the static server holds open until the page has no request in flight and its height stopped changing. Vivliostyle waits for every image of a document before it paginates, so this postpones the layout until charts and canvases are rendered. The tracker also logs `devicePixelRatio` and the canvas sizes, which makes resolution problems visible.
- Pages that paint asynchronously can set `window.__vivReady = true` when done; the layout gate and the renderer treat it as an immediate “painted” signal instead of guessing from network quietness.
- Pages with resolution-dependent content (canvas, WebGL) can expose `window.__vivResize = (factor) => void` to redraw at `clientSize × factor` backing pixels. `--pixel-ratio <n>` calls that hook with `n` before printing, so output past 96dpi stays sharp while layout keeps its CSS size. Without the hook a `resize` event is still dispatched so chart libraries can re-layout.
- `--fetch-missing` HEADs every remote reference without a local file and drops the ones that are definitively gone (404/410), so retired embeds do not stall the build. A reference that resolves to a local file is never probed: the live site may have moved on while the local copy still has what the page needs.
- Collapsed `<details>` elements are opened for the PDF. Vivliostyle loads the page's scripts itself and only re-dispatches `DOMContentLoaded` on the window, so the print scripts that expand collapsible content never run. The preview is left untouched.
- Print media is active before the document loads, otherwise JS-driven containers are measured as `0x0` and charts stay empty.
- Every push to `main` publishes a showcase page (GitHub Pages): a landing page rendering this README next to the synthetic fixtures from `test/render-fixtures/` and the PDFs CI rendered from them — input iframe on the left, output PDF, settle reason and canvas sizes on the right. Build it locally with `npm run site:dev` (sample data) or render first and run `npm run site:collect && npm run site:build`.

### Converting a built website

```bash
vivliostyle-cli -i docs/post/example/article.html -o pdf/example.pdf \
  --asset-base "https://example.com/=$PWD/docs" \
  --static "/:$PWD/docs" \
  --language en
```

`--asset-base` maps every absolute URL below `https://example.com/` to the local build output. Use `--dump-html tmp/` to inspect the rewritten document, and `--debug` to see every resolved mapping.

For pages whose content JavaScript builds (charts, WebGL viewers, PDF viewers):

```bash
vivliostyle-cli -i docs/post/example/article.html -o pdf/example.pdf \
  --asset-base "https://example.com/=$PWD/docs" \
  --wait-for-content 12000 --fetch-missing --timeout 150000 --pixel-ratio 2
```

Cross-origin iframes are printed by the browser as they appear on screen, so maps and video players that render for a visitor render in the PDF as well. A frame that needs interaction (or refuses to load without cookies) shows what a visitor without that state would see.

## Examples

```bash
# Build a PDF from an HTML file
vivliostyle-cli -i index.html -o output.pdf

# Preview an HTML file in browser
vivliostyle-cli -i index.html --preview

# Build with explicit static asset mapping
vivliostyle-cli -i index.html -o output.pdf \
  --static /assets:/dist/assets --static /fonts:/dist/fonts

# Map an absolute CDN URL to a local directory
vivliostyle-cli -i index.html -o output.pdf \
  --asset-base https://cdn.example.com/=/home/user/cdn-cache

# Pass extra viewer options after --
vivliostyle-cli -i index.html -o output.pdf -- --size A4
```

## License

MIT
