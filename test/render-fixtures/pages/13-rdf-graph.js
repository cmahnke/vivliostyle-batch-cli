// test/render-fixtures/pages/13-rdf-graph.js

// Mock of the blog's graph-viz component (custom element "rdf-graph",
// cytoscape canvas rendering): fetch the dataset, then paint a deterministic
// node-link graph on a canvas. Supports the HiDPI redraw contract
// (__vivResize) the pre-print upscale step calls.

function paintGraph(canvas, graph, factor) {
  factor = factor || 1;
  canvas.width = Math.ceil(500 * factor);
  canvas.height = Math.ceil(300 * factor);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(factor, 0, 0, factor, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 500, 300);
  ctx.strokeStyle = "#888";
  for (const edge of graph.edges) {
    const a = graph.nodes[edge[0]];
    const b = graph.nodes[edge[1]];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  for (const node of graph.nodes) {
    ctx.fillStyle = node.color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, 10, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#111";
  ctx.font = "16px serif";
  ctx.fillText("mocked rdf graph 42", 12, 24);
}

class RdfGraph extends HTMLElement {
  connectedCallback() {
    if (this.dataset.executed) return;
    this.dataset.executed = "true";
    if (!this.hasAttribute("auto-execute")) return;
    const status = document.getElementById("graph-status");
    const canvas = document.createElement("canvas");
    this.appendChild(canvas);
    let graph = null;
    fetch(this.dataset.url)
      .then((response) => {
        if (!response.ok) throw new Error("fetch failed: " + response.status);
        return response.json();
      })
      .then((data) => {
        graph = data;
        paintGraph(canvas, graph, 1);
        window.__vivGraphNodes = graph.nodes.length;
        status.textContent = "mocked rdf graph 42";
        window.__vivReady = true;
      })
      .catch((err) => {
        status.textContent = "fetch failed: " + err;
        window.__vivFetchFailed = String(err);
        window.__vivReady = true;
      });
    window.__vivResize = function (factor) {
      if (graph) paintGraph(canvas, graph, factor);
    };
  }
}

customElements.define("rdf-graph", RdfGraph);
