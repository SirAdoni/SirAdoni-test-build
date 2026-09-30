import type { GameNpcAvatarState } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { characters } from "../../db/schema/index.js";
import { eq, inArray } from "../../db/file-query.js";
import { currentRoomGeneration } from "../multiplayer/generation-policy.js";

type CharacterAvatarRow = { id: string; avatarPath: string | null; data: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCharacterData(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function readCharacterAvatarState(data: unknown): GameNpcAvatarState | null {
  if (typeof data === "string") data = parseCharacterData(data);
  if (!isRecord(data) || !isRecord(data.extensions) || !isRecord(data.extensions.marinara)) return null;
  const state = data.extensions.marinara.avatarState;
  if (!isRecord(state)) return null;
  if (!Number.isSafeInteger(state.revision) || (state.revision as number) <= 0 || typeof state.removed !== "boolean") {
    return null;
  }
  return { revision: state.revision as number, removed: state.removed };
}

export function readGameNpcAvatarState(state: unknown): GameNpcAvatarState | null {
  if (!isRecord(state)) return null;
  if (!Number.isSafeInteger(state.revision) || (state.revision as number) <= 0 || typeof state.removed !== "boolean") {
    return null;
  }
  return { revision: state.revision as number, removed: state.removed };
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

function readAvatarUrl(npc: unknown): string | null | undefined {
  if (!isRecord(npc)) return undefined;
  return typeof npc.avatarUrl === "string" || npc.avatarUrl === null ? npc.avatarUrl : undefined;
}

function readLegacyAvatar(npc: unknown): string | null | undefined {
  if (!isRecord(npc)) return undefined;
  return typeof npc.avatar === "string" || npc.avatar === null ? npc.avatar : undefined;
}

function readNpcAvatarUrl(npc: unknown): string | null {
  if (!isRecord(npc)) return null;
  if (typeof npc.avatarUrl === "string" || npc.avatarUrl === null) return npc.avatarUrl;
  if (typeof npc.avatar === "string" || npc.avatar === null) return npc.avatar;
  return null;
}

function writeNpcAvatarUrl(npc: Record<string, unknown>, avatarUrl: string | null): void {
  npc.avatarUrl = avatarUrl;
  npc.avatar = avatarUrl;
}

export type NpcAvatarWriteIntents = "replace" | readonly { npcId: string; expectedRevision: number }[];

/** Apply canonical Character portraits without letting model-authored values erase an unmarked portrait. */
export async function reconcileNpcAvatarState(
  db: DB,
  incoming: unknown,
  current?: unknown,
  options?: {
    authorizedCharacterIds?: readonly string[];
    npcAvatarWriteIntents?: NpcAvatarWriteIntents;
  },
): Promise<unknown> {
  if (!Array.isArray(incoming)) return incoming;
  const currentNpcs = Array.isArray(current) ? current : [];
  const room = currentRoomGeneration();
  const ambientIds = room ? new Set(room.characterIds) : null;
  const policyIds = options?.authorizedCharacterIds ? new Set(options.authorizedCharacterIds) : null;
  const authorizedIds =
    ambientIds && policyIds ? new Set([...ambientIds].filter((id) => policyIds.has(id))) : (ambientIds ?? policyIds);
  const currentById = new Map<string, Record<string, unknown>>();
  const currentIdCounts = new Map<string, number>();
  for (const npc of currentNpcs) {
    if (isRecord(npc) && typeof npc.id === "string") {
      currentIdCounts.set(npc.id, (currentIdCounts.get(npc.id) ?? 0) + 1);
      currentById.set(npc.id, npc);
    }
  }
  const incomingIdCounts = new Map<string, number>();
  for (const npc of incoming) {
    if (isRecord(npc) && typeof npc.id === "string" && npc.id) {
      incomingIdCounts.set(npc.id, (incomingIdCounts.get(npc.id) ?? 0) + 1);
    }
  }
  const targetedIntents = new Map<string, number>();
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
      if (targetedIntents.has(intent.npcId)) duplicateIntentIds.add(intent.npcId);
      else targetedIntents.set(intent.npcId, intent.expectedRevision);
    }
    for (const id of duplicateIntentIds) targetedIntents.delete(id);
  }
  const linkedIds = new Set<string>();
  const linkedByIndex = incoming.map((npc) => {
    const previous =
      isRecord(npc) && typeof npc.id === "string" && currentIdCounts.get(npc.id) === 1
        ? currentById.get(npc.id)
        : undefined;
    const id =
      isRecord(npc) && typeof npc.characterId === "string" && npc.characterId
        ? npc.characterId
        : typeof previous?.characterId === "string"
          ? previous.characterId
          : null;
    const authorized = Boolean(id && (!authorizedIds || authorizedIds.has(id)));
    if (id && authorized) linkedIds.add(id);
    return { previous, id, authorized };
  });
  const rows = linkedIds.size
    ? await db
        .select({ id: characters.id, avatarPath: characters.avatarPath, data: characters.data })
        .from(characters)
        .where(inArray(characters.id, [...linkedIds]))
    : [];
  const byCharacterId = new Map<string, CharacterAvatarRow>(rows.map((row) => [row.id, row] as const));
  return incoming.map((value, index) => {
    if (!isRecord(value)) return value;
    const { previous, id, authorized } = linkedByIndex[index]!;
    const result = { ...value } as Record<string, unknown>;
    // Transport markers never establish authority; only a stored roster marker or linked card can.
    delete result.avatarState;
    if (id && !authorized) {
      const previousUrl = readAvatarUrl(previous);
      const previousAvatar = readLegacyAvatar(previous);
      if (previousUrl === undefined) delete result.avatarUrl;
      else result.avatarUrl = previousUrl;
      if (previousAvatar === undefined) delete result.avatar;
      else result.avatar = previousAvatar;
      return result;
    }

    if (!id) {
      const npcId = typeof value.id === "string" && value.id ? value.id : null;
      const previousState = readGameNpcAvatarState(previous?.avatarState);
      const previousRevision = previousState?.revision ?? 0;
      const replaceIntent = options?.npcAvatarWriteIntents === "replace";
      const expectedRevision = targetedIntents.get(npcId ?? "");
      const targetedIntent = expectedRevision !== undefined;
      const hasUniqueNpcId =
        npcId !== null && incomingIdCounts.get(npcId) === 1 && (currentIdCounts.get(npcId) ?? 0) <= 1;
      const acceptedIntent =
        hasUniqueNpcId && (replaceIntent || (targetedIntent && expectedRevision === previousRevision));
      const requestedIntent = npcId !== null && (replaceIntent || targetedIntent);
      if (acceptedIntent) {
        const requestedUrl = readNpcAvatarUrl(value);
        const previousUrl = previousState?.removed ? null : readNpcAvatarUrl(previous);
        const previousRemoved = previousState?.removed ?? false;
        const removed = requestedUrl === null;
        const changed = previousUrl !== requestedUrl || previousRemoved !== removed;
        if (changed && previousRevision < Number.MAX_SAFE_INTEGER) {
          result.avatarState = { revision: previousRevision + 1, removed };
          writeNpcAvatarUrl(result, requestedUrl);
        } else if (changed) {
          // An exhausted persisted revision cannot safely authorize a new projection.
          result.avatarState = previousState;
          writeNpcAvatarUrl(result, previousState?.removed ? null : readNpcAvatarUrl(previous));
        } else {
          if (previousState) result.avatarState = previousState;
          writeNpcAvatarUrl(result, requestedUrl);
        }
      } else if (requestedIntent || previousState) {
        if (previousState) {
          result.avatarState = previousState;
          writeNpcAvatarUrl(result, previousState.removed ? null : readNpcAvatarUrl(previous));
        } else {
          delete result.avatarState;
          if (readAvatarUrl(previous) === undefined) delete result.avatarUrl;
          else result.avatarUrl = readAvatarUrl(previous);
          if (readLegacyAvatar(previous) === undefined) delete result.avatar;
          else result.avatar = readLegacyAvatar(previous);
        }
      } else {
        // Without explicit HTTP/target intent, model null and omission cannot clear an unmarked portrait.
        if (readAvatarUrl(value) == null && readAvatarUrl(previous) !== undefined) {
          result.avatarUrl = readAvatarUrl(previous);
        }
        if (readLegacyAvatar(value) == null && readLegacyAvatar(previous) !== undefined) {
          result.avatar = readLegacyAvatar(previous);
        }
      }
      return result;
    }

    const row = byCharacterId.get(id);
    const state = row ? readCharacterAvatarState(parseCharacterData(row.data)) : null;
    if (state) {
      result.avatarState = state;
      result.characterId = id;
      result.avatarUrl = state.removed ? null : row!.avatarPath;
      result.avatar = state.removed ? null : row!.avatarPath;
    } else {
      // Do not carry an unlinked roster portrait into a newly linked Character identity.
      const sameLinkedCard = isRecord(previous) && previous.characterId === id;
      if (sameLinkedCard && readAvatarUrl(value) == null) {
        const oldAvatar = readAvatarUrl(previous);
        if (oldAvatar !== undefined) result.avatarUrl = oldAvatar;
      }
      if (sameLinkedCard && readLegacyAvatar(value) == null) {
        const oldAvatar = readLegacyAvatar(previous);
        if (oldAvatar !== undefined) result.avatar = oldAvatar;
      }
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
  const row = rows[0];
  if (!row) return null;
  return readCharacterAvatarState(parseCharacterData(row.data))?.revision ?? 0;
}

export async function captureNpcAvatarRevisions(db: DB, gameNpcs: unknown): Promise<Map<string, number>> {
  const room = currentRoomGeneration();
  const authorizedIds = room ? new Set(room.characterIds) : null;
  const ids = new Set<string>();
  if (Array.isArray(gameNpcs)) {
    for (const npc of gameNpcs as unknown[]) {
      if (
        isRecord(npc) &&
        typeof npc.characterId === "string" &&
        npc.characterId &&
        (!authorizedIds || authorizedIds.has(npc.characterId))
      )
        ids.add(npc.characterId);
    }
  }
  const rows = ids.size
    ? await db
        .select({ id: characters.id, data: characters.data })
        .from(characters)
        .where(inArray(characters.id, [...ids]))
    : [];
  const revisions = new Map<string, number>();
  for (const row of rows) revisions.set(row.id, readCharacterAvatarState(parseCharacterData(row.data))?.revision ?? 0);
  return revisions;
}
