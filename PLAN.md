# Follow-up plan — PDF post-processing session leftovers

Status of the session that added `src/render/pdf-postprocess.ts`,
`src/render/xmp.ts`, `src/metadata.ts` (metadata + XMP + PDF/A/PDF/X
labeling). This file collects what was deliberately left out, decisions that
still need input, and the risks found along the way.

## 1. Critical knowledge for any MuPDF work (found by bisection)

- **`PDFDocument.setMetaData()` replaces the trailer dict object.** A
  `PDFObject` handle held across a `setMetaData` call becomes detached:
  writes into it succeed in memory but silently disappear on
  `saveToBuffer()`. `postProcessPdf` therefore re-fetches
  trailer/catalog/info handles around every mutation
  (`withTrailer`/`withCatalog`/`withInfo`). If this module grows, keep that
  discipline; there is no error, warning or API hint — outputs are just
  missing entries.
- **`PDFObject.resolve()` does not surface stream-ness** for indirect
  references to streams (`isStream()` returns `false` even though the stream
  is intact — check via `readStream()` instead).
- `mupdf` is pinned at 1.28.0 (vivliostyle-cli v11.4's version). They left
  the patched fork (`@u1f992/mupdf`) with 1.28.0; when bumping, re-verify
  the two behaviors above — they are undocumented.

## 2. Verification gap: no veraPDF check

The labels are written but nothing validates conformance. Follow-up:

- Add `scripts/verify-pdf.mjs` running [veraPDF](https://verapdf.org/)
  against the labeled fixtures; wire it as a **non-gating** CI job (separate
  workflow or `continue-on-error`) plus one local npm script.
- Decide the exact fixture set: `--pdfa 2b`, `--pdfa 3b`, `--pdfx X-4`,
  `--pdfx X-1a:2003` over one representative fixture page.
- Expected outcome today: PDF/A-2b/3b plausibly pass or fail only on
  Chromium-specific details; PDF/A-1b will fail on transparency; PDF/X
  passes the identification checks but not a full color-conformance preflight.

## 3. Metadata model leftovers

- `xmpMM:DocumentID` is a fresh random UUID per build → **not reproducible**.
  For reproducible builds (hash-derived or `--document-id <urn>` flag) —
  decide whether reproducibility matters before adding a flag.
- `dc:language` is not written to XMP (the catalog `/Lang` carries it);
  PDF/A does not require it. Add `<dc:language><rdf:Bag>` if a validator
  complains.
- No `--created <date>`, `--producer`, `--creator` flags: the wrapper
  identity is hardcoded and the creation date is taken from the print
  backend. Add flags if users need control (vivliostyle reads creation from
  publication metadata; we skipped that).
- Manifest extraction reads `title`, `author`, `description`, `keywords`,
  `language`/`inLanguage` only — no `dateModified` → creation date, no
  canonical/link-derived metadata. Extend `extractMetadataFromManifest` when
  a manifest in the wild misses something.
- HTML extraction has no fallback to `og:title`/`og:description` and no
  support for `dcterms.date`. Cheap to add if needed.
- Consolidation: `execute()` now parses the input HTML three times
  (`hasScripts` check, `collectRemoteReferences`, `resolvePdfMetadata`).
  Merge them into one JSDOM pass — small perf win, less drift risk.

## 4. Standards-labeling leftovers

- **PDF/A-3 / PDF/A-4F**: attachment rules (`afRelationship`, EmbeddedFiles)
  are unimplemented; Chrome output has no embedded files today, so nothing
  to do until that changes or users need attaching sidecars (PDF/A-3's
  selling point).
- PDF/A-4 requires a PDF 2.0 header for real conformance; the label path
  keeps the Skia 1.4 header (only `pdfaid:part 4` is written). If veraPDF
  flags it, bump `setMinimumPdfVersion(document, 20)` for part 4.
- PDF/X-1a output-intent realism: print houses may require `GTS_PDFXVersion`
  plus a *matching* output condition (`OutputConditionIdentifier` is written
  as `"Custom"` — same as vivliostyle-cli). Consider copying the ICC
  profile's registered name into the identifier when the profile carries
  one (`description` tag).
- Full-conversion path (real PDF/X-1a / PDF/A conformance) is intentionally
  out: press-ready/Ghostscript (native + Docker) — revisit only if print
  submission becomes a real use case.

## 5. Features vivliostyle-cli has that were never ported

Not requested, listed so the gap is explicit:

- PDF bookmarks/outlines from a TOC (`applyToc` in vivliostyle's
  pdf-document.ts) — Chrome's tagged PDF may already produce an outline;
  verify what `page.pdf({tagged: true})` yields before porting.
- Page boxes: TrimBox/BleedBox/MediaBox correction + the Chromium blank-page
  deletion (`applyPageBoxes`, needs the in-browser `loadPageSizeData` pass).
- RTL reading direction (`ViewerPreferences/Direction R2L`).
- CMYK color mapping and image replacement (whole visitor machinery).

## 6. Packaging/build notes

- `src/render/srgb.icc` (60 KB, ICC `sRGB_v4_ICC_preference.icc`) ships via
  the `files: ["src"]` entry. License requires the file stay **unchanged**
  (including the embedded copyright tag); keep it byte-identical. If size
  ever matters, ICC's `sRGB2014.icc` (v2, smaller) is an alternative under
  the general ICC profile terms.
- Rollup leaves `mupdf` external (the `/^[^./]/` external pattern), so the
  wasm resolves from `node_modules` at runtime — no bundler work needed.
  Verify the packed tarball layout once before publishing
  (`npm pack --dry-run` + install-from-tarball smoke test).

## 7. Small polish candidates

- `--format` currently only guards `pdf`; the label flags subsume the old
  "different PDF formats" idea. Document that coupling in the next README
  pass (done once here) and consider deprecating `--format` altogether.
- Site (`site/`) could show the label + metadata of each fixture PDF in the
  manifest cards (data is already in the render logs).
- `docs/` still contains site scratch data — unrelated cleanup candidate.
