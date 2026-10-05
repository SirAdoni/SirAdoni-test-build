import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { chats } from "../../db/schema/index.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { readCharacterAvatarState, readGameNpcAvatarState } from "./npc-avatar-state.js";
import { normalizeAvatarCrop, PROFESSOR_MARI_ID, type AvatarCrop } from "@marinara-engine/shared";

export type ContactBookChatRow = {
  id: string;
  mode?: string | null;
  groupId?: string | null;
  characterIds?: unknown;
  personaId?: string | null;
  metadata?: unknown;
};

export interface GameContact {
  id: string;
  sourceChatId: string;
  characterId?: string;
  name: string;
  avatar?: string;
  avatarCrop?: AvatarCrop | null;
  portraitDescription?: string;
  gender?: string;
  pronouns?: string;
  avatarState?: { revision: number; removed: boolean };
  opinion?: number | string;
  relationshipStatus?: string;
  automaticCategories: string[];
  evidenceMessageIds: string[];
}

export interface GameContactBookResult {
  contacts: GameContact[];
  coverage: { complete: boolean; pendingSessions: number };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function identity(row: ContactBookChatRow): string {
  const meta = object(row.metadata);
  return typeof meta.gameId === "string" && meta.gameId.trim() ? meta.gameId.trim() : row.groupId || row.id;
}

function isBranch(row: ContactBookChatRow): boolean {
  const meta = object(row.metadata);
  return !!(meta.branchParentChatId || meta.parentChatId);
}

function stringIds(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return stringIds(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && !!id.trim()).map((id) => id.trim())
    : [];
}

/** Keep historical campaign authority while excluding sibling branches and ambiguous sessions. */
export function selectContactBookChats(
  current: ContactBookChatRow,
  candidates: ContactBookChatRow[],
): ContactBookChatRow[] {
  const currentMeta = object(current.metadata);
  const currentSession = typeof currentMeta.gameSessionNumber === "number" ? currentMeta.gameSessionNumber : null;
  if (isBranch(current)) return [current];
  const campaignId = identity(current);
  const scoped = candidates.filter((row) => {
    if (row.mode !== "game" || identity(row) !== campaignId || isBranch(row)) return false;
    const session = object(row.metadata).gameSessionNumber;
    return (
      row.id === current.id || (currentSession !== null && typeof session === "number" && session <= currentSession)
    );
  });
  const counts = new Map<number, number>();
  for (const row of scoped) {
    const session = object(row.metadata).gameSessionNumber;
    if (typeof session === "number") counts.set(session, (counts.get(session) ?? 0) + 1);
  }
  return scoped
    .filter((row) => {
      const session = object(row.metadata).gameSessionNumber;
      return row.id === current.id || (typeof session === "number" && counts.get(session) === 1);
    })
    .sort((left, right) => {
      const a = object(left.metadata).gameSessionNumber;
      const b = object(right.metadata).gameSessionNumber;
      return (
        (typeof a === "number" ? a : Number.MAX_SAFE_INTEGER) - (typeof b === "number" ? b : Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id)
      );
    });
}

function rowNpcs(row: ContactBookChatRow): Array<Record<string, unknown>> {
  let parsed: unknown = object(row.metadata).gameNpcs;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (Array.isArray(parsed))
    return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  return [];
}

export function selectContactBookNpcOwners(
  current: ContactBookChatRow,
  rows: ContactBookChatRow[],
): Array<{ id: string; npc: Record<string, unknown>; row: ContactBookChatRow }> {
  const owners = new Map<string, { npc: Record<string, unknown>; row: ContactBookChatRow; ambiguous: boolean }>();
  for (const row of rows) {
    const rowNpcsById = new Map<string, Record<string, unknown>>();
    const duplicateIds = new Set<string>();
    for (const npc of rowNpcs(row)) {
      const id = typeof npc.id === "string" ? npc.id.trim() : typeof npc.npcId === "string" ? npc.npcId.trim() : "";
      if (!id || duplicateIds.has(id)) continue;
      if (rowNpcsById.has(id)) {
        rowNpcsById.delete(id);
        duplicateIds.add(id);
        continue;
      }
      rowNpcsById.set(id, npc);
    }
    for (const id of new Set([...rowNpcsById.keys(), ...duplicateIds])) {
      const npc = rowNpcsById.get(id);
      const ambiguous = duplicateIds.has(id);
      if (!ambiguous && !(typeof npc?.name === "string" && npc.name.trim())) continue;
      const previous = owners.get(id);
      const session = object(row.metadata).gameSessionNumber;
      const previousSession = previous ? object(previous.row.metadata).gameSessionNumber : null;
      if (
        !previous ||
        row.id === current.id ||
        (previous.row.id !== current.id &&
          typeof session === "number" &&
          (typeof previousSession !== "number" || session > previousSession))
      )
        owners.set(id, { npc: npc ?? {}, row, ambiguous });
    }
  }
  return [...owners]
    .filter(([, value]) => !value.ambiguous)
    .map(([id, value]) => ({ id, npc: value.npc, row: value.row }));
}

export async function buildGameContactBook(db: DB, chatId: string): Promise<GameContactBookResult> {
  const current = (await db.select().from(chats).where(eq(chats.id, chatId)).limit(1))[0] as
    ContactBookChatRow | undefined;
  if (!current || current.mode !== "game") return { contacts: [], coverage: { complete: false, pendingSessions: 0 } };
  const allRows = (await db.select().from(chats)) as ContactBookChatRow[];
  const selected = selectContactBookChats(current, allRows);
  const currentSession = object(current.metadata).gameSessionNumber;
  const eligibleHistory = isBranch(current)
    ? [current]
    : allRows.filter((row) => {
        if (row.mode !== "game" || identity(row) !== identity(current) || isBranch(row)) return false;
        const session = object(row.metadata).gameSessionNumber;
        return (
          row.id === current.id ||
          (typeof currentSession === "number" && (typeof session !== "number" || session <= currentSession))
        );
      });
  const pendingSessions = Math.max(0, eligibleHistory.length - selected.length);
  const latestNpcById = new Map(selectContactBookNpcOwners(current, selected).map(({ id, ...owner }) => [id, owner]));

  const currentMeta = object(current.metadata);
  const setup = object(currentMeta.gameSetupConfig);
  const gmCharacterId = typeof setup.gmCharacterId === "string" ? setup.gmCharacterId : "";
  const activeCharacterIds = new Set(
    [
      ...stringIds(current.characterIds),
      ...stringIds(currentMeta.gamePartyCharacterIds),
      ...stringIds(setup.partyCharacterIds),
    ].filter((id) => id !== gmCharacterId && id !== PROFESSOR_MARI_ID),
  );
  const linkedIds = [...latestNpcById.values()]
    .map(({ npc }) => (typeof npc.characterId === "string" ? npc.characterId.trim() : ""))
    .filter(Boolean);
  const characterIds = new Set([...activeCharacterIds, ...linkedIds]);
  const characterStorage = createCharactersStorage(db);
  const cards = new Map(
    await Promise.all([...characterIds].map(async (id) => [id, await characterStorage.getById(id)] as const)),
  );
  const contacts = new Map<string, GameContact>();
  for (const [id, { npc, row }] of latestNpcById) {
    const name = typeof npc.name === "string" ? npc.name.trim() : "";
    const characterId = typeof npc.characterId === "string" ? npc.characterId.trim() : "";
    const card = characterId ? cards.get(characterId) : null;
    const state = readCharacterAvatarState(card?.data);
    const removed = object(npc.avatarState).removed === true || state?.removed === true;
    const avatar = removed
      ? undefined
      : (card?.avatarPath ?? (typeof npc.avatarUrl === "string" ? npc.avatarUrl : undefined));
    const extensions = object(object(card?.data).extensions);
    const observedDescription =
      typeof npc.observedAppearance === "string"
        ? npc.observedAppearance
        : typeof npc.observedDescription === "string"
          ? npc.observedDescription
          : undefined;
    const descriptionSource = npc.descriptionSource;
    const persistedDescription =
      descriptionSource === undefined ||
      descriptionSource === "user" ||
      descriptionSource === "model" ||
      descriptionSource === "library"
        ? typeof npc.description === "string"
          ? npc.description
          : undefined
        : undefined;
    contacts.set(id, {
      id,
      sourceChatId: row.id,
      ...(characterId ? { characterId } : {}),
      name,
      ...(avatar ? { avatar } : {}),
      avatarCrop: normalizeAvatarCrop(extensions.avatarCrop),
      ...(persistedDescription || observedDescription
        ? { portraitDescription: persistedDescription || observedDescription }
        : {}),
      ...(typeof npc.gender === "string" && npc.gender.trim() ? { gender: npc.gender.trim() } : {}),
      ...(typeof npc.pronouns === "string" && npc.pronouns.trim() ? { pronouns: npc.pronouns.trim() } : {}),
      ...((state ?? readGameNpcAvatarState(npc.avatarState))
        ? { avatarState: state ?? readGameNpcAvatarState(npc.avatarState)! }
        : {}),
      ...(typeof npc.opinion === "number" || typeof npc.opinion === "string" ? { opinion: npc.opinion } : {}),
      ...(typeof npc.relationshipStatus === "string" ? { relationshipStatus: npc.relationshipStatus } : {}),
      automaticCategories: [],
      evidenceMessageIds: [],
    });
  }
  for (const id of activeCharacterIds) {
    const card = cards.get(id);
    if (!card) continue;
    const data = object(card.data);
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name || [...latestNpcById.values()].some((owner) => owner.npc.characterId === id)) continue;
    const state = readCharacterAvatarState(card.data);
    const extensions = object(data.extensions);
    contacts.set(`party:${id}`, {
      id: `party:${id}`,
      sourceChatId: current.id,
      characterId: id,
      name,
      ...(typeof extensions.appearance === "string" && extensions.appearance.trim()
        ? { portraitDescription: extensions.appearance.trim() }
        : typeof data.description === "string" && data.description.trim()
          ? { portraitDescription: data.description.trim() }
          : {}),
      ...(typeof data.gender === "string" && data.gender.trim() ? { gender: data.gender.trim() } : {}),
      ...(typeof data.pronouns === "string" && data.pronouns.trim() ? { pronouns: data.pronouns.trim() } : {}),
      ...(state ? { avatarState: state } : {}),
      ...(!state?.removed && card.avatarPath ? { avatar: card.avatarPath } : {}),
      avatarCrop: normalizeAvatarCrop(extensions.avatarCrop),
      automaticCategories: [],
      evidenceMessageIds: [],
    });
  }
  return {
    contacts: [...contacts.values()].sort((left, right) => left.name.localeCompare(right.name)),
    coverage: { complete: pendingSessions === 0, pendingSessions },
  };
}
