import { createHash, randomUUID } from "node:crypto";
import type {
  CampaignMemoryActor,
  CampaignMemoryEvidence,
  CampaignMemoryEntity,
  CampaignMemoryFact,
  CampaignMemoryKnowledge,
  CampaignMemoryCurrentState,
  CampaignMemoryEvent,
  CampaignMemoryRelationship,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { and, eq } from "../../db/file-query.js";
import { campaignMemoryMutationJournal } from "../../db/schema/index.js";
import {
  createCampaignMemoryStorage,
  normalizeCampaignMemoryEvidence,
  type CampaignMemoryEntityInput,
  type CampaignMemoryFactInput,
  type CampaignMemoryKnowledgeInput,
  type CampaignMemoryEventInput,
  type CampaignMemoryStateInput,
  type CampaignMemoryRelationshipInput,
} from "../storage/campaign-memory.storage.js";

export type CampaignMemoryRecordType = "entity" | "fact" | "knowledge" | "event" | "current-state" | "relationship";
type RecordByType = {
  entity: CampaignMemoryEntity;
  fact: CampaignMemoryFact;
  knowledge: CampaignMemoryKnowledge;
  event: CampaignMemoryEvent;
  "current-state": CampaignMemoryCurrentState;
  relationship: CampaignMemoryRelationship;
};
type InputByType = {
  entity: CampaignMemoryEntityInput;
  fact: CampaignMemoryFactInput;
  knowledge: CampaignMemoryKnowledgeInput;
  event: CampaignMemoryEventInput;
  "current-state": CampaignMemoryStateInput;
  relationship: CampaignMemoryRelationshipInput;
};
type IdKey = "entityId" | "factId" | "knowledgeId" | "eventId" | "stateId" | "relationshipId";

export type CampaignMemoryMutationCommand =
  | (
      | {
          chatId: string;
          operationId: string;
          actor: CampaignMemoryActor;
          reason: string;
          evidence?: CampaignMemoryEvidence[];
          recordType: "entity";
          action: "create";
          input: CampaignMemoryEntityInput;
        }
      | {
          chatId: string;
          operationId: string;
          actor: CampaignMemoryActor;
          reason: string;
          evidence?: CampaignMemoryEvidence[];
          recordType: "fact";
          action: "create";
          input: CampaignMemoryFactInput;
        }
      | {
          chatId: string;
          operationId: string;
          actor: CampaignMemoryActor;
          reason: string;
          evidence?: CampaignMemoryEvidence[];
          recordType: "knowledge";
          action: "create";
          input: CampaignMemoryKnowledgeInput;
        }
      | {
          chatId: string;
          operationId: string;
          actor: CampaignMemoryActor;
          reason: string;
          evidence?: CampaignMemoryEvidence[];
          recordType: "event";
          action: "create";
          input: CampaignMemoryEventInput;
        }
      | {
          chatId: string;
          operationId: string;
          actor: CampaignMemoryActor;
          reason: string;
          evidence?: CampaignMemoryEvidence[];
          recordType: "current-state";
          action: "create";
          input: CampaignMemoryStateInput;
        }
      | {
          chatId: string;
          operationId: string;
          actor: CampaignMemoryActor;
          reason: string;
          evidence?: CampaignMemoryEvidence[];
          recordType: "relationship";
          action: "create";
          input: CampaignMemoryRelationshipInput;
        }
    )
  | {
      [K in CampaignMemoryRecordType]: {
        chatId: string;
        operationId: string;
        actor: CampaignMemoryActor;
        reason: string;
        evidence?: CampaignMemoryEvidence[];
        recordType: K;
        action: "update";
        recordId: string;
        expectedRevision: number;
        patch: Partial<InputByType[K]>;
      };
    }[CampaignMemoryRecordType];

export interface CampaignMemoryCompensationCommand {
  chatId: string;
  operationId: string;
  originalOperationId: string;
  actor: CampaignMemoryActor;
  reason: string;
  evidence?: CampaignMemoryEvidence[];
}
const COMPENSATION_COMMAND_KEYS = [
  "chatId",
  "operationId",
  "originalOperationId",
  "actor",
  "reason",
  "evidence",
] as const;

export class CampaignMemoryMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CampaignMemoryMutationError";
  }
}
const fail = (code: string, message: string): never => {
  throw new CampaignMemoryMutationError(code, message);
};
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function nonblank(v: unknown, label: string): asserts v is string {
  if (typeof v !== "string" || !v.trim()) fail("CAMPAIGN_MEMORY_INVALID_VALUE", `${label} is required`);
}
const ACTORS = ["system", "user", "import"] as const;
const TYPES = ["entity", "fact", "knowledge", "event", "current-state", "relationship"] as const;
const idKey: Record<CampaignMemoryRecordType, IdKey> = {
  entity: "entityId",
  fact: "factId",
  knowledge: "knowledgeId",
  event: "eventId",
  "current-state": "stateId",
  relationship: "relationshipId",
};
const inputKeys: Record<CampaignMemoryRecordType, readonly string[]> = {
  entity: [
    "entityId",
    "chatId",
    "kind",
    "owner",
    "aliases",
    "tags",
    "summary",
    "body",
    "attributes",
    "status",
    "manualLock",
    "provenance",
  ],
  fact: [
    "factId",
    "chatId",
    "subjectEntityId",
    "predicate",
    "value",
    "conditions",
    "status",
    "validFromOrder",
    "validToOrder",
    "sourceRevision",
    "evidence",
    "author",
    "provenance",
    "manualLock",
    "supersedesFactId",
  ],
  knowledge: [
    "knowledgeId",
    "chatId",
    "holderEntityId",
    "factId",
    "attributedClaim",
    "epistemicState",
    "learnedFrom",
    "learnedAtOrder",
    "confidence",
    "provenance",
    "manualLock",
  ],
  event: [
    "eventId",
    "chatId",
    "occurrenceOrder",
    "campaignTime",
    "participantEntityIds",
    "locationEntityId",
    "sourceRevision",
    "transitions",
    "evidence",
    "provenance",
  ],
  "current-state": [
    "stateId",
    "chatId",
    "entityId",
    "property",
    "value",
    "sourceEventId",
    "validAtOrder",
    "protected",
    "provenance",
    "manualLock",
  ],
  relationship: [
    "relationshipId",
    "chatId",
    "sourceEntityId",
    "targetEntityId",
    "type",
    "inverseLabel",
    "status",
    "effectiveFrom",
    "effectiveTo",
    "evidence",
    "provenance",
    "manualLock",
  ],
};
const updateKeys: Record<CampaignMemoryRecordType, readonly string[]> = {
  entity: inputKeys.entity.filter((k) => !["entityId", "chatId"].includes(k)),
  fact: inputKeys.fact.filter((k) => !["factId", "chatId"].includes(k)),
  knowledge: inputKeys.knowledge.filter((k) => !["knowledgeId", "chatId"].includes(k)),
  event: [],
  "current-state": inputKeys["current-state"].filter((k) => !["stateId", "chatId"].includes(k)),
  relationship: inputKeys.relationship.filter((k) => !["relationshipId", "chatId"].includes(k)),
};
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : isRecord(value)
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, stable(v)]),
        )
      : value;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
const parseAfter = (value: string | null): unknown => (value == null ? undefined : JSON.parse(value));
const clean = (value: Record<string, unknown>, allowed: readonly string[], label: string) => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", `${label}.${key} is forbidden`);
  return value;
};
const CREATE_COMMAND_KEYS = [
  "chatId",
  "operationId",
  "actor",
  "reason",
  "evidence",
  "recordType",
  "action",
  "input",
] as const;
const UPDATE_COMMAND_KEYS = [
  "chatId",
  "operationId",
  "actor",
  "reason",
  "evidence",
  "recordType",
  "action",
  "recordId",
  "expectedRevision",
  "patch",
] as const;
function validateCommand(raw: unknown): asserts raw is CampaignMemoryMutationCommand {
  if (!isRecord(raw)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Mutation command must be an object");
  const object = raw as Record<string, unknown>;
  const command = raw as CampaignMemoryMutationCommand;
  if (command.action !== "create" && command.action !== "update")
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "action must be create or update");
  clean(object, command.action === "update" ? UPDATE_COMMAND_KEYS : CREATE_COMMAND_KEYS, "command");
  nonblank(command.chatId, "chatId");
  nonblank(command.operationId, "operationId");
  nonblank(command.reason, "reason");
  if (!ACTORS.includes(command.actor)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "actor is invalid");
  if (!TYPES.includes(command.recordType)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "recordType is invalid");
  if (command.action === "update" && command.recordType === "event")
    fail("CAMPAIGN_MEMORY_IMMUTABLE", "Events cannot be updated");
  if (command.action === "update") {
    nonblank(command.recordId, "recordId");
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1)
      fail("CAMPAIGN_MEMORY_INVALID_VALUE", "expectedRevision is required");
    if (!isRecord(command.patch)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "patch must be an object");
    clean(command.patch, updateKeys[command.recordType], "patch");
  } else {
    if (!isRecord(command.input)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "input must be an object");
    clean(command.input, inputKeys[command.recordType], "input");
    if ("chatId" in command.input && command.input.chatId !== command.chatId)
      fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "input.chatId must match command.chatId");
  }
  if (
    command.evidence !== undefined &&
    (!Array.isArray(command.evidence) ||
      command.evidence.some(
        (e) =>
          !isRecord(e) ||
          typeof e.messageId !== "string" ||
          typeof e.quote !== "string" ||
          !e.messageId.trim() ||
          !e.quote.trim(),
      ))
  )
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "evidence is invalid");
}

async function journalRow(db: DB, chatId: string, operationId: string) {
  return (
    await db
      .select()
      .from(campaignMemoryMutationJournal)
      .where(
        and(
          eq(campaignMemoryMutationJournal.chatId, chatId),
          eq(campaignMemoryMutationJournal.operationId, operationId),
        ),
      )
      .limit(1)
  )[0];
}
function replayResult(row: typeof campaignMemoryMutationJournal.$inferSelect, requestHash: string) {
  if (row.payloadHash !== requestHash)
    fail("CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT", `Operation ${row.operationId} was already used with another payload`);
  const result = parseAfter(row.after);
  if (result === undefined) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Committed mutation has no result");
  return result;
}

async function createRecord(
  storage: ReturnType<typeof createCampaignMemoryStorage>,
  command: Extract<CampaignMemoryMutationCommand, { action: "create" }>,
) {
  switch (command.recordType) {
    case "entity":
      return storage.createEntity({ ...command.input, chatId: command.chatId });
    case "fact":
      return storage.createFact({ ...command.input, chatId: command.chatId });
    case "knowledge":
      return storage.createKnowledge({ ...command.input, chatId: command.chatId });
    case "event":
      return storage.createEvent({ ...command.input, chatId: command.chatId });
    case "current-state":
      return storage.createCurrentState({ ...command.input, chatId: command.chatId });
    case "relationship":
      return storage.createRelationship({ ...command.input, chatId: command.chatId });
    default:
      return fail("CAMPAIGN_MEMORY_INVALID_VALUE", "recordType is invalid");
  }
}
async function readRecord(
  storage: ReturnType<typeof createCampaignMemoryStorage>,
  chatId: string,
  recordType: CampaignMemoryRecordType,
  recordId: string,
) {
  switch (recordType) {
    case "entity":
      return storage.getEntity({ chatId }, recordId);
    case "fact":
      return storage.getFact({ chatId }, recordId);
    case "knowledge":
      return storage.getKnowledge({ chatId }, recordId);
    case "event":
      return storage.getEvent({ chatId }, recordId);
    case "current-state":
      return storage.getCurrentState({ chatId }, recordId);
    case "relationship":
      return storage.getRelationship({ chatId }, recordId);
    default:
      return fail("CAMPAIGN_MEMORY_INVALID_VALUE", "recordType is invalid");
  }
}
async function updateRecord(
  storage: ReturnType<typeof createCampaignMemoryStorage>,
  command: Extract<CampaignMemoryMutationCommand, { action: "update" }>,
) {
  const scope = { chatId: command.chatId };
  const options = {
    expectedRevision: command.expectedRevision,
    actor: command.actor,
    reason: command.reason,
    evidence: command.evidence ?? [],
  };
  switch (command.recordType) {
    case "entity":
      return storage.updateEntity(
        scope,
        command.recordId,
        command.patch as Partial<CampaignMemoryEntityInput>,
        options,
      );
    case "fact":
      return storage.updateFact(scope, command.recordId, command.patch as Partial<CampaignMemoryFactInput>, options);
    case "knowledge":
      return storage.updateKnowledge(
        scope,
        command.recordId,
        command.patch as Partial<CampaignMemoryKnowledgeInput>,
        options,
      );
    case "current-state":
      return storage.updateCurrentState(
        scope,
        command.recordId,
        command.patch as Partial<CampaignMemoryStateInput>,
        options,
      );
    case "relationship":
      return storage.updateRelationship(
        scope,
        command.recordId,
        command.patch as Partial<CampaignMemoryRelationshipInput>,
        options,
      );
    case "event":
      return fail("CAMPAIGN_MEMORY_IMMUTABLE", "Events cannot be updated");
    default:
      return fail("CAMPAIGN_MEMORY_INVALID_VALUE", "recordType is invalid");
  }
}

export async function applyCampaignMemoryMutation(
  db: DB,
  command: CampaignMemoryMutationCommand,
): Promise<RecordByType[CampaignMemoryRecordType]> {
  validateCommand(command);
  const requestHash = hash({
    chatId: command.chatId,
    actor: command.actor,
    reason: command.reason,
    evidence: command.evidence ?? [],
    recordType: command.recordType,
    action: command.action,
    recordId: command.action === "update" ? command.recordId : undefined,
    expectedRevision: command.action === "update" ? command.expectedRevision : undefined,
    payload: command.action === "update" ? command.patch : command.input,
  });
  return db.transaction(
    async (tx) => {
      const existing = await journalRow(tx, command.chatId, command.operationId);
      if (existing) return replayResult(existing, requestHash) as RecordByType[CampaignMemoryRecordType];
      const evidence = await normalizeCampaignMemoryEvidence({ chatId: command.chatId }, command.evidence ?? [], tx);
      const storage = createCampaignMemoryStorage(tx);
      let before: unknown;
      let result: RecordByType[CampaignMemoryRecordType];
      if (command.action === "create") {
        result = await createRecord(storage, command);
      } else {
        before = await readRecord(storage, command.chatId, command.recordType, command.recordId);
        if (!before) fail("CAMPAIGN_MEMORY_NOT_FOUND", `${command.recordType} ${command.recordId} not found`);
        result = await updateRecord(storage, { ...command, evidence } as typeof command);
      }
      const resultId = (result as unknown as Record<string, unknown>)[idKey[command.recordType]];
      if (typeof resultId !== "string") fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Mutation result has no record ID");
      await tx.insert(campaignMemoryMutationJournal).values({
        journalId: randomUUID(),
        chatId: command.chatId,
        operationId: command.operationId,
        recordType: command.recordType,
        recordId: resultId,
        actor: command.actor,
        expectedRevision: command.action === "update" ? command.expectedRevision : null,
        before: before === undefined ? null : JSON.stringify(before),
        after: JSON.stringify(result),
        reason: command.reason,
        evidence: JSON.stringify(evidence),
        compensationOperationId: null,
        payloadHash: requestHash,
        createdAt: new Date().toISOString(),
      });
      return result;
    },
    { durable: true },
  ) as Promise<RecordByType[CampaignMemoryRecordType]>;
}

/** Storage has no delete: a journaled create is neutralised with the schema's own "no canonical force" state. */
const NEUTRAL_CREATE_PATCH: Record<Exclude<CampaignMemoryRecordType, "event">, Record<string, unknown>> = {
  entity: { status: "archived" },
  fact: { status: "retracted" },
  knowledge: { epistemicState: "unknown" },
  relationship: { status: "ended" },
  "current-state": { value: null },
};
export interface CampaignMemoryCompensationSkipped {
  skipped: "immutable";
  recordType: "event";
  recordId: string;
  compensates: string;
}

/**
 * Compensate one journaled operation. Updates are restored from their journaled
 * `before`; creates are neutralised (NEUTRAL_CREATE_PATCH) because storage has no
 * delete; events are immutable and reported as skipped. Every path is revision
 * protected (CAS against the original result), journaled under its own operationId
 * with `compensationOperationId` pointing at the original, and replayed on retry.
 * Current-state never regresses its order anchor (CAMPAIGN_MEMORY_STALE_ORDER):
 * validAtOrder and sourceEventId are kept, only value and the other fields move.
 */
export async function compensateCampaignMemoryMutation(db: DB, command: CampaignMemoryCompensationCommand) {
  if (!isRecord(command)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Compensation command must be an object");
  clean(command as unknown as Record<string, unknown>, COMPENSATION_COMMAND_KEYS, "command");
  nonblank(command.chatId, "chatId");
  nonblank(command.operationId, "operationId");
  nonblank(command.originalOperationId, "originalOperationId");
  nonblank(command.reason, "reason");
  if (!ACTORS.includes(command.actor)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "actor is invalid");
  if (
    command.evidence !== undefined &&
    (!Array.isArray(command.evidence) ||
      command.evidence.some(
        (e) =>
          !isRecord(e) ||
          typeof e.messageId !== "string" ||
          typeof e.quote !== "string" ||
          !e.messageId.trim() ||
          !e.quote.trim(),
      ))
  )
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "evidence is invalid");
  const requestHash = hash({
    chatId: command.chatId,
    operationId: command.operationId,
    originalOperationId: command.originalOperationId,
    actor: command.actor,
    reason: command.reason,
    evidence: command.evidence ?? [],
    action: "compensate",
  });
  return db.transaction(
    async (tx) => {
      const existing = await journalRow(tx, command.chatId, command.operationId);
      if (existing) return replayResult(existing, requestHash);
      const originalRow = await journalRow(tx, command.chatId, command.originalOperationId);
      if (!originalRow)
        fail("CAMPAIGN_MEMORY_NOT_FOUND", `Original operation ${command.originalOperationId} not found`);
      const original = originalRow!;
      if (!TYPES.includes(original.recordType as CampaignMemoryRecordType) || original.after == null)
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Only journaled record mutations can be compensated");
      const evidence = await normalizeCampaignMemoryEvidence({ chatId: command.chatId }, command.evidence ?? [], tx);
      const createdAt = new Date().toISOString();
      if (original.recordType === "event") {
        const skipped: CampaignMemoryCompensationSkipped = {
          skipped: "immutable",
          recordType: "event",
          recordId: original.recordId,
          compensates: original.operationId,
        };
        await tx.insert(campaignMemoryMutationJournal).values({
          journalId: randomUUID(),
          chatId: command.chatId,
          operationId: command.operationId,
          recordType: "event",
          recordId: original.recordId,
          actor: command.actor,
          expectedRevision: null,
          before: null,
          after: JSON.stringify(skipped),
          reason: command.reason,
          evidence: JSON.stringify(evidence),
          compensationOperationId: command.originalOperationId,
          payloadHash: requestHash,
          createdAt,
        });
        return skipped;
      }
      const recordType = original.recordType as Exclude<CampaignMemoryRecordType, "event">;
      const after = JSON.parse(original.after!) as Record<string, unknown>;
      const before = original.before == null ? undefined : (JSON.parse(original.before) as Record<string, unknown>);
      if (after.revision === undefined || (before && before[idKey[recordType]] === undefined))
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Original journal is not a record mutation");
      const storage = createCampaignMemoryStorage(tx);
      const current = await readRecord(storage, command.chatId, recordType, original.recordId);
      if (!current) fail("CAMPAIGN_MEMORY_NOT_FOUND", `Record ${original.recordId} not found`);
      const currentRecord = current as Exclude<RecordByType[CampaignMemoryRecordType], CampaignMemoryEvent>;
      if (currentRecord.revision !== after.revision)
        fail("CAMPAIGN_MEMORY_CAS_MISMATCH", "Record changed since the original mutation");
      let patch: Record<string, unknown>;
      if (before) {
        patch = { ...before };
        delete patch.chatId;
        delete patch[idKey[recordType]];
        delete patch.revision;
        delete patch.createdAt;
        delete patch.updatedAt;
        delete patch.immutable;
        // Storage never lets the order anchor regress: keep the newest validAtOrder/sourceEventId.
        if (recordType === "current-state") {
          delete patch.validAtOrder;
          delete patch.sourceEventId;
        }
      } else {
        patch = { ...NEUTRAL_CREATE_PATCH[recordType] };
      }
      const updateCommand = {
        chatId: command.chatId,
        operationId: command.operationId,
        actor: command.actor,
        reason: command.reason,
        evidence,
        recordType,
        action: "update" as const,
        recordId: original.recordId,
        expectedRevision: currentRecord.revision,
        patch,
      } as CampaignMemoryMutationCommand;
      const result = await updateRecord(
        storage,
        updateCommand as Extract<CampaignMemoryMutationCommand, { action: "update" }>,
      );
      await tx.insert(campaignMemoryMutationJournal).values({
        journalId: randomUUID(),
        chatId: command.chatId,
        operationId: command.operationId,
        recordType,
        recordId: original.recordId,
        actor: command.actor,
        expectedRevision: currentRecord.revision,
        before: JSON.stringify(current),
        after: JSON.stringify(result),
        reason: command.reason,
        evidence: JSON.stringify(evidence),
        compensationOperationId: command.originalOperationId,
        payloadHash: requestHash,
        createdAt,
      });
      return result;
    },
    { durable: true },
  );
}

export async function previewCampaignMemoryMutation(db: DB, command: CampaignMemoryMutationCommand) {
  validateCommand(command);
  class PreviewRollback extends Error {
    constructor(readonly result: unknown) {
      super("preview rollback");
    }
  }
  try {
    await db.transaction(async (tx) => {
      const storage = createCampaignMemoryStorage(tx);
      const evidence = await normalizeCampaignMemoryEvidence({ chatId: command.chatId }, command.evidence ?? [], tx);
      if (command.action === "create") {
        const result = await createRecord(storage, command);
        throw new PreviewRollback({
          validated: true,
          persisted: false,
          recordType: command.recordType,
          action: "create" as const,
          before: undefined,
          after: result,
          diff: command.input,
        });
      }
      const current = await readRecord(storage, command.chatId, command.recordType, command.recordId);
      if (!current) fail("CAMPAIGN_MEMORY_NOT_FOUND", `${command.recordType} ${command.recordId} not found`);
      const currentRecord = current!;
      if (!("revision" in currentRecord) || currentRecord.revision !== command.expectedRevision)
        fail("CAMPAIGN_MEMORY_CAS_MISMATCH", `Revision changed for ${command.recordId}`);
      const result = await updateRecord(storage, { ...command, evidence } as typeof command);
      throw new PreviewRollback({
        validated: true,
        persisted: false,
        recordType: command.recordType,
        action: "update" as const,
        before: currentRecord,
        after: result,
        diff: command.patch,
      });
    });
  } catch (error) {
    if (error instanceof PreviewRollback) return error.result;
    throw error;
  }
}
