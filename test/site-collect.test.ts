// test/site-collect.test.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * Showcase collector: input-URL rewriting and render-log parsing.
 *
 * The deployed input copies must not contain absolute `/vendor/` URLs (the
 * Pages base path is not `/`), the importmap must stay ahead of the module
 * script, and the manifest fields must parse out of real render logs.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  FIXTURES,
  VENDOR_DIRS,
  VENDOR_FILES,
  hasAbsoluteVendorUrl,
  parseFramesSegment,
  parseWaitDetail,
  rewriteInputHtml
} from "../site/collect-manifest.mjs";

const REPO_ROOT = resolve(__dirname, "..");

describe("showcase input rewriting", () => {
  it("rewrites quoted absolute vendor URLs to inputs-relative ones", () => {
    const html = [
      '<script src="/vendor/echarts/dist/echarts.min.js"></script>',
      "<script src='/vendor/d3/dist/d3.min.js'></script>",
      '<script type="importmap">{"imports":{"three":"/vendor/three/build/three.module.js"}}</script>',
      'prefixUrl: "/vendor/openseadragon/build/openseadragon/images/"'
    ].join("\n");
    const rewritten = rewriteInputHtml(html);
    expect(hasAbsoluteVendorUrl(rewritten)).toBe(false);
    expect(rewritten).toContain('"../vendor/echarts/dist/echarts.min.js"');
    expect(rewritten).toContain('"../vendor/three/build/three.module.js"');
    // Relative references (tiles, sibling pages) pass through untouched.
    expect(rewriteInputHtml('<img src="../tiles/osd/preview.png"><iframe src="./iframe-child.html">')).toContain(
      "../tiles/osd/preview.png"
    );
  });

  it("keeps the importmap ahead of the module script", () => {
    const html =
      '<script type="importmap">{"imports":{"three":"/vendor/three/build/three.module.js"}}</script>\n<script type="module">import "three";</script>';
    const rewritten = rewriteInputHtml(html);
    expect(rewritten.indexOf("importmap")).toBeLessThan(rewritten.indexOf('type="module"'));
  });

  it("every real fixture page rewrites cleanly", async () => {
    const { readFileSync } = await import("node:fs");
    for (const fixture of FIXTURES) {
      const html = readFileSync(join(REPO_ROOT, "test/render-fixtures/pages", fixture.page), "utf-8");
      expect(hasAbsoluteVendorUrl(rewriteInputHtml(html)), fixture.id).toBe(false);
    }
  });

  it("vendor allowlist points at installed files", () => {
    for (const file of [...VENDOR_FILES, ...VENDOR_DIRS]) {
      expect(existsSync(join(REPO_ROOT, "node_modules", file)), file).toBe(true);
    }
  });
});

describe("showcase log parsing", () => {
  const waitLine =
    `[wait] layout gate settled after 3ms {"reason":"ready","ms":1140,"pending":0,"frames":0,` +
    `"canvases":"600x300@600x300","containers":"hires@600x300","mutations":3,"dpr":1,"painted":1,"ready":1}`;
  const framesLine =
    `[render] frames: canvas-hires canvases=[1200x600@600x300] iframes=0 ` +
    `webgl=true/2=true webgpu=true resized=[1200x600@600x300] | iframe canvases=[] iframes=2 webgl=true/2=true webgpu=false`;

  it("parseWaitDetail reads reason, canvases and dpr", () => {
    expect(parseWaitDetail(waitLine)).toEqual({ gateState: "settled", reason: "ready", canvases: "600x300@600x300", dpr: 1 });
  });

  it("parseWaitDetail tolerates a deadline line without detail JSON", () => {
    expect(parseWaitDetail("[wait] layout gate deadline after 12000ms — content may be incomplete")).toEqual({
      gateState: "deadline",
      reason: null,
      canvases: null,
      dpr: null
    });
  });

  it("parseWaitDetail returns nulls without a gate line", () => {
    expect(parseWaitDetail("nothing here")).toEqual({ gateState: null, reason: null, canvases: null, dpr: null });
  });

  it("parseFramesSegment reads the matching frame only", () => {
    expect(parseFramesSegment(framesLine, "canvas-hires")).toEqual({
      canvases: "1200x600@600x300",
      resized: "1200x600@600x300",
      webgl: true,
      webgl2: true,
      webgpu: true,
      iframeCount: 0
    });
    expect(parseFramesSegment(framesLine, "iframe")).toMatchObject({ iframeCount: 2, webgpu: false });
  });

  it("parseFramesSegment returns nulls for an absent frame", () => {
    expect(parseFramesSegment(framesLine, "threejs")).toEqual({
      canvases: null,
      resized: null,
      webgl: null,
      webgl2: null,
      webgpu: null,
      iframeCount: null
    });
  });
});
