// test/render-fixtures/lib/ready.js

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * Shared readiness contract for the synthetic render fixtures.
 *
 * Pages are intentionally deterministic (no animation loops, no network) so a
 * PDF render can assert on them. When a fixture finished its own async work it
 * sets `window.__vivReady = true` and `window.__vivFixture = "<name>"`.
 *
 * The CLI settle tracker (`buildRuntimeScript` in src/vivliostyle-cli.ts) treats
 * `window.__vivReady === true` as an immediate "ready" signal, without waiting
 * for the quiet period. Pages that render resolution-dependent content (canvas,
 * WebGL) additionally expose `window.__vivResize = (factor) => void`, which the
 * pre-print upscale step calls to redraw at `clientSize * factor` backing
 * pixels while keeping CSS layout size stable.
 *
 * Fixtures inline a copy of this snippet so each page stays a single file; this
 * module documents the contract and is what unit tests assert against.
 */
window.__vivFixture = window.__vivFixture ?? "unknown";
window.__vivReady = false;
window.__vivResize = window.__vivResize ?? null;
function __vivSignalReady(name) {
  window.__vivFixture = name;
  window.__vivReady = true;
}
window.__vivSignalReady = __vivSignalReady;
