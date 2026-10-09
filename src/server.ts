// src/server.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * The static server the renderer serves the document and its assets from.
 *
 * It replaces the Vite based server this package used before: everything is
 * served by us, which is what makes the document's origin (and therefore the
 * base URI of scripts the page runs) ours as well.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { lookup as mimeLookup } from "mime-types";
import { resolve } from "node:path";

export type AssetBaseMapping = {
  urlBase: string;
  localBase: string;
};

export type StaticMap = Record<string, string>;

export type SettleGate = {
  /** Hold the gate response until the page reports that it settled. */
  quietMs: number;
  /** Never hold longer than this. */
  deadlineMs: number;
};

export type StaticServerOptions = {
  staticMap?: StaticMap;
  assetBases?: AssetBaseMapping[];
  /** Redirect requests without a local file to the mapped origin. */
  fetchMissing?: boolean;
  settle?: SettleGate | null;
  /** Directory of @vivliostyle/viewer/lib, served under `viewerPath`. */
  viewerLibDir?: string | null;
  /** Page that renders the document; served under the document's directory. */
  viewerFilePath?: string | null;
  /**
   * Document to serve, mapped to its path on the site. `localPath` may be null
   * at first and filled in later: the document is rewritten with the server's
   * URL, which is only known once the server runs.
   */
  entry?: { localPath: string | null; sitePath: string } | null;
  onSettled?: (detail: SettleReport) => void;
  log?: (message: string) => void;
};

export type SettleReport = {
  reason: "settled" | "deadline";
  waitedMs: number;
  detail?: Record<string, unknown>;
};

export type StaticServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

/** Paths the wrapper owns inside the site it serves. */
export const VIEWER_PAGE_NAME = "__viv-viewer.html";
export const VIEWER_LIB_PATH = "/__viv-viewer";
export const SETTLE_GATE_PATH = "/__viv-settle";
export const SETTLE_READY_PATH = "/__viv-settle-ready";

const TRANSPARENT_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** CSP that lets the Vivliostyle viewer embed the served documents. */
function frameAncestors(): string {
  return ["'self'", "http://localhost:*", "https://localhost:*", "http://127.0.0.1:*", "https://127.0.0.1:*"].join(" ");
}

/** Only redirect requests that ask for a file, never bare directory URLs. */
export function looksLikeFileRequest(urlPath: string): boolean {
  const last = urlPath.slice(urlPath.lastIndexOf("/") + 1);
  return last !== "" && last !== "/" && last.includes(".");
}

export function decodeRequestPath(req: IncomingMessage): string {
  const raw = (req.url ?? "/").split("?")[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Resolves a request path against the explicit static map, then against the
 * asset-base roots.
 */
export function resolveRequestPath(
  urlPath: string,
  staticMap: StaticMap,
  assetBases: AssetBaseMapping[]
): { localPath: string | null; remoteUrl: string | null } {
  // An exact entry whose file is gone (e.g. a derived mapping for an already
  // virtual path) must not shadow a prefix mount that actually serves the file.
  if (Object.hasOwn(staticMap, urlPath)) {
    const localPath = resolve(staticMap[urlPath]);
    if (existsSync(localPath)) return { localPath, remoteUrl: null };
  }

  for (const [virtual, localBase] of Object.entries(staticMap)) {
    const prefix = virtual.endsWith("/") ? virtual : `${virtual}/`;
    if (!urlPath.startsWith(prefix)) continue;
    const localPath = resolve(localBase, urlPath.slice(prefix.length));
    if (existsSync(localPath)) return { localPath, remoteUrl: null };
  }

  for (const ab of assetBases) {
    const localPath = resolve(ab.localBase, urlPath.replace(/^\//, ""));
    if (existsSync(localPath)) return { localPath, remoteUrl: null };
  }

  for (const ab of assetBases) {
    if (!looksLikeFileRequest(urlPath)) continue;
    return { localPath: null, remoteUrl: `${ab.urlBase.replace(/\/$/, "")}${urlPath}` };
  }

  return { localPath: null, remoteUrl: null };
}

function sendFile(res: ServerResponse, localPath: string): boolean {
  let size: number;
  try {
    const stat = statSync(localPath);
    if (!stat.isFile()) return false;
    size = stat.size;
  } catch {
    return false;
  }

  const mime = mimeLookup(localPath);
  if (mime) res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", String(size));
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors()}`);
  res.statusCode = 200;
  res.end(readFileSync(localPath));
  return true;
}

/**
 * Serves the viewer page with its asset references made absolute, so that it
 * can live in the document's directory without dragging its own assets along.
 */
export function buildViewerPage(viewerHtml: string, viewerLibPath = VIEWER_LIB_PATH): string {
  return viewerHtml
    .replace(/(src|href)="(?!https?:|data:|\/)([^"]+)"/g, (_match, attr: string, path: string) => `${attr}="${viewerLibPath}/${path}"`)
    .replace(/<base[^>]*>/g, "");
}

export async function startStaticServer(options: StaticServerOptions = {}, port = 0): Promise<StaticServer> {
  const staticMap = options.staticMap ?? {};
  const assetBases = options.assetBases ?? [];
  const fetchMissing = options.fetchMissing === true;
  const settle = options.settle ?? null;
  const log = options.log ?? ((): void => undefined);

  let released = false;
  let holdStartedAt = 0;
  let deadlineTimer: NodeJS.Timeout | null = null;
  let pending: ServerResponse[] = [];

  const release = (reason: "settled" | "deadline", detail?: Record<string, unknown>): void => {
    if (released) return;
    released = true;
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);

    const waitedMs = holdStartedAt === 0 ? 0 : Date.now() - holdStartedAt;
    options.onSettled?.({ reason, waitedMs, detail });

    const waiting = pending;
    pending = [];
    for (const res of waiting) {
      if (res.headersSent || res.writableEnded) continue;
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/gif");
      res.setHeader("Content-Length", String(TRANSPARENT_GIF.length));
      res.end(TRANSPARENT_GIF);
    }
  };

  const handleSettle = (urlPath: string, query: URLSearchParams, res: ServerResponse): boolean => {
    if (settle === null) return false;

    if (urlPath === SETTLE_READY_PATH) {
      const detail: Record<string, unknown> = {};
      for (const key of [
        "reason",
        "ms",
        "pending",
        "frames",
        "canvases",
        "containers",
        "mutations",
        "dpr",
        "painted",
        "ready",
        "longtasks"
      ]) {
        const value = query.get(key);
        if (value === null) continue;
        detail[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
      }
      res.statusCode = 204;
      res.end();
      release("settled", detail);
      return true;
    }

    if (urlPath !== SETTLE_GATE_PATH) return false;

    if (released) {
      release("deadline");
      return true;
    }

    if (holdStartedAt === 0) {
      holdStartedAt = Date.now();
      deadlineTimer = setTimeout(() => release("deadline"), settle.deadlineMs);
      deadlineTimer.unref?.();
    }

    pending.push(res);
    res.on("close", () => {
      pending = pending.filter((candidate) => candidate !== res);
    });
    return true;
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const urlPath = decodeRequestPath(req);
    const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
    // Every request the page makes transits here: log it (path + status) so
    // render problems become traceable from the per-page logs.
    res.on("finish", () => {
      log(`${urlPath} ${res.statusCode}`);
    });

    if (handleSettle(urlPath, query, res)) return;

    // The viewer page lives next to the document so that scripts the page runs
    // resolve relative URLs against the document's directory.
    if (urlPath.endsWith(`/${VIEWER_PAGE_NAME}`)) {
      const html =
        options.viewerFilePath === null || options.viewerFilePath === undefined ? "" : readFileSync(options.viewerFilePath, "utf-8");
      if (html !== "") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.end(buildViewerPage(html));
        return;
      }
    }

    if (options.viewerLibDir != null && urlPath.startsWith(`${VIEWER_LIB_PATH}/`)) {
      const relative = urlPath.slice(VIEWER_LIB_PATH.length + 1);
      if (sendFile(res, resolve(options.viewerLibDir, relative))) return;
    }

    const entry = options.entry;
    if (entry !== null && entry !== undefined && entry.localPath !== null && urlPath === entry.sitePath) {
      if (sendFile(res, resolve(entry.localPath))) return;
    }

    const { localPath, remoteUrl } = resolveRequestPath(urlPath, staticMap, assetBases);

    if (localPath !== null && sendFile(res, localPath)) return;

    if (remoteUrl !== null && fetchMissing) {
      log(`[fetch] ${urlPath} → ${remoteUrl}`);
      res.statusCode = 302;
      res.setHeader("Location", remoteUrl);
      res.end();
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  };

  const server: Server = createServer(handler);

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    baseUrl: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        release("deadline");
        server.closeAllConnections?.();
        server.close(() => resolvePromise());
      })
  };
}

/** Directory the document has on the mapped site. */
export function documentDirectoryUrl(sitePath: string, baseUrl: string): string {
  const dir = sitePath.slice(0, sitePath.lastIndexOf("/") + 1);
  return `${baseUrl}${dir}`;
}
