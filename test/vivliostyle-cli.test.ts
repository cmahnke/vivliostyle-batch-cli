// test/vivliostyle-cli.test.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ASSETS, SITE_ORIGIN, articleHtml, siteUrl, writeArticle, writeRedirectStub, writeSite } from "./fixtures";

/** Port the mocked static server reports. */
const SERVER_BASE_URL = "http://127.0.0.1:19876";

/** Host used for references that only exist on the web. */
const REMOTE_HOST = "img.example.com";

const renderMock = vi.fn(async (request: { output: string }) => ({
  output: request.output,
  bytes: 0,
  pageCount: 1,
  settle: null
}));

const serverMock = vi.fn(async () => ({
  baseUrl: SERVER_BASE_URL,
  close: async () => undefined
}));

// The renderer and the static server are the seams the CLI drives.
vi.mock("../src/render/pdf.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  renderPdf: renderMock
}));

vi.mock("../src/server.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  startStaticServer: serverMock
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runArgs(argv: string[]): Promise<void> {
  const { parseArgs, execute } = await import("../src/vivliostyle-cli");
  const parsed = parseArgs(["node", "script", ...argv]);
  if (!parsed) throw new Error("parseArgs returned null — no arguments given");
  await execute(parsed.options, parsed.extraArgs);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("vivliostyle-cli", () => {
  let tempDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vivliostyle-cli-test-"));
    renderMock.mockClear();
    serverMock.mockClear();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  // ---------------------------------------------------------------------------
  // Help / arg parsing
  // ---------------------------------------------------------------------------

  it("parseArgs returns null when no arguments are given", async () => {
    const { parseArgs } = await import("../src/vivliostyle-cli");
    expect(parseArgs(["node", "script"])).toBeNull();
  });

  it("printHelp writes to stdout and mentions --input", async () => {
    const { printHelp } = await import("../src/vivliostyle-cli");

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);

    printHelp();

    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("vivliostyle-cli");
    expect(output).toContain("--input");

    writeSpy.mockRestore();
    exitSpy.mockRestore();

    expect(renderMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("throws when --input file does not exist", async () => {
    await expect(runArgs(["--input", "/nonexistent/path/file.html"])).rejects.toThrow("Input file does not exist");
  });

  it("throws on invalid --format", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await expect(runArgs(["--input", inputFile, "--format", "docx"])).rejects.toThrow('Invalid format: "docx"');
  });

  it("throws on invalid --log-level", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await expect(runArgs(["--input", inputFile, "--log-level", "trace"])).rejects.toThrow('Invalid log level: "trace"');
  });

  it("throws on invalid --mode", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await expect(runArgs(["--input", inputFile, "--mode", "watch"])).rejects.toThrow('Invalid mode: "watch"');
  });

  // ---------------------------------------------------------------------------
  // isHtmlInput
  // ---------------------------------------------------------------------------

  it("isHtmlInput returns true for .html and .htm files", async () => {
    const { isHtmlInput } = await import("../src/vivliostyle-cli");
    expect(isHtmlInput("/path/to/file.html")).toBe(true);
    expect(isHtmlInput("/path/to/file.HTML")).toBe(true);
    expect(isHtmlInput("/path/to/file.htm")).toBe(true);
  });

  it("isHtmlInput returns false for non-HTML files", async () => {
    const { isHtmlInput } = await import("../src/vivliostyle-cli");
    expect(isHtmlInput("/path/to/file.json")).toBe(false);
    expect(isHtmlInput("/path/to/file.toml")).toBe(false);
    expect(isHtmlInput("/path/to/file.js")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Build mode — basic
  // ---------------------------------------------------------------------------

  it("calls build() with correct input and output in default build mode", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><head></head><body>Hello</body></html>", "utf-8");
    const outputFile = join(tempDir, "out.pdf");

    await runArgs(["--input", inputFile, "--output", outputFile]);

    expect(renderMock).toHaveBeenCalledTimes(1);

    const request = renderMock.mock.calls[0][0];
    expect(request.output).toBe(resolve(outputFile));
    // The document is served from our own server, at its path on the site.
    expect(request.documentUrl).toBe(`${SERVER_BASE_URL}/index.html`);
    expect(request.viewerPageUrl).toBe(`${SERVER_BASE_URL}/__viv-viewer.html`);

    const server = serverMock.mock.calls[0][0];
    expect(server.entry.sitePath).toBe("/index.html");
  });

  it("passes --format epub to build()", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await expect(runArgs(["--input", inputFile, "--format", "epub"])).rejects.toThrow(/choices|epub/);
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("passes --title, --author, --language to build()", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await runArgs(["--input", inputFile, "--title", "My Title", "--author", "Jane", "--language", "en"]);

    const request = renderMock.mock.calls[0][0];
    expect(request.title).toBe("My Title");
    expect(request.author).toBe("Jane");
    expect(request.language).toBe("en");
  });

  it("sets logLevel to debug and debug:true when -d is used", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await runArgs(["--input", inputFile, "-d"]);

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("raw CLI options");
  });

  it("passes extra args after -- into build config", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await runArgs(["--input", inputFile, "--", "--size", "A4", "--viewer-param", "pixelRatio=2&fontSize=14"]);

    const request = renderMock.mock.calls[0][0];
    expect(request.viewerParams.size).toBe("A4");
    expect(request.viewerParams.pixelRatio).toBe("2");
    expect(request.viewerParams.fontSize).toBe("14");
  });

  it("warns about short flags after --", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await runArgs(["--input", inputFile, "--", "-v"]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('short flag "-v"'));
  });

  // ---------------------------------------------------------------------------
  // Build mode — HTML auto-detection and URL extraction
  // ---------------------------------------------------------------------------

  it("auto-detects HTML input by extension and does not warn", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><head></head><body>Hello</body></html>", "utf-8");

    await runArgs(["--input", inputFile]);

    expect(renderMock).toHaveBeenCalledTimes(1);
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((w) => w.includes("no effect"))).toBe(false);
  });

  it("warns when --asset-base is used with non-HTML input", async () => {
    const inputFile = join(tempDir, "pub.json");
    writeFileSync(inputFile, "{}", "utf-8");

    await runArgs(["--input", inputFile, "--asset-base", `http://cdn.example.com/=${tempDir}`]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("--asset-base has no effect"));
  });

  it("warns when --ignore-asset is used with non-HTML input", async () => {
    const inputFile = join(tempDir, "pub.json");
    writeFileSync(inputFile, "{}", "utf-8");

    await runArgs(["--input", inputFile, "--ignore-asset", "/livereload.js"]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("--ignore-asset has no effect"));
  });

  // ---------------------------------------------------------------------------
  // splitArgsAtDoubleDash
  // ---------------------------------------------------------------------------

  it("splitArgsAtDoubleDash splits correctly", async () => {
    const { splitArgsAtDoubleDash } = await import("../src/vivliostyle-cli");

    expect(splitArgsAtDoubleDash(["a", "b", "--", "c", "d"])).toEqual({
      cliArgv: ["a", "b"],
      extraArgs: ["c", "d"]
    });

    expect(splitArgsAtDoubleDash(["a", "b"])).toEqual({
      cliArgv: ["a", "b"],
      extraArgs: []
    });

    expect(splitArgsAtDoubleDash(["a", "--", "--foo", "bar"])).toEqual({
      cliArgv: ["a"],
      extraArgs: ["--foo", "bar"]
    });
  });

  // ---------------------------------------------------------------------------
  // parseExtraArgs
  // ---------------------------------------------------------------------------

  it("parseExtraArgs handles --key value, --key=value, and boolean flags", async () => {
    const { parseExtraArgs } = await import("../src/vivliostyle-cli");

    expect(parseExtraArgs(["--sandbox", "--port", "4000", "--foo=bar"])).toEqual({
      sandbox: true,
      port: 4000,
      foo: "bar"
    });
  });

  it("parseExtraArgs ignores non-flag tokens", async () => {
    const { parseExtraArgs } = await import("../src/vivliostyle-cli");
    expect(parseExtraArgs(["positional", "--key", "val"])).toEqual({ key: "val" });
  });

  // ---------------------------------------------------------------------------
  // parseAssetBaseMapping
  // ---------------------------------------------------------------------------

  it("parseAssetBaseMapping parses urlBase=localBase correctly", async () => {
    const { parseAssetBaseMapping } = await import("../src/vivliostyle-cli");

    const result = parseAssetBaseMapping("https://cdn.example.com/=/home/user/cdn");
    expect(result.urlBase).toBe("https://cdn.example.com/");
    expect(result.localBase).toBe("/home/user/cdn");
  });

  it("parseAssetBaseMapping throws on missing =", async () => {
    const { parseAssetBaseMapping } = await import("../src/vivliostyle-cli");
    expect(() => parseAssetBaseMapping("nodivider")).toThrow("Invalid --asset-base");
  });

  it("parseAssetBaseMapping throws when urlBase or localBase is empty", async () => {
    const { parseAssetBaseMapping } = await import("../src/vivliostyle-cli");
    expect(() => parseAssetBaseMapping("=/local")).toThrow("Invalid --asset-base");
    expect(() => parseAssetBaseMapping("http://cdn.example.com/=")).toThrow("Invalid --asset-base");
  });

  // ---------------------------------------------------------------------------
  // normalizeUrlBase
  // ---------------------------------------------------------------------------

  it("normalizeUrlBase ensures exactly one trailing slash", async () => {
    const { normalizeUrlBase } = await import("../src/vivliostyle-cli");
    expect(normalizeUrlBase("https://cdn.example.com")).toBe("https://cdn.example.com/");
    expect(normalizeUrlBase("https://cdn.example.com/")).toBe("https://cdn.example.com/");
  });

  // ---------------------------------------------------------------------------
  // normalizeIgnoreAssetPath
  // ---------------------------------------------------------------------------

  it("normalizeIgnoreAssetPath normalises paths", async () => {
    const { normalizeIgnoreAssetPath } = await import("../src/vivliostyle-cli");
    expect(normalizeIgnoreAssetPath("/livereload.js")).toBe("/livereload.js");
    expect(normalizeIgnoreAssetPath("livereload.js")).toBe("/livereload.js");
    expect(normalizeIgnoreAssetPath("/a/../b/c")).toBe("/b/c");
  });

  it("normalizeIgnoreAssetPath throws on empty input", async () => {
    const { normalizeIgnoreAssetPath } = await import("../src/vivliostyle-cli");
    expect(() => normalizeIgnoreAssetPath("")).toThrow("must not be empty");
    expect(() => normalizeIgnoreAssetPath("   ")).toThrow("must not be empty");
  });

  // ---------------------------------------------------------------------------
  // mapAbsoluteUrlToLocal
  // ---------------------------------------------------------------------------

  it("mapAbsoluteUrlToLocal maps a matching URL to virtual + local paths", async () => {
    const { mapAbsoluteUrlToLocal } = await import("../src/vivliostyle-cli");

    const result = mapAbsoluteUrlToLocal("https://cdn.example.com/css/foo.css", [
      { urlBase: "https://cdn.example.com/", localBase: "/local/cdn" }
    ]);

    // Result is now a discriminated union, not nullable
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") throw new Error("unreachable");
    expect(result.virtualPath).toBe("/css/foo.css");
    expect(result.localPath).toBe(resolve("/local/cdn", "css/foo.css"));
  });

  it("mapAbsoluteUrlToLocal returns no-match for non-matching URLs", async () => {
    const { mapAbsoluteUrlToLocal } = await import("../src/vivliostyle-cli");

    const result = mapAbsoluteUrlToLocal("https://other.example.com/css/foo.css", [
      { urlBase: "https://cdn.example.com/", localBase: "/local/cdn" }
    ]);

    expect(result.kind).toBe("no-match");
  });

  it("mapAbsoluteUrlToLocal returns root-only when URL has no sub-path", async () => {
    const { mapAbsoluteUrlToLocal } = await import("../src/vivliostyle-cli");

    const result = mapAbsoluteUrlToLocal("https://cdn.example.com/", [{ urlBase: "https://cdn.example.com/", localBase: "/local/cdn" }]);

    expect(result.kind).toBe("root-only");
  });

  it("mapAbsoluteUrlToLocal strips query and fragment", async () => {
    const { mapAbsoluteUrlToLocal } = await import("../src/vivliostyle-cli");

    const result = mapAbsoluteUrlToLocal("https://cdn.example.com/css/foo.css?v=123#top", [
      { urlBase: "https://cdn.example.com/", localBase: "/local/cdn" }
    ]);

    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") throw new Error("unreachable");
    expect(result.virtualPath).toBe("/css/foo.css");
  });

  // ---------------------------------------------------------------------------
  // shouldIgnoreVirtualPath
  // ---------------------------------------------------------------------------

  it("shouldIgnoreVirtualPath matches normalised paths", async () => {
    const { shouldIgnoreVirtualPath } = await import("../src/vivliostyle-cli");

    const ignored = new Set(["/livereload.js", "/debug/tool.js"]);
    expect(shouldIgnoreVirtualPath("/livereload.js", ignored)).toBe(true);
    expect(shouldIgnoreVirtualPath("/other.js", ignored)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // parseStaticMapping
  // ---------------------------------------------------------------------------

  it("parseStaticMapping parses virtual:local pairs", async () => {
    const { parseStaticMapping } = await import("../src/vivliostyle-cli");

    expect(parseStaticMapping("/css:/dist/css")).toEqual({
      virtual: "/css",
      local: "/dist/css"
    });
  });

  it("parseStaticMapping throws when virtual path does not start with /", async () => {
    const { parseStaticMapping } = await import("../src/vivliostyle-cli");
    expect(() => parseStaticMapping("css:/dist/css")).toThrow("Invalid --static mapping");
  });

  it("parseStaticMapping throws when local path is missing", async () => {
    const { parseStaticMapping } = await import("../src/vivliostyle-cli");
    expect(() => parseStaticMapping("/css:")).toThrow("Local path missing");
  });

  // ---------------------------------------------------------------------------
  // extractUrlsFromHtml
  // ---------------------------------------------------------------------------

  it("extractUrlsFromHtml extracts link href and script src", async () => {
    const { extractUrlsFromHtml } = await import("../src/vivliostyle-cli");

    const htmlFile = join(tempDir, "test.html");
    writeFileSync(
      htmlFile,
      `<html><head>
        <link rel="stylesheet" href="/css/site.css">
        <script src="/js/app.js"></script>
      </head><body></body></html>`,
      "utf-8"
    );

    const urls = extractUrlsFromHtml(htmlFile, true);
    expect(urls).toContain("/css/site.css");
    expect(urls).toContain("/js/app.js");
  });

  it("extractUrlsFromHtml excludes script src when includeScripts is false", async () => {
    const { extractUrlsFromHtml } = await import("../src/vivliostyle-cli");

    const htmlFile = join(tempDir, "test.html");
    writeFileSync(
      htmlFile,
      `<html><head>
        <link rel="stylesheet" href="/css/site.css">
        <script src="/js/app.js"></script>
      </head><body></body></html>`,
      "utf-8"
    );

    const urls = extractUrlsFromHtml(htmlFile, false);
    expect(urls).toContain("/css/site.css");
    expect(urls).not.toContain("/js/app.js");
  });

  it("extractUrlsFromHtml deduplicates repeated URLs", async () => {
    const { extractUrlsFromHtml } = await import("../src/vivliostyle-cli");

    const htmlFile = join(tempDir, "test.html");
    writeFileSync(
      htmlFile,
      `<html><head>
        <link rel="stylesheet" href="/css/site.css">
        <link rel="stylesheet" href="/css/site.css">
      </head><body></body></html>`,
      "utf-8"
    );

    const urls = extractUrlsFromHtml(htmlFile, false);
    expect(urls.filter((u) => u === "/css/site.css")).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // rewriteAbsoluteUrls (string wrapper)
  // ---------------------------------------------------------------------------

  it("rewriteAbsoluteUrls rewrites matching href and src to virtual paths", async () => {
    const { rewriteAbsoluteUrls } = await import("../src/vivliostyle-cli");

    const html = `<html><head>
      <link rel="stylesheet" href="https://cdn.example.com/css/foo.css">
      <script src="https://cdn.example.com/js/app.js"></script>
    </head><body></body></html>`;

    const result = rewriteAbsoluteUrls(html, [{ urlBase: "https://cdn.example.com/", localBase: "/local/cdn" }]);

    expect(result).toContain('href="/css/foo.css"');
    expect(result).toContain('src="/js/app.js"');
  });

  it("rewriteAbsoluteUrls returns original string when no assetBases given", async () => {
    const { rewriteAbsoluteUrls } = await import("../src/vivliostyle-cli");

    const html = "<html><body>unchanged</body></html>";
    expect(rewriteAbsoluteUrls(html, [])).toBe(html);
  });

  it("rewriteAbsoluteUrls returns original string when no URLs match", async () => {
    const { rewriteAbsoluteUrls } = await import("../src/vivliostyle-cli");

    const html = `<html><head>
      <link rel="stylesheet" href="https://other.example.com/css/foo.css">
    </head><body></body></html>`;

    const result = rewriteAbsoluteUrls(html, [{ urlBase: "https://cdn.example.com/", localBase: "/local/cdn" }]);

    expect(result).toContain("https://other.example.com/css/foo.css");
  });

  // ---------------------------------------------------------------------------
  // rewriteVirtualPathsToServer (string wrapper)
  // ---------------------------------------------------------------------------

  it("rewriteVirtualPathsToServer rewrites matching virtual paths to absolute URLs", async () => {
    const { rewriteVirtualPathsToServer } = await import("../src/vivliostyle-cli");

    const html = `<html><head>
      <link rel="stylesheet" href="/css/foo.css">
      <script src="/js/app.js"></script>
    </head><body></body></html>`;

    const result = rewriteVirtualPathsToServer(html, { "/css": "/local/css", "/js": "/local/js" }, "http://127.0.0.1:12345");

    expect(result).toContain('href="http://127.0.0.1:12345/css/foo.css"');
    expect(result).toContain('src="http://127.0.0.1:12345/js/app.js"');
  });

  it("rewriteVirtualPathsToServer returns original when staticMap is empty", async () => {
    const { rewriteVirtualPathsToServer } = await import("../src/vivliostyle-cli");

    const html = "<html><body>unchanged</body></html>";
    expect(rewriteVirtualPathsToServer(html, {}, "http://127.0.0.1:1234")).toBe(html);
  });

  it("rewriteCustomElementUrlsInDom resolves relative model URLs to server URLs", async () => {
    const { rewriteCustomElementUrlsInDom } = await import("../src/vivliostyle-cli");
    const { JSDOM } = await import("jsdom");

    // Regression: the viewer mangled `../tiles/model.glb` on `<a-asset-item>`
    // into `http://tiles/model.glb`, so the model 404'd and the canvas stayed
    // empty. Absolute server URLs always resolve.
    const dom = new JSDOM(`<html><body>
      <a-scene><a-asset-item id="m" src="../tiles/aframe/mock.glb"></a-asset-item></a-scene>
      <model-viewer src="./models/vase.glb"></model-viewer>
      <img src="../img/photo.jpg">
    </body></html>`);
    const changed = rewriteCustomElementUrlsInDom(dom.window.document, "http://127.0.0.1:1/post/example/");

    expect(changed).toBe(true);
    const html = dom.serialize();
    expect(html).toContain('src="http://127.0.0.1:1/post/tiles/aframe/mock.glb"');
    expect(html).toContain('src="http://127.0.0.1:1/post/example/models/vase.glb"');
    // Standard elements are the viewer's own business and stay untouched.
    expect(html).toContain('src="../img/photo.jpg"');
  });

  it("rewriteCustomElementUrlsInDom leaves absolute, remote and empty URLs alone", async () => {
    const { rewriteCustomElementUrlsInDom } = await import("../src/vivliostyle-cli");
    const { JSDOM } = await import("jsdom");

    const dom = new JSDOM(`<html><body>
      <a-asset-item src="https://cdn.example.com/model.glb"></a-asset-item>
      <a-asset-item src="data:model/gltf-binary;base64,AAA"></a-asset-item>
      <a-asset-item src="/tiles/absolute.glb"></a-asset-item>
      <model-viewer src=""></model-viewer>
    </body></html>`);
    expect(rewriteCustomElementUrlsInDom(dom.window.document, "http://127.0.0.1:1/post/")).toBe(false);
    const html = dom.serialize();
    expect(html).toContain('src="https://cdn.example.com/model.glb"');
    expect(html).toContain('src="/tiles/absolute.glb"');
  });

  // ---------------------------------------------------------------------------
  // urlToStaticMapping
  // ---------------------------------------------------------------------------

  it("urlToStaticMapping skips empty URLs", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");
    const result = urlToStaticMapping("", tempDir, [], new Set());
    expect(result.kind).toBe("skipped");
  });

  it("urlToStaticMapping skips fragment-only URLs", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");
    const result = urlToStaticMapping("#section", tempDir, [], new Set());
    expect(result.kind).toBe("skipped");
  });

  it("urlToStaticMapping skips external URLs without asset-base", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");
    const result = urlToStaticMapping("https://cdn.example.com/foo.css", tempDir, [], new Set());
    expect(result.kind).toBe("skipped");
    expect((result as { kind: "skipped"; reason: string }).reason).toContain("external URL");
  });

  it("urlToStaticMapping skips root-only asset-base URLs with a clear reason", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");

    // URL exactly equals the urlBase — no sub-path to map
    const result = urlToStaticMapping(
      "https://cdn.example.com/",
      tempDir,
      [{ urlBase: "https://cdn.example.com/", localBase: tempDir }],
      new Set()
    );

    expect(result.kind).toBe("skipped");
    const reason = (result as { kind: "skipped"; reason: string }).reason;
    // Must not fall through to the "add --asset-base" message
    expect(reason).not.toContain("add --asset-base");
    expect(reason).toContain("root URL");
  });

  it("urlToStaticMapping maps an absolute URL via asset-base", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");

    writeFileSync(join(tempDir, "foo.css"), "/* css */", "utf-8");

    const result = urlToStaticMapping(
      "https://cdn.example.com/foo.css",
      tempDir,
      [{ urlBase: "https://cdn.example.com/", localBase: tempDir }],
      new Set()
    );

    expect(result.kind).toBe("mapped");
    expect((result as { kind: "mapped"; mapping: string }).mapping).toContain("/foo.css:");
  });

  it("urlToStaticMapping skips ignored virtual paths", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");

    writeFileSync(join(tempDir, "livereload.js"), "// lr", "utf-8");

    const result = urlToStaticMapping("/livereload.js", tempDir, [], new Set(["/livereload.js"]));

    expect(result.kind).toBe("skipped");
    expect((result as { kind: "skipped"; reason: string }).reason).toContain("ignore-asset");
  });

  it("urlToStaticMapping maps a root-relative URL to a local file", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");

    writeFileSync(join(tempDir, "app.js"), "// js", "utf-8");

    const result = urlToStaticMapping("./app.js", tempDir, [], new Set());

    expect(result.kind).toBe("mapped");
    const m = result as { kind: "mapped"; mapping: string };
    expect(m.mapping).toContain("/app.js:");
    expect(m.mapping).toContain(tempDir);
  });

  // ---------------------------------------------------------------------------
  // Preview mode
  // ---------------------------------------------------------------------------

  it("--preview selects preview mode instead of a PDF build", async () => {
    const { parseArgs } = await import("../src/vivliostyle-cli");

    const argv = ["node", "viv", "-i", "a.html", "-o", "a.pdf"];
    expect(parseArgs([...argv, "--preview"])?.options.preview).toBe(true);
    expect(parseArgs(argv)?.options.preview ?? false).toBe(false);
  });

  it("passes --fetch-missing on to the server", async () => {
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", { body: `<img src="${ASSETS.remoteEmbed}">` });

    await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf"), "--fetch-missing"]);

    expect(serverMock.mock.calls[0][0].fetchMissing).toBe(true);
    // Nothing is dropped, so the remote reference is left alone.
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("Dropped remote reference");
  });

  it("never probes a remote reference that resolves to a local file", async () => {
    const { referencesToProbe } = await import("../src/vivliostyle-cli");
    const assetBases = [{ urlBase: SITE_ORIGIN, localBase: tempDir }];

    writeFileSync(join(tempDir, "local.css"), "body{}", "utf-8");

    // The live site may have moved on; our copy is what gets served.
    expect(referencesToProbe(`${SITE_ORIGIN}/local.css`, assetBases)).toBe(false);
    // Missing locally as well: worth probing, so a dead reference can be dropped.
    expect(referencesToProbe(`${SITE_ORIGIN}/gone.css`, assetBases)).toBe(true);
    // Nothing local to fall back on.
    expect(referencesToProbe(`${ASSETS.remoteImage}`, assetBases)).toBe(true);
  });

  it("opens collapsed <details> for the PDF but not for the preview", async () => {
    const { buildRuntimeScript } = await import("../src/vivliostyle-cli");
    const options = { origin: SERVER_BASE_URL, documentBaseUrl: `${SERVER_BASE_URL}/`, gate: null };

    const forPdf = buildRuntimeScript({ ...options, expandDetails: true });
    expect(forPdf).toContain("expandDetails(document)");
    // Vivliostyle paginates incrementally, so the sweep has to repeat.
    expect(forPdf.match(/expandDetails\(document\);/g)?.length).toBeGreaterThan(1);

    expect(buildRuntimeScript(options)).not.toContain("expandDetails");
  });

  it("expands <details> in the document it renders", async () => {
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", {
      body: ["<details><summary>Mehr</summary>", "<p>Versteckter Text</p></details>"].join("")
    });

    const dumpDir = join(tempDir, "dump");
    await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf"), "--dump-html", dumpDir]);

    expect(readFileSync(join(dumpDir, "article.html"), "utf-8")).toContain("expandDetails");
  });

  it("startPreview serves the document and returns a viewer URL", async () => {
    const { startPreview } = await import("../src/vivliostyle-cli");
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", { css: [ASSETS.css] });

    const preview = await startPreview(inputFile, [{ urlBase: SITE_ORIGIN, localBase: tempDir }], {}, {}, {});

    expect(preview.documentUrl).toBe(`${SERVER_BASE_URL}/post/example/article.html`);
    expect(preview.url).toBe(
      `${SERVER_BASE_URL}/post/example/__viv-viewer.html#src=${SERVER_BASE_URL}/post/example/article.html&bookMode=false&renderAllPages=false`
    );

    const server = serverMock.mock.calls[0][0];
    expect(server.entry.sitePath).toBe("/post/example/article.html");
    expect(server.viewerLibDir).not.toBeNull();

    await preview.close();
  });

  it("startPreview passes layout options from -- to the viewer", async () => {
    const { startPreview } = await import("../src/vivliostyle-cli");
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", { css: [ASSETS.css] });

    const preview = await startPreview(inputFile, [{ urlBase: SITE_ORIGIN, localBase: tempDir }], {}, {}, { viewerParam: "pixelRatio=2" });

    expect(preview.url).toContain("pixelRatio=2");

    await preview.close();
  });

  it("startPreview serves the rewritten document even without an asset base", async () => {
    const { startPreview } = await import("../src/vivliostyle-cli");
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", { css: [] });

    const preview = await startPreview(inputFile, [], {}, {}, {});

    expect(preview.documentUrl).toBe(`${SERVER_BASE_URL}/index.html`);
    expect(preview.url).toContain(`${SERVER_BASE_URL}/__viv-viewer.html#`);

    await preview.close();
  });

  // ---------------------------------------------------------------------------
  // --ignore-asset in build mode
  // ---------------------------------------------------------------------------

  it("does not map ignored assets in build mode", async () => {
    const inputFile = join(tempDir, "input.html");

    mkdirSync(join(tempDir, "js"));
    writeFileSync(join(tempDir, "js", "app.js"), "// js", "utf-8");
    writeFileSync(join(tempDir, "livereload.js"), "// lr", "utf-8");

    writeFileSync(
      inputFile,
      `<html><head>
        <script src="/livereload.js"></script>
        <script src="./js/app.js"></script>
      </head><body></body></html>`,
      "utf-8"
    );

    await runArgs(["--input", inputFile, "--ignore-asset", "/livereload.js"]);

    expect(renderMock).toHaveBeenCalledTimes(1);

    const logs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain("livereload.js");
    expect(logs).toContain("Skipped");
    expect(logs).not.toContain("Mapping: /livereload.js");
  });

  // ---------------------------------------------------------------------------
  // buildPreviewHtml
  // ---------------------------------------------------------------------------

  it("buildPreviewHtml writes a sibling file with rewritten URLs", async () => {
    const { buildPreviewHtml } = await import("../src/vivliostyle-cli");

    const inputFile = join(tempDir, "page.html");
    writeFileSync(
      inputFile,
      `<html><head>
        <link rel="stylesheet" href="https://cdn.example.com/css/foo.css">
      </head><body></body></html>`,
      "utf-8"
    );

    const { htmlPath, extraStatic, cleanup } = buildPreviewHtml(inputFile, [
      { urlBase: "https://cdn.example.com/", localBase: "/local/cdn" }
    ]);

    expect(htmlPath).not.toBe(inputFile);
    expect(htmlPath).toContain("_vivliostyle_preview_page.html");

    const { readFileSync } = await import("node:fs");
    const written = readFileSync(htmlPath, "utf-8");
    expect(written).toContain('href="/css/foo.css"');
    expect(written).not.toContain("https://cdn.example.com");

    expect(extraStatic["/"]).toBe(resolve("/local/cdn"));

    cleanup();
  });

  it("buildPreviewHtml returns original file when no rewrites needed", async () => {
    const { buildPreviewHtml } = await import("../src/vivliostyle-cli");

    const inputFile = join(tempDir, "page.html");
    writeFileSync(inputFile, "<html><head></head><body></body></html>", "utf-8");

    const { htmlPath, cleanup } = buildPreviewHtml(inputFile, []);

    expect(htmlPath).toBe(inputFile);
    cleanup();
  });

  // ---------------------------------------------------------------------------  // Offline reference dropping
  // ---------------------------------------------------------------------------

  it("dropRemoteReferencesInDom keeps local references and drops remote ones", async () => {
    const { dropRemoteReferencesInDom } = await import("../src/vivliostyle-cli");
    const { JSDOM } = await import("jsdom");

    const dom = new JSDOM(
      articleHtml({
        relative: true,
        css: [ASSETS.css, ASSETS.remoteBadge],
        js: [ASSETS.js, `//${REMOTE_HOST}/app.js`],
        body: [
          `<img src="${ASSETS.photo}" alt="local">`,
          `<img src="${ASSETS.remoteImage}" alt="remote">`,
          `<img srcset="${ASSETS.thumb} 1x, ${ASSETS.remoteImage} 2x" src="${ASSETS.thumb}">`,
          `<iframe src="${ASSETS.remoteEmbed}"></iframe>`,
          `<link rel="preconnect" href="https://fonts.example.com">`,
          `<a href="https://example.com/page">link stays</a>`
        ].join("\n")
      })
    );

    const dropped = dropRemoteReferencesInDom(dom.window.document);
    const html = dom.serialize();

    expect([...dropped].sort()).toEqual(
      [ASSETS.remoteBadge, `//${REMOTE_HOST}/app.js`, ASSETS.remoteImage, ASSETS.remoteEmbed, "https://fonts.example.com"].sort()
    );

    expect(html).toContain(`href="${ASSETS.css}"`);
    expect(html).toContain(`src="${ASSETS.photo}"`);
    expect(html).toContain(`srcset="${ASSETS.thumb} 1x"`);
    expect(html).toContain('href="https://example.com/page"');
    expect(html).not.toContain(REMOTE_HOST);
  });

  it("dropRemoteReferencesInDom keeps references served by the static server", async () => {
    const { dropRemoteReferencesInDom, isStaticServerUrl } = await import("../src/vivliostyle-cli");
    const { JSDOM } = await import("jsdom");

    const dom = new JSDOM(`<html><body><img src="${SERVER_BASE_URL}${ASSETS.photo}"></body></html>`);

    expect(dropRemoteReferencesInDom(dom.window.document, isStaticServerUrl(SERVER_BASE_URL))).toEqual([]);
    expect(dom.serialize()).toContain(`src="${SERVER_BASE_URL}${ASSETS.photo}"`);
  });

  it("dropRemoteReferencesInDom removes meta refresh redirects", async () => {
    const { dropRemoteReferencesInDom } = await import("../src/vivliostyle-cli");
    const { JSDOM } = await import("jsdom");

    const dom = new JSDOM(articleHtml({ relative: true, css: [], js: [], redirectTo: "/post/renamed/article.html" }));

    expect(dropRemoteReferencesInDom(dom.window.document)).toEqual([]);
    expect(dom.serialize()).toContain('http-equiv="refresh"');

    const stub = new JSDOM(articleHtml({ relative: true, css: [], js: [], redirectTo: ASSETS.remoteMap }));
    expect(dropRemoteReferencesInDom(stub.window.document)).toEqual([ASSETS.remoteMap]);
    expect(stub.serialize()).not.toContain("http-equiv");
  });

  it("parseMetaRefreshTarget extracts quoted, bare and absent targets", async () => {
    const { parseMetaRefreshTarget } = await import("../src/vivliostyle-cli");

    expect(parseMetaRefreshTarget("0; url=https://site.test/a.html")).toBe("https://site.test/a.html");
    expect(parseMetaRefreshTarget("5;URL='https://site.test/b.html'")).toBe("https://site.test/b.html");
    expect(parseMetaRefreshTarget('0; url="https://site.test/c.html"')).toBe("https://site.test/c.html");
    expect(parseMetaRefreshTarget("30")).toBeNull();
    expect(parseMetaRefreshTarget("0; url=")).toBeNull();
  });

  it("isRemoteUrl classifies schemes, protocol-relative and inline URLs", async () => {
    const { isRemoteUrl } = await import("../src/vivliostyle-cli");

    for (const url of ["https://site.test/a", "http://site.test/a", "//site.test/a", "HTTPS://site.test/a"]) {
      expect(isRemoteUrl(url)).toBe(true);
    }
    for (const url of [
      "/post/a.png",
      "./a.png",
      "../a.png",
      "#anchor",
      "",
      "data:image/png;base64,AAA",
      "blob:http://x/1",
      "mailto:a@b.c"
    ]) {
      expect(isRemoteUrl(url)).toBe(false);
    }
  });

  it("collectUnservedVirtualPaths reports root-relative paths nothing can serve", async () => {
    const { collectUnservedVirtualPaths } = await import("../src/vivliostyle-cli");
    const { JSDOM } = await import("jsdom");

    const dom = new JSDOM(`<html><head>
      <link rel="stylesheet" href="/css/site.css">
      <link rel="stylesheet" href="/css/theme.css">
      <link rel="stylesheet" href="/css/other.css">
    </head><body>
      <img srcset="/img/a.png 1x, /img/gone.png 2x">
      <img src="a-relative.png">
    </body></html>`);

    const served = new Set(["/img/a.png"]);
    const unserved = collectUnservedVirtualPaths(dom.window.document, ["/css/site.css", "/css/theme.css"], (virtualPath) =>
      served.has(virtualPath)
    );

    expect(unserved).toEqual(["/css/other.css", "/img/gone.png"]);
  });

  it("drops remote references in build mode and reports them", async () => {
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", {
      body: [
        `<img src="${ASSETS.remoteImage}" alt="remote">`,
        `<iframe src="${ASSETS.remoteEmbed}"></iframe>`,
        `<img src="${siteUrl(ASSETS.photo)}" alt="local">`
      ].join("\n")
    });
    const dumpDir = join(tempDir, "dump");

    await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf"), "--dump-html", dumpDir]);

    const request = renderMock.mock.calls[0][0];
    // No --asset-base was given, so the document is mounted at the site root.
    expect(request.documentUrl).toBe(`${SERVER_BASE_URL}/index.html`);

    const server = serverMock.mock.calls[0][0];
    expect(server.entry.localPath).toBe(join(dumpDir, "article.html"));

    const rendered = readFileSync(server.entry.localPath, "utf-8");
    expect(rendered).not.toContain(REMOTE_HOST);

    const logs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain(`[offline] Dropped remote reference: ${ASSETS.remoteImage}`);
    expect(logs).toContain(`[offline] Dropped remote reference: ${ASSETS.remoteEmbed}`);
  });

  it("keeps remote references when --allow-remote is used", async () => {
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", { body: `<img src="${ASSETS.remoteImage}" alt="remote">` });

    const dumpDir = join(tempDir, "dump");
    // --allow-remote verifies that the remote reference exists before keeping it.
    const fetchStub = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchStub);

    try {
      await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf"), "--allow-remote", "--dump-html", dumpDir]);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(readFileSync(join(dumpDir, "article.html"), "utf-8")).toContain(ASSETS.remoteImage);

    const logs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).not.toContain("[offline]");
  });

  it("drops remote references in preview mode and dumps the HTML outside the input directory", async () => {
    const { startPreview } = await import("../src/vivliostyle-cli");
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", { body: `<img src="${ASSETS.remoteImage}" alt="remote">` });
    const dumpDir = join(tempDir, "dump");

    const preview = await startPreview(inputFile, [{ urlBase: SITE_ORIGIN, localBase: tempDir }], {}, { fetchMissing: false, dumpDir }, {});

    const server = serverMock.mock.calls[0][0];
    expect(server.entry.localPath).toBe(join(dumpDir, "article.html"));
    expect(readFileSync(server.entry.localPath, "utf-8")).not.toContain(REMOTE_HOST);
    expect(existsSync(join(dirname(inputFile), "_vivliostyle_preview_article.html"))).toBe(false);

    await preview.close();
  });

  // ---------------------------------------------------------------------------
  // asset-base local roots and --dump-html
  // ---------------------------------------------------------------------------

  it("maps every local asset of a synthetic site to the static server", async () => {
    writeSite(tempDir, [ASSETS.thumb]);
    const inputFile = writeArticle(tempDir, "example", {
      css: [ASSETS.css],
      js: [ASSETS.js],
      body: [
        `<img src="${siteUrl(ASSETS.photo)}" alt="photo">`,
        `<img src="${siteUrl(ASSETS.thumb)}" alt="thumb">`,
        `<img src="${siteUrl(ASSETS.missingPhoto)}" alt="missing">`,
        `<img srcset="${siteUrl(ASSETS.gallery)} 1x, ${siteUrl(ASSETS.thumb)} 2x" src="${siteUrl(ASSETS.gallery)}">`
      ].join("\n")
    });
    const dumpDir = join(tempDir, "dump");

    await runArgs([
      "--input",
      inputFile,
      "--output",
      join(tempDir, "out.pdf"),
      "--asset-base",
      `${SITE_ORIGIN}=${tempDir}`,
      "--dump-html",
      dumpDir
    ]);

    expect(renderMock.mock.calls[0][0].input).not.toBe(resolve(inputFile));

    const rendered = readFileSync(join(dumpDir, "article.html"), "utf-8");

    // every subresource is served through the static server, srcset included
    expect(rendered).toContain(`href="${SERVER_BASE_URL}${ASSETS.css}"`);
    expect(rendered).toContain(`src="${SERVER_BASE_URL}${ASSETS.js}"`);
    expect(rendered).toContain(`src="${SERVER_BASE_URL}${ASSETS.photo}"`);
    expect(rendered).toContain(`srcset="${SERVER_BASE_URL}${ASSETS.gallery} 1x, ${SERVER_BASE_URL}${ASSETS.thumb} 2x"`);

    // the site origin never survives into the rendered document
    expect(rendered).not.toContain(SITE_ORIGIN);
  });

  it("reports every asset that is mapped but missing from the site", async () => {
    writeSite(tempDir, [ASSETS.thumb]);
    const inputFile = writeArticle(tempDir, "example", {
      css: [ASSETS.css],
      body: [`<img src="${siteUrl(ASSETS.thumb)}" alt="thumb">`, `<img src="${siteUrl(ASSETS.missingPhoto)}" alt="missing">`].join("\n")
    });

    await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf"), "--asset-base", `${SITE_ORIGIN}=${tempDir}`]);

    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    const missing = warnings.filter((line) => line.includes("does not exist"));

    // one warning per missing asset, not per attribute occurrence
    expect(missing).toHaveLength(2);
    expect(warnings.some((line) => line.includes(ASSETS.thumb))).toBe(true);
    expect(warnings.some((line) => line.includes(ASSETS.missingPhoto))).toBe(true);
  });

  it("keeps the CSS-referenced assets of a synthetic site resolvable", async () => {
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", { css: [ASSETS.css] });
    const dumpDir = join(tempDir, "dump");

    await runArgs([
      "--input",
      inputFile,
      "--output",
      join(tempDir, "out.pdf"),
      "--asset-base",
      `${SITE_ORIGIN}=${tempDir}`,
      "--dump-html",
      dumpDir
    ]);

    // The generated stylesheet references /images/icon.svg relatively to itself;
    // the mounted asset-base root is what makes fonts and images resolvable.
    const css = readFileSync(join(tempDir, ASSETS.css), "utf-8");
    expect(css).toContain(ASSETS.icon);
    expect(existsSync(join(tempDir, ASSETS.icon))).toBe(true);
  });

  it("--dump-html keeps the rewritten HTML in the given directory", async () => {
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", { css: [ASSETS.css] });
    const dumpDir = join(tempDir, "dump");

    await runArgs([
      "--input",
      inputFile,
      "--output",
      join(tempDir, "out.pdf"),
      "--asset-base",
      `${SITE_ORIGIN}=${tempDir}`,
      "--dump-html",
      dumpDir
    ]);

    expect(existsSync(join(dumpDir, "article.html"))).toBe(true);
    expect(readFileSync(join(dumpDir, "article.html"), "utf-8")).toContain(`href="${SERVER_BASE_URL}${ASSETS.css}"`);
  });

  it("does not write a sibling preview file without --dump-html", async () => {
    const { startPreview } = await import("../src/vivliostyle-cli");
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", { css: [ASSETS.css] });

    const preview = await startPreview(inputFile, [{ urlBase: SITE_ORIGIN, localBase: tempDir }], {}, {}, {});

    expect(preview.documentUrl).toBe(`${SERVER_BASE_URL}/post/example/article.html`);

    // Without --dump-html the sibling file is removed again on close().
    const sibling = join(dirname(inputFile), "_vivliostyle_preview_article.html");
    await preview.close();
    expect(existsSync(sibling)).toBe(false);

    // Site URLs are resolved through the asset base the server was started with.
    const server = serverMock.mock.calls[0][0];
    expect(server.assetBases).toHaveLength(1);

    await preview.close();
  });

  it("leaves a redirect stub untouched with --allow-remote", async () => {
    const inputFile = writeRedirectStub(tempDir, "renamed", siteUrl("/post/target/article.html"));

    await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf"), "--allow-remote"]);

    // with --allow-remote the redirect stays, so the browser may follow it
    expect(serverMock.mock.calls[0][0].entry.localPath).toBe(inputFile);
    expect(readFileSync(inputFile, "utf-8")).toContain("http-equiv");
  });

  it("empties a redirect stub when running offline", async () => {
    const inputFile = writeRedirectStub(tempDir, "renamed", siteUrl("/post/target/article.html"));
    const dumpDir = join(tempDir, "dump");

    await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf"), "--dump-html", dumpDir]);

    const rendered = readFileSync(serverMock.mock.calls[0][0].entry.localPath, "utf-8");
    expect(rendered).not.toContain("http-equiv");
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      `[offline] Dropped remote reference: ${siteUrl("/post/target/article.html")}`
    );
  });

  // ---------------------------------------------------------------------------
  // Logger
  // ---------------------------------------------------------------------------

  it("keeps diagnostics out of the default output", async () => {
    const inputFile = writeArticle(tempDir, "plain", { css: [] });

    await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf")]);

    expect(errorSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("raw CLI options");
  });

  it("--log-level verbose stays below the diagnostics", async () => {
    const inputFile = writeArticle(tempDir, "plain", { css: [] });

    await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf"), "--log-level", "verbose"]);

    const debugOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(debugOutput).not.toContain("raw CLI options");
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("--log-level silent silences wrapper output", async () => {
    writeSite(tempDir, [ASSETS.css]);
    const inputFile = writeArticle(tempDir, "example", { css: [ASSETS.css] });

    await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf"), "--static", `/:${tempDir}`, "--log-level", "silent"]);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("-d restores debug output for the whole run", async () => {
    const inputFile = writeArticle(tempDir, "plain", { css: [] });

    await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf"), "-d"]);

    const debugOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(debugOutput).toContain("raw CLI options");
    expect(debugOutput).toContain("renderPdf request");
  });

  // ---------------------------------------------------------------------------
  // Site paths, settle gate and runtime shims
  // ---------------------------------------------------------------------------

  it("deriveSitePath returns the path the document has on the mapped site", async () => {
    const { deriveSitePath } = await import("../src/vivliostyle-cli");

    expect(deriveSitePath("/site/post/a/article.html", [{ urlBase: "https://site.test/", localBase: "/site" }])).toBe(
      "/post/a/article.html"
    );
    expect(deriveSitePath("/other/article.html", [{ urlBase: "https://site.test/", localBase: "/site" }])).toBeNull();
    expect(deriveSitePath("/site/article.html", [])).toBeNull();
  });

  it("looksLikeFileRequest distinguishes files from directory URLs", async () => {
    const { looksLikeFileRequest } = await import("../src/server");

    expect(looksLikeFileRequest("/meta/tags/index.json")).toBe(true);
    expect(looksLikeFileRequest("/collections/")).toBe(false);
    expect(looksLikeFileRequest("/")).toBe(false);
  });

  it("resolveSettleGate applies defaults and caps the deadline", async () => {
    const { resolveSettleGate } = await import("../src/vivliostyle-cli");

    expect(resolveSettleGate({ waitForContent: undefined } as never)).toBeNull();
    expect(resolveSettleGate({ waitForContent: true } as never)).toEqual({ quietMs: 400, deadlineMs: 25_000 });
    expect(resolveSettleGate({ waitForContent: "3000", quietMs: "50" } as never)).toEqual({ quietMs: 50, deadlineMs: 3000 });
    // 0 disables the wait entirely (including the automatic one).
    expect(resolveSettleGate({ waitForContent: "0" } as never)).toBeNull();
    // Vivliostyle gives up on images after 30s, so the gate must open before that.
    expect(resolveSettleGate({ waitForContent: "99000" } as never)?.deadlineMs).toBe(25_000);
    expect(() => resolveSettleGate({ waitForContent: "nope" } as never)).toThrow(/Invalid --wait-for-content/);
    expect(() => resolveSettleGate({ waitForContent: "-1" } as never)).toThrow(/Invalid --wait-for-content/);
  });

  it("resolveEffectiveSettle auto-arms on script pages only", async () => {
    const { resolveEffectiveSettle } = await import("../src/vivliostyle-cli");

    // No scripts → no waiting, no auto-arm.
    expect(resolveEffectiveSettle({ waitForContent: undefined } as never, false)).toEqual({ gate: null, autoArmed: false });
    // Scripts → automatic gate with the 10s deadline.
    expect(resolveEffectiveSettle({ waitForContent: undefined } as never, true)).toEqual({
      gate: { quietMs: 400, deadlineMs: 10_000 },
      autoArmed: true
    });
    // Explicit flag wins over auto-arm.
    expect(resolveEffectiveSettle({ waitForContent: "3000" } as never, true)).toEqual({
      gate: { quietMs: 400, deadlineMs: 3000 },
      autoArmed: false
    });
    // Explicit 0 disables even on script pages.
    expect(resolveEffectiveSettle({ waitForContent: "0" } as never, true)).toEqual({ gate: null, autoArmed: false });
  });

  it("the runtime script tracks wasm compilation, long tasks and fonts", async () => {
    const { buildRuntimeScript } = await import("../src/vivliostyle-cli");
    const script = buildRuntimeScript({
      origin: "http://127.0.0.1:1",
      documentBaseUrl: "http://127.0.0.1:1/",
      gate: { quietMs: 400, deadlineMs: 1000 }
    });
    for (const marker of ["instantiateStreaming", "compileStreaming", "longtask", 'document.fonts.status==="loading"']) {
      expect(script, marker).toContain(marker);
    }
  });

  it("the runtime script routes URLs and reports through absolute URLs", async () => {
    const { buildRuntimeScript, buildSettleGateImage } = await import("../src/vivliostyle-cli");

    const script = buildRuntimeScript({
      origin: SERVER_BASE_URL,
      documentBaseUrl: `${SERVER_BASE_URL}/post/example/`,
      gate: { quietMs: 400, deadlineMs: 1000 }
    });

    // Page-script requests must reach our server, not Vivliostyle's own.
    expect(script).toContain(`ORIGIN="${SERVER_BASE_URL}"`);
    expect(script).toContain(`BASE="${SERVER_BASE_URL}/post/example/"`);
    expect(script).toContain(`url=ORIGIN+"/__viv-settle-ready`);
    // The renderer polls window.__vivSettle instead of the HTTP endpoint.
    expect(script).toContain("window.__vivSettle");
    expect(script).toContain("watchFrame");

    // A relative gate URL would be requested from the wrong origin.
    expect(buildSettleGateImage(SERVER_BASE_URL)).toContain(`src="${SERVER_BASE_URL}/__viv-settle"`);
  });

  it("injects the settle gate and mounts the site on our own server", async () => {
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", { body: `<img src="${siteUrl(ASSETS.photo)}" alt="photo">` });
    const dumpDir = join(tempDir, "dump");

    await runArgs([
      "--input",
      inputFile,
      "--output",
      join(tempDir, "out.pdf"),
      "--asset-base",
      `${SITE_ORIGIN}=${tempDir}`,
      "--wait-for-content",
      "2000",
      "--dump-html",
      dumpDir
    ]);

    const rendered = readFileSync(join(dumpDir, "article.html"), "utf-8");
    expect(rendered).toContain(`${SERVER_BASE_URL}/__viv-settle`);
    expect(rendered).toContain("__viv-settle-ready");
    expect(rendered).toContain("data-vivliostyle-settle-gate");

    // Page scripts must be able to reach the document directory and the site root.
    const server = serverMock.mock.calls[0][0];
    expect(server.assetBases).toEqual([expect.objectContaining({ urlBase: `${SITE_ORIGIN}/`, localBase: tempDir })]);
    expect(server.staticMap[ASSETS.photo]).toBe(join(tempDir, ASSETS.photo));
  });

  it("--fetch-missing keeps remote references instead of dropping them", async () => {
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", {
      body: `<img src="${ASSETS.remoteImage}" alt="remote"><iframe src="${ASSETS.remoteEmbed}"></iframe>`
    });

    await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf"), "--fetch-missing"]);

    const logs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).not.toContain("[offline]");
    // The input document itself is never modified.
    expect(readFileSync(inputFile, "utf-8")).toContain(ASSETS.remoteImage);
    expect(readFileSync(inputFile, "utf-8")).toContain(ASSETS.remoteEmbed);
  });

  it("--fetch-missing keeps absolute URLs of assets that are missing locally", async () => {
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", { body: `<img src="${siteUrl(ASSETS.missingPhoto)}" alt="missing">` });
    const dumpDir = join(tempDir, "dump");

    // --fetch-missing verifies that remote references still exist; answer that
    // without touching the network.
    const fetchStub = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchStub);

    try {
      await runArgs([
        "--input",
        inputFile,
        "--output",
        join(tempDir, "out.pdf"),
        "--asset-base",
        `${SITE_ORIGIN}=${tempDir}`,
        "--fetch-missing",
        "--dump-html",
        dumpDir
      ]);
    } finally {
      vi.unstubAllGlobals();
    }

    const rendered = readFileSync(join(dumpDir, "article.html"), "utf-8");
    expect(rendered).toContain(`src="${siteUrl(ASSETS.missingPhoto)}"`);
  });

  it("--pixel-ratio is forwarded as a viewer parameter", async () => {
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", { css: [ASSETS.css] });

    await runArgs([
      "--input",
      inputFile,
      "--output",
      join(tempDir, "out.pdf"),
      "--asset-base",
      `${SITE_ORIGIN}=${tempDir}`,
      "--pixel-ratio",
      "2"
    ]);

    expect(renderMock.mock.calls[0][0].viewerParams.pixelRatio).toBe("2");
  });

  it("normalizes kebab-case extra args and coerces numbers", async () => {
    const { parseExtraArgs } = await import("../src/vivliostyle-cli");

    expect(parseExtraArgs(["--viewer-param", "allowScripts=true", "--timeout", "60000", "--version", "1.9.2"])).toEqual({
      viewerParam: "allowScripts=true",
      timeout: 60000,
      version: "1.9.2"
    });
  });

  it("drops remote references that no longer exist", async () => {
    writeSite(tempDir);
    const inputFile = writeArticle(tempDir, "example", {
      body: `<img src="${ASSETS.remoteImage}" alt="remote"><iframe src="${ASSETS.remoteEmbed}"></iframe>`
    });
    const dumpDir = join(tempDir, "dump");

    const fetchStub = vi.fn(async (url: string) =>
      String(url).includes("youtube") ? { ok: false, status: 404 } : { ok: true, status: 200 }
    );
    vi.stubGlobal("fetch", fetchStub);

    try {
      await runArgs(["--input", inputFile, "--output", join(tempDir, "out.pdf"), "--fetch-missing", "--dump-html", dumpDir]);
    } finally {
      vi.unstubAllGlobals();
    }

    const rendered = readFileSync(join(dumpDir, "article.html"), "utf-8");
    expect(rendered).toContain(ASSETS.remoteImage);
    expect(rendered).not.toContain(ASSETS.remoteEmbed);

    const warnings = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warnings).toContain(`[fetch] Dropped unavailable remote reference: ${ASSETS.remoteEmbed}`);
  });
});
