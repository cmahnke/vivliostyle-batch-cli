// src/render/verapdf.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * Optional pass-through to the verapdf binary (https://verapdf.org/), which
 * implements the full ISO conformance rule sets for PDF/A and PDF/X. The
 * binary must be on the PATH; it is never bundled because it needs a Java
 * runtime. Only invoked on explicit request (--verapdf).
 */

import { spawnSync } from "node:child_process";
import type { PdfLabel } from "./xmp.js";

export type VeraPdfResult = {
  /** Whether the binary actually ran. */
  ran: boolean;
  /** Validation outcome; undefined when the binary could not be started. */
  passed?: boolean;
  exitCode?: number | null;
  output?: string;
  reason?: string;
};

/** Maps a standards label onto a veraPDF --flavour value. */
export function veraPdfFlavour(label: PdfLabel): string {
  if (label.kind === "pdfa") {
    return label.part === "4" ? "4" : `${label.part}${label.conformance ?? ""}`;
  }
  return label.version === "X-4" ? "X-4" : "X-1a";
}

export function runVeraPdf(pdfPath: string, label: PdfLabel): VeraPdfResult {
  const flavour = veraPdfFlavour(label);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("verapdf", ["--flavour", flavour, "--format", "text", pdfPath], {
      encoding: "utf-8",
      timeout: 120_000
    });
  } catch (error) {
    return { ran: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ran: false,
      reason: code === "ENOENT" ? "verapdf binary not found on PATH" : String(result.error)
    };
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const output = `${stdout}${stderr}`.slice(0, 4000);
  return { ran: true, passed: /\bPASS\b/.test(stdout), exitCode: result.status, output };
}
