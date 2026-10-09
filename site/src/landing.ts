import "./style.css";
import { marked } from "marked";
import readme from "../../README.md?raw";

/**
 * Landing page: the README is the single source of truth for install and
 * usage docs. Vite inlines it at build time (?raw), so the page works
 * offline and never drifts from the repo manual.
 */
async function main(): Promise<void> {
  const article = document.getElementById("manual");
  if (article === null) return;
  try {
    article.innerHTML = String(await marked.parse(readme));
    for (const anchor of article.querySelectorAll('a[href^="http"]')) {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener");
    }
  } catch {
    article.innerHTML =
      "<p>Could not render the manual here. Read it in the " +
      '<a href="https://github.com/cmahnke/vivliostyle-batch-cli">repository</a>.</p>';
  }
}

void main();
