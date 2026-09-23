// ──────────────────────────────────────────────
// Initiative tracker: the encounter being run, per chat
//
// The Tools tab and the tracker window show the same fight, so the working
// encounter lives here rather than in either component. It is kept in this
// browser as a convenience (a reload does not lose the fight); saving it for
// the game is an explicit action that goes to the server.
// ──────────────────────────────────────────────
import { useSyncExternalStore } from "react";
import { createInitiativeState, sanitizeInitiativeState, type InitiativeEncounterState } from "@marinara-engine/shared";

export interface InitiativeDraft {
  /** The saved encounter this draft was loaded from or saved as; null for an unsaved one. */
  encounterId: string | null;
  name: string;
  state: InitiativeEncounterState;
}

const STORAGE_PREFIX = "marinara-initiative-draft:";
const drafts = new Map<string, InitiativeDraft>();
const listeners = new Set<() => void>();

function emptyDraft(): InitiativeDraft {
  return { encounterId: null, name: "", state: createInitiativeState() };
}

function readStored(chatId: string): InitiativeDraft {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + chatId);
    if (!raw) return emptyDraft();
    const parsed = JSON.parse(raw) as Partial<InitiativeDraft> | null;
    return {
      encounterId: typeof parsed?.encounterId === "string" ? parsed.encounterId : null,
      name: typeof parsed?.name === "string" ? parsed.name : "",
      state: sanitizeInitiativeState(parsed?.state),
    };
  } catch {
    return emptyDraft();
  }
}

export function getInitiativeDraft(chatId: string): InitiativeDraft {
  let draft = drafts.get(chatId);
  if (!draft) {
    draft = readStored(chatId);
    drafts.set(chatId, draft);
  }
  return draft;
}

export function setInitiativeDraft(chatId: string, update: (draft: InitiativeDraft) => InitiativeDraft): void {
  const next = update(getInitiativeDraft(chatId));
  drafts.set(chatId, next);
  try {
    if (next.state.combatants.length === 0 && !next.encounterId) {
      window.localStorage.removeItem(STORAGE_PREFIX + chatId);
    } else {
      window.localStorage.setItem(STORAGE_PREFIX + chatId, JSON.stringify(next));
    }
  } catch {
    // Storage is a convenience; the draft still lives in memory.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInitiativeDraft(chatId: string): InitiativeDraft {
  return useSyncExternalStore(
    subscribe,
    () => getInitiativeDraft(chatId),
    () => getInitiativeDraft(chatId),
  );
}
