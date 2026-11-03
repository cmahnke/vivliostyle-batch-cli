// src/render/xmp.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * XMP metadata packet builder for the PDF post-processing step
 * (see src/render/pdf-postprocess.ts).
 *
 * The packet follows XMP Specification Part 1 (April 2012) the same way
 * vivliostyle-cli builds it for PDF/X: a packet wrapper Acrobat's preflight
 * accepts, Dublin Core for title/creator/description, the Adobe PDF and XMP
 * namespaces for producer/creator/dates, and the identification namespaces
 * pdfaid (PDF/A, ISO 19005) and pdfxid (PDF/X, ISO 15930).
 */

/** PDF/A part (ISO 19005-1/-2/-3/-4). */
export type PdfAPart = "1" | "2" | "3" | "4";

/** PDF/A conformance level. PDF/A-4 has no conformance levels. */
export type PdfAConformance = "a" | "b" | "u";

/** PDF/A labeling request, e.g. `--pdfa 2b`. */
export type PdfAIdentification = {
  kind: "pdfa";
  part: PdfAPart;
  conformance?: PdfAConformance;
};

/** PDF/X conformance level (ISO 15930), e.g. `--pdfx X-4`. */
export type PdfXVersion = "X-4" | "X-1a:2003";

export type PdfXIdentification = {
  kind: "pdfx";
  version: PdfXVersion;
};

/** Standards label carried into the XMP packet and the PDF catalog. */
export type PdfLabel = PdfAIdentification | PdfXIdentification;

/** Values the XMP packet carries; all but the identifiers are optional. */
export type XmpFields = {
  title?: string;
  /** Authors joined on ";" end up as individual dc:creator entries. */
  author?: string;
  subject?: string;
  keywords?: string;
  producer?: string;
  creatorTool?: string;
  /** XMP dates (YYYY-MM-DDThh:mm:ssTZD, XMP Part 1, 8.2.1.2). */
  createDate?: string;
  modifyDate?: string;
  metadataDate?: string;
  /** URN written as xmpMM:DocumentID; its presence adds the ID family. */
  documentId?: string;
  trapped?: "True" | "False";
};

const NS = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  dc: "http://purl.org/dc/elements/1.1/",
  pdf: "http://ns.adobe.com/pdf/1.3/",
  xmp: "http://ns.adobe.com/xap/1.0/",
  xmpMM: "http://ns.adobe.com/xap/1.0/mm/",
  pdfaid: "http://www.aiim.org/pdfa/ns/id/",
  pdfxid: "http://www.npes.org/pdfx/ns/id/"
} as const;

/** XMP Specification Part 1 (April 2012), 8.2.1.2 date form. */
export function toXmpDate(date: Date): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, "0");
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
  );
}

// ISO 32000-1:2008, 7.9.4 writes a date as D:YYYYMMDDHHmmSSOHH'mm, the form
// Skia in Chromium writes. The offset is kept, not normalized to UTC, so the
// XMP packet shows the same instant the information dictionary shows.
const PDF_DATE = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:Z|([+\-])(\d{2})'(\d{2})'?)$/;

/** Reformats a PDF date string as an XMP date; `undefined` when not one. */
export function pdfDateToXmpDate(value: string): string | undefined {
  const match = PDF_DATE.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  const zone = sign === undefined ? "Z" : `${sign}${offsetHour}:${offsetMinute}`;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`;
}

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** dc:title/dc:description: a language alternative with the x-default entry. */
function languageAlternative(text: string): string {
  return [
    "<rdf:Alt>",
    `  <rdf:li xml:lang="x-default">${xmlEscape(text)}</rdf:li>`,
    "</rdf:Alt>"
  ].join("\n      ");
}

/** dc:creator: an ordered sequence; ";" separates individual authors. */
function creatorSequence(author: string): string {
  const names = author
    .split(";")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const items = (names.length === 0 ? [author] : names).map((name) => `  <rdf:li>${xmlEscape(name)}</rdf:li>`);
  return ["<rdf:Seq>", ...items, "</rdf:Seq>"].join("\n      ");
}

/**
 * Builds the XMP packet for the document. Only defined fields are written;
 * the packet wrapper uses the fixed header id packet scanners look for
 * (XMP Part 1, 7.3.2 makes the wrapper optional, Acrobat rejects its absence).
 */
export function buildXmpPacket(fields: XmpFields, label?: PdfLabel): string {
  const properties: string[] = [];

  if (label !== undefined && label.kind === "pdfx" && label.version === "X-4") {
    properties.push(`<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>`);
  }
  if (fields.title !== undefined) {
    properties.push(`<dc:title>\n      ${languageAlternative(fields.title)}\n    </dc:title>`);
  }
  if (fields.author !== undefined) {
    properties.push(`<dc:creator>\n      ${creatorSequence(fields.author)}\n    </dc:creator>`);
  }
  if (fields.subject !== undefined) {
    properties.push(`<dc:description>\n      ${languageAlternative(fields.subject)}\n    </dc:description>`);
  }
  if (fields.keywords !== undefined) {
    properties.push(`<pdf:Keywords>${xmlEscape(fields.keywords)}</pdf:Keywords>`);
  }
  if (fields.producer !== undefined) {
    properties.push(`<pdf:Producer>${xmlEscape(fields.producer)}</pdf:Producer>`);
  }
  if (fields.trapped !== undefined) {
    properties.push(`<pdf:Trapped>${fields.trapped}</pdf:Trapped>`);
  }
  if (fields.creatorTool !== undefined) {
    properties.push(`<xmp:CreatorTool>${xmlEscape(fields.creatorTool)}</xmp:CreatorTool>`);
  }
  if (fields.createDate !== undefined) {
    properties.push(`<xmp:CreateDate>${fields.createDate}</xmp:CreateDate>`);
  }
  if (fields.modifyDate !== undefined) {
    properties.push(`<xmp:ModifyDate>${fields.modifyDate}</xmp:ModifyDate>`);
  }
  if (fields.metadataDate !== undefined) {
    properties.push(`<xmp:MetadataDate>${fields.metadataDate}</xmp:MetadataDate>`);
  }
  if (fields.documentId !== undefined) {
    properties.push(
      `<xmpMM:DocumentID>${xmlEscape(fields.documentId)}</xmpMM:DocumentID>`,
      `<xmpMM:VersionID>1</xmpMM:VersionID>`,
      `<xmpMM:RenditionClass>default</xmpMM:RenditionClass>`
    );
  }
  if (label !== undefined && label.kind === "pdfa") {
    properties.push(`<pdfaid:part>${label.part}</pdfaid:part>`);
    // PDF/A-4 (ISO 19005-4) identifies through the part value alone; the
    // conformance levels a/b/u exist for parts 1 to 3 only.
    if (label.part !== "4" && label.conformance !== undefined) {
      properties.push(`<pdfaid:conformance>${label.conformance.toUpperCase()}</pdfaid:conformance>`);
    }
  }

  const body = [
    `<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>`,
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">`,
    `  <rdf:RDF xmlns:rdf="${NS.rdf}">`,
    `    <rdf:Description rdf:about="" xmlns:dc="${NS.dc}" xmlns:pdf="${NS.pdf}" xmlns:xmp="${NS.xmp}" xmlns:xmpMM="${NS.xmpMM}" xmlns:pdfaid="${NS.pdfaid}" xmlns:pdfxid="${NS.pdfxid}">`,
    ...properties.map((property) => `      ${property}`),
    `    </rdf:Description>`,
    `  </rdf:RDF>`,
    `</x:xmpmeta>`,
    `<?xpacket end="w"?>`
  ].join("\n");

  // XML 1.0 (Fifth Edition), 2.11: a processor turns a literal CR into LF
  // before parsing, so a CR in a value survives only as a character reference.
  return `${body.replaceAll("\r", "&#xD;")}\n`;
}
