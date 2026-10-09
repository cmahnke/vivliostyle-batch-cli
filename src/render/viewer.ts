// src/render/viewer.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * Locates the Vivliostyle viewer that renders the document.
 *
 * The viewer is served by our own static server (see src/server.ts) so that the
 * document's origin — and with it the base URI of the scripts the page runs — is
 * the site we serve.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

/** Directory of `@vivliostyle/viewer/lib`, which holds index.html and assets. */
export function resolveViewerLibDir(): string {
  const candidates: string[] = [];

  try {
    candidates.push(dirname(require.resolve("@vivliostyle/viewer/package.json")));
  } catch {
    // fall through to the paths below
  }

  candidates.push(
    resolve(dirname(fileURLOfSelf()), "../node_modules/@vivliostyle/viewer"),
    "/usr/local/lib/node_modules/@vivliostyle/viewer",
    "/usr/lib/node_modules/@vivliostyle/viewer"
  );

  for (const candidate of candidates) {
    const libDir = join(candidate, "lib");
    if (existsSync(join(libDir, "index.html"))) return libDir;
  }

  throw new Error("Could not find @vivliostyle/viewer. Install it as a dependency of this package.");
}

function fileURLOfSelf(): string {
  return new URL(import.meta.url).pathname;
}
