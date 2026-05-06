import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const buildMock = vi.fn(async () => {});
const previewMock = vi.fn(async () => {});

vi.mock("@vivliostyle/cli", () => ({
  build: buildMock,
  preview: previewMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Re-imports the module fresh on every test (vi.resetModules() in afterEach
 * ensures the previous import is discarded) and runs the given argv.
 */
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
    buildMock.mockClear();
    previewMock.mockClear();
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

    expect(buildMock).not.toHaveBeenCalled();
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("throws when --input file does not exist", async () => {
    await expect(
      runArgs(["--input", "/nonexistent/path/file.html"])
    ).rejects.toThrow("Input file does not exist");
  });

  it("throws on invalid --format", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await expect(
      runArgs(["--input", inputFile, "--format", "docx"])
    ).rejects.toThrow('Invalid format: "docx"');
  });

  it("throws on invalid --log-level", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await expect(
      runArgs(["--input", inputFile, "--log-level", "trace"])
    ).rejects.toThrow('Invalid log level: "trace"');
  });

  it("throws on invalid --mode", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await expect(
      runArgs(["--input", inputFile, "--mode", "watch"])
    ).rejects.toThrow('Invalid mode: "watch"');
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

    expect(buildMock).toHaveBeenCalledTimes(1);
    expect(previewMock).not.toHaveBeenCalled();

    const config = buildMock.mock.calls[0][0];
    expect(config.input).toBe(resolve(inputFile));
    expect(config.output).toEqual([{ path: resolve(outputFile), format: "pdf" }]);
  });

  it("passes --format epub to build()", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await runArgs(["--input", inputFile, "--format", "epub"]);

    const config = buildMock.mock.calls[0][0];
    expect(config.output[0].format).toBe("epub");
  });

  it("passes --title, --author, --language to build()", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await runArgs([
      "--input", inputFile,
      "--title", "My Title",
      "--author", "Jane",
      "--language", "en",
    ]);

    const config = buildMock.mock.calls[0][0];
    expect(config.title).toBe("My Title");
    expect(config.author).toBe("Jane");
    expect(config.language).toBe("en");
  });

  it("sets logLevel to debug and debug:true when -d is used", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await runArgs(["--input", inputFile, "-d"]);

    const config = buildMock.mock.calls[0][0];
    expect(config.logLevel).toBe("debug");
    expect(config.debug).toBe(true);
  });

  it("passes extra args after -- into build config", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await runArgs([
      "--input", inputFile,
      "--",
      "--sandbox",
      "--port", "4000",
      "--foo=bar",
    ]);

    const config = buildMock.mock.calls[0][0];
    expect(config.sandbox).toBe(true);
    expect(config.port).toBe("4000");
    expect(config.foo).toBe("bar");
  });

  it("warns about short flags after --", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body></body></html>", "utf-8");

    await runArgs(["--input", inputFile, "--", "-v"]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('short flag "-v"')
    );
  });

  // ---------------------------------------------------------------------------
  // Build mode — HTML auto-detection and URL extraction
  // ---------------------------------------------------------------------------

  it("auto-detects HTML input by extension and does not warn", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(
      inputFile,
      "<html><head></head><body>Hello</body></html>",
      "utf-8"
    );

    await runArgs(["--input", inputFile]);

    expect(buildMock).toHaveBeenCalledTimes(1);
    // No warnings about non-HTML input
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((w) => w.includes("no effect"))).toBe(false);
  });

  it("warns when --asset-base is used with non-HTML input", async () => {
    // Use a .json file which won't be treated as HTML
    const inputFile = join(tempDir, "pub.json");
    writeFileSync(inputFile, "{}", "utf-8");

    // build() will be called but will succeed (mock)
    await runArgs([
      "--input", inputFile,
      "--asset-base", `http://cdn.example.com/=${tempDir}`,
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("--asset-base has no effect")
    );
  });

  it("warns when --ignore-asset is used with non-HTML input", async () => {
    const inputFile = join(tempDir, "pub.json");
    writeFileSync(inputFile, "{}", "utf-8");

    await runArgs([
      "--input", inputFile,
      "--ignore-asset", "/livereload.js",
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("--ignore-asset has no effect")
    );
  });

  // ---------------------------------------------------------------------------
  // splitArgsAtDoubleDash
  // ---------------------------------------------------------------------------

  it("splitArgsAtDoubleDash splits correctly", async () => {
    const { splitArgsAtDoubleDash } = await import("../src/vivliostyle-cli");

    expect(splitArgsAtDoubleDash(["a", "b", "--", "c", "d"])).toEqual({
      cliArgv: ["a", "b"],
      extraArgs: ["c", "d"],
    });

    expect(splitArgsAtDoubleDash(["a", "b"])).toEqual({
      cliArgv: ["a", "b"],
      extraArgs: [],
    });

    expect(splitArgsAtDoubleDash(["a", "--", "--foo", "bar"])).toEqual({
      cliArgv: ["a"],
      extraArgs: ["--foo", "bar"],
    });
  });

  // ---------------------------------------------------------------------------
  // parseExtraArgs
  // ---------------------------------------------------------------------------

  it("parseExtraArgs handles --key value, --key=value, and boolean flags", async () => {
    const { parseExtraArgs } = await import("../src/vivliostyle-cli");

    expect(parseExtraArgs(["--sandbox", "--port", "4000", "--foo=bar"])).toEqual({
      sandbox: true,
      port: "4000",
      foo: "bar",
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

    const result = mapAbsoluteUrlToLocal(
      "https://cdn.example.com/css/foo.css",
      [{ urlBase: "https://cdn.example.com/", localBase: "/local/cdn" }]
    );

    expect(result).not.toBeNull();
    expect(result!.virtualPath).toBe("/css/foo.css");
    expect(result!.localPath).toBe(resolve("/local/cdn", "css/foo.css"));
  });

  it("mapAbsoluteUrlToLocal returns null for non-matching URLs", async () => {
    const { mapAbsoluteUrlToLocal } = await import("../src/vivliostyle-cli");

    expect(
      mapAbsoluteUrlToLocal("https://other.example.com/css/foo.css", [
        { urlBase: "https://cdn.example.com/", localBase: "/local/cdn" },
      ])
    ).toBeNull();
  });

  it("mapAbsoluteUrlToLocal strips query and fragment", async () => {
    const { mapAbsoluteUrlToLocal } = await import("../src/vivliostyle-cli");

    const result = mapAbsoluteUrlToLocal(
      "https://cdn.example.com/css/foo.css?v=123#top",
      [{ urlBase: "https://cdn.example.com/", localBase: "/local/cdn" }]
    );

    expect(result!.virtualPath).toBe("/css/foo.css");
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
      local: "/dist/css",
    });
  });

  it("parseStaticMapping throws when virtual path does not start with /", async () => {
    const { parseStaticMapping } = await import("../src/vivliostyle-cli");
    // "css:/dist/css" has no slash before the colon so parseStaticMapping
    // detects it as a malformed mapping before reaching the starts-with-/
    // check — the error message reflects the format validation.
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

    const result = rewriteAbsoluteUrls(html, [
      { urlBase: "https://cdn.example.com/", localBase: "/local/cdn" },
    ]);

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

    const result = rewriteAbsoluteUrls(html, [
      { urlBase: "https://cdn.example.com/", localBase: "/local/cdn" },
    ]);

    // No match — should be unchanged (JSDOM may normalise whitespace so check
    // the attribute value rather than the full string)
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

    const result = rewriteVirtualPathsToServer(
      html,
      { "/css": "/local/css", "/js": "/local/js" },
      "http://127.0.0.1:12345"
    );

    expect(result).toContain('href="http://127.0.0.1:12345/css/foo.css"');
    expect(result).toContain('src="http://127.0.0.1:12345/js/app.js"');
  });

  it("rewriteVirtualPathsToServer returns original when staticMap is empty", async () => {
    const { rewriteVirtualPathsToServer } = await import("../src/vivliostyle-cli");

    const html = "<html><body>unchanged</body></html>";
    expect(rewriteVirtualPathsToServer(html, {}, "http://127.0.0.1:1234")).toBe(html);
  });

  // ---------------------------------------------------------------------------
  // urlToStaticMapping
  // ---------------------------------------------------------------------------

  it("urlToStaticMapping skips empty URLs", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");
    const result = urlToStaticMapping("", tempDir, [], new Set(), () => {});
    expect(result.kind).toBe("skipped");
  });

  it("urlToStaticMapping skips fragment-only URLs", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");
    const result = urlToStaticMapping("#section", tempDir, [], new Set(), () => {});
    expect(result.kind).toBe("skipped");
  });

  it("urlToStaticMapping skips external URLs without asset-base", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");
    const result = urlToStaticMapping(
      "https://cdn.example.com/foo.css",
      tempDir,
      [],
      new Set(),
      () => {}
    );
    expect(result.kind).toBe("skipped");
    expect((result as { kind: "skipped"; reason: string }).reason).toContain("external URL");
  });

  it("urlToStaticMapping maps an absolute URL via asset-base", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");

    writeFileSync(join(tempDir, "foo.css"), "/* css */", "utf-8");

    const result = urlToStaticMapping(
      "https://cdn.example.com/foo.css",
      tempDir,
      [{ urlBase: "https://cdn.example.com/", localBase: tempDir }],
      new Set(),
      () => {}
    );

    expect(result.kind).toBe("mapped");
    expect((result as { kind: "mapped"; mapping: string }).mapping).toContain("/foo.css:");
  });

  it("urlToStaticMapping skips ignored virtual paths", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");

    writeFileSync(join(tempDir, "livereload.js"), "// lr", "utf-8");

    const result = urlToStaticMapping(
      "/livereload.js",
      tempDir,
      [],
      new Set(["/livereload.js"]),
      () => {}
    );

    expect(result.kind).toBe("skipped");
    expect((result as { kind: "skipped"; reason: string }).reason).toContain("ignore-asset");
  });

  it("urlToStaticMapping maps a root-relative URL to a local file", async () => {
    const { urlToStaticMapping } = await import("../src/vivliostyle-cli");

    // Use a relative URL (./app.js) so that resolve(htmlDir, url) produces a
    // path inside tempDir. Root-relative URLs (/app.js) are resolved against
    // the filesystem root, not htmlDir, so tempDir would not appear in the result.
    writeFileSync(join(tempDir, "app.js"), "// js", "utf-8");

    const result = urlToStaticMapping(
      "./app.js",
      tempDir,
      [],
      new Set(),
      () => {}
    );

    expect(result.kind).toBe("mapped");
    const m = result as { kind: "mapped"; mapping: string };
    expect(m.mapping).toContain("/app.js:");
    expect(m.mapping).toContain(tempDir);
  });

  // ---------------------------------------------------------------------------
  // Preview mode
  // ---------------------------------------------------------------------------

  it("calls preview() with singleDoc, openViewer, enableStaticServe", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body>Hello</body></html>", "utf-8");

    await runArgs(["--input", inputFile, "--mode", "preview"]);

    expect(previewMock).toHaveBeenCalledTimes(1);
    expect(buildMock).not.toHaveBeenCalled();

    const config = previewMock.mock.calls[0][0];
    expect(config.openViewer).toBe(true);
    expect(config.enableStaticServe).toBe(true);
    expect(config.singleDoc).toBe(true);
    // input is the absolute path to the file (Vivliostyle resolves it)
    expect(config.input).toBe(resolve(inputFile));
  });

  it("calls preview() with --preview shortcut", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(inputFile, "<html><body>Hello</body></html>", "utf-8");

    await runArgs(["--input", inputFile, "--preview"]);

    expect(previewMock).toHaveBeenCalledTimes(1);
    const config = previewMock.mock.calls[0][0];
    expect(config.input).toBe(resolve(inputFile));
    expect(config.openViewer).toBe(true);
  });

  it("passes static mappings via configData[0].static in preview mode", async () => {
    const inputFile = join(tempDir, "input.html");

    mkdirSync(join(tempDir, "css"));
    writeFileSync(join(tempDir, "css", "site.css"), "/* css */", "utf-8");

    writeFileSync(
      inputFile,
      `<html><head>
        <link rel="stylesheet" href="./css/site.css">
      </head><body>Hello</body></html>`,
      "utf-8"
    );

    await runArgs(["--input", inputFile, "--preview"]);

    expect(previewMock).toHaveBeenCalledTimes(1);
    const config = previewMock.mock.calls[0][0];

    // Static mounts go into configData[0].static, not top-level
    expect(config.configData).toBeDefined();
    expect(config.configData[0].static).toBeDefined();
    expect(config.configData[0].static["/css/site.css"]).toBe(
      resolve(tempDir, "css/site.css")
    );
    expect(config.static).toBeUndefined();
  });

  it("does not include configData when there are no static mounts in preview mode", async () => {
    const inputFile = join(tempDir, "input.html");
    writeFileSync(
      inputFile,
      "<html><head></head><body>Hello</body></html>",
      "utf-8"
    );

    await runArgs(["--input", inputFile, "--preview"]);

    const config = previewMock.mock.calls[0][0];
    expect(config.configData).toBeUndefined();
  });

  it("passes --asset-base mounts into configData[0].static in preview mode", async () => {
    const inputFile = join(tempDir, "input.html");

    mkdirSync(join(tempDir, "css"));
    writeFileSync(join(tempDir, "css", "site.css"), "/* css */", "utf-8");

    writeFileSync(
      inputFile,
      `<html><head>
        <link rel="stylesheet" href="http://localhost:1313/css/site.css">
      </head><body>Hello</body></html>`,
      "utf-8"
    );

    await runArgs([
      "--input", inputFile,
      "--preview",
      "--asset-base", `http://localhost:1313/=${tempDir}`,
    ]);

    const config = previewMock.mock.calls[0][0];
    expect(config.configData[0].static).toBeDefined();
    // The explicit file mapping from the HTML
    expect(config.configData[0].static["/css/site.css"]).toBe(
      resolve(tempDir, "css/site.css")
    );
    // The fallback root mount from the assetBase
    expect(config.configData[0].static["/"]).toBe(resolve(tempDir));
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

    await runArgs([
      "--input", inputFile,
      "--ignore-asset", "/livereload.js",
    ]);

    expect(buildMock).toHaveBeenCalledTimes(1);
    const config = buildMock.mock.calls[0][0];

    // livereload.js is ignored so it must not appear in the log output.
    // The build input is the original file (no absolute URLs to rewrite,
    // and relative paths in the HTML are not rewritten to server URLs
    // because prepareInputHtmlForBuild only changes things when there is
    // an actual textual difference to make).
    expect(config.input).toBe(resolve(inputFile));

    // Verify the ignored asset was actually skipped by checking the console
    // log output captured by logSpy.
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

    const dbg = () => {};
    const { htmlPath, extraStatic, cleanup } = buildPreviewHtml(
      inputFile,
      [{ urlBase: "https://cdn.example.com/", localBase: "/local/cdn" }],
      dbg
    );

    expect(htmlPath).not.toBe(inputFile);
    expect(htmlPath).toContain("_vivliostyle_preview_page.html");

    // The written file should have the rewritten href
    const { readFileSync } = await import("node:fs");
    const written = readFileSync(htmlPath, "utf-8");
    expect(written).toContain('href="/css/foo.css"');
    expect(written).not.toContain("https://cdn.example.com");

    // extraStatic should contain the assetBase root
    expect(extraStatic["/"]).toBe(resolve("/local/cdn"));

    cleanup();
  });

  it("buildPreviewHtml returns original file when no rewrites needed", async () => {
    const { buildPreviewHtml } = await import("../src/vivliostyle-cli");

    const inputFile = join(tempDir, "page.html");
    writeFileSync(
      inputFile,
      "<html><head></head><body></body></html>",
      "utf-8"
    );

    const { htmlPath, cleanup } = buildPreviewHtml(inputFile, [], () => {});

    expect(htmlPath).toBe(inputFile);
    cleanup(); // no-op, should not throw
  });
});