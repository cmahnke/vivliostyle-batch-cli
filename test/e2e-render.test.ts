// test/e2e-render.test.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * End-to-end render tests: real Chrome, real settle gate, real PDF output.
 *
 * The structural tests in render-fixtures.test.ts run everywhere; this suite
 * drives the full pipeline (execute → HTML rewrite → static server → viewer →
 * print-to-PDF → post-processing) and asserts on the produced PDF, covering
 * the complex content of the blog this tool was built for:
 *
 * - module-defined globals that appear LATE while an inline classic script
 *   already ran (the maps post's initMap race), with the viewer-context
 *   readyState/DOMContentLoaded pitfall locked as a contract,
 * - custom elements (oxigraph-sparql / rdf-graph patterns) that fetch their
 *   dataset and render only after the response arrives,
 * - lazy-loaded images,
 * - wasm, three.js/WebGL and deferred/async/module script mixes,
 * - PDF/A-2b labeled output (PDF 1.7, XMP identification) passing the
 *   built-in validation and the full verapdf rule set.
 *
 * Per project decision this suite ALWAYS runs and fails hard when Chrome is
 * missing — the renders are the product.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as mupdf from "mupdf";
import { parseArgs, execute } from "../src/vivliostyle-cli.js";
import { resolveBrowserExecutable } from "../src/render/chrome.js";
import { validateLabeledPdf } from "../src/render/pdf-validate.js";
import { runVeraPdf } from "../src/render/verapdf.js";
import { VENDOR_MAP } from "./render-fixtures.test.js";

const PAGES_DIR = resolve(__dirname, "render-fixtures/pages");
const FIXTURE_ROOT = resolve(__dirname, "render-fixtures");
const OUTPUT_DIR = mkdtempSync(join(tmpdir(), "vivliostyle-e2e-"));

// Fail hard, by design: without a browser binary these tests cannot do their
// job and must be loud about it.
beforeAll(() => {
  const browser = resolveBrowserExecutable();
  if (browser === null) {
    throw new Error("E2E render tests require a Chrome/Chromium binary — none found (set --executable-browser or install one)");
  }
});

/**
 * Mirrors the blog's build: the whole fixture root is mounted at `/`
 * (`--static /:./docs/` in the blog), and the fixture.example.test origin is
 * mapped onto the root via --asset-base so deriveSitePath gives the pages a
 * /pages/<name>.html site path — the depth relative URLs like ../tiles need.
 */
function renderArgs(name: string): string[] {
  const args = ["--static", `/:${FIXTURE_ROOT}`, "--asset-base", `https://fixture.example.test/=${FIXTURE_ROOT}`];
  for (const [virtual, local] of Object.entries(VENDOR_MAP)) {
    if (readFileSync(join(PAGES_DIR, name), "utf-8").includes(virtual)) {
      args.push("--static", `${virtual}:${local}`);
    }
  }
  return args;
}

async function renderPages(name: string, argv: string[] = []): Promise<string> {
  const output = join(OUTPUT_DIR, `${name}.pdf`);
  const parsed = parseArgs([
    "node",
    "vivliostyle-batch-cli",
    "-i",
    join(PAGES_DIR, name),
    "-o",
    output,
    "--log-level",
    "info",
    ...renderArgs(name),
    ...argv
  ]);
  if (parsed === null) throw new Error("parseArgs returned null");
  await execute(parsed.options, parsed.extraArgs);
  if (!existsSync(output)) throw new Error(`render did not produce ${output}`);
  return output;
}

function openPdf(output: string): { document: mupdf.PDFDocument; text: (page: number) => string; pixmap: (page: number) => mupdf.Pixmap } {
  const document = mupdf.PDFDocument.openDocument(readFileSync(output), "application/pdf") as mupdf.PDFDocument;
  return {
    document,
    text: (page) =>
      document
        .loadPage(page)
        .toStructuredText({} as never)
        .asText(),
    pixmap: (page) => document.loadPage(page).toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false)
  };
}

/** Share of non-white sample points on a rendered page. */
function nonWhiteShare(pixmap: mupdf.Pixmap): number {
  const pixels = pixmap.getPixels();
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const components = pixmap.getNumberOfComponents() + pixmap.getAlpha();
  let nonWhite = 0;
  let samples = 0;
  for (let y = 0; y < height; y += 7) {
    for (let x = 0; x < width; x += 7) {
      const offset = (y * width + x) * components;
      if (pixels[offset] !== 255 || pixels[offset + 1] !== 255 || pixels[offset + 2] !== 255) nonWhite++;
      samples++;
    }
  }
  return nonWhite / samples;
}

describe("e2e render (real Chrome)", () => {
  it("iframe fixture renders the child document into the PDF", async () => {
    const output = await renderPages("01-iframe.html", []);
    const pdf = openPdf(output);
    expect(pdf.text(0)).toContain("mocked srcdoc content 42");
    pdf.document.destroy();
  }, 120_000);

  it("three.js fixture paints its WebGL canvas into the PDF", async () => {
    const output = await renderPages("02-threejs.html", []);
    const pdf = openPdf(output);
    expect(nonWhiteShare(pdf.pixmap(0))).toBeGreaterThan(0.01);
    expect(pdf.text(0)).toContain("mocked box 42");
    pdf.document.destroy();
  }, 120_000);

  it("echarts fixture paints its chart into the PDF", async () => {
    const output = await renderPages("03-echarts.html", []);
    const pdf = openPdf(output);
    expect(pdf.text(0)).toContain("mocked sales 42");
    pdf.document.destroy();
  }, 120_000);

  it("d3 fixture paints its bars into the PDF", async () => {
    const output = await renderPages("04-d3.html", []);
    const pdf = openPdf(output);
    expect(pdf.text(0)).toContain("mocked d3 bars 42");
    pdf.document.destroy();
  }, 120_000);

  it("openseadragon fixture loads its tiles into the PDF", async () => {
    const output = await renderPages("05-openseadragon.html", []);
    const pdf = openPdf(output);
    expect(nonWhiteShare(pdf.pixmap(0))).toBeGreaterThan(0.05);
    pdf.document.destroy();
  }, 120_000);

  it("HiDPI canvas fixture renders sharp after the __vivResize redraw", async () => {
    const output = await renderPages("06-canvas-hires.html", []);
    const pdf = openPdf(output);
    expect(pdf.text(0)).toContain("mocked hires grid 42");
    // The 1px grid is sparse at dpr 1: ~4.3% non-white with 7px sampling,
    // so the threshold stays below the dense-content fixtures' 0.05.
    expect(nonWhiteShare(pdf.pixmap(0))).toBeGreaterThan(0.03);
    pdf.document.destroy();
  }, 120_000);

  it("aframe fixture renders its mocked scene into the PDF", async () => {
    const output = await renderPages("07-aframe.html", []);
    const pdf = openPdf(output);
    expect(nonWhiteShare(pdf.pixmap(0))).toBeGreaterThan(0.01);
    pdf.document.destroy();
  }, 120_000);

  it("wasm fixture paints its streamed module output into the PDF", async () => {
    const output = await renderPages("08-wasm.html", []);
    const pdf = openPdf(output);
    expect(pdf.text(0)).toContain("mocked wasm painted 42");
    expect(nonWhiteShare(pdf.pixmap(0))).toBeGreaterThan(0.05);
    pdf.document.destroy();
  }, 120_000);

  it("deferred/async/module fixture waits for all three script kinds", async () => {
    const output = await renderPages("09-deferred-async.html", []);
    const pdf = openPdf(output);
    expect(pdf.text(0)).toContain("mocked d3 bars 42");
    pdf.document.destroy();
  }, 120_000);

  it("module global arriving late still renders (maps initMap race), and the viewer-context pitfall holds", async () => {
    const output = await renderPages("10-module-global-late.html", []);
    const pdf = openPdf(output);
    const pageText = pdf.text(0);
    // The module painted its canvas content ("mocked map tiles 42" is
    // canvas text; the row text is DOM) and the inline poller saw it.
    expect(nonWhiteShare(pdf.pixmap(0))).toBeGreaterThan(0.01);
    expect(pageText).toContain("module global ready 42");
    expect(pageText).toContain("initMapLate ran after");
    // The pitfall contract: in the viewer context page scripts observe
    // readyState "complete" and DOMContentLoaded never fires for them.
    // Locked here so a viewer change that alters either gets noticed.
    expect(pageText).toContain("exec readyState=complete");
    pdf.document.destroy();
  }, 120_000);

  it("custom element fetches its dataset and the PDF contains the rows (oxigraph pattern)", async () => {
    // The data-url is an absolute fixture URL mapped onto the pages
    // directory via --asset-base, like the blog maps its CDN URLs.
    const output = await renderPages("11-custom-element-data.html");
    const pdf = openPdf(output);
    const pageText = pdf.text(0);
    expect(pageText).toContain("mocked sparql row 42");
    expect(pageText).toContain("mocked sparql rows 42");
    pdf.document.destroy();
  }, 120_000);

  it("lazy images load before pagination and end up in the PDF", async () => {
    const output = await renderPages("12-lazy-images.html", []);
    const pdf = openPdf(output);
    // Chrome's print pipeline forces lazy images in; all three tiles must
    // be present as image XObjects on the pages.
    let imageCount = 0;
    for (let page = 0; page < pdf.document.countPages(); page++) {
      const xObjects = pdf.document.loadPage(page).getObject().get("Resources").resolve().get("XObject");
      if (!xObjects.isDictionary()) continue;
      xObjects.forEach((value: mupdf.PDFObject) => {
        if (value.resolve().get("Subtype").asName() === "Image") imageCount++;
      });
    }
    expect(imageCount).toBeGreaterThanOrEqual(3);
    expect(nonWhiteShare(pdf.pixmap(0))).toBeGreaterThan(0.05);
    pdf.document.destroy();
  }, 120_000);

  it("canvas graph from fetched data renders (rdf-graph/cytoscape pattern)", async () => {
    const output = await renderPages("13-canvas-graph.html");
    const pdf = openPdf(output);
    expect(pdf.text(0)).toContain("mocked rdf graph 42");
    expect(nonWhiteShare(pdf.pixmap(0))).toBeGreaterThan(0.01);
    pdf.document.destroy();
  }, 120_000);

  it("PDF/A-2b labeled output passes the built-in validation and verapdf", async () => {
    const output = await renderPages("06-canvas-hires.html", ["--pdfa", "2b", "--verapdf"]);
    // The build itself already validated (built-in checks + verapdf via
    // --verapdf); assert the artifacts here so a regression fails loudly.
    expect(readFileSync(output).subarray(0, 8).toString()).toBe("%PDF-1.7");
    const violations = validateLabeledPdf(readFileSync(output), { kind: "pdfa", part: "2", conformance: "b" });
    expect(violations).toEqual([]);
    const vera = runVeraPdf(output, { kind: "pdfa", part: "2", conformance: "b" });
    if (!vera.ran) throw new Error(`verapdf binary required for this suite: ${vera.reason}`);
    expect(vera.passed, vera.output).toBe(true);
  }, 180_000);
});
