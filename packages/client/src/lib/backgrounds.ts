// ──────────────────────────────────────────────
// Chat background URL <-> metadata helpers
// ──────────────────────────────────────────────

import { GAME_ASSET_FILE_URL_PREFIX, gameAssetFileUrl } from "./game-asset-urls";

const USER_BACKGROUND_URL_PREFIX = "/api/backgrounds/file/";
const GAME_ASSET_BACKGROUND_META_PREFIX = "gameAsset:";

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * `width` requests a downscaled copy for previews (sidebar rows, pickers). Only honoured for
 * uploaded backgrounds — the server ignores unknown widths and animated sources and returns
 * the original, so callers never need a fallback. Omit it wherever the image is shown large.
 */
export function chatBackgroundMetadataToUrl(value: unknown, width?: number): string | null {
  if (typeof value !== "string") return null;
  const background = value.trim();
  if (!background) return null;

  const sized = (url: string) => (width ? `${url}?w=${width}` : url);

  if (background.startsWith(USER_BACKGROUND_URL_PREFIX)) return sized(background);
  if (background.startsWith(GAME_ASSET_FILE_URL_PREFIX)) return background;
  if (/^(https?:|data:|blob:)/i.test(background) || background.startsWith("/")) {
    return background;
  }

  if (background.startsWith(GAME_ASSET_BACKGROUND_META_PREFIX)) {
    const assetPath = background.slice(GAME_ASSET_BACKGROUND_META_PREFIX.length).replace(/^\/+/, "");
    return gameAssetFileUrl(assetPath);
  }

  return sized(`${USER_BACKGROUND_URL_PREFIX}${encodeURIComponent(background)}`);
}

export function chatBackgroundUrlToMetadata(url: string | null): string | null {
  if (!url) return null;

  if (url.startsWith(USER_BACKGROUND_URL_PREFIX)) {
    // Drop any `?w=` preview sizing so a round-tripped URL stores the plain filename.
    return safeDecode(url.slice(USER_BACKGROUND_URL_PREFIX.length).split("?")[0] ?? "");
  }

  if (url.startsWith(GAME_ASSET_FILE_URL_PREFIX)) {
    const assetPath = safeDecode(url.slice(GAME_ASSET_FILE_URL_PREFIX.length)).replace(/^\/+/, "");
    return assetPath ? `${GAME_ASSET_BACKGROUND_META_PREFIX}${assetPath}` : null;
  }

  return url;
}
