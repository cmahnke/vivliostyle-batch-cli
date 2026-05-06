# Vivliostyle CLI Wrapper

A powerful CLI wrapper for [Vivliostyle](https://vivliostyle.org/) with enhanced static asset handling and HTML parsing capabilities.

## Features

- Build PDF, EPUB, and WebPub output from HTML or publication manifests
- Preview documents in the browser with live reloading
- Automatic detection and mapping of static assets from HTML (`<link>`, `<script>`, `<img>`, etc.)
- Support for custom static asset mappings via `--static`
- Map external URLs (CDNs, etc.) to local directories using `--asset-base`
- Ignore specific assets with `--ignore-asset`
- Forward extra Vivliostyle options using `--`
- Debug mode with detailed logging
- Temporary file management and cleanup

## Installation

```bash
#npm install -g @vivliostyle/cli
npm install -g @projektemacher/vivliostyle-batch-cli
```

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

### Pass extra Vivliostyle options after `--`

```bash
vivliostyle-cli -i index.html -o output.pdf -- --timeout 60000 --debug
```

## Options

| Option | Description |
|--------|-------------|
| `-i, --input <input>` | Input HTML or publication manifest file (required) |
| `-o, --output <file>` | Output file path (default: `output.pdf`) |
| `--title <title>` | Document title (overrides source) |
| `--author <author>` | Document author |
| `--language <lang>` | Document language tag (e.g. `en`, `de`, `ja`) (default: `de`) |
| `--static <mapping>` | Map virtual path to local path: `/virtual/path:/local/path` (repeatable) |
| `--no-scripts` | Do not map `<script src>` tags as static assets (recommended for PDF builds) |
| `--asset-base <urlBase=localBase>` | Map URLs starting with `urlBase` to files under `localBase` (repeatable) |
| `--ignore-asset <path>` | Skip specific virtual paths when deriving static mappings (repeatable) |
| `--cwd <dir>` | Working directory for Vivliostyle (default: directory of `--input`) |
| `--format <format>` | Output format: `pdf`, `epub`, or `webpub` (default: `pdf`) |
| `--log-level <level>` | Log level: `silent`, `info`, `verbose`, or `debug` (default: `info`) |
| `--mode <mode>` | Execution mode: `build` or `preview` (default: `build`) |
| `--preview` | Shorthand for `--mode preview` — open result in browser |
| `-d, --debug` | Enable debug mode (sets log level to `debug`) |

## Notes

- HTML input (`.html`/`.htm`) is auto-detected by file extension.
- For HTML input, `<link href>` and `<script src>` tags are parsed and automatically mapped.
- Options after `--` are forwarded verbatim to Vivliostyle.
- `--debug` automatically sets `--log-level` to `debug`.
- `--preview` and `--mode preview` are equivalent.
- In **preview mode**, Vivliostyle serves everything via its own Vite server.
- In **build mode**, an Express server is started to serve assets.
- `--asset-base` local directories are also used as fallback roots for CSS-referenced assets (fonts, images, etc.).

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

# Pass extra Vivliostyle options after --
vivliostyle-cli -i index.html -o output.pdf -- --timeout 60000
```

## License

MIT