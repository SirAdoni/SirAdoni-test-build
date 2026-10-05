import type { GameNpcAvatarState } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { characters } from "../../db/schema/index.js";
import { eq, inArray } from "../../db/file-query.js";
import { currentRoomGeneration } from "../multiplayer/generation-policy.js";

type CharacterAvatarRow = { id: string; avatarPath: string | null; data: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseData(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function readCharacterAvatarState(data: unknown): GameNpcAvatarState | null {
  const value = parseData(data);
  if (!isRecord(value) || !isRecord(value.extensions) || !isRecord(value.extensions.marinara)) return null;
  return readGameNpcAvatarState(value.extensions.marinara.avatarState);
}

export function readGameNpcAvatarState(value: unknown): GameNpcAvatarState | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) <= 0 ||
    typeof value.removed !== "boolean"
  ) {
    return null;
  }
  return { revision: value.revision as number, removed: value.removed };
}

/** Remove transport-supplied avatar authority while preserving unrelated extension data. */
export function withoutCharacterAvatarState<T extends { extensions?: unknown }>(data: T): T {
  if (!isRecord(data) || !isRecord(data.extensions) || !isRecord(data.extensions.marinara)) return data;
  const extensions = { ...data.extensions };
  const marinara = { ...data.extensions.marinara };
  delete marinara.avatarState;
  if (Object.keys(marinara).length) extensions.marinara = marinara;
  else delete extensions.marinara;
  return { ...data, extensions } as T;
}

/** Strip server-owned markers from a roster before it is copied or exported. */
export function withoutGameNpcAvatarStates(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((npc) => {
    if (!isRecord(npc)) return npc;
    const { avatarState: _avatarState, ...portableNpc } = npc;
    return portableNpc;
  });
}

function avatarUrl(value: unknown): string | null | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.avatarUrl === "string" || value.avatarUrl === null ? value.avatarUrl : undefined;
}

function legacyAvatar(value: unknown): string | null | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.avatar === "string" || value.avatar === null ? value.avatar : undefined;
}

function writeAvatar(value: Record<string, unknown>, url: string | null): void {
  value.avatarUrl = url;
  value.avatar = url;
}

export type NpcAvatarWriteIntents = "replace" | readonly { npcId: string; expectedRevision: number }[];

/** Project linked Character portraits and apply only explicitly authorized unlinked portrait writes. */
export async function reconcileNpcAvatarState(
  db: DB,
  incoming: unknown,
  current?: unknown,
  options?: { authorizedCharacterIds?: readonly string[]; npcAvatarWriteIntents?: NpcAvatarWriteIntents },
): Promise<unknown> {
  if (!Array.isArray(incoming)) return incoming;
  const currentNpcs = Array.isArray(current) ? current : [];
  const room = currentRoomGeneration();
  const ambientIds = room ? new Set(room.characterIds) : null;
  const callerIds = options?.authorizedCharacterIds ? new Set(options.authorizedCharacterIds) : null;
  const approvedIds =
    ambientIds && callerIds ? new Set([...ambientIds].filter((id) => callerIds.has(id))) : (ambientIds ?? callerIds);
  const currentById = new Map<string, Record<string, unknown>>();
  const currentCounts = new Map<string, number>();
  for (const value of currentNpcs) {
    if (!isRecord(value) || typeof value.id !== "string") continue;
    currentCounts.set(value.id, (currentCounts.get(value.id) ?? 0) + 1);
    currentById.set(value.id, value);
  }
  const incomingCounts = new Map<string, number>();
  for (const value of incoming) {
    if (isRecord(value) && typeof value.id === "string" && value.id)
      incomingCounts.set(value.id, (incomingCounts.get(value.id) ?? 0) + 1);
  }
  const intents = new Map<string, number>();
  const duplicateIntentIds = new Set<string>();
  if (Array.isArray(options?.npcAvatarWriteIntents)) {
    for (const intent of options.npcAvatarWriteIntents) {
      if (
        !intent ||
        typeof intent.npcId !== "string" ||
        !intent.npcId ||
        !Number.isSafeInteger(intent.expectedRevision) ||
        intent.expectedRevision < 0
      )
        continue;
      if (intents.has(intent.npcId)) duplicateIntentIds.add(intent.npcId);
      else intents.set(intent.npcId, intent.expectedRevision);
    }
  }
  for (const id of duplicateIntentIds) intents.delete(id);

  const linked = incoming.map((value) => {
    const previous =
      isRecord(value) && typeof value.id === "string" && currentCounts.get(value.id) === 1
        ? currentById.get(value.id)
        : undefined;
    const characterId =
      isRecord(value) && typeof value.characterId === "string" && value.characterId
        ? value.characterId
        : typeof previous?.characterId === "string"
          ? previous.characterId
          : null;
    return { previous, characterId, authorized: !!characterId && (!approvedIds || approvedIds.has(characterId)) };
  });
  const linkedIds = new Set(
    linked.flatMap(({ characterId, authorized }) => (characterId && authorized ? [characterId] : [])),
  );
  const rows = linkedIds.size
    ? await db
        .select({ id: characters.id, avatarPath: characters.avatarPath, data: characters.data })
        .from(characters)
        .where(inArray(characters.id, [...linkedIds]))
    : [];
  const byCharacterId = new Map<string, CharacterAvatarRow>(rows.map((row) => [row.id, row]));

  return incoming.map((value, index) => {
    if (!isRecord(value)) return value;
    const { previous, characterId, authorized } = linked[index]!;
    const result = { ...value };
    delete result.avatarState;
    if (characterId && !authorized) {
      for (const key of ["avatarUrl", "avatar"] as const) {
        const old = key === "avatarUrl" ? avatarUrl(previous) : legacyAvatar(previous);
        if (old === undefined) delete result[key];
        else result[key] = old;
      }
      return result;
    }
    if (!characterId) {
      const id = typeof value.id === "string" && value.id ? value.id : null;
      const prior = readGameNpcAvatarState(previous?.avatarState);
      const expected = id ? intents.get(id) : undefined;
      const unique = !!id && incomingCounts.get(id) === 1 && (currentCounts.get(id) ?? 0) <= 1;
      const accepted =
        unique &&
        (options?.npcAvatarWriteIntents === "replace" ||
          (expected !== undefined && expected === (prior?.revision ?? 0)));
      const requested = !!id && (options?.npcAvatarWriteIntents === "replace" || expected !== undefined);
      if (accepted) {
        const requestedUrl =
          typeof value.avatarUrl === "string" || value.avatarUrl === null
            ? value.avatarUrl
            : typeof value.avatar === "string" || value.avatar === null
              ? value.avatar
              : null;
        const previousUrl = prior?.removed
          ? null
          : typeof previous?.avatarUrl === "string" || previous?.avatarUrl === null
            ? previous.avatarUrl
            : typeof previous?.avatar === "string" || previous?.avatar === null
              ? previous.avatar
              : null;
        const changed = requestedUrl !== previousUrl || (prior?.removed ?? false) !== (requestedUrl === null);
        if (changed && (prior?.revision ?? 0) < Number.MAX_SAFE_INTEGER)
          result.avatarState = { revision: (prior?.revision ?? 0) + 1, removed: requestedUrl === null };
        else if (changed) result.avatarState = prior;
        else if (prior) result.avatarState = prior;
        writeAvatar(
          result,
          changed && (prior?.revision ?? 0) >= Number.MAX_SAFE_INTEGER
            ? prior?.removed
              ? null
              : previousUrl
            : requestedUrl,
        );
      } else if (requested || prior) {
        if (prior) {
          result.avatarState = prior;
          writeAvatar(
            result,
            prior.removed
              ? null
              : typeof previous?.avatarUrl === "string" || previous?.avatarUrl === null
                ? previous.avatarUrl
                : typeof previous?.avatar === "string" || previous?.avatar === null
                  ? previous.avatar
                  : null,
          );
        } else {
          for (const key of ["avatarUrl", "avatar"] as const) {
            const old = key === "avatarUrl" ? avatarUrl(previous) : legacyAvatar(previous);
            if (old === undefined) delete result[key];
            else result[key] = old;
          }
        }
      } else {
        for (const key of ["avatarUrl", "avatar"] as const) {
          const old = key === "avatarUrl" ? avatarUrl(previous) : legacyAvatar(previous);
          if (result[key] == null && old !== undefined) result[key] = old;
        }
      }
      return result;
    }
    const row = byCharacterId.get(characterId);
    const state = row ? readCharacterAvatarState(row.data) : null;
    if (state) {
      result.characterId = characterId;
      result.avatarState = state;
      writeAvatar(result, state.removed ? null : row!.avatarPath);
    } else {
      const sameIdentity = previous?.characterId === characterId;
      if (sameIdentity && value.avatarUrl == null && avatarUrl(previous) !== undefined)
        result.avatarUrl = avatarUrl(previous);
      if (sameIdentity && value.avatar == null && legacyAvatar(previous) !== undefined)
        result.avatar = legacyAvatar(previous);
    }
    return result;
  });
}

export async function readNpcAvatarRevision(db: DB, characterId: string): Promise<number | null> {
  const room = currentRoomGeneration();
  if (room && !room.characterIds.includes(characterId)) return null;
  const rows = await db
    .select({ id: characters.id, data: characters.data })
    .from(characters)
    .where(eq(characters.id, characterId));
  return rows[0] ? (readCharacterAvatarState(rows[0].data)?.revision ?? 0) : null;
}

export async function captureNpcAvatarRevisions(db: DB, gameNpcs: unknown): Promise<Map<string, number>> {
  const room = currentRoomGeneration();
  const approved = room ? new Set(room.characterIds) : null;
  const ids = new Set<string>();
  if (Array.isArray(gameNpcs))
    for (const value of gameNpcs) {
      if (
        isRecord(value) &&
        typeof value.characterId === "string" &&
        value.characterId &&
        (!approved || approved.has(value.characterId))
      )
        ids.add(value.characterId);
    }
  const rows = ids.size
    ? await db
        .select({ id: characters.id, data: characters.data })
        .from(characters)
        .where(inArray(characters.id, [...ids]))
    : [];
  return new Map(rows.map((row) => [row.id, readCharacterAvatarState(row.data)?.revision ?? 0]));
}
