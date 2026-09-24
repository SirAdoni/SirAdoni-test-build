import { useCallback, useSyncExternalStore } from "react";

/**
 * Per-game, per-device visibility of the two character lists on the Game HUD:
 * the party bar (portraits beside the map) and the "Currently present" strip.
 * Both are shown by default. The scope is the game id, so every session of a
 * game shares the choice; the setting is device-local like the rest of the HUD
 * layout (status widget, panel positions).
 */
export type GameHudList = "partyBar" | "presence";

const LIST_KEY_PART: Record<GameHudList, string> = {
  partyBar: "party-bar",
  presence: "scene-presence",
};

export function resolveGameHudScope(
  gameId: unknown,
  groupId: string | null | undefined,
  chatId: string | null | undefined,
): string {
  if (typeof gameId === "string" && gameId.trim()) return gameId.trim();
  return groupId || chatId || "";
}

export function gameHudListStorageKey(scopeId: string, list: GameHudList): string {
  return `marinara-game-hud:${scopeId}:${LIST_KEY_PART[list]}:hidden`;
}

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key == null || event.key.startsWith("marinara-game-hud:")) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function readGameHudListHidden(scopeId: string, list: GameHudList): boolean {
  if (!scopeId) return false;
  try {
    return localStorage.getItem(gameHudListStorageKey(scopeId, list)) === "1";
  } catch {
    return false;
  }
}

export function writeGameHudListHidden(scopeId: string, list: GameHudList, hidden: boolean) {
  if (!scopeId) return;
  try {
    const key = gameHudListStorageKey(scopeId, list);
    // Shown is the default, so only the hidden choice is stored.
    if (hidden) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    /* Best effort: storage can be blocked. */
  }
  emit();
}

/** `[visible, setVisible]` for one HUD character list of one game. */
export function useGameHudListVisible(scopeId: string, list: GameHudList): [boolean, (visible: boolean) => void] {
  const hidden = useSyncExternalStore(
    subscribe,
    () => readGameHudListHidden(scopeId, list),
    () => false,
  );
  const setVisible = useCallback(
    (visible: boolean) => writeGameHudListHidden(scopeId, list, !visible),
    [scopeId, list],
  );
  return [!hidden, setVisible];
}
