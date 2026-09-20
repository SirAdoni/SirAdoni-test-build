import { createHash, randomUUID } from "node:crypto";
import type {
  CampaignMemoryActor,
  CampaignMemoryBacklink,
  CampaignMemoryCondition,
  CampaignMemoryCurrentState,
  CampaignMemoryEntity,
  CampaignMemoryEntityKind,
  CampaignMemoryEvent,
  CampaignMemoryEvidence,
  CampaignMemoryFact,
  CampaignMemoryJson,
  CampaignMemoryKnowledge,
  CampaignMemoryMutationJournal,
  CampaignMemoryRelationship,
  CampaignMemoryScope,
  CampaignMemorySourceProvenance,
  CampaignMemoryUpdateOptions,
} from "@marinara-engine/shared";
import { and, eq } from "../../db/file-query.js";
import { FileUniqueConstraintError } from "../../db/file-schema.js";
import type { DB } from "../../db/connection.js";
import { readCampaignMemorySources } from "../game/campaign-memory-sources.js";
import { compareCampaignMemoryMessageOrder } from "../game/campaign-memory-order.js";
import { campaignMemoryRelationshipKindError } from "../game/campaign-memory-relationship-kinds.js";
import {
  createCampaignMemoryOwnerReader,
  validateCampaignMemoryEntityOwner,
  type CampaignMemoryOwnerReader,
} from "../game/campaign-memory-owners.js";
import {
  chats,
  campaignMemoryCurrentState,
  campaignMemoryEntities,
  campaignMemoryEvents,
  campaignMemoryFacts,
  campaignMemoryKnowledge,
  campaignMemoryMutationJournal,
  campaignMemoryRelationships,
} from "../../db/schema/index.js";

export type CampaignMemoryEntityInput = Omit<
  CampaignMemoryEntity,
  "entityId" | "revision" | "createdAt" | "updatedAt"
> & {
  entityId?: string;
  /** Prose notes. Declared here as well until the shared dist is rebuilt with the field. */
  body?: string;
};
export type CampaignMemoryFactInput = Omit<CampaignMemoryFact, "factId" | "revision" | "createdAt" | "updatedAt"> & {
  factId?: string;
};
export type CampaignMemoryKnowledgeInput = Omit<
  CampaignMemoryKnowledge,
  "knowledgeId" | "revision" | "createdAt" | "updatedAt"
> & {
  knowledgeId?: string;
};
export type CampaignMemoryEventInput = Omit<CampaignMemoryEvent, "eventId" | "createdAt" | "immutable"> & {
  eventId?: string;
};
export type CampaignMemoryStateInput = Omit<
  CampaignMemoryCurrentState,
  "stateId" | "revision" | "createdAt" | "updatedAt"
> & {
  stateId?: string;
};
export type CampaignMemoryRelationshipInput = Omit<
  CampaignMemoryRelationship,
  "relationshipId" | "revision" | "createdAt" | "updatedAt"
> & {
  relationshipId?: string;
};

export class CampaignMemoryStorageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CampaignMemoryStorageError";
  }
}

function fail(code: string, message: string): never {
  throw new CampaignMemoryStorageError(code, message);
}
const json = (value: unknown): CampaignMemoryJson => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Structured values must contain finite numbers");
  }
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === "object" && value)
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, json(entry)]));
  return fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Structured values cannot contain undefined or functions");
};
const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return (value ?? fallback) as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Persisted campaign memory JSON is malformed");
  }
};
const now = () => new Date().toISOString();
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
const scopeWhere = (table: { chatId: unknown }, scope: CampaignMemoryScope, idColumn: unknown, id: string) =>
  and(eq(table.chatId, scope.chatId), eq(idColumn, id));
const provenance = (value: CampaignMemorySourceProvenance) => {
  if (
    !value ||
    typeof value.source !== "string" ||
    typeof value.sourceRevision !== "string" ||
    !value.source.trim() ||
    !value.sourceRevision.trim()
  )
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Invalid source provenance");
  oneOf(value.actor, ACTORS, "provenance.actor");
  return value;
};
const listOfStrings = (value: unknown, label: string) => {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", `${label} must be a string array`);
  return value;
};
const evidence = (value: unknown) => {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        typeof (entry as { messageId?: unknown }).messageId !== "string" ||
        typeof (entry as { quote?: unknown }).quote !== "string" ||
        !(entry as { quote: string }).quote.trim() ||
        (typeof (entry as { sourceHash?: unknown }).sourceHash !== "undefined" &&
          (typeof (entry as { sourceHash?: unknown }).sourceHash !== "string" ||
            !/^[a-f0-9]{64}$/iu.test((entry as { sourceHash: string }).sourceHash))),
    )
  )
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Evidence must contain messageId and quote");
  return value;
};
const ENTITY_KINDS = ["character", "persona", "location", "organization", "item", "quest", "lore", "note"] as const;
const FACT_STATUSES = ["proposed", "verified", "superseded", "held", "retracted"] as const;
const RELATIONSHIP_STATUSES = ["proposed", "active", "ended", "held"] as const;
const EPISTEMIC_STATES = ["knows", "believes", "rumor", "unknown"] as const;
const ACTORS = ["system", "user", "import"] as const;
function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T))
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", `${label} is invalid`);
}
function validateOwner(value: unknown, entityId?: string) {
  if (!value || typeof value !== "object") fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "Owner reference is required");
  const ref = value as { type?: unknown; store?: unknown; recordId?: unknown };
  oneOf(ref.type, ["existing", "registry"], "owner.type");
  if (typeof ref.store !== "string" || !ref.store.trim() || typeof ref.recordId !== "string" || !ref.recordId.trim())
    fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "Owner store and recordId are required");
  if (
    ref.type === "registry" &&
    (ref.store !== "campaign-memory" || (entityId !== undefined && ref.recordId !== entityId))
  )
    fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "Registry owner must point to its own entity ID");
}
function conditions(value: unknown) {
  if (!Array.isArray(value)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Conditions must be an array");
  for (const condition of value as Array<{ kind?: unknown; value?: unknown }>) {
    if (!condition || typeof condition.kind !== "string" || !condition.kind.trim() || !("value" in condition))
      fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Conditions require kind and structured value");
    json(condition.value);
  }
}
function nonblank(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail("CAMPAIGN_MEMORY_INVALID_VALUE", `${label} is required`);
}
function claim(value: unknown) {
  if (!value || typeof value !== "object") fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Attributed claim is invalid");
  const item = value as { subjectEntityId?: unknown; predicate?: unknown; value?: unknown };
  nonblank(item.subjectEntityId, "claim.subjectEntityId");
  nonblank(item.predicate, "claim.predicate");
  if (!("value" in item)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "claim.value is required");
  json(item.value);
}

/** Normalize source-backed evidence for mutation/extraction workers without creating a storage writer. */
export async function normalizeCampaignMemoryEvidence(
  scope: CampaignMemoryScope,
  value: unknown,
  database: DB,
): Promise<CampaignMemoryEvidence[]> {
  evidence(value);
  const sources = await readCampaignMemorySources(database, {
    chatId: scope.chatId,
    messageIds: (value as CampaignMemoryEvidence[]).map((item) => item.messageId),
  });
  const normalized: CampaignMemoryEvidence[] = [];
  for (const item of value as CampaignMemoryEvidence[]) {
    const source = sources.get(item.messageId);
    if (!source)
      fail(
        "CAMPAIGN_MEMORY_INVALID_REFERENCE",
        `Evidence message ${item.messageId} is outside chat scope ${scope.chatId}`,
      );
    if (!source.content.includes(item.quote))
      fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `Evidence quote is not present in source message ${item.messageId}`);
    const currentHash = source.sourceHash;
    if (item.sourceHash && item.sourceHash !== currentHash)
      fail(
        "CAMPAIGN_MEMORY_INVALID_REFERENCE",
        `Evidence source changed for message ${item.messageId}; refresh evidence explicitly`,
      );
    normalized.push({ ...item, sourceHash: currentHash });
  }
  return normalized;
}

export function createCampaignMemoryStorage(
  db: DB,
  ownerReader: CampaignMemoryOwnerReader = createCampaignMemoryOwnerReader(db),
) {
  async function assertChat(chatId: string) {
    if (!chatId) fail("CAMPAIGN_MEMORY_SCOPE_REQUIRED", "chatId is required for every campaign-memory operation");
    const found = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    if (!found[0] || found[0].mode !== "game")
      fail("CAMPAIGN_MEMORY_CHAT_NOT_FOUND", `Game chat ${chatId} does not exist`);
  }
  async function normalizeEvidence(scope: CampaignMemoryScope, value: unknown, database: DB = db) {
    return normalizeCampaignMemoryEvidence(scope, value, database);
  }
  async function assertEntity(
    scope: CampaignMemoryScope,
    entityId: string,
    database: DB = db,
    expectedKind?: CampaignMemoryEntityKind | CampaignMemoryEntityKind[],
  ) {
    const row = (
      await database
        .select()
        .from(campaignMemoryEntities)
        .where(scopeWhere(campaignMemoryEntities, scope, campaignMemoryEntities.entityId, entityId))
        .limit(1)
    )[0];
    if (!row) fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `Entity ${entityId} is not in chat scope ${scope.chatId}`);
    if (
      expectedKind &&
      !(Array.isArray(expectedKind) ? expectedKind : [expectedKind]).includes(row.kind as CampaignMemoryEntityKind)
    )
      fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `Entity ${entityId} has an invalid kind for this reference`);
    return row;
  }
  async function assertEvent(scope: CampaignMemoryScope, eventId: string, database: DB = db) {
    const row = (
      await database
        .select()
        .from(campaignMemoryEvents)
        .where(scopeWhere(campaignMemoryEvents, scope, campaignMemoryEvents.eventId, eventId))
        .limit(1)
    )[0];
    if (!row) fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `Event ${eventId} is not in chat scope ${scope.chatId}`);
    return row;
  }
  async function assertRelationshipEndpoints(
    scope: CampaignMemoryScope,
    input: Pick<CampaignMemoryRelationship, "sourceEntityId" | "targetEntityId" | "type">,
    database: DB = db,
  ) {
    const source = await assertEntity(scope, input.sourceEntityId, database);
    const target = await assertEntity(scope, input.targetEntityId, database);
    const message = campaignMemoryRelationshipKindError(
      input.type,
      source.kind as CampaignMemoryEntityKind,
      target.kind as CampaignMemoryEntityKind,
    );
    if (message) fail("CAMPAIGN_MEMORY_INVALID_ENDPOINT_KIND", message);
  }
  async function assertOwner(input: Pick<CampaignMemoryEntity, "chatId" | "kind" | "owner" | "aliases">) {
    if (input.owner.type === "registry") {
      if (input.kind !== "organization" && input.kind !== "note")
        fail(
          "CAMPAIGN_MEMORY_INVALID_REFERENCE",
          "Registry owners are allowed only for organization and note entities",
        );
      // A registry-owned row is the owner record being created. The optional
      // adapter hook is for validating already-existing registry records, not
      // for making first creation depend on a prior row.
      return;
    }
    const resolution = await validateCampaignMemoryEntityOwner(input, ownerReader);
    if (!resolution.selected)
      fail(
        "CAMPAIGN_MEMORY_INVALID_REFERENCE",
        `Owner reference for ${input.kind} is not resolved in chat scope ${input.chatId}`,
      );
  }
  type MutationInput = {
    operationId?: string;
    recordType: CampaignMemoryMutationJournal["recordType"];
    recordId: string;
    actor: CampaignMemoryActor;
    expectedRevision?: number;
    before?: unknown;
    after?: unknown;
    reason: string;
    evidence?: unknown[];
    payload?: unknown;
  };
  async function replay(scope: CampaignMemoryScope, input: MutationInput, database: DB = db) {
    if (!input.operationId) return false;
    const normalizedEvidence = input.evidence ? await normalizeEvidence(scope, input.evidence, database) : [];
    const existing = await database
      .select()
      .from(campaignMemoryMutationJournal)
      .where(
        and(
          eq(campaignMemoryMutationJournal.chatId, scope.chatId),
          eq(campaignMemoryMutationJournal.operationId, input.operationId),
        ),
      )
      .limit(1);
    if (!existing[0]) return false;
    const payloadHash = hash({
      chatId: scope.chatId,
      operationId: input.operationId,
      recordType: input.recordType,
      recordId: input.recordId,
      actor: input.actor,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
      evidence: normalizedEvidence,
      payload: input.payload,
    });
    if (existing[0].payloadHash !== payloadHash)
      fail(
        "CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT",
        `Operation ${input.operationId} was already used with another payload`,
      );
    return true;
  }
  async function journal(scope: CampaignMemoryScope, input: MutationInput, database: DB = db) {
    if (!input.operationId) return;
    const normalizedEvidence = input.evidence ? await normalizeEvidence(scope, input.evidence, database) : [];
    const payload = {
      chatId: scope.chatId,
      operationId: input.operationId,
      recordType: input.recordType,
      recordId: input.recordId,
      actor: input.actor,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
      evidence: normalizedEvidence,
      payload: input.payload,
    };
    const payloadHash = hash(payload);
    const existing = await database
      .select()
      .from(campaignMemoryMutationJournal)
      .where(
        and(
          eq(campaignMemoryMutationJournal.chatId, scope.chatId),
          eq(campaignMemoryMutationJournal.operationId, input.operationId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].payloadHash !== payloadHash)
        fail(
          "CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT",
          `Operation ${input.operationId} was already used with another payload`,
        );
      return;
    }
    await database.insert(campaignMemoryMutationJournal).values({
      journalId: randomUUID(),
      chatId: scope.chatId,
      operationId: input.operationId,
      recordType: input.recordType,
      recordId: input.recordId,
      actor: input.actor,
      expectedRevision: input.expectedRevision ?? null,
      before: input.before === undefined ? null : JSON.stringify(json(input.before)),
      after: input.after === undefined ? null : JSON.stringify(json(input.after)),
      reason: input.reason,
      evidence: JSON.stringify(normalizedEvidence),
      compensationOperationId: null,
      payloadHash,
      createdAt: now(),
    });
  }
  function entityFrom(row: typeof campaignMemoryEntities.$inferSelect): CampaignMemoryEntity {
    oneOf(row.kind, ENTITY_KINDS, "entity.kind");
    oneOf(row.status, ["active", "archived"], "entity.status");
    validateOwner(parse(row.owner, null), row.entityId);
    listOfStrings(parse(row.aliases, []), "aliases");
    listOfStrings(parse(row.tags, []), "tags");
    json(parse(row.attributes, {}));
    provenance(parse(row.provenance, {} as CampaignMemorySourceProvenance));
    return {
      entityId: row.entityId,
      chatId: row.chatId,
      kind: row.kind as CampaignMemoryEntityKind,
      owner: parse(row.owner, {} as CampaignMemoryEntity["owner"]),
      aliases: parse(row.aliases, []),
      tags: parse(row.tags, []),
      ...(row.summary == null ? {} : { summary: row.summary }),
      ...(row.body == null ? {} : { body: row.body }),
      attributes: parse(row.attributes, {}),
      status: row.status as CampaignMemoryEntity["status"],
      manualLock: row.manualLock === 1,
      provenance: parse(row.provenance, {} as CampaignMemorySourceProvenance),
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  function factFrom(row: typeof campaignMemoryFacts.$inferSelect): CampaignMemoryFact {
    oneOf(row.status, FACT_STATUSES, "fact.status");
    conditions(parse(row.conditions, []));
    evidence(parse(row.evidence, []));
    json(parse(row.value, null));
    provenance(parse(row.provenance, {} as CampaignMemorySourceProvenance));
    oneOf(row.author, ACTORS, "fact.author");
    nonblank(row.predicate, "fact.predicate");
    nonblank(row.sourceRevision, "fact.sourceRevision");
    return {
      factId: row.factId,
      chatId: row.chatId,
      subjectEntityId: row.subjectEntityId,
      predicate: row.predicate,
      value: parse(row.value, null),
      conditions: parse(row.conditions, [] as CampaignMemoryCondition[]),
      status: row.status as CampaignMemoryFact["status"],
      ...(row.validFromOrder == null ? {} : { validFromOrder: row.validFromOrder }),
      ...(row.validToOrder == null ? {} : { validToOrder: row.validToOrder }),
      sourceRevision: row.sourceRevision,
      evidence: parse(row.evidence, []),
      author: row.author as CampaignMemoryActor,
      provenance: parse(row.provenance, {} as CampaignMemorySourceProvenance),
      manualLock: row.manualLock === 1,
      ...(row.supersedesFactId == null ? {} : { supersedesFactId: row.supersedesFactId }),
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  function knowledgeFrom(row: typeof campaignMemoryKnowledge.$inferSelect): CampaignMemoryKnowledge {
    oneOf(row.epistemicState, EPISTEMIC_STATES, "knowledge.epistemicState");
    evidence(parse(row.learnedFrom, []));
    provenance(parse(row.provenance, {} as CampaignMemorySourceProvenance));
    if (row.attributedClaim != null) claim(parse(row.attributedClaim, null));
    return {
      knowledgeId: row.knowledgeId,
      chatId: row.chatId,
      holderEntityId: row.holderEntityId,
      ...(row.factId == null ? {} : { factId: row.factId }),
      ...(row.attributedClaim == null ? {} : { attributedClaim: parse(row.attributedClaim, undefined) }),
      epistemicState: row.epistemicState as CampaignMemoryKnowledge["epistemicState"],
      learnedFrom: parse(row.learnedFrom, []),
      ...(row.learnedAtOrder == null ? {} : { learnedAtOrder: row.learnedAtOrder }),
      ...(row.confidence == null ? {} : { confidence: row.confidence as CampaignMemoryKnowledge["confidence"] }),
      provenance: parse(row.provenance, {} as CampaignMemorySourceProvenance),
      manualLock: row.manualLock === 1,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  function eventFrom(row: typeof campaignMemoryEvents.$inferSelect): CampaignMemoryEvent {
    if (row.immutable !== 1) fail("CAMPAIGN_MEMORY_IMMUTABLE", "Campaign events must be immutable");
    evidence(parse(row.evidence, []));
    provenance(parse(row.provenance, {} as CampaignMemorySourceProvenance));
    listOfStrings(parse(row.participantEntityIds, []), "event.participantEntityIds");
    listOfStrings(parse(row.transitions, []), "event.transitions");
    nonblank(row.occurrenceOrder, "event.occurrenceOrder");
    nonblank(row.sourceRevision, "event.sourceRevision");
    return {
      eventId: row.eventId,
      chatId: row.chatId,
      occurrenceOrder: row.occurrenceOrder,
      ...(row.campaignTime == null ? {} : { campaignTime: row.campaignTime }),
      participantEntityIds: parse(row.participantEntityIds, []),
      ...(row.locationEntityId == null ? {} : { locationEntityId: row.locationEntityId }),
      sourceRevision: row.sourceRevision,
      transitions: parse(row.transitions, []),
      evidence: parse(row.evidence, []),
      provenance: parse(row.provenance, {} as CampaignMemorySourceProvenance),
      immutable: true,
      createdAt: row.createdAt,
    };
  }
  function stateFrom(row: typeof campaignMemoryCurrentState.$inferSelect): CampaignMemoryCurrentState {
    json(parse(row.value, null));
    provenance(parse(row.provenance, {} as CampaignMemorySourceProvenance));
    nonblank(row.property, "state.property");
    nonblank(row.validAtOrder, "state.validAtOrder");
    return {
      stateId: row.stateId,
      chatId: row.chatId,
      entityId: row.entityId,
      property: row.property,
      value: parse(row.value, null),
      sourceEventId: row.sourceEventId,
      validAtOrder: row.validAtOrder,
      protected: row.protected === 1,
      provenance: parse(row.provenance, {} as CampaignMemorySourceProvenance),
      manualLock: row.manualLock === 1,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  function relationshipFrom(row: typeof campaignMemoryRelationships.$inferSelect): CampaignMemoryRelationship {
    oneOf(row.status, RELATIONSHIP_STATUSES, "relationship.status");
    evidence(parse(row.evidence, []));
    provenance(parse(row.provenance, {} as CampaignMemorySourceProvenance));
    nonblank(row.sourceEntityId, "relationship.sourceEntityId");
    nonblank(row.targetEntityId, "relationship.targetEntityId");
    nonblank(row.type, "relationship.type");
    nonblank(row.inverseLabel, "relationship.inverseLabel");
    return {
      relationshipId: row.relationshipId,
      chatId: row.chatId,
      sourceEntityId: row.sourceEntityId,
      targetEntityId: row.targetEntityId,
      type: row.type,
      inverseLabel: row.inverseLabel,
      status: row.status as CampaignMemoryRelationship["status"],
      ...(row.effectiveFrom == null ? {} : { effectiveFrom: row.effectiveFrom }),
      ...(row.effectiveTo == null ? {} : { effectiveTo: row.effectiveTo }),
      evidence: parse(row.evidence, []),
      provenance: parse(row.provenance, {} as CampaignMemorySourceProvenance),
      manualLock: row.manualLock === 1,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  const requireMutable = (current: { manualLock: number; protected?: number }, actor: CampaignMemoryActor) => {
    if ((current.manualLock === 1 || current.protected === 1) && actor !== "user")
      fail("CAMPAIGN_MEMORY_LOCKED", "Automatic actors cannot overwrite protected campaign memory");
  };

  async function createEntity(input: CampaignMemoryEntityInput) {
    await assertChat(input.chatId);
    const entityId = input.entityId ?? randomUUID();
    if (input.owner.type === "registry" && input.owner.recordId && input.owner.recordId !== entityId)
      fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "Registry owners must point to their own stable entity ID");
    const owner = input.owner.type === "registry" ? { ...input.owner, recordId: entityId } : input.owner;
    if (owner.type === "registry" && (owner.store !== "campaign-memory" || owner.recordId !== entityId))
      fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "Registry owners must point to their own stable entity ID");
    listOfStrings(input.aliases, "aliases");
    listOfStrings(input.tags, "tags");
    oneOf(input.kind, ENTITY_KINDS, "entity.kind");
    oneOf(input.status, ["active", "archived"], "entity.status");
    validateOwner(input.owner, entityId);
    if (input.owner.type === "registry" && input.kind !== "organization" && input.kind !== "note")
      fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "Registry owners are allowed only for organization and note entities");
    await assertOwner({ chatId: input.chatId, kind: input.kind, owner, aliases: input.aliases });
    provenance(input.provenance);
    json(input.attributes);
    const timestamp = now();
    await db.insert(campaignMemoryEntities).values({
      entityId,
      chatId: input.chatId,
      kind: input.kind,
      owner: JSON.stringify(owner),
      aliases: JSON.stringify(input.aliases),
      tags: JSON.stringify(input.tags),
      summary: input.summary ?? null,
      body: input.body ?? null,
      attributes: JSON.stringify(input.attributes),
      status: input.status,
      manualLock: input.manualLock ? 1 : 0,
      provenance: JSON.stringify(input.provenance),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { ...input, owner, entityId, revision: 1, createdAt: timestamp, updatedAt: timestamp };
  }
  async function getEntity(scope: CampaignMemoryScope, entityId: string) {
    await assertChat(scope.chatId);
    const row = (
      await db
        .select()
        .from(campaignMemoryEntities)
        .where(scopeWhere(campaignMemoryEntities, scope, campaignMemoryEntities.entityId, entityId))
        .limit(1)
    )[0];
    return row ? entityFrom(row) : null;
  }
  async function listEntities(scope: CampaignMemoryScope) {
    await assertChat(scope.chatId);
    return (await db.select().from(campaignMemoryEntities).where(eq(campaignMemoryEntities.chatId, scope.chatId))).map(
      entityFrom,
    );
  }
  async function updateEntity(
    scope: CampaignMemoryScope,
    entityId: string,
    patch: Partial<CampaignMemoryEntityInput>,
    options: CampaignMemoryUpdateOptions,
  ) {
    await assertChat(scope.chatId);
    return db.transaction(
      async (tx) => {
        const row = (
          await tx
            .select()
            .from(campaignMemoryEntities)
            .where(scopeWhere(campaignMemoryEntities, scope, campaignMemoryEntities.entityId, entityId))
            .limit(1)
        )[0];
        if (!row) fail("CAMPAIGN_MEMORY_NOT_FOUND", `Entity ${entityId} not found`);
        const mutation = { ...options, recordType: entityFrom(row).kind, recordId: entityId, payload: patch };
        if (await replay(scope, mutation, tx)) return entityFrom(row);
        requireMutable(row, options.actor);
        if (row.revision !== options.expectedRevision)
          fail("CAMPAIGN_MEMORY_CAS_MISMATCH", `Entity ${entityId} revision changed`);
        const next = {
          ...entityFrom(row),
          ...patch,
          entityId,
          chatId: scope.chatId,
          revision: row.revision + 1,
          updatedAt: now(),
        };
        oneOf(next.kind, ENTITY_KINDS, "entity.kind");
        oneOf(next.status, ["active", "archived"], "entity.status");
        if (next.kind !== entityFrom(row).kind || JSON.stringify(next.owner) !== JSON.stringify(entityFrom(row).owner))
          fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "Entity kind and owner are immutable after registration");
        validateOwner(next.owner, entityId);
        if (next.owner.type === "registry" && next.kind !== "organization" && next.kind !== "note")
          fail(
            "CAMPAIGN_MEMORY_INVALID_REFERENCE",
            "Registry owners are allowed only for organization and note entities",
          );
        await assertOwner({ chatId: scope.chatId, kind: next.kind, owner: next.owner, aliases: next.aliases });
        listOfStrings(next.aliases, "aliases");
        listOfStrings(next.tags, "tags");
        provenance(next.provenance);
        json(next.attributes);
        await tx
          .update(campaignMemoryEntities)
          .set({
            kind: next.kind,
            owner: JSON.stringify(next.owner),
            aliases: JSON.stringify(next.aliases),
            tags: JSON.stringify(next.tags),
            summary: next.summary ?? null,
            body: next.body ?? null,
            attributes: JSON.stringify(next.attributes),
            status: next.status,
            manualLock: next.manualLock ? 1 : 0,
            provenance: JSON.stringify(next.provenance),
            revision: next.revision,
            updatedAt: next.updatedAt,
          })
          .where(scopeWhere(campaignMemoryEntities, scope, campaignMemoryEntities.entityId, entityId));
        await journal(
          scope,
          {
            operationId: options.operationId,
            recordType: next.kind,
            recordId: entityId,
            actor: options.actor,
            expectedRevision: options.expectedRevision,
            before: entityFrom(row),
            after: next,
            reason: options.reason,
            evidence: options.evidence,
            payload: patch,
          },
          tx,
        );
        return next;
      },
      { durable: true },
    );
  }

  async function createFact(input: CampaignMemoryFactInput) {
    await assertChat(input.chatId);
    await assertEntity({ chatId: input.chatId }, input.subjectEntityId);
    if (input.supersedesFactId) {
      const existing = await db
        .select()
        .from(campaignMemoryFacts)
        .where(
          scopeWhere(campaignMemoryFacts, { chatId: input.chatId }, campaignMemoryFacts.factId, input.supersedesFactId),
        )
        .limit(1);
      if (!existing[0]) fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "Superseded fact is outside chat scope");
    }
    provenance(input.provenance);
    oneOf(input.status, FACT_STATUSES, "fact.status");
    if (!input.predicate.trim() || !input.sourceRevision.trim())
      fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Fact predicate and sourceRevision are required");
    conditions(input.conditions);
    json(input.value);
    const normalizedEvidence = await normalizeEvidence({ chatId: input.chatId }, input.evidence);
    const factId = input.factId ?? randomUUID();
    const timestamp = now();
    await db.insert(campaignMemoryFacts).values({
      factId,
      chatId: input.chatId,
      subjectEntityId: input.subjectEntityId,
      predicate: input.predicate,
      value: JSON.stringify(input.value),
      conditions: JSON.stringify(input.conditions),
      status: input.status,
      validFromOrder: input.validFromOrder ?? null,
      validToOrder: input.validToOrder ?? null,
      sourceRevision: input.sourceRevision,
      evidence: JSON.stringify(normalizedEvidence),
      author: input.author,
      provenance: JSON.stringify(input.provenance),
      manualLock: input.manualLock ? 1 : 0,
      supersedesFactId: input.supersedesFactId ?? null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { ...input, evidence: normalizedEvidence, factId, revision: 1, createdAt: timestamp, updatedAt: timestamp };
  }
  async function getFact(scope: CampaignMemoryScope, factId: string) {
    await assertChat(scope.chatId);
    const row = (
      await db
        .select()
        .from(campaignMemoryFacts)
        .where(scopeWhere(campaignMemoryFacts, scope, campaignMemoryFacts.factId, factId))
        .limit(1)
    )[0];
    return row ? factFrom(row) : null;
  }
  async function listFacts(scope: CampaignMemoryScope) {
    await assertChat(scope.chatId);
    return (await db.select().from(campaignMemoryFacts).where(eq(campaignMemoryFacts.chatId, scope.chatId))).map(
      factFrom,
    );
  }
  async function updateFact(
    scope: CampaignMemoryScope,
    factId: string,
    patch: Partial<CampaignMemoryFactInput>,
    options: CampaignMemoryUpdateOptions,
  ) {
    await assertChat(scope.chatId);
    return db.transaction(
      async (tx) => {
        const row = (
          await tx
            .select()
            .from(campaignMemoryFacts)
            .where(scopeWhere(campaignMemoryFacts, scope, campaignMemoryFacts.factId, factId))
            .limit(1)
        )[0];
        if (!row) fail("CAMPAIGN_MEMORY_NOT_FOUND", `Fact ${factId} not found`);
        const mutation = { ...options, recordType: "fact" as const, recordId: factId, payload: patch };
        if (await replay(scope, mutation, tx)) return factFrom(row);
        requireMutable(row, options.actor);
        if (row.revision !== options.expectedRevision)
          fail("CAMPAIGN_MEMORY_CAS_MISMATCH", `Fact ${factId} revision changed`);
        const next = {
          ...factFrom(row),
          ...patch,
          factId,
          chatId: scope.chatId,
          revision: row.revision + 1,
          updatedAt: now(),
        };
        oneOf(next.status, FACT_STATUSES, "fact.status");
        conditions(next.conditions);
        oneOf(next.author, ACTORS, "fact.author");
        nonblank(next.predicate, "fact.predicate");
        nonblank(next.sourceRevision, "fact.sourceRevision");
        next.evidence = await normalizeEvidence(scope, next.evidence, tx);
        provenance(next.provenance);
        await assertEntity(scope, next.subjectEntityId, tx);
        if (next.supersedesFactId)
          await tx
            .select()
            .from(campaignMemoryFacts)
            .where(scopeWhere(campaignMemoryFacts, scope, campaignMemoryFacts.factId, next.supersedesFactId))
            .limit(1)
            .then((rows) => {
              if (!rows[0]) fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "Superseded fact is outside chat scope");
            });
        json(next.value);
        await tx
          .update(campaignMemoryFacts)
          .set({
            subjectEntityId: next.subjectEntityId,
            predicate: next.predicate,
            value: JSON.stringify(next.value),
            conditions: JSON.stringify(next.conditions),
            status: next.status,
            validFromOrder: next.validFromOrder ?? null,
            validToOrder: next.validToOrder ?? null,
            sourceRevision: next.sourceRevision,
            evidence: JSON.stringify(next.evidence),
            author: next.author,
            provenance: JSON.stringify(next.provenance),
            manualLock: next.manualLock ? 1 : 0,
            supersedesFactId: next.supersedesFactId ?? null,
            revision: next.revision,
            updatedAt: next.updatedAt,
          })
          .where(scopeWhere(campaignMemoryFacts, scope, campaignMemoryFacts.factId, factId));
        await journal(
          scope,
          {
            operationId: options.operationId,
            recordType: "fact",
            recordId: factId,
            actor: options.actor,
            expectedRevision: options.expectedRevision,
            before: factFrom(row),
            after: next,
            reason: options.reason,
            evidence: options.evidence,
            payload: patch,
          },
          tx,
        );
        return next;
      },
      { durable: true },
    );
  }

  async function createKnowledge(input: CampaignMemoryKnowledgeInput) {
    await assertChat(input.chatId);
    await assertEntity({ chatId: input.chatId }, input.holderEntityId, db, ["character", "persona"]);
    if (input.factId) {
      const fact = await getFact({ chatId: input.chatId }, input.factId);
      if (!fact) fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "Knowledge fact is outside chat scope");
    }
    if (!input.factId && !input.attributedClaim)
      fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Knowledge must reference a fact or attributed claim");
    if (input.attributedClaim) {
      await assertEntity({ chatId: input.chatId }, input.attributedClaim.subjectEntityId);
      claim(input.attributedClaim);
      json(input.attributedClaim.value);
    }
    provenance(input.provenance);
    oneOf(input.epistemicState, EPISTEMIC_STATES, "knowledge.epistemicState");
    const normalizedLearnedFrom = await normalizeEvidence({ chatId: input.chatId }, input.learnedFrom);
    const knowledgeId = input.knowledgeId ?? randomUUID();
    const timestamp = now();
    await db.insert(campaignMemoryKnowledge).values({
      knowledgeId,
      chatId: input.chatId,
      holderEntityId: input.holderEntityId,
      factId: input.factId ?? null,
      attributedClaim: input.attributedClaim ? JSON.stringify(input.attributedClaim) : null,
      epistemicState: input.epistemicState,
      learnedFrom: JSON.stringify(normalizedLearnedFrom),
      learnedAtOrder: input.learnedAtOrder ?? null,
      confidence: input.confidence ?? null,
      provenance: JSON.stringify(input.provenance),
      manualLock: input.manualLock ? 1 : 0,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return {
      ...input,
      learnedFrom: normalizedLearnedFrom,
      knowledgeId,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }
  async function getKnowledge(scope: CampaignMemoryScope, knowledgeId: string) {
    await assertChat(scope.chatId);
    const row = (
      await db
        .select()
        .from(campaignMemoryKnowledge)
        .where(scopeWhere(campaignMemoryKnowledge, scope, campaignMemoryKnowledge.knowledgeId, knowledgeId))
        .limit(1)
    )[0];
    return row ? knowledgeFrom(row) : null;
  }
  async function listKnowledge(scope: CampaignMemoryScope) {
    await assertChat(scope.chatId);
    return (
      await db.select().from(campaignMemoryKnowledge).where(eq(campaignMemoryKnowledge.chatId, scope.chatId))
    ).map(knowledgeFrom);
  }
  async function updateKnowledge(
    scope: CampaignMemoryScope,
    knowledgeId: string,
    patch: Partial<CampaignMemoryKnowledgeInput>,
    options: CampaignMemoryUpdateOptions,
  ) {
    await assertChat(scope.chatId);
    return db.transaction(
      async (tx) => {
        const row = (
          await tx
            .select()
            .from(campaignMemoryKnowledge)
            .where(scopeWhere(campaignMemoryKnowledge, scope, campaignMemoryKnowledge.knowledgeId, knowledgeId))
            .limit(1)
        )[0];
        if (!row) fail("CAMPAIGN_MEMORY_NOT_FOUND", `Knowledge ${knowledgeId} not found`);
        const mutation = { ...options, recordType: "knowledge" as const, recordId: knowledgeId, payload: patch };
        if (await replay(scope, mutation, tx)) return knowledgeFrom(row);
        requireMutable(row, options.actor);
        if (row.revision !== options.expectedRevision)
          fail("CAMPAIGN_MEMORY_CAS_MISMATCH", `Knowledge ${knowledgeId} revision changed`);
        const next = {
          ...knowledgeFrom(row),
          ...patch,
          knowledgeId,
          chatId: scope.chatId,
          revision: row.revision + 1,
          updatedAt: now(),
        };
        oneOf(next.epistemicState, EPISTEMIC_STATES, "knowledge.epistemicState");
        if (next.attributedClaim) claim(next.attributedClaim);
        next.learnedFrom = await normalizeEvidence(scope, next.learnedFrom, tx);
        provenance(next.provenance);
        await assertEntity(scope, next.holderEntityId, tx, ["character", "persona"]);
        if (next.attributedClaim) await assertEntity(scope, next.attributedClaim.subjectEntityId, tx);
        if (
          next.factId &&
          !(
            await tx
              .select()
              .from(campaignMemoryFacts)
              .where(scopeWhere(campaignMemoryFacts, scope, campaignMemoryFacts.factId, next.factId))
              .limit(1)
          )[0]
        )
          fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "Knowledge fact is outside chat scope");
        await tx
          .update(campaignMemoryKnowledge)
          .set({
            holderEntityId: next.holderEntityId,
            factId: next.factId ?? null,
            attributedClaim: next.attributedClaim ? JSON.stringify(next.attributedClaim) : null,
            epistemicState: next.epistemicState,
            learnedFrom: JSON.stringify(next.learnedFrom),
            learnedAtOrder: next.learnedAtOrder ?? null,
            confidence: next.confidence ?? null,
            provenance: JSON.stringify(next.provenance),
            manualLock: next.manualLock ? 1 : 0,
            revision: next.revision,
            updatedAt: next.updatedAt,
          })
          .where(scopeWhere(campaignMemoryKnowledge, scope, campaignMemoryKnowledge.knowledgeId, knowledgeId));
        await journal(
          scope,
          {
            operationId: options.operationId,
            recordType: "knowledge",
            recordId: knowledgeId,
            actor: options.actor,
            expectedRevision: options.expectedRevision,
            before: knowledgeFrom(row),
            after: next,
            reason: options.reason,
            evidence: options.evidence,
            payload: patch,
          },
          tx,
        );
        return next;
      },
      { durable: true },
    );
  }

  async function createEvent(input: CampaignMemoryEventInput) {
    await assertChat(input.chatId);
    listOfStrings(input.participantEntityIds, "event.participantEntityIds");
    listOfStrings(input.transitions, "event.transitions");
    for (const id of input.participantEntityIds) await assertEntity({ chatId: input.chatId }, id);
    if (input.locationEntityId) await assertEntity({ chatId: input.chatId }, input.locationEntityId, db, "location");
    provenance(input.provenance);
    if (!input.occurrenceOrder.trim() || !input.sourceRevision.trim())
      fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Event ordering and sourceRevision are required");
    const normalizedEvidence = await normalizeEvidence({ chatId: input.chatId }, input.evidence);
    const eventId = input.eventId ?? randomUUID();
    const timestamp = now();
    await db.insert(campaignMemoryEvents).values({
      eventId,
      chatId: input.chatId,
      occurrenceOrder: input.occurrenceOrder,
      campaignTime: input.campaignTime ?? null,
      participantEntityIds: JSON.stringify(input.participantEntityIds),
      locationEntityId: input.locationEntityId ?? null,
      sourceRevision: input.sourceRevision,
      transitions: JSON.stringify(input.transitions),
      evidence: JSON.stringify(normalizedEvidence),
      provenance: JSON.stringify(input.provenance),
      immutable: 1,
      createdAt: timestamp,
    });
    return { ...input, evidence: normalizedEvidence, eventId, immutable: true as const, createdAt: timestamp };
  }
  async function getEvent(scope: CampaignMemoryScope, eventId: string) {
    await assertChat(scope.chatId);
    const row = (
      await db
        .select()
        .from(campaignMemoryEvents)
        .where(scopeWhere(campaignMemoryEvents, scope, campaignMemoryEvents.eventId, eventId))
        .limit(1)
    )[0];
    return row ? eventFrom(row) : null;
  }
  async function listEvents(scope: CampaignMemoryScope) {
    await assertChat(scope.chatId);
    return (await db.select().from(campaignMemoryEvents).where(eq(campaignMemoryEvents.chatId, scope.chatId))).map(
      eventFrom,
    );
  }

  async function createCurrentState(input: CampaignMemoryStateInput) {
    await assertChat(input.chatId);
    await assertEntity({ chatId: input.chatId }, input.entityId);
    await assertEvent({ chatId: input.chatId }, input.sourceEventId);
    provenance(input.provenance);
    if (!input.property.trim() || !input.validAtOrder.trim())
      fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Current-state property and order are required");
    json(input.value);
    const stateId = input.stateId ?? randomUUID();
    const timestamp = now();
    try {
      await db.insert(campaignMemoryCurrentState).values({
        stateId,
        chatId: input.chatId,
        entityId: input.entityId,
        property: input.property,
        value: JSON.stringify(input.value),
        sourceEventId: input.sourceEventId,
        validAtOrder: input.validAtOrder,
        protected: input.protected ? 1 : 0,
        provenance: JSON.stringify(input.provenance),
        manualLock: input.manualLock ? 1 : 0,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      if (error instanceof FileUniqueConstraintError)
        fail("CAMPAIGN_MEMORY_CONFLICT", "Current state already exists for this entity property");
      throw error;
    }
    return { ...input, stateId, revision: 1, createdAt: timestamp, updatedAt: timestamp };
  }
  async function getCurrentState(scope: CampaignMemoryScope, stateId: string) {
    await assertChat(scope.chatId);
    const row = (
      await db
        .select()
        .from(campaignMemoryCurrentState)
        .where(scopeWhere(campaignMemoryCurrentState, scope, campaignMemoryCurrentState.stateId, stateId))
        .limit(1)
    )[0];
    return row ? stateFrom(row) : null;
  }
  async function listCurrentState(scope: CampaignMemoryScope) {
    await assertChat(scope.chatId);
    return (
      await db.select().from(campaignMemoryCurrentState).where(eq(campaignMemoryCurrentState.chatId, scope.chatId))
    ).map(stateFrom);
  }
  async function updateCurrentState(
    scope: CampaignMemoryScope,
    stateId: string,
    patch: Partial<CampaignMemoryStateInput>,
    options: CampaignMemoryUpdateOptions,
  ) {
    await assertChat(scope.chatId);
    return db.transaction(
      async (tx) => {
        const row = (
          await tx
            .select()
            .from(campaignMemoryCurrentState)
            .where(scopeWhere(campaignMemoryCurrentState, scope, campaignMemoryCurrentState.stateId, stateId))
            .limit(1)
        )[0];
        if (!row) fail("CAMPAIGN_MEMORY_NOT_FOUND", `State ${stateId} not found`);
        const mutation = { ...options, recordType: "current-state" as const, recordId: stateId, payload: patch };
        if (await replay(scope, mutation, tx)) return stateFrom(row);
        requireMutable(row, options.actor);
        if (row.revision !== options.expectedRevision)
          fail("CAMPAIGN_MEMORY_CAS_MISMATCH", `State ${stateId} revision changed`);
        const next = {
          ...stateFrom(row),
          ...patch,
          stateId,
          chatId: scope.chatId,
          revision: row.revision + 1,
          updatedAt: now(),
        };
        if (!next.property.trim() || !next.validAtOrder.trim())
          fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Current-state property and order are required");
        provenance(next.provenance);
        await assertEntity(scope, next.entityId, tx);
        const sourceEvent = await assertEvent(scope, next.sourceEventId, tx);
        json(next.value);
        // Monotonic order guard: an older movement delivered late must not overwrite newer state.
        if (compareCampaignMemoryMessageOrder(next.validAtOrder, row.validAtOrder) < 0)
          fail("CAMPAIGN_MEMORY_STALE_ORDER", `State ${stateId} already holds a newer order than ${next.validAtOrder}`);
        if (next.sourceEventId !== row.sourceEventId) {
          const previousEvent = (
            await tx
              .select()
              .from(campaignMemoryEvents)
              .where(scopeWhere(campaignMemoryEvents, scope, campaignMemoryEvents.eventId, row.sourceEventId))
              .limit(1)
          )[0];
          if (
            previousEvent &&
            compareCampaignMemoryMessageOrder(sourceEvent.occurrenceOrder, previousEvent.occurrenceOrder) < 0
          )
            fail(
              "CAMPAIGN_MEMORY_STALE_ORDER",
              `State ${stateId} already follows a newer event than ${next.sourceEventId}`,
            );
        }
        await tx
          .update(campaignMemoryCurrentState)
          .set({
            entityId: next.entityId,
            property: next.property,
            value: JSON.stringify(next.value),
            sourceEventId: next.sourceEventId,
            validAtOrder: next.validAtOrder,
            protected: next.protected ? 1 : 0,
            provenance: JSON.stringify(next.provenance),
            manualLock: next.manualLock ? 1 : 0,
            revision: next.revision,
            updatedAt: next.updatedAt,
          })
          .where(scopeWhere(campaignMemoryCurrentState, scope, campaignMemoryCurrentState.stateId, stateId));
        await journal(
          scope,
          {
            operationId: options.operationId,
            recordType: "current-state",
            recordId: stateId,
            actor: options.actor,
            expectedRevision: options.expectedRevision,
            before: stateFrom(row),
            after: next,
            reason: options.reason,
            evidence: options.evidence,
            payload: patch,
          },
          tx,
        );
        return next;
      },
      { durable: true },
    );
  }

  async function createRelationship(input: CampaignMemoryRelationshipInput) {
    await assertChat(input.chatId);
    nonblank(input.type, "relationship.type");
    await assertRelationshipEndpoints({ chatId: input.chatId }, input);
    provenance(input.provenance);
    oneOf(input.status, RELATIONSHIP_STATUSES, "relationship.status");
    nonblank(input.inverseLabel, "relationship.inverseLabel");
    const normalizedEvidence = await normalizeEvidence({ chatId: input.chatId }, input.evidence);
    const relationshipId = input.relationshipId ?? randomUUID();
    const timestamp = now();
    await db.insert(campaignMemoryRelationships).values({
      relationshipId,
      chatId: input.chatId,
      sourceEntityId: input.sourceEntityId,
      targetEntityId: input.targetEntityId,
      type: input.type,
      inverseLabel: input.inverseLabel,
      status: input.status,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      evidence: JSON.stringify(normalizedEvidence),
      provenance: JSON.stringify(input.provenance),
      manualLock: input.manualLock ? 1 : 0,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return {
      ...input,
      evidence: normalizedEvidence,
      relationshipId,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }
  async function getRelationship(scope: CampaignMemoryScope, relationshipId: string) {
    await assertChat(scope.chatId);
    const row = (
      await db
        .select()
        .from(campaignMemoryRelationships)
        .where(
          scopeWhere(campaignMemoryRelationships, scope, campaignMemoryRelationships.relationshipId, relationshipId),
        )
        .limit(1)
    )[0];
    return row ? relationshipFrom(row) : null;
  }
  async function listRelationships(scope: CampaignMemoryScope) {
    await assertChat(scope.chatId);
    return (
      await db.select().from(campaignMemoryRelationships).where(eq(campaignMemoryRelationships.chatId, scope.chatId))
    ).map(relationshipFrom);
  }
  async function updateRelationship(
    scope: CampaignMemoryScope,
    relationshipId: string,
    patch: Partial<CampaignMemoryRelationshipInput>,
    options: CampaignMemoryUpdateOptions,
  ) {
    await assertChat(scope.chatId);
    return db.transaction(
      async (tx) => {
        const row = (
          await tx
            .select()
            .from(campaignMemoryRelationships)
            .where(
              scopeWhere(
                campaignMemoryRelationships,
                scope,
                campaignMemoryRelationships.relationshipId,
                relationshipId,
              ),
            )
            .limit(1)
        )[0];
        if (!row) fail("CAMPAIGN_MEMORY_NOT_FOUND", `Relationship ${relationshipId} not found`);
        const mutation = { ...options, recordType: "relationship" as const, recordId: relationshipId, payload: patch };
        if (await replay(scope, mutation, tx)) return relationshipFrom(row);
        requireMutable(row, options.actor);
        if (row.revision !== options.expectedRevision)
          fail("CAMPAIGN_MEMORY_CAS_MISMATCH", `Relationship ${relationshipId} revision changed`);
        const next = {
          ...relationshipFrom(row),
          ...patch,
          relationshipId,
          chatId: scope.chatId,
          revision: row.revision + 1,
          updatedAt: now(),
        };
        oneOf(next.status, RELATIONSHIP_STATUSES, "relationship.status");
        nonblank(next.type, "relationship.type");
        nonblank(next.inverseLabel, "relationship.inverseLabel");
        next.evidence = await normalizeEvidence(scope, next.evidence, tx);
        provenance(next.provenance);
        await assertRelationshipEndpoints(scope, next, tx);
        await tx
          .update(campaignMemoryRelationships)
          .set({
            sourceEntityId: next.sourceEntityId,
            targetEntityId: next.targetEntityId,
            type: next.type,
            inverseLabel: next.inverseLabel,
            status: next.status,
            effectiveFrom: next.effectiveFrom ?? null,
            effectiveTo: next.effectiveTo ?? null,
            evidence: JSON.stringify(next.evidence),
            provenance: JSON.stringify(next.provenance),
            manualLock: next.manualLock ? 1 : 0,
            revision: next.revision,
            updatedAt: next.updatedAt,
          })
          .where(
            scopeWhere(campaignMemoryRelationships, scope, campaignMemoryRelationships.relationshipId, relationshipId),
          );
        await journal(
          scope,
          {
            operationId: options.operationId,
            recordType: "relationship",
            recordId: relationshipId,
            actor: options.actor,
            expectedRevision: options.expectedRevision,
            before: relationshipFrom(row),
            after: next,
            reason: options.reason,
            evidence: options.evidence,
            payload: patch,
          },
          tx,
        );
        return next;
      },
      { durable: true },
    );
  }
  async function listBacklinks(scope: CampaignMemoryScope, entityId: string): Promise<CampaignMemoryBacklink[]> {
    await assertChat(scope.chatId);
    await assertEntity(scope, entityId);
    const relationships = await listRelationships(scope);
    return relationships.flatMap<CampaignMemoryBacklink>((relationship) => {
      if (relationship.sourceEntityId === entityId)
        return [{ ...relationship, direction: "outgoing" as const, label: relationship.type }];
      if (relationship.targetEntityId === entityId)
        return [{ ...relationship, direction: "incoming" as const, label: relationship.inverseLabel }];
      return [];
    });
  }

  async function listMutationJournal(scope: CampaignMemoryScope) {
    await assertChat(scope.chatId);
    return (
      await db
        .select()
        .from(campaignMemoryMutationJournal)
        .where(eq(campaignMemoryMutationJournal.chatId, scope.chatId))
    ).map(
      (row): CampaignMemoryMutationJournal => ({
        journalId: row.journalId,
        chatId: row.chatId,
        operationId: row.operationId,
        recordType: row.recordType as CampaignMemoryMutationJournal["recordType"],
        recordId: row.recordId,
        actor: row.actor as CampaignMemoryActor,
        ...(row.expectedRevision == null ? {} : { expectedRevision: row.expectedRevision }),
        ...(row.before == null ? {} : { before: parse(row.before, null) }),
        ...(row.after == null ? {} : { after: parse(row.after, null) }),
        reason: row.reason,
        evidence: parse(row.evidence, []),
        ...(row.compensationOperationId == null ? {} : { compensationOperationId: row.compensationOperationId }),
        payloadHash: row.payloadHash,
        createdAt: row.createdAt,
      }),
    );
  }
  return {
    createEntity,
    getEntity,
    listEntities,
    updateEntity,
    createFact,
    getFact,
    listFacts,
    updateFact,
    createKnowledge,
    getKnowledge,
    listKnowledge,
    updateKnowledge,
    createEvent,
    getEvent,
    listEvents,
    createCurrentState,
    getCurrentState,
    listCurrentState,
    updateCurrentState,
    createRelationship,
    getRelationship,
    listRelationships,
    updateRelationship,
    listBacklinks,
    listMutationJournal,
  };
}
