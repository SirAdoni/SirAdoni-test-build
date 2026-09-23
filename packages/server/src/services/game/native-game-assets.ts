import { existsSync, statSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { GAME_ASSETS_DIR } from "./asset-manifest.service.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Canonical read-only assets shipped with Marinara Engine. */
export const BUNDLED_GAME_ASSETS_DIR = resolve(moduleDir, "../../assets/default-game-assets");

function safeRelativeAssetPath(relativePath: string): string | null {
  if (!relativePath || isAbsolute(relativePath)) return null;
  const segments = relativePath.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return join(...segments);
}

function runtimeRelativePath(absolutePath: string): string | null {
  const relativePath = relative(GAME_ASSETS_DIR, absolutePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return null;
  }
  return safeRelativeAssetPath(relativePath);
}

function bundledEntry(relativePath: string, expectedType: "file" | "directory"): boolean {
  const safePath = safeRelativeAssetPath(relativePath);
  if (!safePath) return false;
  const candidate = join(BUNDLED_GAME_ASSETS_DIR, safePath);
  if (!existsSync(candidate)) return false;
  const stat = statSync(candidate);
  return expectedType === "file" ? stat.isFile() : stat.isDirectory();
}

/** True only when this exact runtime file corresponds to a shipped asset. */
export function isBundledGameAsset(filePath: string): boolean {
  const relativePath = runtimeRelativePath(filePath);
  return relativePath ? bundledEntry(relativePath, "file") : false;
}

/** True when this exact runtime folder has a corresponding shipped folder. */
export function folderContainsBundledGameAssets(folderPath: string): boolean {
  const relativePath = runtimeRelativePath(folderPath);
  return relativePath ? bundledEntry(relativePath, "directory") : false;
}

/** Pure relative-path variants used by focused regression coverage. */
export function isBundledGameAssetPath(relativePath: string): boolean {
  return bundledEntry(relativePath, "file");
}

export function isBundledGameAssetFolderPath(relativePath: string): boolean {
  return bundledEntry(relativePath, "directory");
}
