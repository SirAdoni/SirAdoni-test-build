import type {
  CampaignMemoryBacklink,
  CampaignMemoryCurrentState,
  CampaignMemoryEntity,
  CampaignMemoryEvent,
  CampaignMemoryFact,
  CampaignMemoryKnowledge,
  CampaignMemoryRelationship,
  CampaignMemoryScope,
} from "@marinara-engine/shared";

const WORLD_HISTORY_ATTRIBUTE = "worldHistory";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { chats, messages } from "../../db/schema/index.js";
import { resolveCampaignLineage, type CampaignLineageChat } from "./campaign-lineage.js";
import { createCampaignMemoryStorage } from "../storage/campaign-memory.storage.js";
import { readCampaignMemorySources, type CampaignMemorySource } from "./campaign-memory-sources.js";

/**
 * Campaign-wide memory.
 *
 * Every Game session is its own chat, and continuity writes each session's memory into that chat. Read alone, a new
 * session starts with an empty memory even though the campaign has ten sessions of verified facts behind it. This
 * module merges the memory of every earlier session of the same game into a read-only projection of the current chat:
 *
 * - The same person, place or record in different sessions is one entity. Identity is the owner reference
 *   (`characters:<id>`, `lorebook-entries:<id>`, ...), or kind plus primary name for registry-only entities.
 * - Every projected record carries the current chat id, so the single-chat context builder and read routes work
 *   unchanged, plus `originChatId` / `originSessionNumber`, so edits can be sent to the chat that owns the record.
 * - Current state keeps only the newest value per entity and property; relationships keep the newest per pair and type.
 *
 * Nothing here writes. Earlier sessions are cached briefly; the current chat is always read fresh.
 */

type Origin = { originChatId: string; originSessionNumber?: number };
export type ProjectedEntity = CampaignMemoryEntity & Origin & { sessionNumbers?: number[] };
export type ProjectedFact = CampaignMemoryFact & Origin;
export type ProjectedKnowledge = CampaignMemoryKnowledge & Origin;
export type ProjectedEvent = CampaignMemoryEvent & Origin;
export type ProjectedCurrentState = CampaignMemoryCurrentState & Origin;
export type ProjectedRelationship = CampaignMemoryRelationship & Origin;

export interface CampaignMemoryProjection {
  chatId: string;
  /** Session chats merged, oldest first; the current chat is last. */
  sessionChatIds: string[];
  entities: ProjectedEntity[];
  facts: ProjectedFact[];
  knowledge: ProjectedKnowledge[];
  events: ProjectedEvent[];
  currentState: ProjectedCurrentState[];
  relationships: ProjectedRelationship[];
  /** Original entity id (any session) to the projected entity id. */
  entityIdMap: ReadonlyMap<string, string>;
  /**
   * Current-state values a later session replaced. A regenerate or continue at an earlier point needs the value
   * that was current then; the context builder picks the newest value at or before its cutoff.
   */
  supersededStates: ProjectedCurrentState[];
  /**
   * A fact re-read in a later session is dropped in favour of the earliest copy; its id maps to the kept id, so a
   * link or knowledge row that names the dropped copy still resolves.
   */
  factIdAlias: ReadonlyMap<string, string>;
}

type ChatRow = {
  id: string;
  mode: string;
  metadata: unknown;
  groupId?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  lastMessageAt?: string | null;
};

type ChatMemory = {
  entities: CampaignMemoryEntity[];
  facts: CampaignMemoryFact[];
  knowledge: CampaignMemoryKnowledge[];
  events: CampaignMemoryEvent[];
  currentState: CampaignMemoryCurrentState[];
  relationships: CampaignMemoryRelationship[];
};

const PRIOR_SESSION_CACHE_MS = 60_000;
/**
 * A projection of a long campaign holds every fact of every session (tens of MB); keep only the few chats being
 * played or browsed. Earlier-session memory is kept for at most one campaign's worth of sessions.
 */
const MAX_CACHED_PROJECTIONS = 4;
const MAX_CACHED_SESSION_MEMORIES = 24;
const memoryCache = new Map<string, { at: number; generation: string | null; memory: ChatMemory }>();
const sourceCache = new Map<string, { at: number; version: string; sources: Map<string, CampaignMemorySource> }>();

/** Changes whenever a message in the chat is added, edited, swiped or deleted. */
async function chatVersion(db: DB, chatId: string): Promise<string> {
  const row = (await db.select().from(chats).where(eq(chats.id, chatId)).limit(1))[0] as
    { updatedAt?: string | null; lastMessageAt?: string | null } | undefined;
  return `${row?.updatedAt ?? ""}|${row?.lastMessageAt ?? ""}`;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function sessionNumberOf(row: ChatRow): number | undefined {
  const value = objectValue(row.metadata).gameSessionNumber;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function gameIdOf(row: ChatRow): string {
  const meta = objectValue(row.metadata);
  const id = typeof meta.gameId === "string" && meta.gameId.trim() ? meta.gameId.trim() : row.groupId?.trim();
  return id || "";
}

function branchParentOf(row: ChatRow): string | undefined {
  const parent = objectValue(row.metadata).branchParentChatId;
  return typeof parent === "string" && parent.trim() ? parent.trim() : undefined;
}

function nameKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Provenance source of rows written by the legacy campaign-memory importer (LEGACY_CAMPAIGN_MEMORY_MIGRATION in
 * campaign-memory-import.ts, repeated here because that module imports this one through campaign-memory-mutations).
 */
const LEGACY_IMPORT_SOURCE = "campaign-memory-legacy-v1";

function isLegacyImportCopy(entity: CampaignMemoryEntity): boolean {
  return entity.provenance?.source === LEGACY_IMPORT_SOURCE;
}

/** Entity ids a session's own facts, knowledge and events refer to. */
function referencedEntityIds(memory: ChatMemory): Set<string> {
  const ids = new Set<string>();
  for (const fact of memory.facts) ids.add(fact.subjectEntityId);
  for (const item of memory.knowledge) {
    ids.add(item.holderEntityId);
    if (item.attributedClaim) ids.add(item.attributedClaim.subjectEntityId);
  }
  for (const event of memory.events) {
    for (const id of event.participantEntityIds) ids.add(id);
    if (event.locationEntityId) ids.add(event.locationEntityId);
  }
  return ids;
}

/** Identity of an entity across sessions. */
export function campaignEntityIdentity(
  entity: Pick<CampaignMemoryEntity, "kind" | "owner" | "aliases"> & Partial<Pick<CampaignMemoryEntity, "attributes">>,
): string {
  if (entity.owner.type === "existing") return `${entity.owner.store}:${entity.owner.recordId}`;
  // Historical notes with the same title can describe distinct events. Preserve stable owner identity.
  if (entity.kind === "note" && entity.attributes?.[WORLD_HISTORY_ATTRIBUTE] !== undefined)
    return `world-history:${entity.owner.recordId}`;
  const name = entity.aliases.map(nameKey).find(Boolean);
  return name ? `${entity.kind}:name:${name}` : `registry:${entity.owner.recordId}`;
}

/** Whether campaign scope is on for a chat (default on; chat metadata `gameCampaignMemoryScope: "session"` turns it off). */
export function campaignMemoryScopeEnabled(metadata: unknown): boolean {
  return objectValue(metadata).gameCampaignMemoryScope !== "session";
}

/**
 * Follow explicitly verified session and branch ancestry, oldest first through the selected chat.
 * Incomplete or stale lineage reads only the selected chat; no sibling branch may replace its history.
 */
export async function listCampaignSessionChats(
  db: DB,
  chatId: string,
): Promise<Array<{ id: string; sessionNumber?: number }>> {
  const current = (await db.select().from(chats).where(eq(chats.id, chatId)).limit(1))[0] as ChatRow | undefined;
  if (!current) return [];
  const self = [{ id: current.id, sessionNumber: sessionNumberOf(current) }];
  if (current.mode !== "game" || !campaignMemoryScopeEnabled(current.metadata)) return self;
  const gameId = gameIdOf(current);
  if (!gameId) return self;
  const rows = ((await db.select().from(chats).where(eq(chats.mode, "game"))) as ChatRow[]).filter(
    (row) => gameIdOf(row) === gameId,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const lineageChatIds = new Set<string>();
  for (const row of rows) {
    const parentId = branchParentOf(row);
    if (parentId) {
      lineageChatIds.add(row.id);
      if (byId.has(parentId)) lineageChatIds.add(parentId);
    }
  }
  const messageIdsByChat = new Map<string, string[]>();
  await Promise.all(
    [...lineageChatIds].map(async (id) => {
      const chatMessages = (await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.chatId, id))) as Array<{ id: string }>;
      messageIdsByChat.set(
        id,
        chatMessages.map((message) => message.id),
      );
    }),
  );
  const lineageChats: CampaignLineageChat[] = rows.map((row) => ({
    id: row.id,
    mode: row.mode,
    groupId: row.groupId,
    metadata: objectValue(row.metadata),
    messageIds: messageIdsByChat.get(row.id) ?? [],
  }));
  const lineage = resolveCampaignLineage(gameId, current.id, lineageChats);
  if (lineage.status !== "ready") return self;
  return lineage.sessions.map((session) => ({ id: session.chatId, sessionNumber: session.sessionNumber }));
}

async function readChatMemory(db: DB, chatId: string, cache: boolean): Promise<ChatMemory> {
  // Keyed by the memory tables' write counters as well as time: a writer that forgets to call
  // forgetCampaignMemoryCache must not leave a rebuilt projection holding the old rows (and the projection cache
  // would then pin them under the new generation). Chat rows are left out: every turn touches the current chat,
  // which says nothing about an earlier session's memory.
  const generation = memoryGeneration(db, MEMORY_ROW_TABLES);
  const cached = cache && generation !== null ? memoryCache.get(chatId) : undefined;
  if (cached && cached.generation === generation && Date.now() - cached.at < PRIOR_SESSION_CACHE_MS)
    return cached.memory;
  const storage = createCampaignMemoryStorage(db);
  const scope = { chatId };
  const [entities, facts, knowledge, events, currentState, relationships] = await Promise.all([
    storage.listEntities(scope),
    storage.listFacts(scope),
    storage.listKnowledge(scope),
    storage.listEvents(scope),
    storage.listCurrentState(scope),
    storage.listRelationships(scope),
  ]);
  const memory = { entities, facts, knowledge, events, currentState, relationships };
  // A write while the rows were read leaves no generation to trust; the next read fetches them again.
  if (cache && generation !== null && memoryGeneration(db, MEMORY_ROW_TABLES) === generation) {
    const now = Date.now();
    for (const [key, entry] of memoryCache) if (now - entry.at >= PRIOR_SESSION_CACHE_MS) memoryCache.delete(key);
    memoryCache.delete(chatId);
    if (memoryCache.size >= MAX_CACHED_SESSION_MEMORIES) memoryCache.delete(memoryCache.keys().next().value!);
    memoryCache.set(chatId, { at: now, generation, memory });
  }
  return memory;
}

/** Drop cached earlier-session memory (after a publish or edit in that chat). */
export function forgetCampaignMemoryCache(chatId?: string): void {
  // A projection embeds earlier sessions, so any chat's change can affect every later session's projection.
  projectionCache.clear();
  if (chatId) {
    memoryCache.delete(chatId);
    sourceCache.delete(chatId);
  } else {
    memoryCache.clear();
    sourceCache.clear();
  }
}

const MEMORY_ROW_TABLES = [
  "campaign_memory_entities",
  "campaign_memory_facts",
  "campaign_memory_knowledge",
  "campaign_memory_events",
  "campaign_memory_current_state",
  "campaign_memory_relationships",
] as const;
const MEMORY_TABLES = ["chats", ...MEMORY_ROW_TABLES] as const;
const projectionCache = new Map<string, { generation: string; projection: CampaignMemoryProjection }>();

/**
 * The store's per-table write counters: unchanged means no memory row and no chat row was written since, so a
 * projection built then is still exact. Null (an adapter without counters) disables the cache.
 */
function memoryGeneration(db: DB, tables: readonly string[] = MEMORY_TABLES): string | null {
  const store = (db as { _fileStore?: { getTableWriteGeneration?: (table: string) => number } })._fileStore;
  if (typeof store?.getTableWriteGeneration !== "function") return null;
  return tables.map((table) => store.getTableWriteGeneration!(table)).join(".");
}

/** Read-only campaign projection of every session up to and including `chatId`, reused until memory changes. */
export async function readCampaignMemoryProjection(db: DB, chatId: string): Promise<CampaignMemoryProjection> {
  const generation = memoryGeneration(db);
  const cached = generation === null ? undefined : projectionCache.get(chatId);
  if (cached && cached.generation === generation) {
    // Most recently used last, so eviction drops the chat nobody has read for longest.
    projectionCache.delete(chatId);
    projectionCache.set(chatId, cached);
    return cached.projection;
  }
  const projection = await buildCampaignMemoryProjection(db, chatId);
  if (generation !== null && memoryGeneration(db) === generation) {
    projectionCache.delete(chatId);
    if (projectionCache.size >= MAX_CACHED_PROJECTIONS) projectionCache.delete(projectionCache.keys().next().value!);
    projectionCache.set(chatId, { generation, projection });
  }
  return projection;
}

async function buildCampaignMemoryProjection(db: DB, chatId: string): Promise<CampaignMemoryProjection> {
  const sessions = await listCampaignSessionChats(db, chatId);
  const list = sessions.length ? sessions : [{ id: chatId, sessionNumber: undefined }];
  const memories = await Promise.all(
    list.map(async (session) => ({ session, memory: await readChatMemory(db, session.id, session.id !== chatId) })),
  );

  // Entities: one per identity. The current chat's entity id wins, else the newest session's.
  type GroupItem = { entity: CampaignMemoryEntity; sessionNumber?: number; order: number };
  const groups = new Map<string, GroupItem[]>();
  memories.forEach(({ session, memory }, order) => {
    for (const entity of memory.entities) {
      const key = campaignEntityIdentity(entity);
      const group = groups.get(key) ?? [];
      group.push({ entity, sessionNumber: session.sessionNumber, order });
      groups.set(key, group);
    }
  });
  // A session that never registered the library card holds the same person as a registry-only entity or a tracked
  // NPC. Fold such a group into the library-card group of the same kind when exactly one of them shares its name.
  const ownedByName = new Map<string, Set<string>>();
  // Library cards (characters, personas) are the canonical owners; tracked Game NPCs and registry names fold into them.
  const canonicalOwner = (key: string) => key.startsWith("characters:") || key.startsWith("personas:");
  const foldable = (key: string) => key.includes(":name:") || key.startsWith("game-npcs:");
  for (const [key, group] of groups) {
    if (!canonicalOwner(key)) continue;
    for (const item of group)
      for (const alias of item.entity.aliases) {
        const name = nameKey(alias);
        if (!name) continue;
        const nameGroupKey = `${item.entity.kind}\u0000${name}`;
        const owners = ownedByName.get(nameGroupKey) ?? new Set<string>();
        owners.add(key);
        ownedByName.set(nameGroupKey, owners);
      }
  }
  // Two groups with rows in the same session chat were kept apart by that session's tracker, so they are two people
  // even when their names match: never fold them into one page.
  const ordersOf = new Map<string, Set<number>>();
  for (const [key, group] of groups) ordersOf.set(key, new Set(group.map((item) => item.order)));
  const sideBySide = (a: string, b: string) => {
    const [small, large] = [ordersOf.get(a)!, ordersOf.get(b)!].sort((x, y) => x.size - y.size);
    for (const order of small!) if (large!.has(order)) return true;
    return false;
  };
  const fold = (key: string, target: string) => {
    groups.get(target)!.push(...groups.get(key)!);
    groups.delete(key);
    for (const order of ordersOf.get(key)!) ordersOf.get(target)!.add(order);
    ordersOf.delete(key);
  };
  for (const [key, group] of [...groups]) {
    if (!foldable(key)) continue;
    const kind = group[0]!.entity.kind;
    const candidates = new Set<string>();
    for (const item of group)
      for (const alias of item.entity.aliases) {
        const owners = ownedByName.get(`${kind}\u0000${nameKey(alias)}`);
        if (owners) owners.forEach((owner) => candidates.add(owner));
      }
    if (candidates.size !== 1) continue;
    const target = [...candidates][0]!;
    // No side-by-side check here: a tracked NPC with a library card's exact name in the same session is the tracker
    // registering the card's character a second time (a long campaign had both for one character over three sessions), not a
    // namesake. The check still guards the one-word fold below, where "Ash" and "Ash Vale" can be two people.
    fold(key, target);
  }
  // A tracked NPC first met under a single name ("Aria") and later under the full name ("Aria Stanmore") is the
  // same person when exactly one other entity of that kind has a name starting with that word. Names are computed
  // once per group and multi-word names indexed by first word, so a long campaign's pass stays linear. Folding only
  // moves single-word names into the target, so the index stays exact while the pass runs.
  const namesByGroup = new Map<string, string[]>();
  const byFirstWord = new Map<string, Set<string>>();
  for (const [key, group] of groups) {
    const names = [...new Set(group.flatMap((item) => item.entity.aliases.map(nameKey)).filter(Boolean))];
    namesByGroup.set(key, names);
    const kind = group[0]!.entity.kind;
    for (const name of names) {
      const space = name.indexOf(" ");
      if (space < 0) continue;
      const indexKey = `${kind}\u0000${name.slice(0, space)}`;
      const keys = byFirstWord.get(indexKey) ?? new Set<string>();
      keys.add(key);
      byFirstWord.set(indexKey, keys);
    }
  }
  for (const [key, group] of [...groups]) {
    if (!foldable(key) || !groups.has(key)) continue;
    const kind = group[0]!.entity.kind;
    const names = namesByGroup.get(key)!;
    if (!names.length || names.some((name) => name.includes(" "))) continue;
    const candidates = new Set<string>();
    for (const short of names)
      for (const other of byFirstWord.get(`${kind}\u0000${short}`) ?? [])
        if (other !== key && groups.has(other)) candidates.add(other);
    if (candidates.size !== 1) continue;
    const target = [...candidates][0]!;
    if (sideBySide(key, target)) continue;
    fold(key, target);
  }
  const referencedByOrder = memories.map(({ memory }) => referencedEntityIds(memory));
  const entityIdMap = new Map<string, string>();
  const entities: ProjectedEntity[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => a.order - b.order);
    const anchor =
      [...ordered].reverse().find((item) => canonicalOwner(campaignEntityIdentity(item.entity))) ??
      [...ordered].reverse().find((item) => item.entity.owner.type === "existing") ??
      ordered[ordered.length - 1]!;
    const aliases = [...new Set(ordered.flatMap((item) => item.entity.aliases))];
    const tags = [...new Set(ordered.flatMap((item) => item.entity.tags))];
    const summary = [...ordered].reverse().find((item) => item.entity.summary?.trim())?.entity.summary;
    const body = [...ordered].reverse().find((item) => item.entity.body?.trim())?.entity.body;
    const anyActive = ordered.some((item) => item.entity.status === "active");
    // The legacy import copied the whole lorebook into every session, so an imported copy is not an appearance on
    // its own: a session counts when its copy was written by something else, or when that session's facts,
    // knowledge or events refer to it. A page that only ever existed as imported copies shows its earliest session.
    const numbered = (items: GroupItem[]) => [
      ...new Set(items.map((item) => item.sessionNumber).filter((n): n is number => typeof n === "number")),
    ];
    const appearances = numbered(
      ordered.filter(
        (item) => !isLegacyImportCopy(item.entity) || referencedByOrder[item.order]!.has(item.entity.entityId),
      ),
    );
    const everyCopy = numbered(ordered);
    const sessionNumbers = appearances.length ? appearances : everyCopy.length ? [Math.min(...everyCopy)] : [];
    for (const item of ordered) entityIdMap.set(item.entity.entityId, anchor.entity.entityId);
    entities.push({
      // Every field describes the anchor row, the one the wiki writes to (recordId = anchor id, expectedRevision =
      // this revision). Identity comes from the anchor too: a newer tracked-NPC row folded into a library card must
      // not replace the card's owner, or party-speaker memory and scene presence stop resolving the person.
      ...anchor.entity,
      kind: anchor.entity.kind,
      owner: anchor.entity.owner,
      entityId: anchor.entity.entityId,
      chatId,
      aliases: [anchor.entity.aliases[0], ...aliases].filter(
        (alias, index, all): alias is string => Boolean(alias) && all.indexOf(alias) === index,
      ),
      tags,
      ...(summary ? { summary } : {}),
      ...(body ? { body } : {}),
      // Archiving a page archives the anchor row; an earlier session's copy that is still active must not undo it.
      status: anchor.entity.status === "archived" ? "archived" : anyActive ? "active" : anchor.entity.status,
      originChatId: anchor.entity.chatId,
      ...(anchor.sessionNumber !== undefined ? { originSessionNumber: anchor.sessionNumber } : {}),
      sessionNumbers,
    });
  }
  const mapId = (id: string) => entityIdMap.get(id) ?? id;
  const originOf = (sessionNumber: number | undefined, originChatId: string): Origin => ({
    originChatId,
    ...(sessionNumber !== undefined ? { originSessionNumber: sessionNumber } : {}),
  });

  const facts: ProjectedFact[] = [];
  const knowledge: ProjectedKnowledge[] = [];
  const events: ProjectedEvent[] = [];
  const stateByKey = new Map<string, ProjectedCurrentState>();
  const supersededStates: ProjectedCurrentState[] = [];
  const relationshipByKey = new Map<string, ProjectedRelationship>();
  for (const { session, memory } of memories) {
    const origin = originOf(session.sessionNumber, session.id);
    for (const fact of memory.facts) {
      facts.push({ ...fact, chatId, subjectEntityId: mapId(fact.subjectEntityId), ...origin });
    }
    for (const item of memory.knowledge) {
      knowledge.push({
        ...item,
        chatId,
        holderEntityId: mapId(item.holderEntityId),
        ...(item.attributedClaim
          ? {
              attributedClaim: {
                ...item.attributedClaim,
                subjectEntityId: mapId(item.attributedClaim.subjectEntityId),
              },
            }
          : {}),
        ...origin,
      });
    }
    for (const event of memory.events) {
      events.push({
        ...event,
        chatId,
        participantEntityIds: [...new Set(event.participantEntityIds.map(mapId))],
        ...(event.locationEntityId ? { locationEntityId: mapId(event.locationEntityId) } : {}),
        ...origin,
      });
    }
    for (const state of memory.currentState) {
      // Presence describes a scene; a new session starts a new scene, so only this session's presence is current.
      if (state.property === "presence" && session.id !== chatId) continue;
      const projected: ProjectedCurrentState = {
        ...state,
        chatId,
        entityId: mapId(state.entityId),
        // Location values are entity ids of the session that wrote them.
        value: typeof state.value === "string" ? mapId(state.value) : state.value,
        ...origin,
      };
      const key = `${projected.entityId}\u0000${projected.property}`;
      const kept = stateByKey.get(key);
      // Later sessions win; within a session the newer order wins.
      if (!kept || kept.originChatId !== session.id || projected.validAtOrder >= kept.validAtOrder) {
        if (kept && kept.originChatId !== session.id) supersededStates.push(kept);
        stateByKey.set(key, projected);
      }
    }
    for (const relationship of memory.relationships) {
      const projected: ProjectedRelationship = {
        ...relationship,
        chatId,
        sourceEntityId: mapId(relationship.sourceEntityId),
        targetEntityId: mapId(relationship.targetEntityId),
        ...origin,
      };
      if (projected.sourceEntityId === projected.targetEntityId) continue;
      const key = `${projected.sourceEntityId}\u0000${projected.targetEntityId}\u0000${projected.type}`;
      const kept = relationshipByKey.get(key);
      if (!kept || kept.originChatId !== session.id || projected.updatedAt >= kept.updatedAt) {
        relationshipByKey.set(key, projected);
      }
    }
  }
  // The same statement is often re-read in several sessions; keep the copy from the session that first established
  // it, so a regenerate at an earlier point in a later session still finds it (the re-read copy may be "future").
  const factByStatement = new Map<string, ProjectedFact>();
  const factIdAlias = new Map<string, string>();
  for (const fact of facts) {
    const key = `${fact.subjectEntityId}\u0000${fact.predicate}\u0000${nameKey(JSON.stringify(fact.value))}\u0000${fact.status}`;
    const kept = factByStatement.get(key);
    // Only a copy from another session is a re-read; identical facts inside one session stay as that chat has them.
    if (kept && kept.originChatId === fact.originChatId) {
      factByStatement.set(`${key}\u0000${fact.factId}`, fact);
      continue;
    }
    if (kept) {
      factIdAlias.set(fact.factId, kept.factId);
      continue;
    }
    factByStatement.set(key, fact);
  }
  const resolveFactId = (id: string): string => {
    let current = id;
    for (let hops = 0; hops < 64 && factIdAlias.has(current); hops += 1) current = factIdAlias.get(current)!;
    return current;
  };
  const dedupedFacts = [...factByStatement.values()];
  const dedupedKnowledge = knowledge.map((item) =>
    item.factId && factIdAlias.has(item.factId) ? { ...item, factId: resolveFactId(item.factId) } : item,
  );
  const knowledgeSeen = new Set<string>();
  const uniqueKnowledge = dedupedKnowledge.filter((item) => {
    const key = `${item.holderEntityId}\u0000${item.factId ?? JSON.stringify(item.attributedClaim ?? null)}\u0000${item.epistemicState}`;
    if (knowledgeSeen.has(key)) return false;
    knowledgeSeen.add(key);
    return true;
  });
  return {
    chatId,
    sessionChatIds: list.map((session) => session.id),
    entities,
    facts: dedupedFacts,
    knowledge: uniqueKnowledge,
    events,
    currentState: [...stateByKey.values()],
    relationships: [...relationshipByKey.values()],
    entityIdMap,
    supersededStates,
    factIdAlias,
  };
}

/** Evidence sources of every merged session, relabelled to the current chat so freshness checks accept them. */
export async function readCampaignMemorySourcesForProjection(
  db: DB,
  projection: Pick<CampaignMemoryProjection, "chatId" | "sessionChatIds">,
): Promise<Map<string, CampaignMemorySource>> {
  const merged = new Map<string, CampaignMemorySource>();
  for (const sessionChatId of projection.sessionChatIds) {
    const isCurrent = sessionChatId === projection.chatId;
    // Earlier sessions are finished transcripts: hashing them is the slow part, so keep them until the chat changes.
    const version = isCurrent ? "" : await chatVersion(db, sessionChatId);
    const cached = isCurrent ? undefined : sourceCache.get(sessionChatId);
    let sources: Map<string, CampaignMemorySource>;
    if (cached && cached.version === version) sources = cached.sources;
    else {
      sources = await readCampaignMemorySources(db, { chatId: sessionChatId });
      if (!isCurrent) {
        if (!sourceCache.has(sessionChatId) && sourceCache.size >= MAX_CACHED_SESSION_MEMORIES) {
          sourceCache.delete(sourceCache.keys().next().value!);
        }
        sourceCache.set(sessionChatId, { at: Date.now(), version, sources });
      }
    }
    for (const [messageId, source] of sources) merged.set(messageId, { ...source, chatId: projection.chatId });
  }
  return merged;
}

/**
 * Read the earlier sessions of the most recently played games once in the background, so the first GM turn after
 * a restart does not pay for hashing every earlier transcript (about eight seconds for a ten-session campaign).
 */
export async function warmCampaignMemoryCache(db: DB, maxGames = 2): Promise<number> {
  const rows = ((await db.select().from(chats)) as ChatRow[])
    .filter((row) => row.mode === "game")
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  const seenGames = new Set<string>();
  let warmed = 0;
  for (const row of rows) {
    const gameId = gameIdOf(row);
    if (!gameId || seenGames.has(gameId)) continue;
    seenGames.add(gameId);
    const projection = await readCampaignMemoryProjection(db, row.id);
    await readCampaignMemorySourcesForProjection(db, projection);
    warmed += projection.sessionChatIds.length;
    await new Promise((resolve) => setImmediate(resolve));
    if (seenGames.size >= maxGames) break;
  }
  return warmed;
}

/**
 * A read-only stand-in for the campaign memory storage whose list/get methods return the campaign projection.
 * Routes use it for `scope=campaign`; writes must still go to the record's own chat.
 */
export function createCampaignScopedMemoryReader(projection: CampaignMemoryProjection) {
  const check = (scope: CampaignMemoryScope) => {
    if (scope.chatId !== projection.chatId) throw new Error("CAMPAIGN_MEMORY_SCOPE_MISMATCH");
  };
  return {
    async listEntities(scope: CampaignMemoryScope): Promise<ProjectedEntity[]> {
      check(scope);
      return [...projection.entities];
    },
    async getEntity(scope: CampaignMemoryScope, entityId: string): Promise<ProjectedEntity | null> {
      check(scope);
      const id = projection.entityIdMap.get(entityId) ?? entityId;
      return projection.entities.find((entity) => entity.entityId === id) ?? null;
    },
    async listFacts(scope: CampaignMemoryScope): Promise<ProjectedFact[]> {
      check(scope);
      return [...projection.facts];
    },
    async getFact(scope: CampaignMemoryScope, factId: string): Promise<ProjectedFact | null> {
      check(scope);
      // A re-read copy dropped by the cross-session dedupe resolves to the earliest copy that was kept.
      let id = factId;
      for (let hops = 0; hops < 64 && projection.factIdAlias.has(id); hops += 1) id = projection.factIdAlias.get(id)!;
      return projection.facts.find((fact) => fact.factId === id) ?? null;
    },
    async listKnowledge(scope: CampaignMemoryScope): Promise<ProjectedKnowledge[]> {
      check(scope);
      return [...projection.knowledge];
    },
    async listEvents(scope: CampaignMemoryScope): Promise<ProjectedEvent[]> {
      check(scope);
      return [...projection.events];
    },
    async listCurrentState(scope: CampaignMemoryScope): Promise<ProjectedCurrentState[]> {
      check(scope);
      return [...projection.currentState];
    },
    async listRelationships(scope: CampaignMemoryScope): Promise<ProjectedRelationship[]> {
      check(scope);
      return [...projection.relationships];
    },
    async listBacklinks(scope: CampaignMemoryScope, entityId: string): Promise<CampaignMemoryBacklink[]> {
      check(scope);
      const id = projection.entityIdMap.get(entityId) ?? entityId;
      const outgoing = new Set(
        projection.relationships
          .filter((relationship) => relationship.sourceEntityId === id)
          .map((relationship) => `${relationship.targetEntityId}|${relationship.type}`),
      );
      return projection.relationships.flatMap((relationship): CampaignMemoryBacklink[] => {
        if (relationship.sourceEntityId === id)
          return [{ ...relationship, direction: "outgoing", label: relationship.type }];
        // A mutual tie recorded from both sides ("lover-of" each way) is one relationship on this page.
        if (relationship.targetEntityId === id && outgoing.has(`${relationship.sourceEntityId}|${relationship.type}`))
          return [];
        if (relationship.targetEntityId === id)
          return [{ ...relationship, direction: "incoming", label: relationship.inverseLabel }];
        return [];
      });
    },
  };
}
