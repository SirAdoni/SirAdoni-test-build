import { readNamedCharacterIds } from "./named-characters.js";
import type {
  CampaignMemoryEntity,
  CampaignMemoryEntityKind,
  CampaignMemoryExistingOwnerRef,
  CampaignMemoryOwnerRef,
  CampaignMemoryRegistryOwnerRef,
  SpatialContextDefinition,
} from "@marinara-engine/shared";
import { spatialContextDefinitionSchema } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { and, desc, eq, inArray } from "../../db/file-query.js";
import {
  chats,
  characters,
  gameStateSnapshots,
  lorebookEntries,
  lorebooks,
  messages,
  personas,
} from "../../db/schema/index.js";
import { createGameStateStorage } from "../storage/game-state.storage.js";

/** The only stores that may be used for an existing (non-registry) owner. */
export const CAMPAIGN_MEMORY_OWNER_STORES = {
  // Game NPCs are character owners whose durable identity is the canonical
  // GameNpc.id in chat metadata, rather than a Character-library row.
  character: "characters",
  persona: "personas",
  location: "spatial-context",
  lore: "lorebook-entries",
  quest: "game-state",
  item: "game-state",
} as const satisfies Partial<Record<CampaignMemoryEntityKind, string>>;

export type CampaignMemoryOwnerStore = (typeof CAMPAIGN_MEMORY_OWNER_STORES)[keyof typeof CAMPAIGN_MEMORY_OWNER_STORES];

/**
 * Visibility is deliberately supplied by the owning stores.  In particular, a
 * name or alias is never used to populate one of these sets.  The character
 * set includes cards linked by the game metadata as well as chat.characterIds.
 */
export interface CampaignMemoryOwnerChatScope {
  chatId: string;
  characterIds: readonly string[];
  linkedCharacterIds?: readonly string[];
  /** Library characters the chat's messages name, whether or not they joined the party. */
  namedCharacterIds?: readonly string[];
  /** Canonical tracked NPC ids from the chat's game metadata. */
  npcIds?: readonly string[];
  personaId?: string | null;
  lorebookEntryIds?: readonly string[];
  questEntryIds?: readonly string[];
  itemIds?: readonly string[];
  spatialDefinition?: SpatialContextDefinition | null;
}

export interface CampaignMemoryExistingOwnerRecord {
  store: string;
  recordId: string;
  /** The owning store may provide this as an additional integrity check. */
  kind?: CampaignMemoryEntityKind;
}

/** Read-only seams keep this adapter usable with the capability bridge and pure fixtures. */
export interface CampaignMemoryOwnerReader {
  readChatScope(chatId: string): Promise<CampaignMemoryOwnerChatScope | null>;
  readExistingOwner(
    owner: CampaignMemoryExistingOwnerRef,
    chatId: string,
  ): Promise<CampaignMemoryExistingOwnerRecord | null>;
  readRegistryOwner?(chatId: string, recordId: string): Promise<boolean>;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringList(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (Array.isArray(parsed))
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return [];
}

function stableIds(value: unknown, allowBareId = false): string[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const id = row.characterId ?? (allowBareId ? (row.id ?? row.entityId) : undefined);
    return typeof id === "string" && id.trim() ? [id] : [];
  });
}

function npcIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const id = (item as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
}

function questIdsFromSnapshot(snapshot: { playerStats?: string | null } | null): string[] {
  const stats = record(snapshot?.playerStats);
  const quests = Array.isArray(stats.activeQuests) ? stats.activeQuests : [];
  return quests.flatMap((quest) => {
    if (!quest || typeof quest !== "object" || Array.isArray(quest)) return [];
    const id = (quest as Record<string, unknown>).questEntryId;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
}

function questIdsFromJournal(metadata: Record<string, unknown>): string[] {
  const journal = record(metadata.gameJournal);
  const quests = Array.isArray(journal.quests) ? journal.quests : [];
  return quests.flatMap((quest) => {
    if (!quest || typeof quest !== "object" || Array.isArray(quest)) return [];
    const id = (quest as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
}

function questIdsFromSources(
  snapshot: { playerStats?: string | null } | null,
  metadata: Record<string, unknown>,
): string[] {
  return [...new Set([...questIdsFromSnapshot(snapshot), ...questIdsFromJournal(metadata)])];
}

/** Latest observed item rows on this chat's committed active-message history. */
export async function readCommittedActiveInventoryItemHistory(
  db: DB,
  chatId: string,
): Promise<Map<string, Record<string, unknown>>> {
  const messageRows = await db
    .select({ id: messages.id, activeSwipeIndex: messages.activeSwipeIndex })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(messages.createdAt, messages.id);
  const anchors = messageRows.map((message) => ({ messageId: message.id, swipeIndex: message.activeSwipeIndex }));
  anchors.unshift({ messageId: "", swipeIndex: 0 });
  const snapshotRows = await db
    .select()
    .from(gameStateSnapshots)
    .where(
      and(
        eq(gameStateSnapshots.chatId, chatId),
        eq(gameStateSnapshots.committed, 1),
        inArray(
          gameStateSnapshots.messageId,
          anchors.map((anchor) => anchor.messageId),
        ),
      ),
    )
    .orderBy(desc(gameStateSnapshots.createdAt));
  const byAnchor = new Map<string, typeof gameStateSnapshots.$inferSelect>();
  for (const row of snapshotRows) {
    const key = `${row.messageId}:${row.swipeIndex}`;
    if (!byAnchor.has(key)) byAnchor.set(key, row);
  }
  const items = new Map<string, Record<string, unknown>>();
  for (const anchor of anchors) {
    const snapshot = byAnchor.get(`${anchor.messageId}:${anchor.swipeIndex}`);
    const inventory = record(snapshot?.playerStats).inventory;
    if (!Array.isArray(inventory)) continue;
    for (const item of inventory) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const itemId = typeof row.itemId === "string" ? row.itemId.trim() : "";
      if (itemId) items.set(itemId, row);
    }
  }
  return items;
}

/** Build the production read-only adapter over existing game stores and the spatial capability bridge. */
export function createCampaignMemoryOwnerReader(db: DB): CampaignMemoryOwnerReader {
  const gameState = createGameStateStorage(db);
  return {
    async readChatScope(chatId) {
      const rows = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
      const chat = rows[0];
      if (!chat || chat.mode !== "game") return null;
      const metadata = record(chat.metadata);
      const latestState = await gameState.getLatestCommitted(chatId);
      const historicalItems = await readCommittedActiveInventoryItemHistory(db, chatId);
      const activeLorebookIds = stringList(metadata.activeLorebookIds);
      const books = await db.select({ id: lorebooks.id, chatId: lorebooks.chatId }).from(lorebooks);
      const visibleLorebookIds = books
        .filter((book) => book.chatId === chatId || activeLorebookIds.includes(book.id))
        .map((book) => book.id);
      const loreEntryRows = visibleLorebookIds.length
        ? await db
            .select({ id: lorebookEntries.id })
            .from(lorebookEntries)
            .where(inArray(lorebookEntries.lorebookId, visibleLorebookIds))
        : [];
      const spatialDefinition = spatialContextDefinitionSchema.safeParse(metadata.spatialContext);
      return {
        chatId,
        characterIds: [...stringList(chat.characterIds), ...stableIds(latestState?.presentCharacters, true)],
        linkedCharacterIds: stableIds(metadata.gameNpcs),
        namedCharacterIds: await readNamedCharacterIds(db, chatId),
        npcIds: npcIds(metadata.gameNpcs),
        personaId: chat.personaId,
        lorebookEntryIds: loreEntryRows.map((entry) => entry.id),
        questEntryIds: questIdsFromSources(latestState, metadata),
        itemIds: [...historicalItems.keys()],
        spatialDefinition: spatialDefinition.success ? spatialDefinition.data : null,
      } satisfies CampaignMemoryOwnerChatScope;
    },
    async readExistingOwner(owner, chatId) {
      switch (owner.store) {
        case "characters": {
          const rows = await db
            .select({ id: characters.id })
            .from(characters)
            .where(eq(characters.id, owner.recordId))
            .limit(1);
          return rows[0] ? { store: owner.store, recordId: rows[0].id, kind: "character" as const } : null;
        }
        case "game-npcs": {
          const metadataNpcs = record(
            (await db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, chatId)).limit(1))[0]
              ?.metadata,
          ).gameNpcs;
          const found = Array.isArray(metadataNpcs)
            ? metadataNpcs.some(
                (item) =>
                  item &&
                  typeof item === "object" &&
                  !Array.isArray(item) &&
                  (item as Record<string, unknown>).id === owner.recordId,
              )
            : false;
          return found ? { store: owner.store, recordId: owner.recordId, kind: "character" as const } : null;
        }
        case "personas": {
          const rows = await db
            .select({ id: personas.id })
            .from(personas)
            .where(eq(personas.id, owner.recordId))
            .limit(1);
          return rows[0] ? { store: owner.store, recordId: rows[0].id, kind: "persona" as const } : null;
        }
        case "lorebook-entries": {
          const chatRows = await db
            .select({ metadata: chats.metadata })
            .from(chats)
            .where(eq(chats.id, chatId))
            .limit(1);
          const activeLorebookIds = stringList(record(chatRows[0]?.metadata).activeLorebookIds);
          const rows = await db
            .select({ id: lorebookEntries.id, lorebookId: lorebookEntries.lorebookId })
            .from(lorebookEntries)
            .where(eq(lorebookEntries.id, owner.recordId))
            .limit(1);
          if (!rows[0]) return null;
          const books = await db
            .select({ id: lorebooks.id, chatId: lorebooks.chatId })
            .from(lorebooks)
            .where(eq(lorebooks.id, rows[0].lorebookId))
            .limit(1);
          const book = books[0];
          return book && (book.chatId === chatId || activeLorebookIds.includes(book.id))
            ? { store: owner.store, recordId: rows[0].id, kind: "lore" as const }
            : null;
        }
        case "spatial-context": {
          const scope = await this.readChatScope(chatId);
          return scope?.spatialDefinition?.locations.some((location) => location.id === owner.recordId)
            ? { store: owner.store, recordId: owner.recordId, kind: "location" as const }
            : null;
        }
        case "game-state": {
          const scope = await this.readChatScope(chatId);
          const isItem = scope?.itemIds?.includes(owner.recordId) ?? false;
          const isQuest = scope?.questEntryIds?.includes(owner.recordId) ?? false;
          if (isItem && isQuest) return null;
          if (isItem) {
            return { store: owner.store, recordId: owner.recordId, kind: "item" as const };
          }
          return isQuest ? { store: owner.store, recordId: owner.recordId, kind: "quest" as const } : null;
        }
        default:
          return null;
      }
    },
  };
}

export type CampaignMemoryOwnerResolutionReason =
  | "resolved_existing_owner"
  | "resolved_registry_owner"
  | "stable_owner_id_required"
  | "chat_not_visible"
  | "owner_store_mismatch"
  | "owner_record_missing"
  | "owner_kind_mismatch"
  | "owner_not_visible_in_chat"
  | "ambiguous_owner_candidates"
  | "spatial_definition_unavailable"
  | "registry_owner_requires_core_validation"
  | "registry_owner_missing"
  | "aliases_are_not_identity";

export interface CampaignMemoryOwnerCandidate {
  owner: CampaignMemoryOwnerRef;
  status: "resolved" | "unresolved";
  reason: CampaignMemoryOwnerResolutionReason;
}

export interface CampaignMemoryOwnerResolution {
  chatId: string;
  kind: CampaignMemoryEntityKind;
  /** At most one selected owner. Ambiguous candidates are never auto-selected. */
  selected: CampaignMemoryOwnerRef | null;
  candidates: CampaignMemoryOwnerCandidate[];
  reason: CampaignMemoryOwnerResolutionReason;
}

export interface CampaignMemoryOwnerInput {
  chatId: string;
  kind: CampaignMemoryEntityKind;
  owner?: CampaignMemoryOwnerRef | null;
  /** Explicit stable IDs from a source. Names/aliases are intentionally ignored. */
  candidateOwnerRefs?: readonly CampaignMemoryOwnerRef[];
  aliases?: readonly string[];
}

function uniqueRefs(refs: readonly CampaignMemoryOwnerRef[]): CampaignMemoryOwnerRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.store}:${ref.recordId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function expectedStore(kind: CampaignMemoryEntityKind): string | null {
  const stores: Partial<Record<CampaignMemoryEntityKind, string>> = CAMPAIGN_MEMORY_OWNER_STORES;
  return stores[kind] ?? null;
}

function isVisible(scope: CampaignMemoryOwnerChatScope, kind: CampaignMemoryEntityKind, recordId: string): boolean {
  switch (kind) {
    case "character":
      return ownerStoreVisible(scope, recordId);
    case "persona":
      return scope.personaId === recordId;
    case "lore":
      return (scope.lorebookEntryIds ?? []).includes(recordId);
    case "quest":
      return (scope.questEntryIds ?? []).includes(recordId);
    case "item":
      return (scope.itemIds ?? []).includes(recordId);
    case "location":
      return Boolean(scope.spatialDefinition?.locations.some((location) => location.id === recordId));
    default:
      return false;
  }
}

function ownerStoreVisible(scope: CampaignMemoryOwnerChatScope, recordId: string): boolean {
  return new Set([
    ...(scope.characterIds ?? []),
    ...(scope.linkedCharacterIds ?? []),
    ...(scope.namedCharacterIds ?? []),
    ...(scope.npcIds ?? []),
  ]).has(recordId);
}

function registryRefIsAllowed(kind: CampaignMemoryEntityKind, owner: CampaignMemoryRegistryOwnerRef): boolean {
  return owner.type === "registry" && owner.store === "campaign-memory" && (kind === "organization" || kind === "note");
}

async function validateCandidate(
  input: CampaignMemoryOwnerInput,
  scope: CampaignMemoryOwnerChatScope | null,
  owner: CampaignMemoryOwnerRef,
  reader: CampaignMemoryOwnerReader,
): Promise<CampaignMemoryOwnerCandidate> {
  if (owner.type === "registry") {
    if (!registryRefIsAllowed(input.kind, owner)) {
      return { owner, status: "unresolved", reason: "owner_store_mismatch" };
    }
    if (!scope) return { owner, status: "unresolved", reason: "chat_not_visible" };
    if (reader.readRegistryOwner && !(await reader.readRegistryOwner(input.chatId, owner.recordId))) {
      return { owner, status: "unresolved", reason: "registry_owner_missing" };
    }
    if (!reader.readRegistryOwner) {
      return { owner, status: "unresolved", reason: "registry_owner_requires_core_validation" };
    }
    return { owner, status: "resolved", reason: "resolved_registry_owner" };
  }

  const store = expectedStore(input.kind);
  const allowedStores = input.kind === "character" ? ["characters", "game-npcs"] : store ? [store] : [];
  if (!allowedStores.includes(owner.store)) return { owner, status: "unresolved", reason: "owner_store_mismatch" };
  if (!scope) return { owner, status: "unresolved", reason: "chat_not_visible" };
  if (input.kind === "location" && !scope.spatialDefinition) {
    return { owner, status: "unresolved", reason: "spatial_definition_unavailable" };
  }
  if (!isVisible(scope, input.kind, owner.recordId)) {
    return { owner, status: "unresolved", reason: "owner_not_visible_in_chat" };
  }
  const record = await reader.readExistingOwner(owner, input.chatId);
  if (!record) return { owner, status: "unresolved", reason: "owner_record_missing" };
  if (record.store !== owner.store || record.recordId !== owner.recordId) {
    return { owner, status: "unresolved", reason: "owner_record_missing" };
  }
  if (record.kind && record.kind !== input.kind) {
    return { owner, status: "unresolved", reason: "owner_kind_mismatch" };
  }
  return { owner, status: "resolved", reason: "resolved_existing_owner" };
}

/** Resolve explicit stable references without mutating the entity or any owner store. */
export async function resolveCampaignMemoryOwner(
  input: CampaignMemoryOwnerInput,
  reader: CampaignMemoryOwnerReader,
): Promise<CampaignMemoryOwnerResolution> {
  const scope = await reader.readChatScope(input.chatId);
  const scopedChat = scope && scope.chatId === input.chatId ? scope : null;
  const refs = uniqueRefs([...(input.owner ? [input.owner] : []), ...(input.candidateOwnerRefs ?? [])]);
  if (refs.length === 0) {
    return {
      chatId: input.chatId,
      kind: input.kind,
      selected: null,
      candidates: [],
      reason: input.aliases?.some((alias) => alias.trim().length > 0)
        ? "aliases_are_not_identity"
        : "stable_owner_id_required",
    };
  }

  const candidates = await Promise.all(refs.map((owner) => validateCandidate(input, scopedChat, owner, reader)));
  const resolved = candidates.filter((candidate) => candidate.status === "resolved");
  const selected = resolved.length === 1 ? resolved[0]!.owner : null;
  return {
    chatId: input.chatId,
    kind: input.kind,
    selected,
    candidates,
    reason:
      selected !== null
        ? resolved[0]!.reason
        : resolved.length > 1
          ? "ambiguous_owner_candidates"
          : (candidates[0]?.reason ?? "stable_owner_id_required"),
  };
}

/** Validate an already-owned entity while preserving its original owner reference. */
export async function validateCampaignMemoryEntityOwner(
  entity: Pick<CampaignMemoryEntity, "chatId" | "kind" | "owner" | "aliases">,
  reader: CampaignMemoryOwnerReader,
): Promise<CampaignMemoryOwnerResolution> {
  return resolveCampaignMemoryOwner(
    { chatId: entity.chatId, kind: entity.kind, owner: entity.owner, aliases: entity.aliases },
    reader,
  );
}
