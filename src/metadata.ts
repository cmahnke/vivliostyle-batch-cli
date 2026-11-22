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
  /** Normalized bare DOI (10.…/…); reference managers read it as dc:identifier. */
  doi?: string;
  /** Source URL of the document, used as dc:identifier when no DOI is known. */
  url?: string;
  language?: string;
  /** ISO 8601 creation date (information dictionary and XMP CreateDate). */
  created?: string;
  /** ISO 8601 modification date (information dictionary and XMP ModifyDate). */
  modified?: string;
};

/** Language tag assumed when no source provides one (project contract). */
export const DEFAULT_LANGUAGE = "de";

// Bare DOI form (ISO 26324): a directory indicator plus a suffix. Accepts
// variants authors hand over: bare, doi: URIs and resolver URLs.
export const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

/**
 * Normalizes a DOI the user supplied: resolver URLs (`https://doi.org/…`,
 * `http://dx.doi.org/…`, `https://hdl.handle.net/…` keeps `10.` handles) and
 * `doi:` URIs reduce to the bare form, which is validated against ISO 26324.
 * Returns undefined when the value is not a DOI at all.
 */
export function normalizeDoi(value: string): string | undefined {
  let doi = value.trim();
  for (const prefix of ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi:"]) {
    if (doi.toLowerCase().startsWith(prefix.toLowerCase())) {
      doi = doi.slice(prefix.length);
      break;
    }
  }
  doi = doi.trim();
  if (!DOI_PATTERN.test(doi)) return undefined;
  return doi;
}

/** Reads a DOI from a meta content, ignoring values that are not DOIs. */
function doiMetaContent(names: readonly string[], document: Document): string | undefined {
  const content = metaContentOf(names, document);
  return content === undefined ? undefined : normalizeDoi(content);
}

/**
 * Extracts a document URL: the canonical link wins, then the usual
 * URL meta tags. Only absolute http(s) URLs are accepted.
 */
function extractDocumentUrl(document: Document): string | undefined {
  const candidates: Array<string | null | undefined> = [
    document.querySelector('link[rel="canonical" i]')?.getAttribute("href"),
    document.querySelector('meta[property="og:url" i]')?.getAttribute("content"),
    document.querySelector('meta[name="citation_url" i]')?.getAttribute("content"),
    document.querySelector('meta[name="dc.url" i]')?.getAttribute("content")
  ];
  for (const candidate of candidates) {
    const url = candidate?.trim();
    if (url === undefined || url === "") continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return url;
  }
  return undefined;
}

/** First non-empty `content` of the named meta tags (name or http-equiv). */
function metaContentOf(names: readonly string[], document: Document): string | undefined {
  for (const name of names) {
    const element = document.querySelector(`meta[name="${name}" i]`) ?? document.querySelector(`meta[http-equiv="${name}" i]`);
    const content = element?.getAttribute("content")?.trim();
    if (content !== undefined && content !== "") return content;
  }
  return undefined;
}

/**
 * Extracts metadata from the input document: <title>, the usual
 * author/description/keywords meta tags, the DOI (citation_doi, dc.doi,
 * dc.identifier when it holds a DOI), the document URL (canonical link,
 * og:url), the creation/modification dates (dcterms, falling back to the
 * plain date meta tag) and the document language.
 */
export function extractMetadataFromDocument(document: Document): DocumentMetadata {
  const title = document.querySelector("title")?.textContent?.trim();
  return {
    ...(title === undefined || title === "" ? {} : { title }),
    ...optional(metaContentOf(["author", "dc.creator", "dcterms.creator"], document), (value) => ({ author: value })),
    ...optional(metaContentOf(["description", "dc.description"], document), (value) => ({ subject: value })),
    ...optional(metaContentOf(["keywords"], document), (value) => ({ keywords: value })),
    ...optional(doiMetaContent(["citation_doi", "dc.doi", "dc.identifier", "doi"], document), (value) => ({ doi: value })),
    ...optional(extractDocumentUrl(document), (value) => ({ url: value })),
    ...optional(metaContentOf(["dcterms.created", "dc.date", "date"], document), (value) => ({ created: value })),
    ...optional(metaContentOf(["dcterms.modified", "dc.date.modified", "modified"], document), (value) => ({ modified: value })),
    ...optional(document.documentElement.getAttribute("lang")?.trim() || metaContentOf(["content-language"], document), (value) => ({
      language: value
    }))
  };
}

/**
 * Extracts metadata from a publication manifest (W3C Web Publication
 * Manifest shape): title, author, description, keywords, DOI, URL and
 * language. Returns undefined when the text is not a JSON object.
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
    ...optional(asDoi(record.doi ?? record.identifier), (value) => ({ doi: value })),
    ...optional(asUrl(record.url), (value) => ({ url: value })),
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

/** Reads a DOI from a manifest value; non-DOI identifiers are ignored. */
function asDoi(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeDoi(value);
}

/** Reads a http(s) URL from a manifest value; relative links are ignored. */
function asUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const url = value.trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return url;
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
