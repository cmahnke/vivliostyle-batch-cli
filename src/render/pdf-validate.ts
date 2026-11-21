// src/render/pdf-validate.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * Built-in compliance checks for standards-labeled output (PDF/A, PDF/X).
 *
 * veraPDF implements the full ISO rule sets; this module covers the practical
 * subset a print backend can violate and that the post-processing step is
 * responsible for: the PDF version of the labeled part, the XMP
 * identification, the OutputIntent with an embedded ICC profile, the file
 * identifier, embedded fonts and the absence of JavaScript actions.
 * Run the verapdf binary (see verapdf.ts) when the full rule set matters.
 */

import * as mupdf from "mupdf";
import { minimumVersionForLabel } from "./pdf-postprocess.js";
import type { PdfLabel } from "./xmp.js";

export type LabelViolation = {
  /** Short identifier of the failed check, e.g. "xmp-identification". */
  check: string;
  detail: string;
};

/** Human-readable label, e.g. "PDF/A-2b" or "PDF/X-4". */
export function describeLabel(label: PdfLabel): string {
  return label.kind === "pdfa" ? `PDF/A-${label.part}${label.conformance ?? ""}` : `PDF/${label.version}`;
}

const decoder = new TextDecoder("utf-8");

function decodeStream(stream: mupdf.PDFObject): string {
  return decoder.decode(stream.readStream().asUint8Array());
}

/** True when the font dictionary carries one of the embedded font file keys. */
function hasEmbeddedFontFile(fontDescriptor: mupdf.PDFObject): boolean {
  for (const key of ["FontFile", "FontFile2", "FontFile3"]) {
    if (fontDescriptor.get(key).isStream()) return true;
  }
  return false;
}

/** Checks a single font dictionary; returns a violation detail or null. */
function checkFont(font: mupdf.PDFObject): string | null {
  const subtype = font.get("Subtype").asName();
  if (subtype === "Type3") {
    // PDF/A (parts 1-3) requires the character procedures of a Type3 font to
    // be embedded streams; PDF/A-4 additionally allows them in the page.
    return font.get("CharProcs").isDictionary() || font.get("CharProcs").isStream() ? null : "Type3 font without CharProcs";
  }
  let descriptor = font.get("FontDescriptor");
  if (subtype === "Type0") {
    const descendants = font.get("DescendantFonts");
    if (!descendants.isArray()) return "Type0 font without DescendantFonts";
    descriptor = descendants.get(0).resolve().get("FontDescriptor");
  } else if (subtype === "CIDFontType0" || subtype === "CIDFontType2") {
    descriptor = font.get("FontDescriptor");
  }
  if (!descriptor.isDictionary()) return `${subtype} font without FontDescriptor`;
  if (!hasEmbeddedFontFile(descriptor)) return `${subtype} font without embedded FontFile`;
  return null;
}

export function validateLabeledPdf(pdf: Uint8Array, label: PdfLabel): LabelViolation[] {
  const violations: LabelViolation[] = [];
  const document = mupdf.PDFDocument.openDocument(pdf, "application/pdf") as mupdf.PDFDocument;
  try {
    const trailer = document.getTrailer();
    const catalog = trailer.get("Root");

    // ── PDF version of the labeled part ───────────────────────────────────
    const minimumVersion = minimumVersionForLabel(label);
    if (document.getVersion() < minimumVersion) {
      violations.push({
        check: "pdf-version",
        detail: `document is PDF ${Math.trunc(document.getVersion() / 10)}.${document.getVersion() % 10}, ${describeLabel(label)} requires at least ${Math.trunc(minimumVersion / 10)}.${minimumVersion % 10}`
      });
    }

    // ── XMP metadata stream with the standards identification ─────────────
    // get() follows indirect references already; resolve() would hide the
    // stream-ness of the handle (see the post-processing test comment).
    const metadataStream = catalog.get("Metadata");
    let xmp = "";
    if (!metadataStream.isStream()) {
      violations.push({ check: "xmp-metadata", detail: "catalog has no Metadata stream" });
    } else {
      xmp = decodeStream(metadataStream);
      if (label.kind === "pdfa") {
        if (!xmp.includes(`<pdfaid:part>${label.part}</pdfaid:part>`)) {
          violations.push({ check: "xmp-identification", detail: `XMP is missing <pdfaid:part>${label.part}` });
        }
        if (label.conformance !== undefined && !xmp.includes(`<pdfaid:conformance>${label.conformance.toUpperCase()}</pdfaid:conformance>`)) {
          violations.push({ check: "xmp-identification", detail: `XMP is missing <pdfaid:conformance>${label.conformance.toUpperCase()}` });
        }
      } else if (label.version === "X-4" && !xmp.includes("<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>")) {
        violations.push({ check: "xmp-identification", detail: "XMP is missing the PDF/X-4 GTS_PDFXVersion" });
      }
    }

    // ── OutputIntent with an embedded ICC profile ──────────────────────────
    if (label.kind === "pdfa" || label.version === "X-4") {
      const intents = catalog.get("OutputIntents");
      if (!intents.isArray() || intents.length < 1) {
        violations.push({ check: "output-intent", detail: "catalog has no OutputIntents array" });
      } else {
        const intent = intents.get(0);
        const expectedS = label.kind === "pdfa" ? "GTS_PDFA1" : "GTS_PDFX";
        if (!intent.get("S").asName()?.startsWith(expectedS)) {
          violations.push({ check: "output-intent", detail: `OutputIntent /S is not ${expectedS}` });
        }
        // MuPDF's PDFObject.resolve() does not surface stream-ness for
        // indirect refs, so the embedded profile is checked through its
        // stream data (same approach as the post-processing tests).
        let profileReadable = false;
        try {
          profileReadable = intent.get("DestOutputProfile").readStream().asUint8Array().length > 0;
        } catch {
          profileReadable = false;
        }
        if (!profileReadable) {
          violations.push({ check: "output-intent", detail: "OutputIntent has no embedded DestOutputProfile" });
        }
      }
    }

    // ── File identifier (required for PDF/A and PDF/X) ──────────────────────
    const fileId = trailer.get("ID");
    if (!fileId.isArray() || fileId.length < 2) {
      violations.push({ check: "file-identifier", detail: "trailer /ID pair missing" });
    }

    // ── Fonts embedded ──────────────────────────────────────────────────────
    const pageCount = document.countPages();
    for (let index = 0; index < pageCount; index++) {
      const page = document.loadPage(index);
      try {
        const fonts = page.getObject().get("Resources").resolve().get("Font");
        if (!fonts.isDictionary()) continue;
        fonts.forEach((fontRef) => {
          const font = fontRef.resolve();
          if (!font.isDictionary()) return;
          const failure = checkFont(font);
          if (failure !== null) violations.push({ check: "font-embedded", detail: `page ${index + 1}: ${failure}` });
        });
      } finally {
        page.destroy();
      }
    }

    // ── No JavaScript actions ────────────────────────────────────────────────
    const names = catalog.get("Names");
    if (names.isDictionary() && names.get("JavaScript").isDictionary()) {
      violations.push({ check: "no-javascript", detail: "document name tree contains JavaScript actions" });
    }
    const openAction = catalog.get("OpenAction");
    if (openAction.isDictionary() && openAction.get("S").asName() === "JavaScript") {
      violations.push({ check: "no-javascript", detail: "OpenAction is a JavaScript action" });
    }

    // ── Information dictionary / XMP consistency ────────────────────────────
    const info = trailer.get("Info");
    if (info.isDictionary()) {
      if (info.get("Title").isString() && xmp !== "" && !xmp.includes("<dc:title>")) {
        violations.push({ check: "metadata-consistency", detail: "information dictionary has a Title but the XMP packet lacks dc:title" });
      }
      if (info.get("Author").isString() && xmp !== "" && !xmp.includes("<dc:creator>")) {
        violations.push({ check: "metadata-consistency", detail: "information dictionary has an Author but the XMP packet lacks dc:creator" });
      }
    }

    return violations;
  } finally {
    document.destroy();
  }
}
