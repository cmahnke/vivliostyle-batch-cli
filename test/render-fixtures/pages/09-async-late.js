// test/render-fixtures/pages/09-async-late.js

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * Loaded with `<script async>` by 09-deferred-async.html, so it may execute
 * before, between or after that page's deferred scripts. Deliberately
 * self-contained (no d3): it paints its own canvas, and the page's readiness
 * is gated on `window.__vivAsyncPainted`, which proves the settle gate waits
 * for out-of-order script execution instead of paginating early.
 */
(function () {
  function paint(factor) {
    var canvas = document.getElementById("late-canvas");
    if (canvas === null) return;
    var width = 600;
    var height = 100;
    canvas.width = Math.ceil(width * factor);
    canvas.height = Math.ceil(height * factor);
    var ctx = canvas.getContext("2d");
    ctx.scale(factor, factor);
    ctx.fillStyle = "#f5f5f5";
    ctx.fillRect(0, 0, width, height);
    var bands = ["#3366cc", "#cc3333", "#33aa66"];
    for (var i = 0; i < bands.length; i++) {
      ctx.fillStyle = bands[i];
      ctx.fillRect(30 + i * 180, 24, 120, 60);
    }
    ctx.fillStyle = "#111";
    ctx.font = "16px serif";
    ctx.fillText("mocked async late 42", 30, 18);
    window.__vivAsyncPainted = true;
  }

  paint(1);
  window.__vivAsyncRepaint = function (factor) {
    paint(factor);
  };
})();
