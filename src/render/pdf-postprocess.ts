// src/render/pdf-postprocess.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * PDF post-processing: document metadata, XMP and standards labeling.
 *
 * Runs on the PDF bytes Chrome printed (Skia output) and applies:
 * - document information entries (title, author, subject, keywords, producer, creator)
 * - the catalog /Lang entry for the document language
 * - an XMP metadata stream kept consistent with the information dictionary
 * - PDF/A or PDF/X identification: XMP identification properties, an
 *   OutputIntent with an embedded ICC profile and a stable file identifier
 *
 * This is a "label, don't convert" step — the same semantics vivliostyle-cli
 * gives its PDF/X option: the content is neither converted nor checked, so
 * conformance of the content is the author's responsibility. Verify with
 * veraPDF (or a print provider's preflight) when it matters.
 *
 * The editing follows vivliostyle-cli's mupdf-based post-processing
 * (src/output/pdfx.ts, pdf-document.ts, pdf-version.ts at v11.4).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import { buildXmpPacket, pdfDateToXmpDate, toXmpDate, xmpDateToPdfDate, type PdfLabel } from "./xmp.js";

/** Document metadata written to the information dictionary and the XMP packet. */
export type PdfMetadata = {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  language?: string;
  /** ISO 8601 or PDF date; overrides the creation date the print backend wrote. */
  created?: string;
  /** ISO 8601 or PDF date; overrides the modification date the print backend wrote. */
  modified?: string;
  creator: string;
  producer: string;
};

export type PostProcessOptions = {
  metadata: PdfMetadata;
  label?: PdfLabel;
  /** ICC profile embedded as the OutputIntent; required whenever a label is set. */
  iccProfile?: Uint8Array;
  iccProfileName?: string;
};

type Destroyable = { destroy(): void };

type Scope = {
  track<T extends Destroyable>(value: T): T;
  dispose(): void;
};

/**
 * Tracks MuPDF's native objects and destroys them in reverse order. Every
 * PDFObject/Buffer/ColorSpace keeps native memory behind the wasm binding,
 * which is only reclaimed on an explicit destroy.
 */
function createScope(): Scope {
  const tracked: Destroyable[] = [];
  return {
    track<T extends Destroyable>(value: T): T {
      tracked.push(value);
      return value;
    },
    dispose(): void {
      while (tracked.length > 0) {
        try {
          tracked.pop()?.destroy();
        } catch {
          // Cleanup is best-effort; a failed destroy must not mask the result.
        }
      }
    }
  };
}

// MuPDF exposes PDF version x.y as x * 10 + y.
type PdfVersion = 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 20;

/**
 * The PDF version each standards label is defined against: PDF/A-1 and
 * PDF/X-1a:2003 on PDF 1.4, PDF/X-4 on PDF 1.6, PDF/A-2 and PDF/A-3 on
 * PDF 1.7 (ISO 32000-1) and PDF/A-4 on PDF 2.0 (ISO 32000-2).
 */
export function minimumVersionForLabel(label: PdfLabel): PdfVersion {
  if (label.kind === "pdfa") {
    if (label.part === "1") return 14;
    if (label.part === "4") return 20;
    return 17;
  }
  return label.version === "X-4" ? 16 : 14;
}

// The catalog /Version is written for every required version; MuPDF's wasm
// binding provides no API for the header version and a full save derives the
// header from the catalog entry (same approach as vivliostyle-cli).
function setMinimumPdfVersion(document: mupdf.PDFDocument, minimumVersion: PdfVersion, scope: Scope): void {
  if (document.getVersion() >= minimumVersion) return;
  const trailer = scope.track(document.getTrailer());
  const catalog = scope.track(trailer.get("Root"));
  const version = scope.track(document.newName(`${Math.trunc(minimumVersion / 10)}.${minimumVersion % 10}`));
  catalog.put("Version", version);
}

function readInfoString(info: mupdf.PDFObject, key: string, scope: Scope): string | undefined {
  const value = scope.track(info.get(key));
  return value.isString() ? value.asString() : undefined;
}

/**
 * Parses an explicitly given date (ISO 8601, optionally date-only, or the PDF
 * "D:…" form) into both formats the document needs: the information
 * dictionary date (ISO 32000-1:2008, 7.9.4) and the XMP date (XMP Part 1,
 * 8.2.1.2). A date without offset counts as UTC.
 */
export function parseExplicitDate(value: string, field: string): { pdfDate: string; xmpDate: string } {
  const trimmed = value.trim();
  const pdfFromXmp = xmpDateToPdfDate(trimmed);
  if (pdfFromXmp !== undefined) return { pdfDate: pdfFromXmp, xmpDate: trimmed };
  const xmpFromPdf = pdfDateToXmpDate(trimmed);
  if (xmpFromPdf !== undefined) return { pdfDate: trimmed, xmpDate: xmpFromPdf };
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2}))?)?(?:[Zz]|([+\-])(\d{2}):?(\d{2}))?$/.exec(trimmed);
  if (match === null) {
    throw new Error(`Invalid ${field} date: "${value}". Use ISO 8601, e.g. 2024-11-18T00:00:00+01:00`);
  }
  const [, year, month, day, hour = "00", minute = "00", second = "00", sign, offsetHour, offsetMinute] = match;
  const offset = sign === undefined ? "Z" : `${sign}${offsetHour}'${offsetMinute}`;
  const xmpOffset = sign === undefined ? "Z" : `${sign}${offsetHour}:${offsetMinute}`;
  return {
    pdfDate: `D:${year}${month}${day}${hour}${minute}${second}${offset}`,
    xmpDate: `${year}-${month}-${day}T${hour}:${minute}:${second}${xmpOffset}`
  };
}

function readTrapped(info: mupdf.PDFObject, scope: Scope): "True" | "False" {
  const trapped = scope.track(info.get("Trapped"));
  return trapped.isName() && trapped.asName() === "True" ? "True" : "False";
}

function openPdfDocument(pdf: Uint8Array, scope: Scope): mupdf.PDFDocument {
  // openDocument returns the Document base type; a PDF input yields a PDFDocument.
  const document = mupdf.PDFDocument.openDocument(pdf, "application/pdf") as mupdf.PDFDocument;
  return scope.track(document);
}

/**
 * Runs `fn` with freshly fetched catalog handles. MuPDF replaces the trailer
 * dict whenever an information entry is written through `setMetaData`, and a
 * PDFObject handle held across such a write ends up detached from the
 * document — edits into it silently disappear on save. Every mutation
 * therefore re-fetches its handles right before it runs.
 */
function withCatalog<T>(document: mupdf.PDFDocument, scope: Scope, fn: (catalog: mupdf.PDFObject) => T): T {
  const trailer = scope.track(document.getTrailer());
  const catalog = scope.track(trailer.get("Root"));
  return fn(catalog);
}

/** Runs `fn` with a freshly fetched information dictionary handle. */
function withInfo<T>(document: mupdf.PDFDocument, scope: Scope, fn: (info: mupdf.PDFObject) => T): T {
  const trailer = scope.track(document.getTrailer());
  const info = scope.track(trailer.get("Info"));
  return fn(info);
}

/** Runs `fn` with a freshly fetched trailer handle. */
function withTrailer<T>(document: mupdf.PDFDocument, scope: Scope, fn: (trailer: mupdf.PDFObject) => T): T {
  return fn(scope.track(document.getTrailer()));
}

/**
 * Applies metadata and standards labeling to a printed PDF.
 *
 * Producer/Creator are always stamped (the wrapper owns them), so a build
 * without explicit metadata still gets a consistent information dictionary
 * and XMP packet. Dates come from what Skia wrote: CreationDate is kept,
 * ModifyDate falls back to it, exactly like vivliostyle-cli handles output
 * from print backends that skip the modification date.
 */
export async function postProcessPdf(pdf: Uint8Array, options: PostProcessOptions): Promise<Uint8Array> {
  const scope = createScope();
  try {
    const { metadata, label } = options;
    const document = openPdfDocument(pdf, scope);

    // ── What the print backend already wrote ────────────────────────────────
    const { creationDate, modifyDate, trapped } = withInfo(document, scope, (info) => ({
      creationDate: readInfoString(info, "CreationDate", scope),
      modifyDate: readInfoString(info, "ModDate", scope),
      trapped: readTrapped(info, scope)
    }));
    let infoCreationDate = creationDate;
    let infoModifyDate = modifyDate;
    let createDateXmp = creationDate !== undefined ? pdfDateToXmpDate(creationDate) : undefined;
    let modifyDateXmp = modifyDate !== undefined ? pdfDateToXmpDate(modifyDate) : undefined;
    if (metadata.created !== undefined) {
      const parsed = parseExplicitDate(metadata.created, "--created");
      infoCreationDate = parsed.pdfDate;
      createDateXmp = parsed.xmpDate;
    }
    if (metadata.modified !== undefined) {
      const parsed = parseExplicitDate(metadata.modified, "--modified");
      infoModifyDate = parsed.pdfDate;
      modifyDateXmp = parsed.xmpDate;
    }
    // Acrobat's preflight requires xmp:CreateDate/MetadataDate and, with
    // ModifyDate absent (as with backends like Firefox's cairo), falls back to
    // the creation date — so both dates are always present in the XMP packet.
    createDateXmp ??= toXmpDate(new Date());
    modifyDateXmp ??= createDateXmp;

    // ── Document information entries ────────────────────────────────────────
    document.setMetaData("info:Producer", metadata.producer);
    document.setMetaData("info:Creator", metadata.creator);
    if (metadata.title !== undefined) document.setMetaData("info:Title", metadata.title);
    if (metadata.author !== undefined) document.setMetaData("info:Author", metadata.author);
    if (metadata.subject !== undefined) document.setMetaData("info:Subject", metadata.subject);
    if (metadata.keywords !== undefined) document.setMetaData("info:Keywords", metadata.keywords);
    // Explicit dates override the ones the print backend wrote (setMetaData
    // replaces the information dictionary, so these run after the entries
    // above and every later access re-fetches its handles).
    if (infoCreationDate !== undefined && infoCreationDate !== creationDate) {
      document.setMetaData("info:CreationDate", infoCreationDate);
    }
    if (infoModifyDate !== undefined && infoModifyDate !== modifyDate) {
      document.setMetaData("info:ModDate", infoModifyDate);
    }

    // ── Catalog language ────────────────────────────────────────────────────
    const language = metadata.language;
    if (language !== undefined && language !== "") {
      withCatalog(document, scope, (catalog) => {
        catalog.put("Lang", scope.track(document.newString(language)));
      });
      setMinimumPdfVersion(document, 14, scope);
    }

    // ── XMP metadata stream ─────────────────────────────────────────────────
    const xmp = buildXmpPacket(
      {
        title: metadata.title,
        author: metadata.author,
        subject: metadata.subject,
        keywords: metadata.keywords,
        producer: metadata.producer,
        creatorTool: metadata.creator,
        createDate: createDateXmp,
        modifyDate: modifyDateXmp,
        metadataDate: toXmpDate(new Date()),
        documentId: `uuid:${randomUUID()}`,
        ...(label !== undefined && label.kind === "pdfx" && label.version === "X-4" ? { trapped } : {})
      },
      label
    );
    withCatalog(document, scope, (catalog) => {
      const xmpBuffer = scope.track(new mupdf.Buffer(xmp));
      const metadataStream = scope.track(document.addStream(xmpBuffer, { Type: "Metadata", Subtype: "XML" }));
      catalog.put("Metadata", metadataStream);
    });

    // ── OutputIntent with the embedded ICC profile ──────────────────────────
    if (label !== undefined) {
      const profile = options.iccProfile;
      if (profile === undefined) {
        throw new Error(
          label.kind === "pdfx"
            ? "PDF/X labeling requires an ICC profile for the OutputIntent (--icc-profile)."
            : "PDF/A labeling requires an ICC profile for the OutputIntent."
        );
      }
      const profileName = options.iccProfileName ?? "output-intent.icc";
      withCatalog(document, scope, (catalog) => {
        const profileBuffer = scope.track(new mupdf.Buffer(profile));
        const colorSpace = scope.track(new mupdf.ColorSpace(profileBuffer, profileName));
        const profileStream = scope.track(document.addStream(profileBuffer, { N: colorSpace.getNumberOfComponents() }));
        const identifier = scope.track(document.newString("Custom"));
        const profileInfo = scope.track(document.newString(profileName));
        // ISO 32000-1:2008, 7.7.2/14.11.5: OutputConditionIdentifier may be
        // "Custom"; Info and DestOutputProfile are required for nonstandard
        // production conditions.
        const intent = scope.track(
          document.addObject({
            Type: "OutputIntent",
            S: label.kind === "pdfa" ? "GTS_PDFA1" : "GTS_PDFX",
            OutputConditionIdentifier: identifier,
            Info: profileInfo,
            DestOutputProfile: profileStream
          })
        );
        catalog.put("OutputIntents", [intent]);
      });
      setMinimumPdfVersion(document, minimumVersionForLabel(label), scope);
    }

    // ── Standards identification outside the XMP packet ─────────────────────
    if (label !== undefined && label.kind === "pdfx" && label.version === "X-1a:2003") {
      // PDF/X-1a:2003 identification lives in the information dictionary, not
      // in XMP (XMP identification is the PDF/X-4 form).
      document.setMetaData("info:GTS_PDFXVersion", "PDF/X-1a:2003");
      withInfo(document, scope, (info) => {
        info.put("Trapped", scope.track(document.newName(trapped)));
        // Acrobat's PDF/X-1a:2003 preflight requires ModDate, which some print
        // backends never write; it takes the creation date then.
        if (modifyDate === undefined && creationDate !== undefined) {
          info.put("ModDate", scope.track(document.newString(creationDate)));
        }
      });
    }

    // A stable file identifier is required for PDF/A and PDF/X. Written last,
    // against a trailer handle fetched after every information entry write.
    if (label !== undefined) {
      withTrailer(document, scope, (trailer) => {
        const existingId = scope.track(trailer.get("ID"));
        if (!existingId.isArray()) {
          const bytes = randomBytes(16);
          trailer.put("ID", [document.newByteString(bytes), document.newByteString(bytes)]);
        }
      });
    }

    if (!document.hasUnsavedChanges()) return pdf;
    const output = scope.track(document.saveToBuffer("compress"));
    // Copy so the data stays valid after the buffer is destroyed.
    return new Uint8Array(output.asUint8Array());
  } finally {
    scope.dispose();
  }
}

/**
 * Loads the bundled sRGB profile, the default OutputIntent for PDF/A labeling.
 *
 * The profile ships unchanged from Debian's icc-profiles-free package
 * (sources.debian.org, sRGB.icc from the "sRGB IEC61966-2.1" distribution by
 * Hewlett-Packard): a monitor-class ("mntr") RGB profile with the embedded
 * copyright tag, as PDF/A requires (ISO 19005-2, 6.2.3: an OutputIntent
 * profile must be of the output or monitor device class and older than
 * ICC v5). The ICC/HP license permits redistribution provided the file,
 * including its embedded copyright notice tag, is not modified
 * (https://registry.color.org/profile-library/#license).
 */
export function loadDefaultIccProfile(): { bytes: Uint8Array; name: string } {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Source layout (vitest, direct TS execution).
    join(moduleDir, "srgb.icc"),
    // Bundled layout: dist/vivliostyle-batch-cli.js ships next to src/.
    resolve(moduleDir, "../src/render/srgb.icc")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { bytes: readFileSync(candidate), name: "sRGB IEC61966-2.1" };
    }
  }
  throw new Error("Bundled sRGB ICC profile not found (expected at src/render/srgb.icc).");
}
