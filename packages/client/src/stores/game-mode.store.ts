// ──────────────────────────────────────────────
// Store: Game Mode
// ──────────────────────────────────────────────
import { create } from "zustand";
import {
  buildStableGameNpcId,
  applyExtendedWidgetUpdate,
  applyHudWidgetLifecycle,
  isExtendedHudWidgetType,
  coerceWidgetValue,
  leadingWidgetNumber,
  listWidgetCapacity,
} from "@marinara-engine/shared";
import { toast } from "sonner";
import { translate } from "../localization/i18n";
import {
  mergeGameNpcsPreservingAvatars,
  normalizeNpcAvatarName,
  withFreshNpcAvatarRevision,
} from "../lib/game-npc-avatar";
import { api } from "../lib/api-client";
import type {
  GameActiveState,
  GameMap,
  GameNpc,
  DiceRollResult,
  HudWidget,
  GameBlueprint,
  WidgetUpdate,
} from "@marinara-engine/shared";

/**
 * Campaign Wiki reader navigation kept across window close/reopen. Chat-scoped:
 * the window ignores a state whose chatId differs from its own.
 */
export interface CampaignWikiNavState {
  chatId: string;
  /** Entity page being read; null is the entity list. */
  entityId: string | null;
  /** Previously read pages, oldest first. */
  back: Array<string | null>;
  /** Pages left with the back control, nearest first. */
  forward: Array<string | null>;
  /** Reader scroll offset captured when the window closed. */
  scrollTop: number;
}

interface GameModeStore {
  /** The active game ID (groupId that links all sessions). */
  activeGameId: string | null;
  /** Current session chat ID. */
  activeSessionChatId: string | null;
  /** Linked party chat ID. */
  partyChatId: string | null;
  /** Current game state. */
  gameState: GameActiveState;
  /** Current map. */
  currentMap: GameMap | null;
  /** All known maps for this game. */
  maps: GameMap[];
  /** ID of the map the party is currently on. */
  activeMapId: string | null;
  /** NPCs discovered in this game. */
  npcs: GameNpc[];
  /** Whether the setup wizard is showing. */
  isSetupActive: boolean;
  /** Current step in the setup wizard. */
  setupStep: number;
  /** Rolls waiting for their own animation, in arrival order. */
  diceRollResults: DiceRollResult[];
  /** Character sheet modal state. */
  characterSheetOpen: boolean;
  characterSheetCharId: string | null;
  /** Party chat sidebar expanded. */
  partyChatExpanded: boolean;
  /** Session number. */
  sessionNumber: number;
  /** Model-designed HUD widgets. */
  hudWidgets: HudWidget[];
  /** Game blueprint from setup. */
  blueprint: GameBlueprint | null;
  /** Campaign Wiki reader position, retained while the window is closed. */
  campaignWikiNav: CampaignWikiNavState | null;

  // Actions
  setActiveGame: (gameId: string | null, sessionChatId?: string | null, partyChatId?: string | null) => void;
  setGameState: (state: GameActiveState) => void;
  setCurrentMap: (map: GameMap | null) => void;
  setMaps: (maps: GameMap[], activeMapId?: string | null) => void;
  upsertMap: (map: GameMap, active?: boolean) => void;
  setActiveMap: (mapId: string | null) => void;
  setNpcs: (npcs: GameNpc[]) => void;
  setSetupActive: (active: boolean) => void;
  setSetupStep: (step: number) => void;
  setDiceRollResult: (result: DiceRollResult | null) => void;
  dismissDiceRollResult: () => void;
  openCharacterSheet: (charId: string) => void;
  closeCharacterSheet: () => void;
  togglePartyChat: () => void;
  setPartyChatExpanded: (expanded: boolean) => void;
  setSessionNumber: (num: number) => void;
  setHudWidgets: (widgets: HudWidget[]) => void;
  applyWidgetUpdate: (update: WidgetUpdate) => HudWidget[];
  setBlueprint: (bp: GameBlueprint | null) => void;
  setCampaignWikiNav: (nav: CampaignWikiNavState | null) => void;
  /** Patch avatarUrl on tracked NPCs after server-side image generation. */
  patchNpcAvatars: (avatars: Array<{ npcId?: string | null; name: string; avatarUrl: string }>) => void;
  reset: () => void;
}

// Debounced widget persistence
let widgetPersistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingWidgetPersistence: { chatId: string; signature: string } | null = null;

export function getHudWidgetStateSignature(widgets: readonly HudWidget[]): string {
  return JSON.stringify(widgets);
}

export function getPendingHudWidgetPersistenceSignature(chatId: string): string | null {
  return pendingWidgetPersistence?.chatId === chatId ? pendingWidgetPersistence.signature : null;
}

export function registerPendingHudWidgetPersistence(chatId: string, widgets: readonly HudWidget[]) {
  pendingWidgetPersistence = { chatId, signature: getHudWidgetStateSignature(widgets) };
}

export function clearPendingHudWidgetPersist(chatId?: string, signature?: string) {
  const matchesChat = !chatId || pendingWidgetPersistence?.chatId === chatId;
  const matchesSignature = !signature || pendingWidgetPersistence?.signature === signature;
  if (matchesChat && widgetPersistTimer) {
    clearTimeout(widgetPersistTimer);
    widgetPersistTimer = null;
  }
  if (matchesChat && matchesSignature) {
    pendingWidgetPersistence = null;
  }
}

function debouncedPersistWidgets(chatId: string, widgets: HudWidget[]) {
  const signature = getHudWidgetStateSignature(widgets);
  pendingWidgetPersistence = { chatId, signature };
  if (widgetPersistTimer) clearTimeout(widgetPersistTimer);
  widgetPersistTimer = setTimeout(() => {
    widgetPersistTimer = null;
    api
      .put(`/game/${chatId}/widgets`, { widgets })
      .catch(() => {
        /* best-effort persistence */
      })
      .finally(() => {
        if (pendingWidgetPersistence?.chatId === chatId && pendingWidgetPersistence.signature === signature) {
          pendingWidgetPersistence = null;
        }
      });
  }, 1000);
}

function normalizeListWidgetItem(value: string): string {
  return value
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?;,:]+$/g, "")
    .toLowerCase();
}

function appendListWidgetItem(items: string[], nextItem: string, capacity: number): string[] {
  const cleaned = nextItem.trim();
  if (!cleaned) return items;

  const normalizedNewItem = normalizeListWidgetItem(cleaned);
  const dedupedItems = items.filter((item) => normalizeListWidgetItem(item) !== normalizedNewItem);
  return [...dedupedItems, cleaned].slice(-capacity);
}

function removeListWidgetItem(items: string[], target: string): string[] {
  const normalizedTarget = normalizeListWidgetItem(target);
  if (!normalizedTarget) return items;

  const exactMatchIndex = items.findIndex((item) => normalizeListWidgetItem(item) === normalizedTarget);
  if (exactMatchIndex >= 0) {
    return items.filter((_, index) => index !== exactMatchIndex);
  }

  const partialMatches = items
    .map((item, index) => ({ index, normalized: normalizeListWidgetItem(item) }))
    .filter(({ normalized }) => normalized.includes(normalizedTarget) || normalizedTarget.includes(normalized));

  if (partialMatches.length !== 1) return items;
  return items.filter((_, index) => index !== partialMatches[0]!.index);
}

function buildTrackedNpcStub(name: string, avatarUrl: string, npcId?: string | null): GameNpc {
  return {
    id: npcId?.trim() || buildStableGameNpcId(name),
    name,
    emoji: "👤",
    description: "",
    location: "",
    reputation: 0,
    notes: [],
    avatarUrl,
  };
}

function slugifyMapId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function getMapId(map: GameMap | null | undefined, fallbackIndex = 0): string | null {
  if (!map) return null;
  const explicit = map.id?.trim();
  if (explicit) return explicit;
  return slugifyMapId(map.name || "") || `map-${fallbackIndex + 1}`;
}

function withMapId(map: GameMap, existingMaps: readonly GameMap[] = []): GameMap {
  const explicit = map.id?.trim();
  if (explicit) return explicit === map.id ? map : { ...map, id: explicit };

  const usedIds = new Set(existingMaps.map((entry, index) => getMapId(entry, index)).filter(Boolean) as string[]);
  const base = slugifyMapId(map.name || "") || "map";
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix++}`;
  }
  return { ...map, id };
}

function upsertMapList(maps: readonly GameMap[], map: GameMap): GameMap[] {
  const mapId = getMapId(map);
  if (!mapId) return [...maps, map];

  const index = maps.findIndex((entry, entryIndex) => getMapId(entry, entryIndex) === mapId);
  if (index < 0) return [...maps, map];

  const next = [...maps];
  next[index] = map;
  return next;
}

const INITIAL_STATE = {
  activeGameId: null,
  activeSessionChatId: null,
  partyChatId: null,
  gameState: "exploration" as GameActiveState,
  currentMap: null,
  maps: [],
  activeMapId: null,
  npcs: [],
  isSetupActive: false,
  setupStep: 0,
  diceRollResults: [],
  characterSheetOpen: false,
  characterSheetCharId: null,
  partyChatExpanded: false,
  sessionNumber: 1,
  hudWidgets: [],
  blueprint: null,
  campaignWikiNav: null,
};

export const useGameModeStore = create<GameModeStore>((set) => ({
  ...INITIAL_STATE,

  setActiveGame: (gameId, sessionChatId, partyChatId) =>
    set((state) => ({
      activeGameId: gameId,
      activeSessionChatId: sessionChatId ?? null,
      partyChatId: partyChatId ?? null,
      diceRollResults:
        gameId === state.activeGameId && (sessionChatId ?? null) === state.activeSessionChatId
          ? state.diceRollResults
          : [],
    })),
  setGameState: (state) => set({ gameState: state }),
  setCurrentMap: (map) =>
    set((s) => {
      if (!map) return { currentMap: null, activeMapId: null };
      const mapWithId = withMapId(map, s.maps);
      const mapId = getMapId(mapWithId);
      return {
        currentMap: mapWithId,
        maps: upsertMapList(s.maps, mapWithId),
        activeMapId: mapId,
      };
    }),
  setMaps: (maps, activeMapId) =>
    set((s) => {
      const normalizedMaps = maps.reduce<GameMap[]>((acc, map) => {
        const mapWithId = withMapId(map, acc);
        return upsertMapList(acc, mapWithId);
      }, []);
      const preferredId =
        activeMapId ??
        s.activeMapId ??
        getMapId(s.currentMap) ??
        (normalizedMaps[0] ? getMapId(normalizedMaps[0]) : null);
      const currentMap =
        normalizedMaps.find((map, index) => getMapId(map, index) === preferredId) ?? normalizedMaps[0] ?? null;
      return {
        maps: normalizedMaps,
        currentMap,
        activeMapId: currentMap ? getMapId(currentMap) : null,
      };
    }),
  upsertMap: (map, active = true) =>
    set((s) => {
      const mapWithId = withMapId(map, s.maps);
      const mapId = getMapId(mapWithId);
      return {
        maps: upsertMapList(s.maps, mapWithId),
        ...(active ? { currentMap: mapWithId, activeMapId: mapId } : {}),
      };
    }),
  setActiveMap: (mapId) =>
    set((s) => {
      if (!mapId) return { activeMapId: null, currentMap: null };
      const currentMap = s.maps.find((map, index) => getMapId(map, index) === mapId) ?? s.currentMap;
      return { activeMapId: mapId, currentMap };
    }),
  setNpcs: (npcs) => set((s) => ({ npcs: mergeGameNpcsPreservingAvatars(s.npcs, npcs) })),
  patchNpcAvatars: (avatars) =>
    set((s) => {
      let modified = false;
      const npcNameCounts = new Map<string, number>();
      for (const npc of s.npcs) {
        const name = normalizeNpcAvatarName(npc.name);
        if (name) npcNameCounts.set(name, (npcNameCounts.get(name) ?? 0) + 1);
      }
      const nextNpcs = s.npcs.map((npc) => {
        const npcName = normalizeNpcAvatarName(npc.name);
        const match = avatars.find((avatar) => {
          const npcId = avatar.npcId?.trim();
          if (npcId) return npc.id === npcId;
          return npcNameCounts.get(npcName) === 1 && normalizeNpcAvatarName(avatar.name) === npcName;
        });
        if (match) {
          const avatarUrl = withFreshNpcAvatarRevision(match.avatarUrl);
          modified = true;
          return { ...npc, avatarUrl };
        }
        return npc; // preserve reference — no churn
      });

      for (const avatar of avatars) {
        const avatarName = normalizeNpcAvatarName(avatar.name);
        const avatarNpcId = avatar.npcId?.trim();
        const exists = avatarNpcId
          ? nextNpcs.some((npc) => npc.id === avatarNpcId)
          : nextNpcs.filter((npc) => normalizeNpcAvatarName(npc.name) === avatarName).length === 1;
        if (!exists) {
          if (!avatarNpcId && nextNpcs.some((npc) => normalizeNpcAvatarName(npc.name) === avatarName)) continue;
          nextNpcs.push(buildTrackedNpcStub(avatar.name, withFreshNpcAvatarRevision(avatar.avatarUrl), avatar.npcId));
          modified = true;
        }
      }

      // Return the SAME state reference when nothing actually changed.
      // Zustand skips subscriber notification on reference equality, which
      // prevents infinite render loops caused by useEffect → store update →
      // useSyncExternalStore synchronous re-subscription → repeat.
      if (!modified) return s;
      return { npcs: nextNpcs };
    }),
  setSetupActive: (active) => set({ isSetupActive: active }),
  setSetupStep: (step) => set({ setupStep: step }),
  setDiceRollResult: (result) =>
    set((state) => ({ diceRollResults: result ? [...state.diceRollResults, result] : [] })),
  dismissDiceRollResult: () => set((state) => ({ diceRollResults: state.diceRollResults.slice(1) })),
  openCharacterSheet: (charId) => set({ characterSheetOpen: true, characterSheetCharId: charId }),
  closeCharacterSheet: () => set({ characterSheetOpen: false, characterSheetCharId: null }),
  togglePartyChat: () => set((s) => ({ partyChatExpanded: !s.partyChatExpanded })),
  setPartyChatExpanded: (expanded) => set({ partyChatExpanded: expanded }),
  setSessionNumber: (num) => set({ sessionNumber: num }),
  setHudWidgets: (widgets) => set({ hudWidgets: widgets }),
  applyWidgetUpdate: (update) => {
    let nextWidgets: HudWidget[] = [];
    const listOverflow = new Map<string, { label: string; capacity: number; dropped: number }>();
    set((s) => {
      const updatedWidgets = update.changes.action
        ? applyHudWidgetLifecycle(s.hudWidgets, update)
        : s.hudWidgets.map((w) => {
            if (w.id !== update.widgetId) return w;
            if (isExtendedHudWidgetType(w.type)) return applyExtendedWidgetUpdate(w, update.changes);
            const changes = update.changes;
            const newConfig = { ...w.config };

            // Handle stat_block: update a specific stat by name, creating it when needed.
            if (changes.statName && w.type === "stat_block") {
              const targetName = changes.statName.trim();
              // Stat values are text ("23 h 52 min", "540 km circuit"): only a wholly numeric one becomes a number.
              const rawValue = typeof changes.value === "string" ? coerceWidgetValue(changes.value) : changes.value;
              const newValue =
                typeof rawValue === "number"
                  ? rawValue
                  : typeof rawValue === "string" && rawValue.trim()
                    ? rawValue.trim()
                    : undefined;
              if (targetName && newValue !== undefined) {
                const stats = Array.isArray(newConfig.stats) ? [...newConfig.stats] : [];
                const targetKey = targetName.toLowerCase();
                const statIndex = stats.findIndex((stat) => stat.name.trim().toLowerCase() === targetKey);
                if (statIndex >= 0) {
                  stats[statIndex] = { ...stats[statIndex]!, value: newValue };
                } else {
                  stats.push({ name: targetName, value: newValue });
                }
                newConfig.stats = stats;
              }
            } else {
              // Merge simple numeric/config fields
              if (changes.value !== undefined) newConfig.value = leadingWidgetNumber(changes.value) ?? newConfig.value;
              if (changes.count !== undefined) newConfig.count = changes.count;
              if (changes.running !== undefined) newConfig.running = changes.running;
              if (changes.seconds !== undefined) newConfig.seconds = changes.seconds;
            }

            // Handle list/inventory add/remove
            if (w.type === "list") {
              // [widget: id, max: N] raises (or lowers) how many entries the list keeps.
              if (typeof changes.max === "number" && Number.isFinite(changes.max)) {
                newConfig.max = listWidgetCapacity({ max: changes.max });
              }
              const capacity = listWidgetCapacity(newConfig);
              let nextItems = [...(newConfig.items ?? [])];
              if (changes.remove) {
                nextItems = removeListWidgetItem(nextItems, changes.remove);
              }
              if (changes.add) {
                const before = nextItems;
                nextItems = appendListWidgetItem(nextItems, changes.add, capacity);
                const dropped = before.filter((item) => !nextItems.includes(item)).length;
                if (dropped > 0) {
                  listOverflow.set(w.id, {
                    label: w.label,
                    capacity,
                    dropped: (listOverflow.get(w.id)?.dropped ?? 0) + dropped,
                  });
                }
              }
              newConfig.items = nextItems;
            } else {
              if (changes.add && w.type === "inventory_grid") {
                newConfig.contents = [...(newConfig.contents ?? []), { name: changes.add, quantity: 1 }];
              }
              if (changes.remove && w.type === "inventory_grid") {
                newConfig.contents = (newConfig.contents ?? []).filter((c) => c.name !== changes.remove);
              }
            }
            return { ...w, config: newConfig };
          });
      // Persist to server
      const chatId = s.activeSessionChatId;
      if (chatId) debouncedPersistWidgets(chatId, updatedWidgets);
      nextWidgets = updatedWidgets;
      return { hudWidgets: updatedWidgets };
    });
    // Narration can claim "added all eighteen" while a full list pushed older entries out; say so.
    for (const [widgetId, overflow] of listOverflow) {
      toast.warning(
        translate("ui.game.widgets.listOverflow", {
          label: overflow.label,
          capacity: overflow.capacity,
          dropped: overflow.dropped,
        }),
        { id: "widget-list-overflow:" + widgetId },
      );
    }
    return nextWidgets;
  },
  setBlueprint: (bp) => set({ blueprint: bp }),
  setCampaignWikiNav: (nav) => set({ campaignWikiNav: nav }),
  reset: () => set(INITIAL_STATE),
}));
