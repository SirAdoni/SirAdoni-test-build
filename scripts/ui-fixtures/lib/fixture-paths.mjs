// Shared path helpers for the rendered UI fixtures under scripts/ui-fixtures.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const localeEn = path.join(repoRoot, "packages", "client", "src", "localization", "locales", "en.json");
export const clientNodePaths = [path.join(repoRoot, "packages", "client", "node_modules"), path.join(repoRoot, "node_modules")];
export const clientPublicRoot = path.join(repoRoot, "packages", "client", "public");

// Vite leaves root-relative public URLs (for example /sprites/...) in CSS for
// the browser. Keep the fixture bundle's esbuild pass faithful to that
// behavior instead of resolving those URLs as filesystem imports.
export function clientPublicAssetPlugin() {
  return {
    name: "fixture-public-assets",
    setup(build) {
      build.onResolve({ filter: /^\// }, (args) => ({ path: args.path, external: true }));
    },
  };
}

export function resolveClientPublicAsset(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\0")) return null;
  const candidate = path.resolve(clientPublicRoot, `.${decoded}`);
  if (candidate !== clientPublicRoot && !candidate.startsWith(`${clientPublicRoot}${path.sep}`)) return null;
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

export function clientPublicContentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return (
    {
      ".css": "text/css",
      ".gif": "image/gif",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".json": "application/json",
      ".mp4": "video/mp4",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
    }[extension] ?? "application/octet-stream"
  );
}

export function fixtureDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export function outputDir(importMetaUrl) {
  const dir = path.join(fixtureDir(importMetaUrl), ".out");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// tsx loader for booting packages/server/src/*.ts in-process. Resolved through
// the server workspace first; falls back to the pnpm store path relative to the repo.
export function tsxLoaderUrl() {
  const serverRequire = createRequire(path.join(repoRoot, "packages", "server", "package.json"));
  let loader;
  try { loader = serverRequire.resolve("tsx"); } catch { loader = path.join(repoRoot, "node_modules", ".pnpm", "tsx@4.23.12", "node_modules", "tsx", "dist", "loader.mjs"); }
  if (!fs.existsSync(loader)) throw new Error(`tsx loader not found: ${loader}`);
  return pathToFileURL(loader).href;
}

export const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 412, height: 915 },
  mobileNarrow: { width: 390, height: 844 },
};
export const MOBILE_VIEWPORTS = [VIEWPORTS.mobile, VIEWPORTS.mobileNarrow];
export const label = (viewport) => `${viewport.width}x${viewport.height}`;
