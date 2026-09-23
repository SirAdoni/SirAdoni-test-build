// Browser-side state for the Game layout editor: snap and collision
// preferences, live drag overlay (guides, overlaps, settle preview), undo
// history per layout scope, hidden panels, the panel catalog for the Panels
// menu, and saved layouts. Pure logic lives in game-layout-geometry.ts and
// game-layout-snapshots.ts.
import { useSyncExternalStore } from "react";
import type { LayoutRect, SnapGuide } from "./game-layout-geometry";
import {
  SAVED_LAYOUTS_STORAGE_KEY,
  applyLayoutSnapshot,
  captureLayoutSnapshot,
  createLayoutHistory,
  layoutPanelPrefix,
  parseSavedLayouts,
  pushLayoutHistory,
  redoLayoutHistory,
  serializeSavedLayouts,
  snapshotsEqual,
  undoLayoutHistory,
  type LayoutHistory,
  type LayoutSnapshot,
  type SavedLayout,
} from "./game-layout-snapshots";
import {
  GAME_PANEL_COLLISIONS_STORAGE_KEY,
  GAME_PANEL_STACK_CHANGE_EVENT,
  gamePanelCollisionsEnabled,
} from "./game-panel-layout";

type Listener = () => void;

function createEmitter() {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// ── Snap preference (device-wide) ──

const SNAP_KEY = "marinara-game-layout-snap";
const snapEmitter = createEmitter();

export function isLayoutSnapEnabled(): boolean {
  return safeStorage()?.getItem(SNAP_KEY) !== "false";
}

export function setLayoutSnapEnabled(enabled: boolean): void {
  try {
    safeStorage()?.setItem(SNAP_KEY, String(enabled));
  } catch {
    /* Best effort. */
  }
  snapEmitter.emit();
}

export function useLayoutSnapEnabled(): boolean {
  return useSyncExternalStore(snapEmitter.subscribe, isLayoutSnapEnabled, () => true);
}

// ── Collisions preference (device-wide). Off lets panels phase through each other. ──

const collisionsEmitter = createEmitter();

export function isLayoutCollisionsEnabled(): boolean {
  return gamePanelCollisionsEnabled();
}

export function setLayoutCollisionsEnabled(enabled: boolean): void {
  try {
    safeStorage()?.setItem(GAME_PANEL_COLLISIONS_STORAGE_KEY, String(enabled));
  } catch {
    /* Best effort. */
  }
  collisionsEmitter.emit();
}

export function useLayoutCollisionsEnabled(): boolean {
  return useSyncExternalStore(collisionsEmitter.subscribe, isLayoutCollisionsEnabled, () => true);
}

// ── Toolbar dock (device-wide): top or bottom centre of the surface ──

const DOCK_KEY = "marinara-game-layout-toolbar-dock";
const dockEmitter = createEmitter();

export function readLayoutToolbarDock(): "top" | "bottom" | null {
  const stored = safeStorage()?.getItem(DOCK_KEY);
  return stored === "top" || stored === "bottom" ? stored : null;
}

export function setLayoutToolbarDock(dock: "top" | "bottom"): void {
  try {
    safeStorage()?.setItem(DOCK_KEY, dock);
  } catch {
    /* Best effort. */
  }
  dockEmitter.emit();
}

export function useLayoutToolbarDock(): "top" | "bottom" | null {
  return useSyncExternalStore(dockEmitter.subscribe, readLayoutToolbarDock, () => null);
}

// ── Front panel: the last panel the user touched paints above its neighbours ──

let frontPanel: string | null = null;
const frontEmitter = createEmitter();

export function bringPanelToFront(key: string): void {
  if (frontPanel === key) return;
  frontPanel = key;
  frontEmitter.emit();
}

export function useIsFrontPanel(key: string): boolean {
  return useSyncExternalStore(
    frontEmitter.subscribe,
    () => frontPanel === key,
    () => false,
  );
}

// ── Live drag overlay (one interaction at a time) ──

export interface LayoutDragOverlay {
  guides: SnapGuide[];
  overlaps: LayoutRect[];
  /** Where the panel will settle on release, when that differs from where it is. */
  ghost: LayoutRect | null;
}

let dragOverlay: LayoutDragOverlay | null = null;
const overlayEmitter = createEmitter();

export function setLayoutDragOverlay(next: LayoutDragOverlay | null): void {
  if (next === null && dragOverlay === null) return;
  dragOverlay = next;
  overlayEmitter.emit();
}

export function useLayoutDragOverlay(): LayoutDragOverlay | null {
  return useSyncExternalStore(
    overlayEmitter.subscribe,
    () => dragOverlay,
    () => null,
  );
}

// ── Open popovers (Esc closes a popover before it leaves edit mode) ──

let openPopovers = 0;

export function markLayoutPopoverOpen(): () => void {
  openPopovers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Release after the current key event so the same Esc cannot also exit edit mode.
    window.setTimeout(() => {
      openPopovers = Math.max(0, openPopovers - 1);
    }, 0);
  };
}

export function isLayoutPopoverOpen(): boolean {
  return openPopovers > 0;
}

// ── Undo history per layout scope ──

const histories = new Map<string, LayoutHistory>();
const historyEmitter = createEmitter();
const recordTimers = new Map<string, number>();
const activeEditSessions = new Set<string>();

export function resetLayoutHistory(scopeId: string): void {
  const storage = safeStorage();
  if (!storage) return;
  const current = captureLayoutSnapshot(storage, scopeId);
  const existing = histories.get(scopeId);
  if (existing && snapshotsEqual(existing.present, current)) return;
  histories.set(scopeId, createLayoutHistory(current));
  historyEmitter.emit();
}

/**
 * Start an edit session: capture the undo baseline once. Remounts during the
 * session (for example after applying a layout) must not reset the history.
 */
export function beginLayoutEditSession(scopeId: string): void {
  if (activeEditSessions.has(scopeId)) return;
  activeEditSessions.add(scopeId);
  resetLayoutHistory(scopeId);
}

export function endLayoutEditSession(scopeId: string): void {
  flushPendingRecord(scopeId);
  activeEditSessions.delete(scopeId);
}

function recordNow(scopeId: string): void {
  recordTimers.delete(scopeId);
  const storage = safeStorage();
  if (!storage) return;
  const history = histories.get(scopeId);
  const current = captureLayoutSnapshot(storage, scopeId);
  if (!history) {
    histories.set(scopeId, createLayoutHistory(current));
    return;
  }
  const next = pushLayoutHistory(history, current);
  if (next !== history) {
    histories.set(scopeId, next);
    historyEmitter.emit();
  }
}

/**
 * Record one undo step once pending React effects have written their keys.
 * Calls within the delay collapse into one step (keyboard nudges, for example).
 */
export function requestLayoutRecord(scopeId: string, delay = 80): void {
  if (!histories.has(scopeId)) return;
  const pending = recordTimers.get(scopeId);
  if (pending != null) window.clearTimeout(pending);
  recordTimers.set(
    scopeId,
    window.setTimeout(() => recordNow(scopeId), delay),
  );
}

function flushPendingRecord(scopeId: string): void {
  const pending = recordTimers.get(scopeId);
  if (pending == null) return;
  window.clearTimeout(pending);
  recordNow(scopeId);
}

const EMPTY_HISTORY_STATE = { canUndo: false, canRedo: false };
const historyStateCache = new Map<string, { canUndo: boolean; canRedo: boolean }>();

function historyState(scopeId: string) {
  const history = histories.get(scopeId);
  if (!history) return EMPTY_HISTORY_STATE;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const cached = historyStateCache.get(scopeId);
  if (cached && cached.canUndo === canUndo && cached.canRedo === canRedo) return cached;
  const next = { canUndo, canRedo };
  historyStateCache.set(scopeId, next);
  return next;
}

export function useLayoutHistoryState(scopeId: string): { canUndo: boolean; canRedo: boolean } {
  return useSyncExternalStore(
    historyEmitter.subscribe,
    () => historyState(scopeId),
    () => EMPTY_HISTORY_STATE,
  );
}

/** Returns false when storage refused the write; the previous layout is then kept. */
function applySnapshotToScope(scopeId: string, snapshot: LayoutSnapshot): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  let applied = false;
  try {
    applied = applyLayoutSnapshot(storage, scopeId, snapshot);
  } catch {
    /* Storage unavailable: keep the current layout. */
  }
  hiddenEmitter.emit();
  window.dispatchEvent(new CustomEvent(GAME_PANEL_STACK_CHANGE_EVENT, { detail: { chatId: scopeId } }));
  return applied;
}

/** Step back. Returns true when a snapshot was applied (the caller remounts the panels). */
export function undoLayout(scopeId: string): boolean {
  flushPendingRecord(scopeId);
  const history = histories.get(scopeId);
  if (!history?.past.length) return false;
  const next = undoLayoutHistory(history);
  // A refused write leaves the layout where it was, so the history must not move either.
  if (!applySnapshotToScope(scopeId, next.present)) return false;
  histories.set(scopeId, next);
  historyEmitter.emit();
  return true;
}

export function redoLayout(scopeId: string): boolean {
  flushPendingRecord(scopeId);
  const history = histories.get(scopeId);
  if (!history?.future.length) return false;
  const next = redoLayoutHistory(history);
  if (!applySnapshotToScope(scopeId, next.present)) return false;
  histories.set(scopeId, next);
  historyEmitter.emit();
  return true;
}

/**
 * Apply a whole layout (saved, imported or empty for defaults) as one undoable step.
 * Returns false when storage refused it and the current layout was kept.
 */
export function applyLayoutAsStep(scopeId: string, snapshot: LayoutSnapshot): boolean {
  flushPendingRecord(scopeId);
  if (!applySnapshotToScope(scopeId, snapshot)) return false;
  const history = histories.get(scopeId);
  if (history) {
    const storage = safeStorage();
    if (storage) histories.set(scopeId, pushLayoutHistory(history, captureLayoutSnapshot(storage, scopeId)));
    historyEmitter.emit();
  }
  return true;
}

export function captureCurrentLayout(scopeId: string): LayoutSnapshot {
  const storage = safeStorage();
  return storage ? captureLayoutSnapshot(storage, scopeId) : { entries: {} };
}

// ── Hidden panels ──

/** Narration and the toolbar hold the game's primary controls and can never be hidden. */
export const UNHIDEABLE_PANEL_IDS = new Set(["narration", "toolbar"]);
const hiddenEmitter = createEmitter();
let hiddenVersion = 0;
hiddenEmitter.subscribe(() => {
  hiddenVersion += 1;
});

export function panelHiddenKey(scopeId: string, panelId: string): string {
  return `${layoutPanelPrefix(scopeId)}floating:${panelId}:hidden`;
}

export function isPanelHidden(scopeId: string, panelId: string): boolean {
  if (UNHIDEABLE_PANEL_IDS.has(panelId)) return false;
  try {
    return safeStorage()?.getItem(panelHiddenKey(scopeId, panelId)) === "true";
  } catch {
    return false;
  }
}

export function setPanelHidden(scopeId: string, panelId: string, hidden: boolean): void {
  if (UNHIDEABLE_PANEL_IDS.has(panelId)) return;
  try {
    if (hidden) safeStorage()?.setItem(panelHiddenKey(scopeId, panelId), "true");
    else safeStorage()?.removeItem(panelHiddenKey(scopeId, panelId));
  } catch {
    /* Best effort. */
  }
  hiddenEmitter.emit();
  requestLayoutRecord(scopeId);
}

export function usePanelHidden(scopeId: string | undefined, panelId: string): boolean {
  return useSyncExternalStore(
    hiddenEmitter.subscribe,
    () => (scopeId ? isPanelHidden(scopeId, panelId) : false),
    () => false,
  );
}

/** Changes whenever any panel is hidden or shown, for menus that list hidden state. */
export function useHiddenPanelsVersion(): number {
  return useSyncExternalStore(
    hiddenEmitter.subscribe,
    () => hiddenVersion,
    () => 0,
  );
}

// ── Panel catalog (every panel a game currently offers, hidden or not) ──

export interface LayoutCatalogEntry {
  id: string;
  label: string;
  hideable: boolean;
}

const catalogs = new Map<string, Map<string, LayoutCatalogEntry>>();
const catalogSnapshots = new Map<string, LayoutCatalogEntry[]>();
const catalogEmitter = createEmitter();
const EMPTY_CATALOG: LayoutCatalogEntry[] = [];
let catalogFrame: number | null = null;

function scheduleCatalogEmit(): void {
  if (catalogFrame != null) return;
  catalogFrame = window.requestAnimationFrame(() => {
    catalogFrame = null;
    catalogEmitter.emit();
  });
}

export function registerLayoutCatalogEntry(scopeId: string, entry: LayoutCatalogEntry): () => void {
  let catalog = catalogs.get(scopeId);
  if (!catalog) {
    catalog = new Map();
    catalogs.set(scopeId, catalog);
  }
  catalog.set(entry.id, entry);
  catalogSnapshots.delete(scopeId);
  scheduleCatalogEmit();
  return () => {
    const current = catalogs.get(scopeId);
    if (current?.get(entry.id) === entry) {
      current.delete(entry.id);
      catalogSnapshots.delete(scopeId);
      scheduleCatalogEmit();
    }
  };
}

function catalogSnapshot(scopeId: string): LayoutCatalogEntry[] {
  const cached = catalogSnapshots.get(scopeId);
  if (cached) return cached;
  const catalog = catalogs.get(scopeId);
  if (!catalog) return EMPTY_CATALOG;
  const order = (id: string) => (id === "narration" ? 0 : id === "toolbar" ? 1 : id.startsWith("widget:") ? 3 : 2);
  const next = [...catalog.values()].sort(
    (a, b) => order(a.id) - order(b.id) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
  catalogSnapshots.set(scopeId, next);
  return next;
}

export function useLayoutCatalog(scopeId: string): LayoutCatalogEntry[] {
  return useSyncExternalStore(
    catalogEmitter.subscribe,
    () => catalogSnapshot(scopeId),
    () => EMPTY_CATALOG,
  );
}

// ── Lock all / unlock all ──

export const GAME_LAYOUT_LOCK_ALL_EVENT = "marinara-game-layout-lock-all";

export function dispatchLayoutLockAll(scopeId: string, locked: boolean): void {
  window.dispatchEvent(new CustomEvent(GAME_LAYOUT_LOCK_ALL_EVENT, { detail: { scopeId, locked } }));
  requestLayoutRecord(scopeId, 120);
}

// ── Saved layouts (global) ──

const savedEmitter = createEmitter();
let savedCache: { raw: string | null; layouts: SavedLayout[] } | null = null;

export function readSavedLayouts(): SavedLayout[] {
  let raw: string | null = null;
  try {
    raw = safeStorage()?.getItem(SAVED_LAYOUTS_STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (savedCache && savedCache.raw === raw) return savedCache.layouts;
  savedCache = { raw, layouts: parseSavedLayouts(raw) };
  return savedCache.layouts;
}

/** Returns false when storage is unavailable or full, so callers can report it. */
export function writeSavedLayouts(layouts: SavedLayout[]): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    storage.setItem(SAVED_LAYOUTS_STORAGE_KEY, serializeSavedLayouts(layouts));
    savedEmitter.emit();
    return true;
  } catch {
    return false;
  }
}

export function useSavedLayouts(): SavedLayout[] {
  return useSyncExternalStore(savedEmitter.subscribe, readSavedLayouts, () => []);
}
