import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { campaignMemoryEntities, campaignMemoryRelationships, chats } from "../../db/schema/index.js";
import { readSceneTimeline } from "./scene-timeline.service.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { normalizeAvatarCrop, type AvatarCrop } from "@marinara-engine/shared";

export interface GameContact {
  id: string;
  characterId?: string;
  name: string;
  avatar?: string;
  avatarCrop?: AvatarCrop | null;
  opinion?: number | string;
  relationshipStatus?: string;
  automaticCategories: string[];
  evidenceMessageIds: string[];
}
export interface GameContactBookResult {
  contacts: GameContact[];
  coverage: { complete: boolean; pendingSessions: number };
}

function object(value: unknown): Record<string, any> {
  if (typeof value !== "string") return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}
function identity(row: any) {
  const meta = object(row.metadata);
  return typeof meta.gameId === "string" && meta.gameId.trim() ? meta.gameId.trim() : row.groupId || row.id;
}
function norm(value: string) {
  return value.trim().toLocaleLowerCase();
}
function readIds(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

export async function buildGameContactBook(db: DB, chatId: string): Promise<GameContactBookResult> {
  const current = (await db.select().from(chats).where(eq(chats.id, chatId)).limit(1))[0];
  if (!current) return { contacts: [], coverage: { complete: false, pendingSessions: 0 } };
  const currentIdentity = identity(current);
  const metadata = object(current.metadata);
  const currentSession = typeof metadata.gameSessionNumber === "number" ? metadata.gameSessionNumber : null;
  const currentIsBranch = Boolean(metadata.branchParentChatId || metadata.parentChatId);
  const characterStorage = createCharactersStorage(db);
  const [personas, libraryRows, relationshipRows, entityRows] = await Promise.all([
    characterStorage.listPersonas(),
    characterStorage.list() as Promise<Array<{ id: string; data?: unknown; avatarPath?: string | null }>>,
    db.select().from(campaignMemoryRelationships),
    db.select().from(campaignMemoryEntities),
  ]);
  const personaName = current.personaId
    ? (personas.find((persona) => persona.id === current.personaId)?.name?.trim() ?? "")
    : "";
  const library = libraryRows.map((row) => {
    const data = object(row.data);
    const extensions = object(data.extensions);
    return {
      ...data,
      id: row.id,
      avatarUrl: row.avatarPath ?? data.avatarUrl ?? data.avatar ?? null,
      avatarCrop: normalizeAvatarCrop(extensions.avatarCrop),
    };
  });
  const candidateRows = (await db.select().from(chats)).filter((row: any) => {
    const meta = object(row.metadata);
    const session = typeof meta.gameSessionNumber === "number" ? meta.gameSessionNumber : null;
    if (row.mode !== "game") return false;
    if (currentIsBranch) return row.id === current.id;
    if (identity(row) !== currentIdentity || meta.branchParentChatId || meta.parentChatId) return false;
    // When the current campaign has numbered sessions, an unnumbered sibling
    // cannot be proven historical. Keep it out rather than leaking its future.
    return row.id === current.id || (currentSession != null && session != null && session <= currentSession);
  });
  const sessionCounts = new Map<number, number>();
  for (const row of candidateRows) {
    const session = object(row.metadata).gameSessionNumber;
    if (typeof session === "number") sessionCounts.set(session, (sessionCounts.get(session) ?? 0) + 1);
  }
  const rows = candidateRows
    .filter((row: any) => {
      const session = object(row.metadata).gameSessionNumber;
      return row.id === current.id || (typeof session === "number" && sessionCounts.get(session) === 1);
    })
    .sort((left: any, right: any) => {
      const leftSession = object(left.metadata).gameSessionNumber;
      const rightSession = object(right.metadata).gameSessionNumber;
      return (
        (typeof leftSession === "number" ? leftSession : Number.MAX_SAFE_INTEGER) -
          (typeof rightSession === "number" ? rightSession : Number.MAX_SAFE_INTEGER) ||
        String(left.id).localeCompare(String(right.id))
      );
    });
  const skippedSessions = candidateRows.length - rows.length;
  const eligibleChatIds = new Set(rows.map((row: any) => String(row.id)));
  const sessionForChat = new Map(
    rows.map((row: any) => {
      const session = object(row.metadata).gameSessionNumber;
      return [String(row.id), typeof session === "number" ? session : Number.MAX_SAFE_INTEGER] as const;
    }),
  );
  const contacts = new Map<string, GameContact>();
  const personaEntityIds = new Set(
    entityRows
      .filter((entity: any) => {
        const owner = object(entity.owner);
        return current.personaId && (owner.recordId === current.personaId || entity.entityId === current.personaId);
      })
      .map((entity: any) => String(entity.entityId)),
  );
  const relationshipEntityIdsByOwner = new Map<string, Set<string>>();
  for (const entity of entityRows as any[]) {
    const owner = object(entity.owner);
    const ownerId = typeof owner.recordId === "string" ? owner.recordId : "";
    if (!ownerId) continue;
    const ids = relationshipEntityIdsByOwner.get(ownerId) ?? new Set<string>();
    ids.add(String(entity.entityId));
    relationshipEntityIdsByOwner.set(ownerId, ids);
  }
  // The ordering depends only on fixed inputs, so sort once and memoize the
  // per-contact result instead of re-sorting the whole table for every name.
  const scopedRelationships = (relationshipRows as any[])
    .filter((relationship) => eligibleChatIds.has(String(relationship.chatId)))
    .sort(
      (left, right) =>
        Number(Boolean(left.manualLock)) - Number(Boolean(right.manualLock)) ||
        (sessionForChat.get(String(left.chatId)) ?? Number.MAX_SAFE_INTEGER) -
          (sessionForChat.get(String(right.chatId)) ?? Number.MAX_SAFE_INTEGER) ||
        String(left.updatedAt ?? left.createdAt ?? "").localeCompare(
          String(right.updatedAt ?? right.createdAt ?? ""),
        ) ||
        Number(left.revision ?? 0) - Number(right.revision ?? 0),
    );
  const relationshipCache = new Map<string, string | null | undefined>();
  const relationshipFor = (ownerIds: readonly string[]): string | null | undefined => {
    const key = [...ownerIds].sort().join("\0");
    if (relationshipCache.has(key)) return relationshipCache.get(key);
    const contactIds = new Set(ownerIds);
    for (const ownerId of ownerIds) {
      for (const entityId of relationshipEntityIdsByOwner.get(ownerId) ?? []) contactIds.add(entityId);
    }
    let selected: string | undefined;
    let selectedType: string | undefined;
    let matched = false;
    for (const relationship of scopedRelationships) {
      const type = String(relationship.type ?? "");
      // Legacy reputation edges are a score tier, not a social bond.
      if (type.startsWith("reputation:")) continue;
      const sourceContact = contactIds.has(String(relationship.sourceEntityId));
      const targetContact = contactIds.has(String(relationship.targetEntityId));
      const sourcePersona = personaEntityIds.has(String(relationship.sourceEntityId));
      const targetPersona = personaEntityIds.has(String(relationship.targetEntityId));
      if (!((sourceContact && targetPersona) || (targetContact && sourcePersona))) continue;
      // A player's suspicion or affection for someone does not establish the
      // NPC's stance toward the player.
      if (
        targetContact &&
        sourcePersona &&
        [
          "stranger-to",
          "acquaintance-of",
          "neutral-toward",
          "suspicious-of",
          "arch-nemesis-of",
          "eternal-ally-of",
          "loves",
          "hates",
          "trusts",
          "distrusts",
        ].includes(type)
      ) {
        continue;
      }
      if (relationship.status === "proposed" || relationship.status === "held") continue;
      matched = true;
      if (relationship.status === "active") {
        selected = sourceContact && targetPersona ? type : String(relationship.inverseLabel);
        selectedType = type;
      } else if (relationship.status === "ended" && selectedType === type) {
        selected = undefined;
        selectedType = undefined;
      }
    }
    const result = matched ? (selected ?? null) : undefined;
    relationshipCache.set(key, result);
    return result;
  };
  let pendingSessions = 0;
  pendingSessions += skippedSessions;
  let ambiguousContacts = 0;
  for (const row of rows) {
    const rowMetadata = object(row.metadata);
    const npcs = Array.isArray(rowMetadata.gameNpcs) ? rowMetadata.gameNpcs : [];
    // Library cards that belong to this campaign (chat cast, party, or linked
    // NPCs) are matched alongside the NPCs. The rest of the library is only a
    // fallback, so an unrelated card that shares a name cannot make a campaign
    // NPC ambiguous.
    const scopedLibraryIds = new Set<string>([
      ...readIds(row.characterIds),
      ...readIds(rowMetadata.gamePartyCharacterIds),
      ...npcs.map((npc: any) => (typeof npc?.characterId === "string" ? npc.characterId : "")).filter(Boolean),
    ]);
    const namedLibrary = library
      .filter((entry: any) => typeof entry.name === "string")
      .map((entry: any) => ({ ...entry, characterId: entry.id }));
    const known = [...npcs, ...namedLibrary.filter((entry: any) => scopedLibraryIds.has(entry.id))];
    const fallback = namedLibrary.filter((entry: any) => !scopedLibraryIds.has(entry.id));
    const timeline = await readSceneTimeline(db, row.id);
    if (timeline.remaining > 0) pendingSessions += 1;
    for (const scene of timeline.scenes) {
      const names = [...new Set([...scene.present, ...scene.participants])];
      for (const name of names) {
        if (!name || (personaName && norm(name) === norm(personaName))) continue;
        const matchesName = (entry: any) => norm(String(entry.name ?? "")) === norm(name);
        let candidates = known.filter(matchesName);
        if (candidates.length === 0) candidates = fallback.filter(matchesName);
        const ids = [
          ...new Set(candidates.map((entry: any) => String(entry.characterId || entry.id || "")).filter(Boolean)),
        ];
        if (ids.length === 0) continue;
        if (ids.length > 1) {
          ambiguousContacts += 1;
          continue;
        }
        const id = ids[0]!;
        const matchingEntries = candidates.filter(
          (candidate: any) => String(candidate.characterId || candidate.id || "") === id,
        );
        const entry = Object.assign({}, ...matchingEntries);
        // Keep crop metadata paired with the portrait source that won. A library
        // avatar must not inherit a stale NPC crop, and vice versa.
        const portraitEntry =
          matchingEntries.find(
            (candidate: any) => typeof candidate.avatarUrl === "string" && candidate.avatarUrl.trim(),
          ) ??
          matchingEntries.find((candidate: any) => typeof candidate.avatar === "string" && candidate.avatar.trim());
        const existing = contacts.get(id);
        const relationshipRecord = relationshipFor([
          ...new Set([id, ...matchingEntries.map((candidate: any) => String(candidate.id ?? "")).filter(Boolean)]),
        ]);
        const relationshipStatus = relationshipRecord ?? existing?.relationshipStatus;
        const shouldClearRelationship = relationshipRecord === null;
        const recordedOpinion =
          typeof entry?.reputation === "number" &&
          Number.isFinite(entry.reputation) &&
          entry.reputation >= -100 &&
          entry.reputation <= 100 &&
          (entry.reputationObserved === true || (entry.reputationObserved !== false && entry.reputation !== 0));
        contacts.set(id, {
          id,
          ...(entry?.characterId
            ? { characterId: String(entry.characterId) }
            : existing?.characterId
              ? { characterId: existing.characterId }
              : {}),
          name: String(entry?.name ?? existing?.name ?? name),
          ...(portraitEntry
            ? { avatar: String(portraitEntry.avatarUrl || portraitEntry.avatar) }
            : existing?.avatar
              ? { avatar: existing.avatar }
              : {}),
          ...(portraitEntry
            ? normalizeAvatarCrop(portraitEntry.avatarCrop)
              ? { avatarCrop: normalizeAvatarCrop(portraitEntry.avatarCrop) }
              : {}
            : existing?.avatarCrop
              ? { avatarCrop: existing.avatarCrop }
              : {}),
          ...(recordedOpinion
            ? { opinion: entry.reputation }
            : existing?.opinion !== undefined
              ? { opinion: existing.opinion }
              : {}),
          ...(shouldClearRelationship ? {} : relationshipStatus ? { relationshipStatus } : {}),
          automaticCategories: recordedOpinion
            ? [entry.reputation >= 50 ? "trusted" : entry.reputation <= -50 ? "hostile" : "known"]
            : ["known"],
          evidenceMessageIds: [...new Set([...(existing?.evidenceMessageIds ?? []), ...scene.messageIds])],
        });
      }
    }
  }
  pendingSessions += ambiguousContacts;
  return {
    contacts: [...contacts.values()].sort((a, b) => a.name.localeCompare(b.name)),
    coverage: { complete: pendingSessions === 0, pendingSessions },
  };
}
