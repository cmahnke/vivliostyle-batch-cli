// test/render-fixtures/pages/10-map-module.js

// Mock of the blog's osm-map module: an ES module loaded via src that only
// defines its global AFTER evaluation (which the CLI's asset server can
// schedule well after the inline scripts ran), fetches its dataset by
// RELATIVE URL once invoked, and paints a deterministic canvas.

export function initMapLate(elementId, dataUrl) {
  const map = document.getElementById(elementId);
  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 200;
  canvas.style.width = "400px";
  canvas.style.height = "200px";
  map.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const instance = {
    updateSize() {
      // OpenLayers no-op in the mock: size is CSS-driven.
    }
  };

  fetch(dataUrl)
    .then((response) => {
      if (!response.ok) throw new Error("fetch failed: " + response.status);
      return response.json();
    })
    .then((markers) => {
      ctx.fillStyle = "#efe9db";
      ctx.fillRect(0, 0, 400, 200);
      for (const marker of markers) {
        ctx.fillStyle = "#3b6ea5";
        ctx.fillRect(marker.x - 4, marker.y - 4, 8, 8);
      }
      ctx.fillStyle = "#111";
      ctx.font = "16px serif";
      ctx.fillText("mocked map tiles 42", 10, 20);
      window.__vivMarkersPainted = markers.length;
      document.getElementById("late-status").textContent = "module global ready 42";
      window.__vivReady = true;
    })
    .catch((err) => {
      map.textContent = "data fetch failed: " + err;
      window.__vivFetchFailed = String(err);
      window.__vivReady = true;
    });
  return instance;
}

// Module top-level declarations are module-scoped: the global the inline
// poller waits for only exists once evaluation publishes it.
window.initMapLate = initMapLate;
