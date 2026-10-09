// scripts/convert-docs-pdf.mjs

// Batch-converts a built Hugo site (expects `<path>/post/<slug>/<pattern>`)
// to PDF using the vivliostyle-batch-cli build. Page selection is driven by
// per-page properties (content types, embedded media, remote references) so
// problem pages can be converted and debugged in isolation.
//
// Shipped with the npm package: the default CLI path resolves relative to this
// file, so it works from a repository checkout and an installed package alike.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

/** Built CLI next to this script (../dist), valid in checkouts and installs. */
const DEFAULT_CLI = fileURLToPath(new URL("../dist/vivliostyle-batch-cli.js", import.meta.url));

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const ASSET_TAG_RE = /<(link|script|img|iframe|source|video|audio|object|embed|input|a-asset-item|model-viewer)\b[^>]*>/gi;
const URL_ATTR_RE = /(?:href|src|data|poster)\s*=\s*"([^"]*)"/gi;
const SRCSET_ATTR_RE = /srcset\s*=\s*"([^"]*)"/gi;

/** Properties a page can be selected by. Order is the display order. */
const PROPERTIES = [
  "redirect",
  "js-content",
  "img",
  "gallery",
  "code",
  "footnote",
  "pdf-link",
  "table",
  "details",
  "math",
  "video",
  "canvas",
  "iframe",
  "script",
  "remote-refs",
  "missing-local-assets"
];

// ---------------------------------------------------------------------------
// Options (yargs: <path> and <pattern> are mandatory positionals)
// ---------------------------------------------------------------------------

function commaList(value) {
  if (value === undefined || value === null) return null;
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function checkProperties(name, value) {
  if (!value) return;
  for (const prop of value) {
    if (!PROPERTIES.includes(prop)) throw new Error(`Unknown property "${prop}" for ${name}. Known: ${PROPERTIES.join(", ")}`);
  }
}

function parseOptions(rawArgv) {
  const parsed = yargs(hideBin(rawArgv))
    .scriptName("convert-docs-pdf")
    .usage("Usage: $0 <path> <pattern> [options]")
    .command("$0 <path> <pattern>", "Batch-convert a built Hugo site to PDF")
    .positional("path", {
      describe: "Site root to convert (expects a post/ directory of article folders)",
      type: "string",
      demandOption: true
    })
    .positional("pattern", { describe: "Page filename inside each post dir", type: "string", demandOption: true })
    .option("out", { describe: "PDF output directory", type: "string", default: "pdf" })
    .option("cli", { describe: "Built CLI entry", type: "string", default: DEFAULT_CLI })
    .option("site-host", { describe: "Host treated as locally available", type: "string", demandOption: true })
    .option("lang", { describe: "Document language passed to the CLI", type: "string" })
    .option("jobs", {
      alias: "j",
      describe: "Parallel conversions",
      type: "number",
      default: Math.max(1, Math.min(4, cpus().length - 1))
    })
    .option("only", { describe: "Convert only pages having at least one of these properties", type: "string", coerce: commaList })
    .option("skip", { describe: "Skip pages having any of these properties", type: "string", coerce: commaList })
    .option("page", { describe: "Convert only these slugs (comma-separated)", type: "string", coerce: commaList })
    .option("list", { describe: "Print slug + property matrix and exit", type: "boolean", default: false })
    .option("limit", { describe: "Convert only the first n selected pages", type: "number" })
    .option("report", { describe: "JSON summary path", type: "string", default: "pdf/report.json" })
    .option("include-redirect", {
      describe: "Also convert meta-refresh redirect stubs (skipped by default)",
      type: "boolean",
      default: false
    })
    .option("force", { describe: "Re-convert pages whose PDF already exists", type: "boolean", default: false })
    .option("dry-run", { describe: "Print the CLI arguments per page without converting", type: "boolean", default: false })
    .option("keep-logs", { describe: "Always write a per-page log, not only on failure", type: "boolean", default: false })
    .option("debug", { describe: "Pass -d to the CLI (implies --jobs 1)", type: "boolean", default: false })
    .option("fetch-missing", {
      describe: "Let Chromium load references without a local file from the web",
      type: "boolean",
      default: false
    })
    .option("wait-for-content", {
      describe: "Delay pagination until the page's async work finished",
      type: "string"
    })
    .option("pixel-ratio", { describe: "Render at n times the output resolution (e.g. 2)", type: "string" })
    .option("timeout", { describe: "Give up on a page after <ms> (Vivliostyle default 300000)", type: "string" })
    .example("$0 site article.html --list", "Print slug + property matrix and exit")
    .example("$0 site article.html --only canvas,iframe --dry-run", "Show what problem pages would convert")
    .example("$0 site article.html -j 4", "Convert with four parallel jobs")
    .example("$0 site article.html --only img --limit 5 --force --keep-logs", "Redo five image pages with logs")
    .epilogue(`Properties: ${PROPERTIES.join(", ")}`)
    .check((argv) => {
      checkProperties("--only", argv.only);
      checkProperties("--skip", argv.skip);
      return true;
    })
    .parserConfiguration({ "populate--": true })
    .strict()
    .locale("en")
    .help()
    .parse();

  const options = {
    docs: parsed.path,
    out: parsed.out,
    cli: parsed.cli,
    siteHost: parsed.siteHost,
    pageFile: parsed.pattern,
    language: parsed.lang ?? null,
    jobs: Math.max(1, parsed.jobs || 1),
    only: parsed.only,
    skip: parsed.skip,
    pages: parsed.page,
    includeRedirect: parsed.includeRedirect,
    list: parsed.list,
    limit: parsed.limit ?? null,
    force: parsed.force,
    dryRun: parsed.dryRun,
    keepLogs: parsed.keepLogs,
    debug: parsed.debug,
    fetchMissing: parsed.fetchMissing,
    waitForContent: parsed.waitForContent ?? null,
    timeout: parsed.timeout ?? null,
    pixelRatio: parsed.pixelRatio ?? null,
    report: parsed.report,
    extraArgs: parsed["--"] ?? []
  };

  if (options.debug) options.jobs = 1;
  return options;
}

// ---------------------------------------------------------------------------
// HTML inspection
// ---------------------------------------------------------------------------

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&(amp|lt|gt|quot|apos|hellip|ldquo|rdquo|ndash|mdash);/g, (match, name) => {
      const map = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        hellip: "…",
        ldquo: "“",
        rdquo: "”",
        ndash: "–",
        mdash: "—"
      };
      return map[name] ?? match;
    });
}

function textOf(html) {
  return decodeEntities(
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function firstMatch(html, re) {
  const match = re.exec(html);
  return match ? match[1].trim() : null;
}

/**
 * Classifies a single reference as "remote", "local" or "missing-local".
 * Relative references resolve against the page directory, absolute ones
 * against the site root.
 */
function classifyRef(rawUrl, pageDir, docsRoot, siteHost) {
  const url = rawUrl.trim();
  if (!url) return null;
  if (url.startsWith("#")) return null;
  if (/^(data|javascript|mailto|tel|about):/i.test(url)) return null;

  if (url.startsWith("//")) {
    const host = url.slice(2).split("/")[0];
    return host === siteHost ? resolveHostRelative(url, pageDir, docsRoot, siteHost) : { kind: "remote", url };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { kind: "remote", url };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.host !== siteHost) return { kind: "remote", url };
    const localPath = join(docsRoot, decodeURIComponent(parsed.pathname));
    return existsSync(localPath) ? { kind: "local", url, localPath } : { kind: "missing-local", url, localPath };
  }

  const clean = url.split(/[?#]/)[0];
  if (!clean) return null;
  const localPath = clean.startsWith("/") ? join(docsRoot, clean) : resolve(pageDir, clean);
  return existsSync(localPath) ? { kind: "local", url, localPath } : { kind: "missing-local", url, localPath };
}

function resolveHostRelative(url, pageDir, docsRoot, siteHost) {
  const path = url.slice(url.indexOf(siteHost) + siteHost.length).split(/[?#]/)[0];
  const clean = path.startsWith("/") ? path : `/${path}`;
  const localPath = join(docsRoot, decodeURIComponent(clean));
  return existsSync(localPath) ? { kind: "local", url, localPath } : { kind: "missing-local", url, localPath };
}

function inspectPage(file, docsRoot, siteHost) {
  const html = readFileSync(file, "utf8");
  const pageDir = dirname(file);

  const remoteRefs = new Set();
  const missingRefs = new Set();
  let hasScriptTag = false;

  ASSET_TAG_RE.lastIndex = 0;
  for (const tagMatch of html.matchAll(ASSET_TAG_RE)) {
    const tag = tagMatch[1].toLowerCase();
    const tagSource = tagMatch[0];

    if (tag === "script") hasScriptTag = true;

    URL_ATTR_RE.lastIndex = 0;
    const refs = [...tagSource.matchAll(URL_ATTR_RE)].map((m) => m[1]);
    SRCSET_ATTR_RE.lastIndex = 0;
    for (const m of tagSource.matchAll(SRCSET_ATTR_RE)) refs.push(...m[1].split(",").map((c) => c.trim().split(/\s+/)[0]));

    for (const ref of refs) {
      const classified = classifyRef(ref, pageDir, docsRoot, siteHost);
      if (!classified) continue;
      if (classified.kind === "remote") remoteRefs.add(classified.url);
      if (classified.kind === "missing-local") missingRefs.add(classified.url);
    }
  }

  const headingHtml =
    firstMatch(html, /<h1[^>]*class="[^"]*post-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ??
    firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ??
    "";

  const properties = {
    redirect: /http-equiv\s*=\s*"refresh"/i.test(html),
    "js-content": /class="[^"]*\bscript\b[^"]*"|<canvas[\s>]|<a-scene[\s>]|<model-viewer[\s>]/i.test(html),
    img: /<img[\s>]/i.test(html),
    gallery: /class="[^"]*gallery/i.test(html),
    code: /<pre[\s>]|<code[\s>]/i.test(html),
    footnote: /class="footnote"/i.test(html),
    "pdf-link": /href="[^"]*\.pdf(#[^"]*)?"/i.test(html),
    table: /<table[\s>]/i.test(html),
    details: /<details[\s>]/i.test(html),
    math: /katex|MathJax|class="math"/i.test(html),
    video: /<video[\s>]|<audio[\s>]/i.test(html),
    canvas: /<canvas[\s>]|<model-viewer[\s>]/i.test(html),
    iframe: /<iframe[\s>]/i.test(html),
    script: hasScriptTag,
    "remote-refs": remoteRefs.size > 0,
    "missing-local-assets": missingRefs.size > 0
  };

  return {
    file,
    slug: basename(dirname(file)),
    title: textOf(headingHtml),
    author: firstMatch(html, /<meta\s+name="author"\s+content="([^"]*)"/i),
    properties,
    flags: PROPERTIES.filter((prop) => properties[prop]),
    remoteRefs: [...remoteRefs],
    missingRefs: [...missingRefs]
  };
}

// ---------------------------------------------------------------------------
// Discovery / selection
// ---------------------------------------------------------------------------

function discoverPages(docsRoot, pageFile) {
  const postRoot = join(docsRoot, "post");
  if (!existsSync(postRoot)) throw new Error(`Not a post directory: ${postRoot}`);

  return readdirSync(postRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(postRoot, entry.name, pageFile))
    .filter((file) => existsSync(file))
    .sort();
}

function selectPages(pages, options) {
  let selected = pages;
  if (options.pages) selected = selected.filter((page) => options.pages.includes(page.slug));
  if (options.only) selected = selected.filter((page) => options.only.some((prop) => page.properties[prop]));
  if (options.skip) selected = selected.filter((page) => !options.skip.some((prop) => page.properties[prop]));
  if (!options.includeRedirect) selected = selected.filter((page) => !page.properties.redirect);
  if (options.limit !== null) selected = selected.slice(0, options.limit);
  return selected;
}

function listPages(pages) {
  const header = ["slug", ...PROPERTIES].join("\t");
  console.log(header);
  for (const page of pages) {
    const cells = PROPERTIES.map((prop) => (page.properties[prop] ? "x" : "."));
    const missing = page.missingRefs.length > 0 ? ` (${page.missingRefs.length} missing)` : "";
    const remote = page.remoteRefs.length > 0 ? ` (${page.remoteRefs.length} remote)` : "";
    console.log([page.slug, ...cells].join("\t") + missing + remote);
  }
  const counts = PROPERTIES.map((prop) => `${prop}=${pages.filter((page) => page.properties[prop]).length}`);
  console.log(`\n${pages.length} pages — ${counts.join(" ")}`);
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function buildArgv(page, options, docsRoot, outFile) {
  const cliPath = resolve(options.cli);
  const siteOrigin = `https://${options.siteHost}`;
  const argv = [cliPath, "-i", page.file, "-o", outFile, "--asset-base", `${siteOrigin}=${docsRoot}`];
  if (options.language) argv.push("--language", options.language);
  if (page.title) argv.push("--title", page.title);
  if (page.author) argv.push("--author", page.author);
  if (options.fetchMissing) argv.push("--fetch-missing");
  if (options.waitForContent !== null) argv.push("--wait-for-content", String(options.waitForContent));
  if (options.pixelRatio !== null) argv.push("--pixel-ratio", String(options.pixelRatio));
  if (options.timeout !== null) argv.push("--timeout", String(options.timeout));
  if (options.debug) argv.push("-d");
  if (options.extraArgs.length > 0) argv.push("--", ...options.extraArgs);
  return argv;
}

function quoteArgv(argv) {
  return argv.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

function spawnCli(argv) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => resolvePromise({ code: 1, stdout, stderr: `${stderr}\n${String(err)}` }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

function collectWarnings(output) {
  const warnings = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (/does not exist|\[offline\]|\[fetch\]|\[wait\]/.test(trimmed)) warnings.push(trimmed);
  }
  return warnings;
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const options = parseOptions(process.argv);

  const docsRoot = resolve(options.docs);
  const outDir = resolve(options.out);
  const cliPath = resolve(options.cli);

  const pages = discoverPages(docsRoot, options.pageFile).map((file) => inspectPage(file, docsRoot, options.siteHost));
  const selected = selectPages(pages, options);

  if (options.list) {
    listPages(selected);
    return 0;
  }

  if (!existsSync(cliPath) && !options.dryRun) {
    console.error(`Built CLI not found: ${cliPath}\nRun: npm install && npm run build`);
    return 1;
  }

  mkdirSync(outDir, { recursive: true });
  const logDir = join(outDir, "logs");

  console.log(`${pages.length} pages found, ${selected.length} selected, ${options.jobs} job(s)`);
  if (options.dryRun) {
    for (const page of selected) {
      console.log(`${page.slug}\n  ${quoteArgv(buildArgv(page, options, docsRoot, join(outDir, `${page.slug}.pdf`)))}`);
    }
    return 0;
  }

  const pending = [];
  let skipped = 0;
  for (const page of selected) {
    const outFile = join(outDir, `${page.slug}.pdf`);
    if (existsSync(outFile) && !options.force) {
      skipped++;
      continue;
    }
    pending.push({ page, outFile });
  }
  if (skipped > 0) console.log(`Skipping ${skipped} page(s) with an existing PDF (use --force to redo)`);
  if (pending.length === 0) return 0;

  const report = {
    startedAt: new Date().toISOString(),
    docsRoot,
    outDir,
    jobs: options.jobs,
    fetchMissing: options.fetchMissing,
    total: pending.length,
    converted: 0,
    failed: 0,
    pages: []
  };

  let done = 0;
  const results = await runPool(pending, options.jobs, async ({ page, outFile }) => {
    const started = Date.now();
    const argv = buildArgv(page, options, docsRoot, outFile);
    const { code, stdout, stderr } = await spawnCli(argv);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    done++;

    const warnings = collectWarnings(`${stdout}\n${stderr}`);
    const ok = code === 0 && existsSync(outFile);
    if (ok) report.converted++;
    else report.failed++;

    report.pages.push({
      slug: page.slug,
      file: page.file,
      output: outFile,
      ok,
      exitCode: code,
      seconds: Number(seconds),
      flags: page.flags,
      title: page.title,
      warnings,
      remoteRefs: page.remoteRefs,
      missingRefs: page.missingRefs
    });

    if (!ok || options.keepLogs) {
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, `${page.slug}.log`), `argv: ${quoteArgv(argv)}\n\n${stdout}\n${stderr}`, "utf-8");
    }

    const status = ok ? "ok" : "FAILED";
    const warnNote = warnings.length > 0 ? ` (${warnings.length} warning(s))` : "";
    console.log(`[${done}/${pending.length}] ${status} ${page.slug} ${seconds}s${warnNote}`);
    return { ok };
  });

  report.finishedAt = new Date().toISOString();
  const reportPath = resolve(options.report);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${report.converted} converted, ${failed} failed, ${skipped} skipped — report: ${reportPath}`);

  const withMissing = report.pages.filter((entry) => entry.missingRefs.length > 0);
  if (withMissing.length > 0) {
    console.log(`\n${withMissing.length} page(s) reference assets missing from ${docsRoot}:`);
    for (const entry of withMissing) console.log(`  ${entry.slug}: ${entry.missingRefs.join(", ")}`);
  }

  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
