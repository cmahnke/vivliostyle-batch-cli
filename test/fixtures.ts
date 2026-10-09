// test/fixtures.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * Synthetic test data.
 *
 * The wrapper is mostly exercised against a static site that references every
 * asset by absolute URL on one origin, which is what the built site looks like.
 * These helpers write such a site into a temporary directory so tests can assert
 * on real files instead of inline HTML snippets.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SITE_HOST = "site.test";
export const SITE_ORIGIN = `https://${SITE_HOST}`;

/** Virtual paths of the synthetic site, mirroring a hashed asset build. */
export const ASSETS = {
  css: "/css/site.1a2b3c.min.abc123.css",
  articleCss: "/css/article.4d5e6f.min.def456.css",
  js: "/js/app.7a8b9c.789abc.js",
  printJs: "/js/print.0d1e2f.000def.js",
  font: "/fonts/body.abcdef.woff2",
  icon: "/images/icon.svg",
  photo: "/post/example/img/photo.jpg",
  thumb: "/post/example/img/thumb.webp",
  gallery: "/post/example/img/gallery.png",
  /** Declared by pages but deliberately absent on disk. */
  missingPhoto: "/post/example/img/gone.jpg",
  /** Declared by pages but only available on the web. */
  remoteBadge: "https://zenodo.org/badge/DOI/10.5281/zenodo.1.svg",
  remoteEmbed: "https://www.youtube.com/embed/abcdef",
  remoteMap: "https://www.google.com/maps/embed?pb=!1",
  remoteImage: "https://img.example.com/remote.png"
} as const;

/** Every asset that exists in the synthetic site. */
export const PRESENT_ASSETS: string[] = [
  ASSETS.css,
  ASSETS.articleCss,
  ASSETS.js,
  ASSETS.printJs,
  ASSETS.font,
  ASSETS.icon,
  ASSETS.photo,
  ASSETS.thumb,
  ASSETS.gallery
];

export function siteUrl(virtualPath: string): string {
  return /^([a-z]+:)?\/\//i.test(virtualPath) ? virtualPath : `${SITE_ORIGIN}${virtualPath}`;
}

/**
 * Writes the asset tree. `omit` removes single files, which is how the tests
 * model an incomplete build.
 */
export function writeSite(root: string, omit: string[] = []): void {
  for (const virtualPath of PRESENT_ASSETS) {
    if (omit.includes(virtualPath)) continue;
    writeFile(root, virtualPath, contentFor(virtualPath));
  }
}

export function writeFile(root: string, virtualPath: string, content: string): string {
  const file = join(root, virtualPath.replace(/^\//, ""));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf-8");
  return file;
}

function contentFor(virtualPath: string): string {
  if (virtualPath.endsWith(".css")) {
    return `@page { size: A4; margin: 1cm; }\nbody { font-family: serif; background-image: url(${ASSETS.icon}); }\n`;
  }
  if (virtualPath.endsWith(".js")) return "// generated\n";
  if (virtualPath.endsWith(".woff2")) return "not-a-real-font";
  return "binary-image-placeholder";
}

export type ArticleParts = {
  title?: string;
  slug?: string;
  author?: string;
  css?: string[];
  js?: string[];
  /** Body markup appended verbatim. */
  body?: string;
  /** Emit `<meta http-equiv="refresh">` pointing at `target`. */
  redirectTo?: string;
  /**
   * Keep asset references root-relative instead of qualifying them with the
   * site origin — the state the document is in after the absolute-URL rewrite.
   */
  relative?: boolean;
};

/**
 * Renders an article page that references the synthetic site by absolute URL.
 */
export function articleHtml(parts: ArticleParts = {}): string {
  const title = parts.title ?? "Synthetic Article";
  const css = parts.css ?? [ASSETS.css, ASSETS.articleCss];
  const js = parts.js ?? [ASSETS.js];

  const ref = (value: string): string => (parts.relative ? value : siteUrl(value));

  const head = [
    `<title>${title}</title>`,
    ...css.map((href) => `<link rel="stylesheet" href="${ref(href)}" integrity="sha384-fixture">`),
    ...js.map((src) => `<script src="${ref(src)}" crossorigin="anonymous"></script>`)
  ];

  if (parts.redirectTo !== undefined) head.push(`<meta http-equiv="refresh" content="0; url=${parts.redirectTo}">`);

  const meta = [
    parts.author === undefined ? `<meta name="author" content="Test Author">` : "",
    parts.slug === undefined ? "" : `<meta name="slug" content="${parts.slug}">`
  ];

  return [
    "<!DOCTYPE html>",
    `<html lang="de"><head><meta charset="utf-8">${meta.filter(Boolean).join("")}${head.join("")}</head>`,
    `<body class="article"><h1 class="post-title">${title}</h1>${parts.body ?? `<img src="${ref(ASSETS.photo)}" alt="photo">`}</body></html>`
  ].join("");
}

/** Writes an article into `<root>/post/<slug>/article.html` and returns its path. */
export function writeArticle(root: string, slug: string, parts: ArticleParts = {}): string {
  return writeFile(root, `/post/${slug}/article.html`, articleHtml({ ...parts, slug }));
}

/** Writes a `<meta http-equiv="refresh">` redirect stub, as Hugo emits for renamed posts. */
export function writeRedirectStub(root: string, slug: string, target: string): string {
  return writeFile(
    root,
    `/post/${slug}/article.html`,
    [
      "<!DOCTYPE html>",
      '<html lang="de"><head><meta charset="utf-8">',
      `<title>${target}</title>`,
      `<link rel="canonical" href="${target}">`,
      `<meta http-equiv="refresh" content="0; url=${target}">`,
      "</head><body></body></html>"
    ].join("")
  );
}
