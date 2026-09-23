// Pure layout snapshot, saved-layout and undo helpers for the Game layout editor.
//
// A snapshot is every localStorage entry under a scope's panel prefix
// (`marinara-game-panel:${scopeId}:`) plus its stack key
// (`marinara-game-panel-stacks:${scopeId}`). Keys are stored relative to the
// scope so a saved layout can be applied to any game chat.

export interface LayoutStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LayoutSnapshot {
  /** Relative key -> raw stored value. Panel keys start with "panel:", the stack map is "stacks". */
  entries: Record<string, string>;
}

export const LAYOUT_SNAPSHOT_FORMAT = "marinara-game-layout";
export const LAYOUT_SNAPSHOT_VERSION = 1;
export const SAVED_LAYOUTS_STORAGE_KEY = "marinara-game-layouts:v1";
export const LAYOUT_HISTORY_LIMIT = 50;
export const LAYOUT_IMPORT_MAX_CHARS = 512 * 1024;

const PANEL_PREFIX = "marinara-game-panel:";
const STACK_PREFIX = "marinara-game-panel-stacks:";

export function layoutPanelPrefix(scopeId: string): string {
  return `${PANEL_PREFIX}${scopeId}:`;
}

export function layoutStackKey(scopeId: string): string {
  return `${STACK_PREFIX}${scopeId}`;
}

function storageKeys(storage: LayoutStorage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function absoluteKey(scopeId: string, relative: string): string | null {
  if (relative === "stacks") return layoutStackKey(scopeId);
  if (relative.startsWith("panel:") && relative.length > "panel:".length)
    return `${layoutPanelPrefix(scopeId)}${relative.slice("panel:".length)}`;
  return null;
}

export function captureLayoutSnapshot(storage: LayoutStorage, scopeId: string): LayoutSnapshot {
  const prefix = layoutPanelPrefix(scopeId);
  const stackKey = layoutStackKey(scopeId);
  const entries: Record<string, string> = {};
  for (const key of storageKeys(storage).sort()) {
    const value = storage.getItem(key);
    if (value === null) continue;
    if (key.startsWith(prefix)) entries[`panel:${key.slice(prefix.length)}`] = value;
    else if (key === stackKey) entries.stacks = value;
  }
  return { entries };
}

/**
 * Write the snapshot's keys and remove every other key under the scope.
 * Returns false and restores the previous layout when storage refuses a write (quota).
 */
export function applyLayoutSnapshot(storage: LayoutStorage, scopeId: string, snapshot: LayoutSnapshot): boolean {
  const previous = captureLayoutSnapshot(storage, scopeId);
  try {
    writeLayoutSnapshot(storage, scopeId, snapshot);
    return true;
  } catch {
    try {
      writeLayoutSnapshot(storage, scopeId, previous);
    } catch {
      /* Best effort. */
    }
    return false;
  }
}

function writeLayoutSnapshot(storage: LayoutStorage, scopeId: string, snapshot: LayoutSnapshot): void {
  const prefix = layoutPanelPrefix(scopeId);
  const stackKey = layoutStackKey(scopeId);
  const wanted = new Map<string, string>();
  for (const [relative, value] of Object.entries(snapshot.entries)) {
    const key = absoluteKey(scopeId, relative);
    if (key && typeof value === "string") wanted.set(key, value);
  }
  for (const key of storageKeys(storage)) {
    if ((key.startsWith(prefix) || key === stackKey) && !wanted.has(key)) storage.removeItem(key);
  }
  for (const [key, value] of wanted) {
    if (storage.getItem(key) !== value) storage.setItem(key, value);
  }
}

/** Remove every stored layout preference for the scope, so panels fall back to defaults. */
export function clearLayoutScope(storage: LayoutStorage, scopeId: string): void {
  applyLayoutSnapshot(storage, scopeId, { entries: {} });
}

export function snapshotsEqual(a: LayoutSnapshot | null | undefined, b: LayoutSnapshot | null | undefined): boolean {
  if (!a || !b) return a === b;
  const aKeys = Object.keys(a.entries);
  const bKeys = Object.keys(b.entries);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => b.entries[key] === a.entries[key]);
}

// ── Undo history ──

export interface LayoutHistory {
  past: LayoutSnapshot[];
  present: LayoutSnapshot;
  future: LayoutSnapshot[];
}

export function createLayoutHistory(present: LayoutSnapshot): LayoutHistory {
  return { past: [], present, future: [] };
}

/** Record a committed change. No-ops when nothing changed; keeps at most `limit` undo steps. */
export function pushLayoutHistory(
  history: LayoutHistory,
  next: LayoutSnapshot,
  limit = LAYOUT_HISTORY_LIMIT,
): LayoutHistory {
  if (snapshotsEqual(history.present, next)) return history;
  const past = [...history.past, history.present];
  return { past: past.slice(Math.max(0, past.length - limit)), present: next, future: [] };
}

export function undoLayoutHistory(history: LayoutHistory): LayoutHistory {
  if (!history.past.length) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1]!,
    future: [history.present, ...history.future],
  };
}

export function redoLayoutHistory(history: LayoutHistory): LayoutHistory {
  if (!history.future.length) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0]!,
    future: history.future.slice(1),
  };
}

// ── Saved layouts (global, reusable across game chats) ──

export interface SavedLayout {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  snapshot: LayoutSnapshot;
}

function isEntries(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, entry]) => typeof entry === "string" && absoluteKey("scope", key) !== null)
  );
}

function sanitizeName(name: unknown, fallback: string): string {
  const trimmed = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return trimmed || fallback;
}

export function parseSavedLayouts(raw: string | null): SavedLayout[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SavedLayout[] => {
      if (!item || typeof item !== "object" || typeof item.id !== "string") return [];
      if (!isEntries(item.snapshot?.entries)) return [];
      return [
        {
          id: item.id,
          name: sanitizeName(item.name, "Layout"),
          createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
          updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
          snapshot: { entries: { ...item.snapshot.entries } },
        },
      ];
    });
  } catch {
    return [];
  }
}

export function serializeSavedLayouts(layouts: SavedLayout[]): string {
  return JSON.stringify(layouts);
}

export function addSavedLayout(
  layouts: SavedLayout[],
  name: string,
  snapshot: LayoutSnapshot,
  now: number,
  id: string,
): SavedLayout[] {
  const layout: SavedLayout = {
    id,
    name: sanitizeName(name, `Layout ${layouts.length + 1}`),
    createdAt: now,
    updatedAt: now,
    snapshot: { entries: { ...snapshot.entries } },
  };
  return [...layouts, layout];
}

export function renameSavedLayout(layouts: SavedLayout[], id: string, name: string, now: number): SavedLayout[] {
  return layouts.map((layout) =>
    layout.id === id ? { ...layout, name: sanitizeName(name, layout.name), updatedAt: now } : layout,
  );
}

export function deleteSavedLayout(layouts: SavedLayout[], id: string): SavedLayout[] {
  return layouts.filter((layout) => layout.id !== id);
}

export function exportLayoutJson(name: string, snapshot: LayoutSnapshot): string {
  return JSON.stringify(
    { format: LAYOUT_SNAPSHOT_FORMAT, version: LAYOUT_SNAPSHOT_VERSION, name, entries: snapshot.entries },
    null,
    2,
  );
}

/** Parse exported JSON (one layout or a list of them). Returns null when it is not a layout. */
export function parseLayoutJson(text: string): Array<{ name: string; snapshot: LayoutSnapshot }> | null {
  // A real layout is a few KB; refuse pasted blobs that could fill localStorage.
  if (typeof text !== "string" || text.length > LAYOUT_IMPORT_MAX_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const result: Array<{ name: string; snapshot: LayoutSnapshot }> = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    const record = item as { format?: unknown; name?: unknown; entries?: unknown; snapshot?: { entries?: unknown } };
    const entries = record.entries ?? record.snapshot?.entries;
    if (record.format !== undefined && record.format !== LAYOUT_SNAPSHOT_FORMAT) return null;
    if (!isEntries(entries)) return null;
    result.push({ name: sanitizeName(record.name, "Imported layout"), snapshot: { entries: { ...entries } } });
  }
  return result.length ? result : null;
}
