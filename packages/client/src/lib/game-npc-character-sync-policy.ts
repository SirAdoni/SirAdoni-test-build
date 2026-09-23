export const GAME_NPC_CHARACTER_SYNC_DEBOUNCE_MS = 1_500;
export const GAME_NPC_CHARACTER_SYNC_RETRY_DELAY_MS = 15_000;
export const GAME_NPC_CHARACTER_SYNC_MAX_REQUEST_RETRIES = 3;
export const GAME_NPC_CHARACTER_SYNC_TOAST_ID = "game-npc-character-sync-delayed";

export interface GameNpcCharacterSyncInvalidationResult {
  refreshChat: boolean;
  refreshCharacters: boolean;
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Decide which caches a successful NPC sync actually needs to refresh. */
export function gameNpcCharacterSyncInvalidation(
  cachedMetadata: unknown,
  response: {
    gameNpcs?: unknown;
    created?: readonly unknown[];
    updated?: readonly unknown[];
    retracted?: readonly unknown[];
    links?: readonly unknown[];
  },
): GameNpcCharacterSyncInvalidationResult {
  const metadata = parseMetadata(cachedMetadata);
  const cachedRoster = metadata?.gameNpcs;
  const responseRoster = response.gameNpcs;
  const refreshChat =
    (response.retracted?.length ?? 0) > 0 ||
    !metadata ||
    !Object.prototype.hasOwnProperty.call(metadata, "gameNpcs") ||
    stableJson(cachedRoster) !== stableJson(responseRoster);
  const refreshCharacters =
    (response.created?.length ?? 0) > 0 || (response.updated?.length ?? 0) > 0 || (response.retracted?.length ?? 0) > 0;
  return { refreshChat, refreshCharacters };
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
}

/** Retry transport/server contention, but do not hammer deterministic request errors. */
export function isRetryableGameNpcCharacterSyncError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  const status = errorStatus(error);
  // apiFetch reports an unreachable server as ApiError status 0 (ME_NETWORK).
  if (status === null || status === 0) return true;
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function gameNpcCharacterSyncRetryDelay(attemptIndex: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attemptIndex), 4_000);
}

/** Keep recovering an unchanged scene, with a ceiling to avoid a tight retry loop. */
export function gameNpcCharacterSyncRecoveryDelay(attemptIndex: number): number {
  return GAME_NPC_CHARACTER_SYNC_RETRY_DELAY_MS * 2 ** Math.min(3, Math.max(0, attemptIndex));
}
