// src/render/chrome.ts

// Copyright (c) 2026 Christian Mahnke
// Licensed under the MIT License.

/**
 * Locates a Chrome/Chromium binary for the renderer.
 *
 * `--executable-browser` wins, then a binary installed by @puppeteer/browsers
 * (the same cache Vivliostyle CLI used), then the usual system locations.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAC_CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium";
const LINUX_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium"
];

/** Directory @puppeteer/browsers installs into. */
export function puppeteerCacheDir(): string {
  return process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
}

/** Finds an installed browser in the @puppeteer/browsers cache. */
export function findCachedBrowser(): string | null {
  const root = join(puppeteerCacheDir(), "chrome");
  if (!existsSync(root)) return null;

  const candidates: string[] = [];
  for (const build of readdirSync(root)) {
    const buildDir = join(root, build);
    let stat;
    try {
      stat = statSync(buildDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    for (const flavour of readdirSync(buildDir)) {
      candidates.push(
        join(buildDir, flavour, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        join(buildDir, flavour, "chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        join(buildDir, flavour, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        join(buildDir, flavour, "chrome-linux64", "chrome"),
        join(buildDir, flavour, "chrome-headless-shell-linux64", "chrome-headless-shell")
      );
    }
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function systemBrowser(): string | null {
  const candidates = platform() === "darwin" ? [MAC_CHROME, MAC_CHROMIUM] : LINUX_PATHS;
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Path of the browser to launch, or `null` when none is installed.
 */
export function resolveBrowserExecutable(explicit?: string | undefined): string | null {
  const candidates = [explicit, process.env.CHROME_PATH, findCachedBrowser(), systemBrowser()];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && candidate !== "" && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Chrome flags for headless rendering.
 *
 * SwiftShader keeps WebGL (three.js, A-Frame) working without a GPU, and the
 * ANGLE/WebGPU flags extend that to WebGPU on headless machines (best effort:
 * pages report `navigator.gpu == null` when the build still lacks it).
 * `--disable-web-security` lets the page load the cross-origin embeds it shows.
 */
export function chromeArgs(extra: string[] = []): string[] {
  return [
    "--disable-field-trial-config",
    "--disable-back-forward-cache",
    "--disable-component-update",
    "--no-default-browser-check",
    "--disable-features=AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileInBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyPartitioning,Translate,AutofillServerCommunication,DestroyProfileOnBrowserClose",
    "--no-service-autorun",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--enable-unsafe-webgpu",
    "--disable-web-security",
    "--hide-scrollbars",
    "--mute-audio",
    "--force-device-scale-factor=1",
    ...extra
  ];
}
