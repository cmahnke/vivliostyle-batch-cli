// test/pdf-postprocess.test.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import * as mupdf from "mupdf";
import { JSDOM } from "jsdom";
import { buildXmpPacket, pdfDateToXmpDate, toXmpDate, xmpDateToPdfDate } from "../src/render/xmp.js";
import {
  loadDefaultIccProfile,
  MAX_PDF_NAME_BYTES,
  minimumVersionForLabel,
  parseExplicitDate,
  postProcessPdf,
  shortenLongDestinationNames
} from "../src/render/pdf-postprocess.js";
import { validateLabeledPdf } from "../src/render/pdf-validate.js";
import { runVeraPdf, veraPdfFlavour } from "../src/render/verapdf.js";
import {
  DEFAULT_LANGUAGE,
  extractMetadataFromDocument,
  extractMetadataFromManifest,
  normalizeDoi,
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

  it("writes the DOI as dc:identifier and drops the url", () => {
    const packet = buildXmpPacket({ ...base, doi: "10.5281/zenodo.12345", url: "https://example.org/post" });
    expect(packet).toContain("<dc:identifier>doi:10.5281/zenodo.12345</dc:identifier>");
    expect(packet).not.toContain("https://example.org/post");
  });

  it("writes the url as dc:identifier when no DOI is set", () => {
    const packet = buildXmpPacket({ ...base, url: "https://example.org/post" });
    expect(packet).toContain("<dc:identifier>https://example.org/post</dc:identifier>");
    expect(packet).not.toContain("<dc:identifier>doi:");
  });

  it("escapes dc:identifier values", () => {
    const packet = buildXmpPacket({ ...base, url: "https://example.org/?a=1&b=2" });
    expect(packet).toContain("<dc:identifier>https://example.org/?a=1&amp;b=2</dc:identifier>");
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

  it("stamps the DOI as dc:identifier into the XMP stream", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: { doi: "10.5281/zenodo.12345", creator: "c", producer: "p" }
    });
    const { catalog } = openPdf(stamped);
    expect(catalog.get("Metadata").readStream().asString()).toContain("<dc:identifier>doi:10.5281/zenodo.12345</dc:identifier>");
  });

  it("stamps the url as dc:identifier into the XMP stream", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: { url: "https://example.org/post", creator: "c", producer: "p" }
    });
    const { catalog } = openPdf(stamped);
    expect(catalog.get("Metadata").readStream().asString()).toContain("<dc:identifier>https://example.org/post</dc:identifier>");
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

describe("shortenLongDestinationNames", () => {
  /** Destination name the viewer would generate for a long article path. */
  const longNameFor = (fragment: string): string =>
    `viv-id-http:003a:002f:002f127:002e0:002e0:002e1:003a55298:002fpost:002f` +
    `a-post-slug-long-enough-to-exceed-the-pdf-name-limit:002farticle:002ehtml:0023${fragment}`;

  function destinationNames(document: mupdf.PDFDocument): string[] {
    const names: string[] = [];
    document
      .getTrailer()
      .get("Root")
      .get("Dests")
      .forEach((_value, key) => {
        if (typeof key === "string") names.push(key);
      });
    return names;
  }

  /** Minimal PDF with a /Dests dictionary and link annotations, Skia-style. */
  async function pdfWithDestinations(): Promise<{ bytes: Uint8Array; longA: string; longB: string; keep: string }> {
    const longA = longNameFor("fn:003a1");
    const longB = longNameFor("fnref:003a1");
    const keep = "Keep-Short";
    const document = mupdf.PDFDocument.openDocument(await minimalPdf(), "application/pdf") as mupdf.PDFDocument;
    const catalog = document.getTrailer().get("Root");
    const page = document.loadPage(0).getObject();
    const pageRef = catalog.get("Pages").get("Kids").get(0);

    const dests = document.newDictionary();
    dests.put(longA, [pageRef, "XYZ", 100, 200, 0]);
    dests.put(longB, [0, "Fit"]);
    dests.put(keep, [0, "Fit"]);
    catalog.put("Dests", dests);

    const link = document.newDictionary();
    link.put("Type", "Annot");
    link.put("Subtype", "Link");
    link.put("Rect", [0, 0, 10, 10]);
    link.put("Dest", longA);
    link.put("A", { S: "GoTo", D: longB });
    const shortLink = document.newDictionary();
    shortLink.put("Type", "Annot");
    shortLink.put("Subtype", "Link");
    shortLink.put("Rect", [0, 0, 10, 10]);
    shortLink.put("Dest", keep);
    page.put("Annots", [link, shortLink]);

    const saved = document.saveToBuffer("compress");
    return { bytes: new Uint8Array(saved.asUint8Array()), longA, longB, keep };
  }

  const noScope = {
    track: <T>(value: T): T => value,
    dispose: () => undefined
  };

  it("renames over-long destinations consistently across the definition and every reference", async () => {
    const { bytes, longA, longB, keep } = await pdfWithDestinations();
    const output = await postProcessPdf(bytes, { metadata: { creator: "c", producer: "p" } });
    const document = mupdf.PDFDocument.openDocument(output, "application/pdf") as mupdf.PDFDocument;
    const dests = document.getTrailer().get("Root").get("Dests");
    const names = destinationNames(document);

    expect(names).toHaveLength(3);
    expect(names).toContain(keep);
    expect(names).not.toContain(longA);
    expect(names).not.toContain(longB);
    const renamed = names.filter((name) => name !== keep);
    expect(renamed).toHaveLength(2);
    for (const name of renamed) {
      expect(name).toMatch(/^viv-id-/);
      expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(MAX_PDF_NAME_BYTES);
    }
    // Distinct old names keep distinct new names.
    expect(new Set(renamed).size).toBe(2);

    // The page reference inside the destination survives the rename.
    const withPage = renamed.find((name) => dests.get(name).length === 5);
    expect(withPage).toBeDefined();
    expect(
      dests
        .get(withPage as string)
        .get(0)
        .isIndirect()
    ).toBe(true);

    // The link annotation's /Dest and its GoTo action's /D follow the rename.
    const annots = document.loadPage(0).getObject().get("Annots");
    const linkDest = annots.get(0).get("Dest").asName();
    const actionDest = annots.get(0).get("A").get("D").asName();
    expect(renamed).toContain(linkDest);
    expect(renamed).toContain(actionDest);
    expect(linkDest).not.toBe(actionDest);
    // Short names pass through untouched.
    expect(annots.get(1).get("Dest").asName()).toBe(keep);
  });

  it("keeps names of exactly the limit and renames ones over it", async () => {
    const atLimit = `viv-id-${"x".repeat(MAX_PDF_NAME_BYTES - 7)}`;
    const overLimit = `viv-id-${"y".repeat(MAX_PDF_NAME_BYTES - 6)}`;
    const document = mupdf.PDFDocument.openDocument(await minimalPdf(), "application/pdf") as mupdf.PDFDocument;
    const dests = document.newDictionary();
    dests.put(atLimit, [0, "Fit"]);
    dests.put(overLimit, [0, "Fit"]);
    document.getTrailer().get("Root").put("Dests", dests);
    const saved = document.saveToBuffer("compress");
    const output = await postProcessPdf(new Uint8Array(saved.asUint8Array()), { metadata: { creator: "c", producer: "p" } });
    const names = destinationNames(mupdf.PDFDocument.openDocument(output, "application/pdf") as mupdf.PDFDocument);
    expect(names).toContain(atLimit);
    expect(names).not.toContain(overLimit);
    expect(names.filter((name) => name !== atLimit)).toHaveLength(1);
  });

  it("collapses a /Names/Dests name tree with an over-long key into one flat sorted node", async () => {
    const longA = longNameFor("fn:003a1");
    const mid = "Mid-Dest";
    const longB = `viv-id-${"z".repeat(130)}`;
    const document = mupdf.PDFDocument.openDocument(await minimalPdf(), "application/pdf") as mupdf.PDFDocument;
    const catalog = document.getTrailer().get("Root");
    const kid = (names: Array<[string, unknown[]]>): mupdf.PDFObject => {
      const node = document.newDictionary();
      const entries = document.newArray();
      for (const [name, value] of names) {
        entries.push(name);
        entries.push(value);
      }
      node.put("Names", entries);
      return node;
    };
    const tree = document.newDictionary();
    tree.put("Kids", [
      kid([
        [longA, [0, "Fit"]],
        [mid, [0, "Fit"]]
      ]),
      kid([[longB, [0, "Fit"]]])
    ]);
    const namesRoot = document.newDictionary();
    namesRoot.put("Dests", tree);
    catalog.put("Names", namesRoot);

    const renames = shortenLongDestinationNames(document, noScope);
    expect(renames.size).toBe(2);
    expect(renames.has(longA)).toBe(true);
    expect(renames.has(longB)).toBe(true);

    const root = catalog.get("Names").get("Dests");
    expect(root.get("Kids").isNull()).toBe(true);
    const flat = root.get("Names");
    expect(flat.isArray()).toBe(true);
    expect(flat.length).toBe(6);
    const keys = [flat.get(0).asName(), flat.get(2).asName(), flat.get(4).asName()];
    // Sorted ascending bytewise, with the untouched short name first.
    expect(keys[0]).toBe(mid);
    expect(keys[1].startsWith("viv-id-")).toBe(true);
    expect(keys[2].startsWith("viv-id-")).toBe(true);
    expect(flat.get(1).isArray()).toBe(true);
    expect(flat.get(3).isArray()).toBe(true);
    expect(flat.get(5).isArray()).toBe(true);
  });

  it("returns an empty map when no name exceeds the limit", async () => {
    const document = mupdf.PDFDocument.openDocument(await minimalPdf(), "application/pdf") as mupdf.PDFDocument;
    expect(shortenLongDestinationNames(document, noScope).size).toBe(0);
  });

  it("leaves already-shortened output unchanged", async () => {
    const { bytes } = await pdfWithDestinations();
    const once = await postProcessPdf(bytes, { metadata: { creator: "c", producer: "p" } });
    const twice = await postProcessPdf(once, { metadata: { creator: "c", producer: "p" } });
    const firstNames = destinationNames(mupdf.PDFDocument.openDocument(once, "application/pdf") as mupdf.PDFDocument);
    const secondNames = destinationNames(mupdf.PDFDocument.openDocument(twice, "application/pdf") as mupdf.PDFDocument);
    expect(secondNames).toEqual(firstNames);
  });
});

describe("loadDefaultIccProfile", () => {
  it("loads the bundled sRGB profile", () => {
    const { bytes, name } = loadDefaultIccProfile();
    expect(name).toBe("sRGB IEC61966-2.1");
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

  it("reads the DOI from the usual metas and normalizes it", () => {
    const dom = new JSDOM(`<!doctype html><html><head>
      <meta name="citation_doi" content="https://doi.org/10.5281/zenodo.12345">
      </head><body></body></html>`);
    expect(extractMetadataFromDocument(dom.window.document)).toEqual({ doi: "10.5281/zenodo.12345" });

    const dcDom = new JSDOM(`<!doctype html><html><head>
      <meta name="dc.identifier" content="doi:10.1000/xyz123">
      </head><body></body></html>`);
    expect(extractMetadataFromDocument(dcDom.window.document)).toEqual({ doi: "10.1000/xyz123" });
  });

  it("ignores a dc.identifier that is not a DOI", () => {
    const dom = new JSDOM(`<!doctype html><html><head>
      <meta name="dc.identifier" content="urn:isbn:0-330-23468-8">
      </head><body></body></html>`);
    expect(extractMetadataFromDocument(dom.window.document)).toEqual({});
  });

  it("reads the document URL from the canonical link", () => {
    const dom = new JSDOM(`<!doctype html><html><head>
      <link rel="canonical" href="https://example.org/blog/post">
      </head><body></body></html>`);
    expect(extractMetadataFromDocument(dom.window.document)).toEqual({ url: "https://example.org/blog/post" });
  });

  it("reads the document URL from og:url when no canonical link exists", () => {
    const dom = new JSDOM(`<!doctype html><html><head>
      <meta property="og:url" content="https://example.org/blog/other">
      </head><body></body></html>`);
    expect(extractMetadataFromDocument(dom.window.document)).toEqual({ url: "https://example.org/blog/other" });
  });

  it("ignores relative and non-http document URLs", () => {
    const dom = new JSDOM(`<!doctype html><html><head>
      <link rel="canonical" href="blog/post">
      <meta property="og:url" content="javascript:alert(1)">
      </head><body></body></html>`);
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

  it("reads the DOI and URL from the manifest", () => {
    const manifest = JSON.stringify({
      title: "Report",
      doi: "doi:10.5281/zenodo.12345",
      url: "https://example.org/report"
    });
    expect(extractMetadataFromManifest(manifest)).toEqual({
      title: "Report",
      doi: "10.5281/zenodo.12345",
      url: "https://example.org/report"
    });
  });

  it("ignores non-DOI identifiers and relative manifest URLs", () => {
    const manifest = JSON.stringify({ identifier: "urn:isbn:0-330-23468-8", url: "/report" });
    expect(extractMetadataFromManifest(manifest)).toEqual({});
  });
});

describe("normalizeDoi", () => {
  it("accepts the bare, doi: and doi.org forms", () => {
    expect(normalizeDoi("10.5281/zenodo.12345")).toBe("10.5281/zenodo.12345");
    expect(normalizeDoi("doi:10.5281/zenodo.12345")).toBe("10.5281/zenodo.12345");
    expect(normalizeDoi("https://doi.org/10.5281/zenodo.12345")).toBe("10.5281/zenodo.12345");
    expect(normalizeDoi("http://dx.doi.org/10.5281/zenodo.12345")).toBe("10.5281/zenodo.12345");
  });

  it("rejects values that are not DOIs", () => {
    expect(normalizeDoi("urn:isbn:0-330-23468-8")).toBeUndefined();
    expect(normalizeDoi("https://example.org/10.5281/x")).toBeUndefined();
    expect(normalizeDoi("")).toBeUndefined();
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

  it("lets the CLI DOI and URL win; the XMP builder drops the URL when a DOI exists", () => {
    expect(resolveMetadata({ doi: "10.5281/cli" }, { doi: "10.5281/doc", url: "https://doc.example" })).toEqual({
      doi: "10.5281/cli",
      url: "https://doc.example",
      language: DEFAULT_LANGUAGE
    });
    expect(resolveMetadata({}, { doi: "10.5281/doc", url: "https://doc.example" }).doi).toBe("10.5281/doc");
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

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

describe("parseExplicitDate", () => {
  it("accepts ISO 8601 with an offset", () => {
    const parsed = parseExplicitDate("2024-11-18T00:00:00+01:00", "--created");
    expect(parsed.pdfDate).toBe("D:20241118000000+01'00");
    expect(parsed.xmpDate).toBe("2024-11-18T00:00:00+01:00");
  });

  it("accepts date-only values as UTC midnight", () => {
    const parsed = parseExplicitDate("2024-11-18", "--created");
    expect(parsed.pdfDate).toBe("D:20241118000000Z");
    expect(parsed.xmpDate).toBe("2024-11-18T00:00:00Z");
  });

  it("accepts the PDF date form", () => {
    const parsed = parseExplicitDate("D:20241118000000+01'00", "--created");
    expect(parsed.xmpDate).toBe("2024-11-18T00:00:00+01:00");
  });

  it("round-trips the XMP and PDF date forms", () => {
    expect(xmpDateToPdfDate("2024-11-18T10:30:00Z")).toBe("D:20241118103000Z");
    expect(pdfDateToXmpDate("D:20241118103000Z")).toBe("2024-11-18T10:30:00Z");
  });

  it("rejects values that are no dates", () => {
    expect(() => parseExplicitDate("next tuesday", "--created")).toThrow(/Invalid --created date/);
  });
});

describe("document date extraction", () => {
  it("reads dcterms.created and dcterms.modified meta tags", () => {
    const dom = new JSDOM(`<!DOCTYPE html><html lang="de"><head>
        <title>Date Document</title>
        <meta name="dcterms.created" content="2024-11-18T00:00:00+01:00">
        <meta name="dcterms.modified" content="2024-11-19T12:00:00+01:00">
      </head><body></body></html>`);
    const metadata = extractMetadataFromDocument(dom.window.document);
    expect(metadata.created).toBe("2024-11-18T00:00:00+01:00");
    expect(metadata.modified).toBe("2024-11-19T12:00:00+01:00");
  });

  it("falls back to the plain date meta tag for the creation date", () => {
    const dom = new JSDOM(`<!DOCTYPE html><html lang="de"><head>
        <title>Date Document</title>
        <meta name="date" content="2024-11-18T00:00:00+01:00">
      </head><body></body></html>`);
    const metadata = extractMetadataFromDocument(dom.window.document);
    expect(metadata.created).toBe("2024-11-18T00:00:00+01:00");
    expect(metadata.modified).toBeUndefined();
  });

  it("stamps explicit dates into the information dictionary and XMP", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: {
        created: "2024-11-18T00:00:00+01:00",
        modified: "2024-11-19T12:00:00+01:00",
        creator: "c",
        producer: "p"
      }
    });
    const { info, catalog } = openPdf(stamped);
    expect(info.get("CreationDate").asString()).toBe("D:20241118000000+01'00");
    expect(info.get("ModDate").asString()).toBe("D:20241119120000+01'00");
    const xmp = catalog.get("Metadata").readStream().asString();
    expect(xmp).toContain("<xmp:CreateDate>2024-11-18T00:00:00+01:00</xmp:CreateDate>");
    expect(xmp).toContain("<xmp:ModifyDate>2024-11-19T12:00:00+01:00</xmp:ModifyDate>");
  });
});

// ---------------------------------------------------------------------------
// Label version requirements
// ---------------------------------------------------------------------------

describe("minimumVersionForLabel", () => {
  it("maps every label onto its required PDF version", () => {
    expect(minimumVersionForLabel({ kind: "pdfa", part: "1", conformance: "b" })).toBe(14);
    expect(minimumVersionForLabel({ kind: "pdfa", part: "2", conformance: "b" })).toBe(17);
    expect(minimumVersionForLabel({ kind: "pdfa", part: "3", conformance: "u" })).toBe(17);
    expect(minimumVersionForLabel({ kind: "pdfa", part: "4" })).toBe(20);
    expect(minimumVersionForLabel({ kind: "pdfx", version: "X-4" })).toBe(16);
    expect(minimumVersionForLabel({ kind: "pdfx", version: "X-1a:2003" })).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// Built-in validation
// ---------------------------------------------------------------------------

describe("validateLabeledPdf", () => {
  it("accepts properly labeled PDF/A-2b output", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: { title: "Archive", author: "Christian Mahnke", creator: "c", producer: "p" },
      label: { kind: "pdfa", part: "2", conformance: "b" },
      iccProfile: srgb.bytes,
      iccProfileName: srgb.name
    });
    expect(validateLabeledPdf(stamped, { kind: "pdfa", part: "2", conformance: "b" })).toEqual([]);
  });

  it("reports the missing identification, OutputIntent and file identifier of unlabeled output", async () => {
    const stamped = await postProcessPdf(await minimalPdf(), {
      metadata: { creator: "c", producer: "p" }
    });
    const checks = validateLabeledPdf(stamped, { kind: "pdfa", part: "2", conformance: "b" }).map((v) => v.check);
    expect(checks).toContain("xmp-identification");
    expect(checks).toContain("output-intent");
    expect(checks).toContain("file-identifier");
  });

  it("reports an unembedded font", async () => {
    // pdf-lib writes a Type1 standard font without a FontFile entry, i.e. an
    // unembedded font exactly like a print backend with a base-14 font would.
    const libDocument = await PDFDocument.create();
    const font = await libDocument.embedFont("Helvetica");
    const page = libDocument.addPage([200, 300]);
    page.drawText("Helvetica", { x: 10, y: 20, font, size: 12 });
    const bytes = await libDocument.save();
    expect(validateLabeledPdf(bytes, { kind: "pdfa", part: "2", conformance: "b" }).map((v) => v.check)).toContain("font-embedded");
  });
});

// ---------------------------------------------------------------------------
// veraPDF integration
// ---------------------------------------------------------------------------

describe("veraPdfFlavour", () => {
  it("maps labels onto veraPDF flavours", () => {
    expect(veraPdfFlavour({ kind: "pdfa", part: "1", conformance: "a" })).toBe("1a");
    expect(veraPdfFlavour({ kind: "pdfa", part: "2", conformance: "b" })).toBe("2b");
    expect(veraPdfFlavour({ kind: "pdfa", part: "2", conformance: "u" })).toBe("2u");
    expect(veraPdfFlavour({ kind: "pdfa", part: "4" })).toBe("4");
    expect(veraPdfFlavour({ kind: "pdfx", version: "X-4" })).toBe("X-4");
    expect(veraPdfFlavour({ kind: "pdfx", version: "X-1a:2003" })).toBe("X-1a");
  });
});

describe("runVeraPdf", () => {
  it("reports a missing binary instead of throwing", () => {
    const previousPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = runVeraPdf("/tmp/does-not-matter.pdf", { kind: "pdfa", part: "2", conformance: "b" });
      expect(result.ran).toBe(false);
      expect(result.reason).toBe("verapdf binary not found on PATH");
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
