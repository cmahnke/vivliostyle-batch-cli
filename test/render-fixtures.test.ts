// test/render-fixtures.test.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * Synthetic render fixtures (iframe, three.js, echarts, d3, OpenSeadragon,
 * HiDPI canvas) plus the render hardening around them.
 *
 * Libraries are never vendored: fixtures reference `/vendor/*` virtual paths
 * that the test harness maps to `node_modules` at runtime (see VENDOR_MAP).
 * Unit tests run without Chrome; integration renders are gated on a browser.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FIXTURE_ROOT = resolve(__dirname, "render-fixtures");
const PAGES_DIR = join(FIXTURE_ROOT, "pages");

/** Virtual `/vendor/*` → real package directory, served via `--static`. */
export const VENDOR_MAP: Record<string, string> = {
  "/vendor/three": resolve(__dirname, "../node_modules/three"),
  "/vendor/echarts": resolve(__dirname, "../node_modules/echarts"),
  "/vendor/d3": resolve(__dirname, "../node_modules/d3"),
  "/vendor/openseadragon": resolve(__dirname, "../node_modules/openseadragon")
};

export const FIXTURE_PAGES = [
  "01-iframe.html",
  "iframe-child.html",
  "02-threejs.html",
  "03-echarts.html",
  "04-d3.html",
  "05-openseadragon.html",
  "06-canvas-hires.html"
] as const;

describe("render fixtures (mocked, offline)", () => {
  it("all fixture pages and mock tiles exist", () => {
    for (const page of FIXTURE_PAGES) {
      expect(existsSync(join(PAGES_DIR, page)), page).toBe(true);
    }
    expect(existsSync(join(FIXTURE_ROOT, "tiles/osd/preview.png"))).toBe(true);
    expect(existsSync(join(FIXTURE_ROOT, "tiles/osd/manifest.json"))).toBe(true);
    expect(existsSync(join(FIXTURE_ROOT, "lib/ready.js"))).toBe(true);
  });

  it("fixtures reference /vendor/* (node_modules), never a CDN", () => {
    const sources = FIXTURE_PAGES.map((p) => readFileSync(join(PAGES_DIR, p), "utf-8")).join("\n");
    expect(sources).toContain("/vendor/");
    for (const host of ["unpkg.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"]) {
      expect(sources).not.toContain(host);
    }
  });

  it("every JS-driven fixture follows the readiness contract", () => {
    for (const page of [
      "01-iframe.html",
      "02-threejs.html",
      "03-echarts.html",
      "04-d3.html",
      "05-openseadragon.html",
      "06-canvas-hires.html"
    ]) {
      const html = readFileSync(join(PAGES_DIR, page), "utf-8");
      expect(html, `${page} sets __vivReady`).toContain("__vivReady");
      expect(html, `${page} tags fixture name`).toContain("__vivFixture");
    }
    for (const page of ["02-threejs.html", "03-echarts.html", "04-d3.html", "06-canvas-hires.html"]) {
      expect(readFileSync(join(PAGES_DIR, page), "utf-8"), `${page} supports HiDPI redraw`).toContain("__vivResize");
    }
  });

  it("mocked datasets are inline (no fetch of remote data)", () => {
    expect(readFileSync(join(PAGES_DIR, "03-echarts.html"), "utf-8")).toContain("mocked sales 42");
    expect(readFileSync(join(PAGES_DIR, "04-d3.html"), "utf-8")).toContain("mocked d3 bars 42");
    expect(readFileSync(join(PAGES_DIR, "05-openseadragon.html"), "utf-8")).toContain("../tiles/osd/preview.png");
    expect(readFileSync(join(PAGES_DIR, "06-canvas-hires.html"), "utf-8")).toContain("mocked hires grid 42");
  });

  it("three.js fixture uses an importmap to node_modules (ESM, no vendored copy)", () => {
    const html = readFileSync(join(PAGES_DIR, "02-threejs.html"), "utf-8");
    expect(html).toContain("importmap");
    expect(html).toContain("/vendor/three/build/three.module.js");
  });

  it("VENDOR_MAP points at installed packages", () => {
    expect(existsSync(join(VENDOR_MAP["/vendor/three"], "build/three.module.js"))).toBe(true);
    expect(existsSync(join(VENDOR_MAP["/vendor/echarts"], "dist/echarts.min.js"))).toBe(true);
    expect(existsSync(join(VENDOR_MAP["/vendor/d3"], "dist/d3.min.js"))).toBe(true);
    expect(existsSync(join(VENDOR_MAP["/vendor/openseadragon"], "build/openseadragon/openseadragon.min.js"))).toBe(true);
  });
});

describe("render hardening (chrome + pre-print + settle)", () => {
  it("chromeArgs enables software WebGL/WebGPU without a GPU", async () => {
    const { chromeArgs } = await import("../src/render/chrome.js");
    const args = chromeArgs();
    expect(args).toContain("--enable-unsafe-swiftshader");
    expect(args).toContain("--use-angle=swiftshader");
    expect(args).toContain("--enable-unsafe-webgpu");
  });

  it("frame probe script scrolls embeds and calls __vivResize(factor)", async () => {
    const { buildFrameProbeScript, summarizeCapabilities } = await import("../src/render/pdf.js");
    const script = buildFrameProbeScript(2);
    expect(script).toContain("scrollIntoView");
    expect(script).toContain("__vivResize");
    expect(script).toContain("webgpu");
    expect(
      summarizeCapabilities([
        {
          url: "http://x/doc",
          ready: true,
          fixture: "canvas-hires",
          webgl: true,
          webgl2: true,
          webgpu: false,
          canvasCount: 1,
          canvases: "600x300@600x300",
          iframeCount: 0,
          dpr: 1,
          resized: "1200x600@600x300"
        }
      ])
    ).toContain("resized=[1200x600@600x300]");
  });

  it("prepareForPrint calls __vivResize(2) in every frame and waits", async () => {
    const { prepareForPrint } = await import("../src/render/pdf.js");
    let waited = 0;
    const Evaluated: string[] = [];
    const page = {
      frames: () => [
        {
          evaluate: async (script: string) => {
            Evaluated.push(script);
            return {
              url: "http://x/a",
              ready: true,
              fixture: "canvas-hires",
              webgl: false,
              webgl2: false,
              webgpu: false,
              canvasCount: 1,
              canvases: "600x300@600x300",
              iframeCount: 0,
              dpr: 1,
              resized: "1200x600@600x300"
            };
          }
        }
      ]
    };
    const origSetTimeout = globalThis.setTimeout;
    (globalThis.setTimeout as unknown) = ((fn: () => void, ms?: number) => {
      waited = ms ?? 0;
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    try {
      const caps = await prepareForPrint(page, { canvasScale: 2, settleMs: 500 });
      expect(caps).toHaveLength(1);
      expect(caps[0].resized).toBe("1200x600@600x300");
      expect(Evaluated[0]).toContain("__vivResize");
      expect(waited).toBe(500);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  it("runtime script signals ready and reports painted canvases", async () => {
    const { buildRuntimeScript } = await import("../src/vivliostyle-cli.js");
    const script = buildRuntimeScript({
      origin: "http://127.0.0.1:1",
      documentBaseUrl: "http://127.0.0.1:1/",
      gate: { quietMs: 400, deadlineMs: 1000 }
    });
    expect(script).toContain("__vivReady");
    expect(script).toContain("paintedCanvases");
    expect(script).toContain("painted=");
    expect(script).toContain('signal("ready")');
  });

  it("static server falls through a stale exact entry to a serving prefix", async () => {
    const { resolveRequestPath } = await import("../src/server.js");
    const mapped = resolveRequestPath(
      "/vendor/echarts/dist/echarts.min.js",
      {
        "/vendor/echarts/dist/echarts.min.js": "/nonexistent/echarts.min.js",
        "/vendor/echarts": VENDOR_MAP["/vendor/echarts"]
      },
      []
    );
    expect(mapped.localPath).toBe(resolve(VENDOR_MAP["/vendor/echarts"], "dist/echarts.min.js"));
  });
});
