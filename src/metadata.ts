// src/metadata.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * Document metadata for the PDF information dictionary and XMP packet:
 * extraction from the input (HTML document or publication manifest) and
 * resolution against the CLI flags.
 *
 * Precedence: CLI flags > publication manifest > document > defaults.
 * The only default is the language tag, which falls back to "de" when
 * neither the flags nor the input provide one.
 */

import type { PdfAConformance, PdfAIdentification, PdfAPart, PdfXIdentification } from "./render/xmp.js";

/** Metadata fields shared by every source (document, manifest, CLI flags). */
export type DocumentMetadata = {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  language?: string;
};

/** Language tag assumed when no source provides one (project contract). */
export const DEFAULT_LANGUAGE = "de";

/**
 * Extracts metadata from the input document: <title>, the usual
 * author/description/keywords meta tags and the document language.
 */
export function extractMetadataFromDocument(document: Document): DocumentMetadata {
  const title = document.querySelector("title")?.textContent?.trim();
  const metaContent = (names: readonly string[]): string | undefined => {
    for (const name of names) {
      const element = document.querySelector(`meta[name="${name}" i]`) ?? document.querySelector(`meta[http-equiv="${name}" i]`);
      const content = element?.getAttribute("content")?.trim();
      if (content !== undefined && content !== "") return content;
    }
    return undefined;
  };
  return {
    ...(title === undefined || title === "" ? {} : { title }),
    ...optional(metaContent(["author", "dc.creator", "dcterms.creator"]), (value) => ({ author: value })),
    ...optional(metaContent(["description", "dc.description"]), (value) => ({ subject: value })),
    ...optional(metaContent(["keywords"]), (value) => ({ keywords: value })),
    ...optional(document.documentElement.getAttribute("lang")?.trim() || metaContent(["content-language"]), (value) => ({
      language: value
    }))
  };
}

/**
 * Extracts metadata from a publication manifest (W3C Web Publication
 * Manifest shape): title, author, description, keywords and language.
 * Returns undefined when the text is not a JSON object.
 */
export function extractMetadataFromManifest(text: string): DocumentMetadata | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (manifest === null || typeof manifest !== "object") return undefined;
  const record = manifest as Record<string, unknown>;
  return {
    ...optional(asString(record.title), (value) => ({ title: value })),
    ...optional(asAuthorList(record.author), (value) => ({ author: value })),
    ...optional(asString(record.description), (value) => ({ subject: value })),
    ...optional(asStringList(record.keywords, ", "), (value) => ({ keywords: value })),
    ...optional(asStringList(record.language ?? record.inLanguage, " "), (value) => ({ language: value }))
  };
}

/**
 * Merges the sources: the CLI fields win over the extracted ones, and the
 * language falls back to the project default.
 */
export function resolveMetadata(cli: DocumentMetadata, derived?: DocumentMetadata): DocumentMetadata & { language: string } {
  const merged: DocumentMetadata = { ...derived, ...definedEntries(cli) };
  if (merged.language === undefined || merged.language === "") {
    merged.language = DEFAULT_LANGUAGE;
  }
  return merged as DocumentMetadata & { language: string };
}

/** Parses a `--pdfa` level like `2b`; part 4 takes no conformance level. */
export function parsePdfaLabel(value: string): PdfAIdentification {
  const match = /^([1-4])([abu])?$/i.exec(value.trim());
  if (match === null) {
    throw new Error(`Invalid --pdfa level: "${value}". Allowed: 1a, 1b, 2a, 2b, 2u, 3a, 3b, 3u, 4`);
  }
  const part = match[1] as PdfAPart;
  const conformance = match[2]?.toLowerCase() as PdfAConformance | undefined;
  if (part === "4" && conformance !== undefined) {
    throw new Error(`PDF/A-4 does not take a conformance level: "${value}". Use --pdfa 4`);
  }
  if (part !== "4" && conformance === undefined) {
    throw new Error(`Missing PDF/A conformance level: "${value}". Use e.g. --pdfa 2b`);
  }
  return { kind: "pdfa", part, ...(conformance === undefined ? {} : { conformance }) };
}

/** Parses a `--pdfx` version; `X-1a` is accepted as shorthand for 2003. */
export function parsePdfxLabel(value: string): PdfXIdentification {
  const normalized = value.trim();
  if (normalized === "X-4") return { kind: "pdfx", version: "X-4" };
  if (normalized === "X-1a" || normalized === "X-1a:2003") return { kind: "pdfx", version: "X-1a:2003" };
  throw new Error(`Invalid --pdfx version: "${value}". Allowed: X-4, X-1a:2003`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function definedEntries(source: DocumentMetadata): DocumentMetadata {
  const entries: DocumentMetadata = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== "") (entries as Record<string, unknown>)[key] = value;
  }
  return entries;
}

function optional<T>(value: T | undefined | null, wrap: (value: T) => DocumentMetadata): DocumentMetadata {
  return value === undefined || value === null || value === "" ? {} : wrap(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Flattens string | {name} | ({name} | string)[] into "a; b" form. */
function asAuthorList(value: unknown): string | undefined {
  const names = Array.isArray(value) ? value : [value];
  const flattened = names
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>).name === "string") {
        return ((entry as Record<string, unknown>).name as string).trim();
      }
      return "";
    })
    .filter((name) => name !== "");
  return flattened.length === 0 ? undefined : flattened.join("; ");
}

function asStringList(value: unknown, separator: string): string | undefined {
  const entries = Array.isArray(value) ? value : [value];
  const flattened = entries.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter((entry) => entry !== "");
  return flattened.length === 0 ? undefined : flattened.join(separator);
}
