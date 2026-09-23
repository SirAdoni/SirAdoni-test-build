import { normalizeTextForMatch } from "@marinara-engine/shared";
import { countNamedCharacterFirstNames, namedCharacterAliases, readNamedCharacterLibrary } from "./named-characters.js";
import { createHash } from "node:crypto";
import type {
  CampaignMemoryEntity,
  CampaignMemoryJson,
  CampaignMemoryExistingOwnerRef,
  CampaignMemoryOwnerRef,
  CampaignMemorySourceProvenance,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq, inArray } from "../../db/file-query.js";
import { chats, characters, personas, lorebookEntries } from "../../db/schema/index.js";
import {
  createCampaignMemoryOwnerReader,
  resolveCampaignMemoryOwner,
  readCommittedActiveInventoryItemHistory,
  type CampaignMemoryOwnerInput,
  type CampaignMemoryOwnerReader,
  type CampaignMemoryOwnerResolution,
} from "./campaign-memory-owners.js";
import { applyCampaignMemoryMutation, type CampaignMemoryMutationCommand } from "./campaign-memory-mutations.js";
import { createCampaignMemoryStorage, type CampaignMemoryEntityInput } from "../storage/campaign-memory.storage.js";
import { createGameStateStorage } from "../storage/game-state.storage.js";

/** The first legacy importer is deliberately limited to references into existing owner stores. */
export const LEGACY_CAMPAIGN_MEMORY_MIGRATION = "campaign-memory-legacy-v1" as const;
export const LEGACY_CAMPAIGN_MEMORY_KINDS = ["character", "persona", "location", "lore", "quest", "item"] as const;
export type LegacyCampaignMemoryKind = (typeof LEGACY_CAMPAIGN_MEMORY_KINDS)[number];

export interface CampaignMemoryLegacyOwnerInput {
  kind: LegacyCampaignMemoryKind;
  owner?: CampaignMemoryExistingOwnerRef | null;
  candidateOwnerRefs?: readonly CampaignMemoryExistingOwnerRef[];
  aliases?: readonly string[];
  /** An old card/persona/lore description may become a wiki-style summary only. */
  summary?: string | null;
  description?: string | null;
  wikiSummary?: string | null;
  attributes?: Record<string, CampaignMemoryJson>;
}

export interface CampaignMemoryLegacyImportSource {
  chatId: string;
  /** Stable hash/revision of the untouched legacy source. It is copied verbatim into provenance. */
  legacySourceHash: string;
  entities: readonly CampaignMemoryLegacyOwnerInput[];
  /** Receipts are accepted as source context for a future importer, never promoted by this one. */
  continuityReceiptIds?: readonly string[];
}

export interface CampaignMemoryLegacyCollectedSource extends CampaignMemoryLegacyImportSource {
  collectedAt: string;
}

export interface CampaignMemoryLegacyImportOptions {
  ownerReader?: CampaignMemoryOwnerReader;
  operationId?: string;
}

export interface CampaignMemoryLegacyHeldItem {
  entityId: string;
  kind: LegacyCampaignMemoryKind;
  owner: CampaignMemoryOwnerRef | null;
  reason: CampaignMemoryResolutionReason | "ambiguous_existing_registry";
}

export type CampaignMemoryResolutionReason = CampaignMemoryResolutionReasonFromOwner;
type CampaignMemoryResolutionReasonFromOwner = CampaignMemoryOwnerResolution["reason"];

export interface CampaignMemoryLegacyImportManifest {
  migration: typeof LEGACY_CAMPAIGN_MEMORY_MIGRATION;
  operationId: string;
  chatId: string;
  legacySourceHash: string;
  counts: {
    input: number;
    uniqueOwners: number;
    planned: number;
    created: number;
    skippedExisting: number;
    held: number;
    replayed: number;
  };
  heldEntityIds: string[];
}

export interface CampaignMemoryLegacyImportPlan {
  manifest: CampaignMemoryLegacyImportManifest;
  commands: CampaignMemoryMutationCommand[];
  held: CampaignMemoryLegacyHeldItem[];
  /** Existing entities are reported so callers can show that user edits were preserved. */
  skippedExistingEntityIds: string[];
  source: CampaignMemoryLegacyImportSource;
}

export interface CampaignMemoryLegacyImportResult extends CampaignMemoryLegacyImportPlan {
  applied: true;
  created: CampaignMemoryEntity[];
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Entity identity is independent of names, aliases, descriptions, and source ordering. */
export function legacyCampaignMemoryEntityId(
  chatId: string,
  kind: LegacyCampaignMemoryKind,
  ownerRecordId: string,
): string {
  return `legacy-${stableHash(`${chatId}\u0000${kind}\u0000${ownerRecordId}`).slice(0, 32)}`;
}

export function legacyCampaignMemoryOperationId(chatId: string, legacySourceHash: string): string {
  return `${LEGACY_CAMPAIGN_MEMORY_MIGRATION}:${stableHash(`${chatId}\u0000${legacySourceHash}`).slice(0, 32)}`;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  return (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value && !seen.has(value) && (seen.add(value), true));
}

function sourceProvenance(legacySourceHash: string): CampaignMemorySourceProvenance {
  return { source: LEGACY_CAMPAIGN_MEMORY_MIGRATION, sourceRevision: legacySourceHash, actor: "import" };
}

function ownerKey(owner: CampaignMemoryOwnerRef): string {
  return `${owner.type}:${owner.store}:${owner.recordId}`;
}

function parseRecord(value: unknown): Record<string, unknown> {
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Collects only canonical server-owned records; callers cannot supply descriptions or hashes here. */
export async function collectCampaignMemoryLegacySource(
  db: DB,
  chatId: string,
  options: Pick<CampaignMemoryLegacyImportOptions, "ownerReader"> = {},
): Promise<CampaignMemoryLegacyCollectedSource> {
  const reader = options.ownerReader ?? createCampaignMemoryOwnerReader(db);
  const scope = await reader.readChatScope(chatId);
  if (!scope) throw new Error(`CAMPAIGN_MEMORY_CHAT_NOT_FOUND: ${chatId}`);
  const chatRow = (await db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, chatId)).limit(1))[0];
  const metadata = parseRecord(chatRow?.metadata);
  const chatRowForNpcs = (
    await db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, chatId)).limit(1)
  )[0];
  const trackedNpcNames = new Set(
    (Array.isArray(parseRecord(chatRowForNpcs?.metadata).gameNpcs)
      ? (parseRecord(chatRowForNpcs?.metadata).gameNpcs as unknown[])
      : []
    )
      .map((value) => parseRecord(value).name)
      .filter((name): name is string => typeof name === "string")
      .map((name) => normalizeTextForMatch(name)),
  );
  const coreCharacterIds = new Set([...(scope.characterIds ?? []), ...(scope.linkedCharacterIds ?? [])]);
  const characterIds = [...new Set([...coreCharacterIds, ...(scope.namedCharacterIds ?? [])])];
  // A named card whose person is already tracked as an NPC of the same name is that NPC. Registering the card as
  // well would give one person two entities, and every mention of her would become ambiguous.
  const characterRows = (
    characterIds.length ? await db.select().from(characters).where(inArray(characters.id, characterIds)) : []
  ).filter((row) => {
    if (coreCharacterIds.has(row.id)) return true;
    const name = parseRecord(row.data).name;
    return !(typeof name === "string" && trackedNpcNames.has(normalizeTextForMatch(name)));
  });
  const personaRows = scope.personaId ? await db.select().from(personas).where(eq(personas.id, scope.personaId)) : [];
  const loreIds = [...new Set(scope.lorebookEntryIds ?? [])];
  const loreRows = loreIds.length
    ? await db.select().from(lorebookEntries).where(inArray(lorebookEntries.id, loreIds))
    : [];
  const gameState = createGameStateStorage(db);
  const latest = await gameState.getLatestCommitted(chatId);
  const historicalItems = await readCommittedActiveInventoryItemHistory(db, chatId);
  const questIds = [...new Set(scope.questEntryIds ?? [])];
  const questRows = parseRecord(latest?.playerStats).activeQuests;
  const journalQuestRows = parseRecord(metadata.gameJournal).quests;
  const questById = new Map(
    Array.isArray(journalQuestRows)
      ? journalQuestRows.flatMap((item) => {
          const row = parseRecord(item);
          return typeof row.id === "string" ? ([[row.id, row]] as const) : [];
        })
      : [],
  );
  for (const item of Array.isArray(questRows) ? questRows : []) {
    const row = parseRecord(item);
    if (typeof row.questEntryId === "string") questById.set(row.questEntryId, row);
  }
  const entities: CampaignMemoryLegacyOwnerInput[] = [];
  const itemRows = [...historicalItems.values()];
  const gameNpcs = Array.isArray(metadata.gameNpcs) ? metadata.gameNpcs : [];
  const npcIdentityDirectory = gameNpcs
    .map((value) => {
      const npc = parseRecord(value);
      return {
        id: typeof npc.id === "string" ? npc.id.trim() : "",
        name: typeof npc.name === "string" ? npc.name.trim() : "",
        characterId: typeof npc.characterId === "string" ? npc.characterId.trim() : "",
      };
    })
    .filter((npc) => npc.id && npc.name)
    .sort((left, right) => left.id.localeCompare(right.id));
  const payload: Record<string, unknown> = {
    chatId,
    characters: characterRows,
    personas: personaRows,
    lore: loreRows,
    spatial: scope.spatialDefinition,
    journalQuests: journalQuestRows,
    quests: questIds.map((id) => questById.get(id) ?? { questEntryId: id }),
    items: itemRows,
    // Only identity fields participate in the legacy revision. NPC profiles,
    // descriptions, and appearance are intentionally excluded.
    npcIdentityDirectory,
  };
  // A unique first name is only an alias when no other library character shares it.
  const firstNameCounts = countNamedCharacterFirstNames(
    (await readNamedCharacterLibrary(db)).map((entry) => entry.name),
  );
  for (const row of characterRows) {
    const data = parseRecord(row.data);
    entities.push({
      kind: "character",
      owner: { type: "existing", store: "characters", recordId: row.id },
      aliases: typeof data.name === "string" ? namedCharacterAliases(data.name, firstNameCounts) : [],
      summary: typeof data.description === "string" ? data.description : undefined,
    });
  }
  // Tracked NPCs are character owners with a canonical metadata identity.
  // Keep this registration identity-only: historical descriptions and
  // profiles are not owner-directory evidence and must come from reviewed
  // source messages.
  for (const value of gameNpcs) {
    const npc = parseRecord(value);
    const npcId = typeof npc.id === "string" ? npc.id.trim() : "";
    const name = typeof npc.name === "string" ? npc.name.trim() : "";
    if (!npcId || !name) continue;
    const characterId = typeof npc.characterId === "string" ? npc.characterId.trim() : "";
    if (characterId && characterRows.some((row) => row.id === characterId)) continue;
    entities.push({
      kind: "character",
      owner: { type: "existing", store: "game-npcs", recordId: npcId },
      aliases: [name],
    });
  }
  if (scope.personaId && personaRows[0])
    entities.push({
      kind: "persona",
      owner: { type: "existing", store: "personas", recordId: scope.personaId },
      aliases: personaRows[0].name ? [personaRows[0].name] : [],
    });
  for (const row of loreRows)
    entities.push({
      kind: "lore",
      owner: { type: "existing", store: "lorebook-entries", recordId: row.id },
      aliases: row.name ? [row.name] : [],
      summary: row.description || row.content || undefined,
    });
  for (const location of scope.spatialDefinition?.locations ?? [])
    entities.push({
      kind: "location",
      owner: { type: "existing", store: "spatial-context", recordId: location.id },
      aliases: [location.name],
      summary: location.description || undefined,
    });
  for (const id of questIds)
    entities.push({
      kind: "quest",
      owner: { type: "existing", store: "game-state", recordId: id },
      aliases: typeof questById.get(id)?.name === "string" ? [questById.get(id)!.name as string] : [],
    });
  for (const item of itemRows) {
    const itemId = (item.itemId as string).trim();
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const description = typeof item.description === "string" ? item.description.trim() : "";
    entities.push({
      kind: "item",
      owner: { type: "existing", store: "game-state", recordId: itemId },
      ...(name ? { aliases: [name] } : {}),
      ...(description ? { summary: description } : {}),
      attributes: {
        quantity: typeof item.quantity === "number" ? item.quantity : null,
        location: typeof item.location === "string" ? item.location : null,
      },
    });
  }
  return {
    chatId,
    legacySourceHash: createHash("sha256").update(stableJson(payload)).digest("hex"),
    entities,
    collectedAt: new Date().toISOString(),
  };
}

function summaryFor(input: CampaignMemoryLegacyOwnerInput): string | undefined {
  const value = input.wikiSummary ?? input.summary ?? input.description;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function reasonFor(resolution: CampaignMemoryOwnerResolution): CampaignMemoryResolutionReason {
  return resolution.reason;
}

/** Read-only planning: resolves stable owners and never calls a mutation or storage writer. */
export async function planCampaignMemoryLegacyImport(
  db: DB,
  source: CampaignMemoryLegacyImportSource,
  options: CampaignMemoryLegacyImportOptions = {},
): Promise<CampaignMemoryLegacyImportPlan> {
  const baseReader = options.ownerReader ?? createCampaignMemoryOwnerReader(db);
  // Planning never writes, so the chat scope cannot change mid-plan. Reading it once instead of once per entity
  // turns seconds of blocking work on a large campaign into milliseconds.
  const scopes = new Map<string, ReturnType<CampaignMemoryOwnerReader["readChatScope"]>>();
  const reader: CampaignMemoryOwnerReader = {
    ...baseReader,
    readChatScope(chatId) {
      let scope = scopes.get(chatId);
      if (!scope) {
        scope = baseReader.readChatScope(chatId);
        scopes.set(chatId, scope);
      }
      return scope;
    },
  };
  const operationId = options.operationId ?? legacyCampaignMemoryOperationId(source.chatId, source.legacySourceHash);
  const storage = createCampaignMemoryStorage(db, reader);
  const existing = await storage.listEntities({ chatId: source.chatId });
  const held: CampaignMemoryLegacyHeldItem[] = [];
  const commands: CampaignMemoryMutationCommand[] = [];
  const skippedExistingEntityIds: string[] = [];
  const dedupe = new Set<string>();
  let uniqueOwners = 0;

  for (const [index, input] of source.entities.entries()) {
    // Let other requests run on the Engine's only thread while a long entity list resolves.
    if (index > 0 && index % 25 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const explicitOwner = input.owner ?? null;
    const entityId = explicitOwner?.recordId
      ? legacyCampaignMemoryEntityId(source.chatId, input.kind, explicitOwner.recordId)
      : legacyCampaignMemoryEntityId(
          source.chatId,
          input.kind,
          stableHash(JSON.stringify(input.candidateOwnerRefs ?? input.aliases ?? [])),
        );
    const resolutionInput: CampaignMemoryOwnerInput = {
      chatId: source.chatId,
      kind: input.kind,
      owner: input.owner,
      candidateOwnerRefs: input.candidateOwnerRefs,
      aliases: input.aliases,
    };
    const resolution = await resolveCampaignMemoryOwner(resolutionInput, reader);
    if (!resolution.selected || resolution.selected.type !== "existing") {
      held.push({ entityId, kind: input.kind, owner: explicitOwner, reason: reasonFor(resolution) });
      continue;
    }
    const selectedOwner = resolution.selected;
    const selectedId = legacyCampaignMemoryEntityId(source.chatId, input.kind, selectedOwner.recordId);
    const key = `${input.kind}:${ownerKey(selectedOwner)}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    uniqueOwners += 1;
    const matchingExisting = existing.filter(
      (entity) => entity.kind === input.kind && ownerKey(entity.owner) === ownerKey(selectedOwner),
    );
    if (matchingExisting.length > 1) {
      held.push({
        entityId: selectedId,
        kind: input.kind,
        owner: selectedOwner,
        reason: "ambiguous_existing_registry",
      });
      continue;
    }
    if (matchingExisting.length === 1) {
      skippedExistingEntityIds.push(matchingExisting[0]!.entityId);
      continue;
    }
    const inputRecord: CampaignMemoryEntityInput = {
      entityId: selectedId,
      chatId: source.chatId,
      kind: input.kind,
      owner: selectedOwner,
      aliases: uniqueStrings(input.aliases),
      tags: ["legacy-import"],
      ...(summaryFor(input) ? { summary: summaryFor(input) } : {}),
      attributes: {
        ...(input.attributes ?? {}),
        legacySourceHash: source.legacySourceHash,
        continuityReceiptIds: uniqueStrings(source.continuityReceiptIds),
      },
      status: "active",
      manualLock: false,
      provenance: sourceProvenance(source.legacySourceHash),
    };
    commands.push({
      chatId: source.chatId,
      operationId: `${operationId}:entity:${selectedId}`,
      actor: "import",
      reason: "Register a stable reference to an explicitly owned legacy campaign entity",
      recordType: "entity",
      action: "create",
      input: inputRecord,
    });
  }

  return {
    manifest: {
      migration: LEGACY_CAMPAIGN_MEMORY_MIGRATION,
      operationId,
      chatId: source.chatId,
      legacySourceHash: source.legacySourceHash,
      counts: {
        input: source.entities.length,
        uniqueOwners,
        planned: commands.length,
        created: 0,
        skippedExisting: skippedExistingEntityIds.length,
        held: held.length,
        replayed: 0,
      },
      heldEntityIds: held.map((item) => item.entityId),
    },
    commands,
    held,
    skippedExistingEntityIds,
    source,
  };
}

/** Explicit write entry point. Root wiring should call this only after reviewing the read-only plan. */
export async function applyCampaignMemoryLegacyImport(
  db: DB,
  plan: CampaignMemoryLegacyImportPlan,
): Promise<CampaignMemoryLegacyImportResult> {
  return db.transaction(
    async (tx) => {
      const currentSource = await collectCampaignMemoryLegacySource(tx, plan.manifest.chatId);
      if (currentSource.legacySourceHash !== plan.source.legacySourceHash) {
        throw new Error("CAMPAIGN_MEMORY_IMPORT_SOURCE_CHANGED: refresh the preview before applying");
      }
      // Rebuild from server-owned state so callers cannot smuggle arbitrary commands into apply.
      const refreshed = await planCampaignMemoryLegacyImport(tx, currentSource, {
        operationId: plan.manifest.operationId,
      });
      const created: CampaignMemoryEntity[] = [];
      let replayed = 0;
      const storage = createCampaignMemoryStorage(tx);
      const before = new Set(
        (await storage.listEntities({ chatId: plan.manifest.chatId })).map((entity) => entity.entityId),
      );
      for (const command of refreshed.commands) {
        const result = await applyCampaignMemoryMutation(tx, command);
        created.push(result as CampaignMemoryEntity);
        if (result && before.has((result as CampaignMemoryEntity).entityId)) replayed += 1;
      }
      const manifest = {
        ...refreshed.manifest,
        counts: { ...refreshed.manifest.counts, created: created.length - replayed, replayed },
      };
      return { ...refreshed, manifest, applied: true, created };
    },
    { durable: true },
  );
}

export async function previewCampaignMemoryLegacyImport(
  db: DB,
  source: CampaignMemoryLegacyImportSource,
  options: CampaignMemoryLegacyImportOptions = {},
): Promise<CampaignMemoryLegacyImportPlan> {
  return planCampaignMemoryLegacyImport(db, source, options);
}
