import { useSyncExternalStore } from "react";

export type RecentMediaKind = "emoji" | "kaomoji" | "gif" | "sticker";

export interface RecentMediaItem {
  value: string;
  label?: string;
  previewUrl?: string;
}

type RecentMediaState = Record<RecentMediaKind, RecentMediaItem[]>;

const STORAGE_KEY = "marinara-recent-media-v1";
const RECENT_ITEM_LIMIT = 8;
const EMPTY_STATE: RecentMediaState = {
  emoji: [],
  kaomoji: [],
  gif: [],
  sticker: [],
};
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedState: RecentMediaState = EMPTY_STATE;
let listeningForStorage = false;

function normalizeItem(value: unknown): RecentMediaItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.value !== "string" || !row.value.trim() || row.value.length > 4096) return null;
  return {
    value: row.value,
    ...(typeof row.label === "string" && row.label.trim() ? { label: row.label.slice(0, 256) } : {}),
    ...(typeof row.previewUrl === "string" && row.previewUrl.trim() && row.previewUrl.length <= 4096
      ? { previewUrl: row.previewUrl }
      : {}),
  };
}

function normalizeState(value: unknown): RecentMediaState {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    emoji: Array.isArray(source.emoji)
      ? source.emoji
          .map(normalizeItem)
          .filter((item): item is RecentMediaItem => item !== null)
          .slice(0, RECENT_ITEM_LIMIT)
      : [],
    kaomoji: Array.isArray(source.kaomoji)
      ? source.kaomoji
          .map(normalizeItem)
          .filter((item): item is RecentMediaItem => item !== null)
          .slice(0, RECENT_ITEM_LIMIT)
      : [],
    gif: Array.isArray(source.gif)
      ? source.gif
          .map(normalizeItem)
          .filter((item): item is RecentMediaItem => item !== null)
          .slice(0, RECENT_ITEM_LIMIT)
      : [],
    sticker: Array.isArray(source.sticker)
      ? source.sticker
          .map(normalizeItem)
          .filter((item): item is RecentMediaItem => item !== null)
          .slice(0, RECENT_ITEM_LIMIT)
      : [],
  };
}

function readState(): RecentMediaState {
  if (typeof window === "undefined") return EMPTY_STATE;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return cachedState;
  }
  if (raw === cachedRaw) return cachedState;
  cachedRaw = raw;
  if (!raw) {
    cachedState = EMPTY_STATE;
    return cachedState;
  }
  try {
    cachedState = normalizeState(JSON.parse(raw));
  } catch {
    cachedState = EMPTY_STATE;
  }
  return cachedState;
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function handleStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  cachedRaw = undefined;
  readState();
  notifyListeners();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!listeningForStorage && typeof window !== "undefined") {
    listeningForStorage = true;
    window.addEventListener("storage", handleStorage);
  }
  return () => listeners.delete(listener);
}

export function rememberRecentMedia(kind: RecentMediaKind, item: RecentMediaItem): void {
  const normalized = normalizeItem(item);
  if (!normalized) return;
  const current = readState();
  const next: RecentMediaState = {
    ...current,
    [kind]: [normalized, ...current[kind].filter((entry) => entry.value !== normalized.value)].slice(
      0,
      RECENT_ITEM_LIMIT,
    ),
  };
  const raw = JSON.stringify(next);
  cachedRaw = raw;
  cachedState = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Keep same-tab recents available even when storage is unavailable.
  }
  notifyListeners();
}

export function useRecentMedia(kind: RecentMediaKind): RecentMediaItem[] {
  return useSyncExternalStore(
    subscribe,
    () => readState()[kind],
    () => EMPTY_STATE[kind],
  );
}
