import "./style.css";

type FixtureEntry = {
  id: string;
  title: string;
  lib: string;
  inputHtml: string | null;
  pdf: string | null;
  bytes: number;
  pass: boolean | null;
  settleReason: string | null;
  canvases: string | null;
  resized: string | null;
  dpr: number | null;
  webgl: boolean | null;
  webgl2: boolean | null;
  webgpu: boolean | null;
  iframeCount: number | null;
  logExcerpt: string;
};

type Manifest = {
  generatedAt: string;
  commit: string | null;
  runUrl: string | null;
  fixtures: FixtureEntry[];
};

function esc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function badge(pass: boolean | null): string {
  if (pass === true) return `<span class="badge pass">pass</span>`;
  if (pass === false) return `<span class="badge fail">fail</span>`;
  return `<span class="badge pending">pending</span>`;
}

function text(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return esc(String(value));
}

function metricRow(label: string, value: string | number | boolean | null | undefined): string {
  return `<tr><th scope="row">${esc(label)}</th><td><code>${text(value)}</code></td></tr>`;
}

function card(entry: FixtureEntry): string {
  const inputPane =
    entry.inputHtml === null
      ? `<p>No input page recorded.</p>`
      : `<iframe src="${esc(entry.inputHtml)}" title="Input: ${esc(entry.title)}" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe>
         <p><a href="${esc(entry.inputHtml)}">Open full page</a></p>`;
  const outputPane =
    entry.pdf === null
      ? `<p>No PDF yet — render the fixtures to fill this pane.</p>`
      : `<object data="${esc(entry.pdf)}" type="application/pdf" title="Output: ${esc(entry.title)}">
           <p><a href="${esc(entry.pdf)}">Download PDF</a></p>
         </object>
         <p><a href="${esc(entry.pdf)}">Download PDF</a></p>`;
  return `<section class="card">
    <h2>${esc(entry.title)} ${badge(entry.pass)} <small>${esc(entry.lib)}</small></h2>
    <div class="panes">
      <div><h3>Input</h3>${inputPane}</div>
      <div><h3>Output</h3>${outputPane}</div>
    </div>
    <table class="metrics">
      ${metricRow("PDF bytes", entry.bytes > 0 ? entry.bytes : null)}
      ${metricRow("Settle reason", entry.settleReason)}
      ${metricRow("Canvases (backing@css)", entry.canvases)}
      ${metricRow("After upscale", entry.resized)}
      ${metricRow("devicePixelRatio", entry.dpr)}
      ${metricRow("webgl / webgl2 / webgpu", [entry.webgl, entry.webgl2, entry.webgpu].map((v) => (v === null ? "—" : String(v))).join(" / "))}
      ${metricRow("Iframes", entry.iframeCount)}
    </table>
    <details><summary>Render log</summary><pre>${esc(entry.logExcerpt || "No log recorded.")}</pre></details>
  </section>`;
}

async function main(): Promise<void> {
  const app = document.getElementById("app");
  if (app === null) return;
  let manifest: Manifest;
  try {
    const response = await fetch("fixtures/manifest.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = (await response.json()) as Manifest;
  } catch {
    app.innerHTML =
      `<header><h1>Render fixtures</h1>` +
      `<p>Could not load <code>fixtures/manifest.json</code>. Run the fixture renders first.</p></header>`;
    return;
  }
  const runLink =
    manifest.runUrl === null || manifest.runUrl === "" || manifest.commit === null
      ? esc(manifest.commit ?? "local")
      : `<a href="${esc(manifest.runUrl)}">${esc(manifest.commit)}</a>`;
  app.innerHTML =
    `<header><h1>Render fixtures</h1>` +
    `<p>JS-painted content (canvas, WebGL, iframes, tiled images) rendered to PDF by vivliostyle-batch-cli. ` +
    `Commit ${runLink}, generated ${esc(manifest.generatedAt)}.</p></header>` +
    `<main>${manifest.fixtures.map(card).join("")}</main>`;
}

void main();
