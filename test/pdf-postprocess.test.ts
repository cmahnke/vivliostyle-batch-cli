// test/pdf-postprocess.test.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import * as mupdf from "mupdf";
import { JSDOM } from "jsdom";
import { buildXmpPacket, pdfDateToXmpDate, toXmpDate } from "../src/render/xmp.js";
import { loadDefaultIccProfile, postProcessPdf } from "../src/render/pdf-postprocess.js";
import {
  DEFAULT_LANGUAGE,
  extractMetadataFromDocument,
  extractMetadataFromManifest,
  parsePdfaLabel,
  parsePdfxLabel,
  resolveMetadata
} from "../src/metadata.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Skia-like PDF base for the post-processing step (pdf-lib output). */
async function minimalPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 300]);
  page.drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
  return document.save();
}

function openPdf(bytes: Uint8Array): {
  document: mupdf.PDFDocument;
  trailer: mupdf.PDFObject;
  catalog: mupdf.PDFObject;
  info: mupdf.PDFObject;
} {
  const document = mupdf.PDFDocument.openDocument(bytes, "application/pdf") as mupdf.PDFDocument;
  const trailer = document.getTrailer();
  const catalog = trailer.get("Root");
  const info = trailer.get("Info");
  return { document, trailer, catalog, info };
}

const srgb = loadDefaultIccProfile();

// ---------------------------------------------------------------------------
// XMP packet
// ---------------------------------------------------------------------------

describe("buildXmpPacket", () => {
  const base = { producer: "vivliostyle-batch-cli", documentId: "uuid:test-1" };

  it("wraps the packet in the XMP processing instructions", () => {
    const packet = buildXmpPacket({ ...base, title: "t" });
    expect(packet).toContain('<?xpacket begin="');
    expect(packet).toContain('id="W5M0MpCehiHzreSzNTczkc9d"?>');
    expect(packet).toContain('<?xpacket end="w"?>');
    expect(packet).toContain('<x:xmpmeta xmlns:x="adobe:ns:meta/">');
    expect(packet).toContain("</x:xmpmeta>");
  });

  it("escapes XML markup in values", () => {
    const packet = buildXmpPacket({ ...base, title: "<Title & More>" });
    expect(packet).toContain("&lt;Title &amp; More&gt;");
    expect(packet).not.toContain("<Title");
  });

  it("escapes carriage returns as character references", () => {
    const packet = buildXmpPacket({ ...base, title: "line\rbreak" });
    expect(packet).toContain("line&#xD;break");
    expect(packet).not.toMatch(/\rv/v);
  });

  it("writes dublin core title/creator/description and pdf fields", () => {
    const packet = buildXmpPacket({
      ...base,
      title: "The Title",
      author: "Ada; Grace",
      subject: "About it",
      keywords: "a, b",
      creatorTool: "vivliostyle-batch-cli",
      createDate: "2026-10-31T09:25:00Z",
      modifyDate: "2026-10-31T09:26:00Z"
    });
    expect(packet).toContain("<dc:title>");
    expect(packet).toContain('<rdf:li xml:lang="x-default">The Title</rdf:li>');
    expect(packet).toContain("<dc:creator>");
    expect(packet).toContain("<rdf:li>Ada</rdf:li>");
    expect(packet).toContain("<rdf:li>Grace</rdf:li>");
    expect(packet).toContain("<dc:description>");
    expect(packet).toContain('<rdf:li xml:lang="x-default">About it</rdf:li>');
    expect(packet).toContain("<pdf:Keywords>a, b</pdf:Keywords>");
    expect(packet).toContain("<pdf:Producer>vivliostyle-batch-cli</pdf:Producer>");
    expect(packet).toContain("<xmp:CreatorTool>vivliostyle-batch-cli</xmp:CreatorTool>");
    expect(packet).toContain("<xmp:CreateDate>2026-10-31T09:25:00Z</xmp:CreateDate>");
    expect(packet).toContain("<xmp:ModifyDate>2026-10-31T09:26:00Z</xmp:ModifyDate>");
    expect(packet).toContain("<xmpMM:DocumentID>uuid:test-1</xmpMM:DocumentID>");
    expect(packet).toContain("<xmpMM:VersionID>1</xmpMM:VersionID>");
  });

  it("omits properties that are not given", () => {
    const packet = buildXmpPacket({ producer: "p" });
    expect(packet).not.toContain("<dc:");
    expect(packet).not.toContain("<xmp:");
    expect(packet).not.toContain("<pdfaid:");
    expect(packet).not.toContain("<pdfxid:");
    expect(packet).toContain("<pdf:Producer>p</pdf:Producer>");
  });

  it("writes the PDF/A identification", () => {
    const packet = buildXmpPacket(base, { kind: "pdfa", part: "2", conformance: "b" });
    expect(packet).toContain("<pdfaid:part>2</pdfaid:part>");
    expect(packet).toContain("<pdfaid:conformance>B</pdfaid:conformance>");
    expect(packet).not.toContain("<pdfxid:");
  });

  it("omits the conformance element for PDF/A-4", () => {
    const packet = buildXmpPacket(base, { kind: "pdfa", part: "4" });
    expect(packet).toContain("<pdfaid:part>4</pdfaid:part>");
    expect(packet).not.toContain("<pdfaid:conformance>");
  });

  it("writes the PDF/X-4 identification", () => {
    const packet = buildXmpPacket({ ...base, trapped: "False" }, { kind: "pdfx", version: "X-4" });
    expect(packet).toContain("<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>");
    expect(packet).toContain("<pdf:Trapped>False</pdf:Trapped>");
    expect(packet).not.toContain("<pdfaid:");
  });

  it("writes no PDF/X identification into XMP for X-1a:2003 (info dictionary form)", () => {
    const packet = buildXmpPacket(base, { kind: "pdfx", version: "X-1a:2003" });
    expect(packet).not.toContain("GTS_PDFXVersion");
  });

  it("formats dates as XMP wants them", () => {
    expect(toXmpDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("2026-01-02T03:04:05Z");
    expect(pdfDateToXmpDate("D:20261031092500Z")).toBe("2026-10-31T09:25:00Z");
    expect(pdfDateToXmpDate("D:20261031092500+01'00'")).toBe("2026-10-31T09:25:00+01:00");
    expect(pdfDateToXmpDate("D:20261031092500-04'00'")).toBe("2026-10-31T09:25:00-04:00");
    expect(pdfDateToXmpDate("D:not-a-date")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

describe("postProcessPdf", () => {
  it("stamps the information dictionary and the wrapper identity", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: {
        title: "Batch Title",
        author: "Christian Mahnke",
        subject: "Testing",
        keywords: "pdf, xmp",
        language: "en",
        creator: "vivliostyle-batch-cli",
        producer: "vivliostyle-batch-cli"
      }
    });

    // updateMetadata would overwrite Producer/Creator with pdf-lib's identity.
    const doc = await PDFDocument.load(stamped, { updateMetadata: false });
    expect(doc.getTitle()).toBe("Batch Title");
    expect(doc.getAuthor()).toBe("Christian Mahnke");
    expect(doc.getSubject()).toBe("Testing");
    expect(doc.getProducer()).toBe("vivliostyle-batch-cli");
    expect(doc.getCreator()).toBe("vivliostyle-batch-cli");
  });

  it("writes an XMP metadata stream consistent with the information dictionary", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: { title: "XMP Title", creator: "vivliostyle-batch-cli", producer: "vivliostyle-batch-cli" }
    });
    const { catalog } = openPdf(stamped);
    const metadata = catalog.get("Metadata");
    expect(metadata.isStream()).toBe(true);
    const xmp = metadata.readStream().asString();
    expect(xmp).toContain("<?xpacket");
    expect(xmp).toContain("<dc:title>");
    expect(xmp).toContain('<rdf:li xml:lang="x-default">XMP Title</rdf:li>');
    expect(xmp).toContain("<pdf:Producer>vivliostyle-batch-cli</pdf:Producer>");
    expect(xmp).toContain("<xmpMM:DocumentID>uuid:");
  });

  it("writes the catalog language entry", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: { language: "en", creator: "c", producer: "p" }
    });
    const { catalog } = openPdf(stamped);
    expect(catalog.get("Lang").asString()).toBe("en");
  });

  it("labels PDF/A with the sRGB output intent and identification", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: { title: "Archive", creator: "c", producer: "p" },
      label: { kind: "pdfa", part: "2", conformance: "b" },
      iccProfile: srgb.bytes,
      iccProfileName: srgb.name
    });

    const { catalog } = openPdf(stamped);
    const intents = catalog.get("OutputIntents");
    expect(intents.isArray()).toBe(true);
    const intent = intents.get(0);
    expect(intent.get("S").asName()).toBe("GTS_PDFA1");
    expect(intent.get("OutputConditionIdentifier").asString()).toBe("Custom");
    // MuPDF's PDFObject.resolve() does not surface stream-ness for indirect
    // refs, so the embedded profile is checked through its stream data.
    const profileBytes = intent.get("DestOutputProfile").readStream().asUint8Array();
    expect(profileBytes.length).toBeGreaterThanOrEqual(srgb.bytes.length / 2);
    expect(intent.get("DestOutputProfile").get("N").asNumber()).toBe(3);
    const xmp = catalog.get("Metadata").readStream().asString();
    expect(xmp).toContain("<pdfaid:part>2</pdfaid:part>");
    expect(xmp).toContain("<pdfaid:conformance>B</pdfaid:conformance>");
  });

  it("labels PDF/X-4 through XMP", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: { creator: "c", producer: "p" },
      label: { kind: "pdfx", version: "X-4" },
      iccProfile: srgb.bytes,
      iccProfileName: srgb.name
    });
    const { catalog } = openPdf(stamped);
    expect(catalog.get("OutputIntents").get(0).get("S").asName()).toBe("GTS_PDFX");
    const xmp = catalog.get("Metadata").readStream().asString();
    expect(xmp).toContain("<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>");
  });

  it("labels PDF/X-1a:2003 through the information dictionary", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: { creator: "c", producer: "p" },
      label: { kind: "pdfx", version: "X-1a:2003" },
      iccProfile: srgb.bytes,
      iccProfileName: srgb.name
    });
    const { info } = openPdf(stamped);
    expect(info.get("GTS_PDFXVersion").asString()).toBe("PDF/X-1a:2003");
    expect(info.get("Trapped").isName()).toBe(true);
    expect(info.get("ModDate").isString()).toBe(true);
    // The document keeps its XMP metadata stream, but no PDF/X XMP identification.
    const { catalog } = openPdf(stamped);
    const xmp = catalog.get("Metadata").readStream().asString();
    expect(xmp).not.toContain("GTS_PDFXVersion");
  });

  it("writes a file identifier pair when a label is present", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: { creator: "c", producer: "p" },
      label: { kind: "pdfa", part: "2", conformance: "b" },
      iccProfile: srgb.bytes,
      iccProfileName: srgb.name
    });
    const { trailer } = openPdf(stamped);
    const id = trailer.get("ID");
    expect(id.isArray()).toBe(true);
    expect(id.length).toBe(2);
  });

  it("rejects a label without an ICC profile", async () => {
    await expect(
      postProcessPdf(await minimalPdf(), {
        metadata: { creator: "c", producer: "p" },
        label: { kind: "pdfx", version: "X-4" }
      })
    ).rejects.toThrow(/ICC profile/);
  });

  it("writes no OutputIntents when unlabeled", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: { creator: "c", producer: "p" }
    });
    const { catalog } = openPdf(stamped);
    expect(catalog.get("OutputIntents").isNull()).toBe(true);
  });
});

describe("loadDefaultIccProfile", () => {
  it("loads the bundled sRGB profile", () => {
    const { bytes, name } = loadDefaultIccProfile();
    expect(name).toBe("sRGB_v4_ICC_preference.icc");
    // ICC signature "acsp" sits at offset 36.
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(String.fromCharCode(bytes[36], bytes[37], bytes[38], bytes[39])).toBe("acsp");
  });
});

// ---------------------------------------------------------------------------
// Metadata resolution
// ---------------------------------------------------------------------------

describe("extractMetadataFromDocument", () => {
  it("reads title, meta tags and the document language", () => {
    const dom = new JSDOM(`<!doctype html>
      <html lang="en">
        <head>
          <title>  Fixture Title  </title>
          <meta name="author" content="Jane Doe">
          <meta name="description" content="A fixture">
          <meta name="keywords" content="one, two">
        </head>
        <body></body>
      </html>`);
    expect(extractMetadataFromDocument(dom.window.document)).toEqual({
      title: "Fixture Title",
      author: "Jane Doe",
      subject: "A fixture",
      keywords: "one, two",
      language: "en"
    });
  });

  it("falls back to Dublin Core metas and content-language", () => {
    const dom = new JSDOM(`<!doctype html>
      <html>
        <head>
          <meta name="dcterms.creator" content="Jane Doe">
          <meta http-equiv="content-language" content="fr">
        </head>
        <body></body>
      </html>`);
    expect(extractMetadataFromDocument(dom.window.document)).toEqual({ author: "Jane Doe", language: "fr" });
  });

  it("returns no fields for an empty document", () => {
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
    expect(extractMetadataFromDocument(dom.window.document)).toEqual({});
  });
});

describe("extractMetadataFromManifest", () => {
  it("reads title, author list, keywords and language", () => {
    const manifest = JSON.stringify({
      title: "Report",
      author: [{ name: "Jane Doe" }, "John Roe"],
      description: "Annual report",
      keywords: ["print", "archive"],
      language: "de"
    });
    expect(extractMetadataFromManifest(manifest)).toEqual({
      title: "Report",
      author: "Jane Doe; John Roe",
      subject: "Annual report",
      keywords: "print, archive",
      language: "de"
    });
  });

  it("returns undefined for invalid JSON", () => {
    expect(extractMetadataFromManifest("{ not json")).toBeUndefined();
  });
});

describe("resolveMetadata", () => {
  it("lets the CLI flags win over the extracted values", () => {
    expect(resolveMetadata({ title: "CLI Title", language: "it" }, { title: "Doc Title", author: "Doc Author", language: "en" })).toEqual({
      title: "CLI Title",
      author: "Doc Author",
      language: "it"
    });
  });

  it("fills fields the CLI does not set and defaults the language", () => {
    expect(resolveMetadata({}, { title: "Doc Title" })).toEqual({ title: "Doc Title", language: DEFAULT_LANGUAGE });
    expect(resolveMetadata({}, {}).language).toBe(DEFAULT_LANGUAGE);
  });
});

describe("parsePdfaLabel", () => {
  it("parses part and conformance", () => {
    expect(parsePdfaLabel("2b")).toEqual({ kind: "pdfa", part: "2", conformance: "b" });
    expect(parsePdfaLabel("3U")).toEqual({ kind: "pdfa", part: "3", conformance: "u" });
    expect(parsePdfaLabel(" 1a ")).toEqual({ kind: "pdfa", part: "1", conformance: "a" });
    expect(parsePdfaLabel("4")).toEqual({ kind: "pdfa", part: "4" });
  });

  it("rejects unknown and malformed levels", () => {
    expect(() => parsePdfaLabel("2x")).toThrow(/Invalid --pdfa level/);
    expect(() => parsePdfaLabel("2")).toThrow(/Missing PDF\/A conformance/);
    expect(() => parsePdfaLabel("4b")).toThrow(/does not take a conformance/);
    expect(() => parsePdfaLabel("5b")).toThrow(/Invalid --pdfa level/);
  });
});

describe("parsePdfxLabel", () => {
  it("parses the supported versions", () => {
    expect(parsePdfxLabel("X-4")).toEqual({ kind: "pdfx", version: "X-4" });
    expect(parsePdfxLabel("X-1a")).toEqual({ kind: "pdfx", version: "X-1a:2003" });
    expect(parsePdfxLabel("X-1a:2003")).toEqual({ kind: "pdfx", version: "X-1a:2003" });
  });

  it("rejects unsupported versions", () => {
    expect(() => parsePdfxLabel("X-5")).toThrow(/Invalid --pdfx version/);
    expect(() => parsePdfxLabel("X-1a:2001")).toThrow(/Invalid --pdfx version/);
  });
});
