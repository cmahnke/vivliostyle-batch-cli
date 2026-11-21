// test/render-fixtures/pages/11-data-grid.js

// Mock of the blog's client-sparql component: a custom element defined in an
// ES module loaded via src, with auto-execute that fetches its dataset from
// the data-url attribute (an absolute URL mapped through --asset-base) and
// renders light-DOM div rows only after the response arrives. The settle
// gate must keep pagination waiting until the rows are in the document.

class DataGrid extends HTMLElement {
  connectedCallback() {
    if (this.dataset.executed) return;
    this.dataset.executed = "true";
    if (!this.hasAttribute("auto-execute")) return;
    const status = document.getElementById("grid-status");
    fetch(this.dataset.url)
      .then((response) => {
        if (!response.ok) throw new Error("fetch failed: " + response.status);
        return response.json();
      })
      .then((rows) => {
        for (const row of rows) {
          const rowDiv = document.createElement("div");
          rowDiv.className = "row";
          const id = document.createElement("span");
          id.className = "id";
          id.textContent = String(row.id);
          const label = document.createElement("span");
          label.textContent = row.label;
          rowDiv.appendChild(id);
          rowDiv.appendChild(label);
          this.appendChild(rowDiv);
        }
        window.__vivRowsRendered = rows.length;
        status.textContent = "mocked sparql rows 42";
        window.__vivReady = true;
      })
      .catch((err) => {
        status.textContent = "fetch failed: " + err;
        window.__vivFetchFailed = String(err);
        window.__vivReady = true;
      });
  }
}

customElements.define("data-grid", DataGrid);
