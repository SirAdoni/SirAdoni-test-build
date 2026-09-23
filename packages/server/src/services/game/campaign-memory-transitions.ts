import { createHash, randomUUID } from "node:crypto";
import type {
  CampaignMemoryActor,
  CampaignMemoryConfidence,
  CampaignMemoryCurrentState,
  CampaignMemoryEpistemicState,
  CampaignMemoryEvent,
  CampaignMemoryEvidence,
  CampaignMemoryJson,
  CampaignMemoryRelationshipStatus,
  CampaignMemorySourceProvenance,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { and, eq } from "../../db/file-query.js";
import { campaignMemoryMutationJournal } from "../../db/schema/index.js";
import { createCampaignMemoryStorage } from "../storage/campaign-memory.storage.js";
import {
  applyCampaignMemoryMutation,
  compensateCampaignMemoryMutation,
  CampaignMemoryMutationError,
  type CampaignMemoryMutationCommand,
  type CampaignMemoryRecordType,
} from "./campaign-memory-mutations.js";
import { compareCampaignMemoryMessageOrder } from "./campaign-memory-order.js";
import { readCampaignMemorySources } from "./campaign-memory-sources.js";

/**
 * Pulse 4 typed transitions on top of the audited mutation layer.
 *
 * Every transition is one durable transaction: each record write goes through
 * `applyCampaignMemoryMutation` (its own journal row, CAS, evidence check) under a
 * child operation ID derived from the transition ID, and a parent journal row
 * (`recordType: "transition"`) records the whole before/after so a retry after
 * post-commit uncertainty discovers the committed operation.
 *
 * ponytail: the transition command/result contracts live here rather than in
 * `@marinara-engine/shared` because the shared dist cannot be regenerated in this
 * lane; lift them once a build is allowed.
 */
export type CampaignMemoryTransitionClass =
  | "event"
  | "movement"
  | "item-transfer"
  | "relationship"
  | "quest"
  | "knowledge";
/** How the source supports the change. Only `observed` may change world truth. */
export type CampaignMemoryTransitionBasis = "observed" | "offer" | "promise" | "rumor" | "speculation";
export type CampaignMemoryQuestStatus =
  | "proposed"
  | "accepted"
  | "active"
  | "completed"
  | "declined"
  | "cancelled"
  | "unresolved";
/** `pending`: consequential ambiguity, nothing applied. `stale`: a newer order already holds the state; only the event was recorded. */
export type CampaignMemoryTransitionStatus = "applied" | "pending" | "stale";

interface TransitionBase {
  chatId: string;
  actor: CampaignMemoryActor;
  reason: string;
  /** Message whose active swipe the transition was read from; `sourceHash` pins that swipe when known. */
  source: { messageId: string; sourceHash?: string };
  evidence: CampaignMemoryEvidence[];
  basis: CampaignMemoryTransitionBasis;
  /** Caller-detected consequential ambiguity; any entry holds the transition as pending. */
  ambiguity?: string[];
  /** Optional record revisions the caller observed; a mismatch fails instead of applying. */
  expectedRevisions?: Record<string, number>;
  campaignTime?: string;
}
export type CampaignMemoryTransitionCommand =
  | (TransitionBase & {
      class: "event";
      key: string;
      participantEntityIds: string[];
      locationEntityId?: string;
      linkedTransitionIds?: string[];
    })
  | (TransitionBase & {
      class: "movement";
      entityId: string;
      locationEntityId: string;
      presence?: "present" | "absent";
    })
  | (TransitionBase & {
      class: "item-transfer";
      giverEntityId?: string;
      receiverEntityId?: string;
      itemEntityId: string;
      quantity: number;
    })
  | (TransitionBase & {
      class: "relationship";
      sourceEntityId: string;
      targetEntityId: string;
      type: string;
      inverseLabel: string;
      status: CampaignMemoryRelationshipStatus;
    })
  | (TransitionBase & {
      class: "quest";
      questEntityId: string;
      status: CampaignMemoryQuestStatus;
      outcome?: CampaignMemoryJson;
    })
  | (TransitionBase & {
      class: "knowledge";
      holderEntityId: string;
      factId?: string;
      claim?: { subjectEntityId: string; predicate: string; value: CampaignMemoryJson };
      epistemicState: CampaignMemoryEpistemicState;
      confidence?: CampaignMemoryConfidence;
    });

export interface CampaignMemoryTransitionOperation {
  operationId: string;
  recordType: CampaignMemoryRecordType;
  recordId: string;
  action: "create" | "update";
  before?: unknown;
  after: unknown;
}
export interface CampaignMemoryTransitionResult {
  transitionId: string;
  chatId: string;
  class: CampaignMemoryTransitionClass;
  status: CampaignMemoryTransitionStatus;
  order: string;
  sourceHash: string;
  reasons: string[];
  operations: CampaignMemoryTransitionOperation[];
  replayed: boolean;
}
export interface CampaignMemoryTransitionCompensationCommand {
  chatId: string;
  transitionId: string;
  operationId?: string;
  actor: CampaignMemoryActor;
  reason: string;
  evidence?: CampaignMemoryEvidence[];
}
export interface CampaignMemoryTransitionCompensationResult {
  transitionId: string;
  operationId: string;
  operations: CampaignMemoryTransitionOperation[];
  /** Immutable events stay as history; the rollback is itself journaled. */
  skippedEventIds: string[];
  replayed: boolean;
}

function fail(code: string, message: string): never {
  throw new CampaignMemoryMutationError(code, message);
}
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function nonblank(v: unknown, label: string): asserts v is string {
  if (typeof v !== "string" || !v.trim()) fail("CAMPAIGN_MEMORY_INVALID_VALUE", `${label} is required`);
}
const optionalString = (v: unknown, label: string) => {
  if (v !== undefined) nonblank(v, label);
};
const ACTORS = ["system", "user", "import"] as const;
const CLASSES = ["event", "movement", "item-transfer", "relationship", "quest", "knowledge"] as const;
const BASES = ["observed", "offer", "promise", "rumor", "speculation"] as const;
const RELATIONSHIP_STATUSES = ["proposed", "active", "ended", "held"] as const;
const QUEST_STATUSES = ["proposed", "accepted", "active", "completed", "declined", "cancelled", "unresolved"] as const;
const EPISTEMIC_STATES = ["knows", "believes", "rumor", "unknown"] as const;
const BASE_KEYS = [
  "class",
  "chatId",
  "actor",
  "reason",
  "source",
  "evidence",
  "basis",
  "ambiguity",
  "expectedRevisions",
  "campaignTime",
] as const;
const CLASS_KEYS: Record<CampaignMemoryTransitionClass, readonly string[]> = {
  event: ["key", "participantEntityIds", "locationEntityId", "linkedTransitionIds"],
  movement: ["entityId", "locationEntityId", "presence"],
  "item-transfer": ["giverEntityId", "receiverEntityId", "itemEntityId", "quantity"],
  relationship: ["sourceEntityId", "targetEntityId", "type", "inverseLabel", "status"],
  quest: ["questEntityId", "status", "outcome"],
  knowledge: ["holderEntityId", "factId", "claim", "epistemicState", "confidence"],
};
/** Quest state machine; anything else is consequential ambiguity and stays pending. */
const QUEST_NEXT: Record<CampaignMemoryQuestStatus | "none", readonly CampaignMemoryQuestStatus[]> = {
  none: ["proposed", "accepted", "active"],
  proposed: ["accepted", "active", "declined", "cancelled", "unresolved"],
  accepted: ["active", "completed", "cancelled", "unresolved"],
  active: ["completed", "cancelled", "unresolved"],
  completed: [],
  declined: [],
  cancelled: [],
  unresolved: [...QUEST_STATUSES],
};
const idKey: Record<CampaignMemoryRecordType, string> = {
  entity: "entityId",
  fact: "factId",
  knowledge: "knowledgeId",
  event: "eventId",
  "current-state": "stateId",
  relationship: "relationshipId",
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
const shortId = (prefix: string, parts: unknown[]) => `${prefix}_${hash(parts).slice(0, 32)}`;
const newer = (left: string, right: string) => (compareCampaignMemoryMessageOrder(left, right) >= 0 ? left : right);
const stringList = (v: unknown, label: string) => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim()))
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", `${label} must be a list of non-empty strings`);
};
const validEvidence = (v: unknown) =>
  Array.isArray(v) &&
  v.every(
    (e) =>
      isRecord(e) &&
      typeof e.messageId === "string" &&
      typeof e.quote === "string" &&
      !!e.messageId.trim() &&
      !!e.quote.trim(),
  );

export function validateCampaignMemoryTransition(raw: unknown): asserts raw is CampaignMemoryTransitionCommand {
  if (!isRecord(raw)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Transition command must be an object");
  const c = raw as Record<string, unknown>;
  if (!CLASSES.includes(c.class as CampaignMemoryTransitionClass))
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "class is invalid");
  const allowed = [...BASE_KEYS, ...CLASS_KEYS[c.class as CampaignMemoryTransitionClass]];
  for (const key of Object.keys(c))
    if (!allowed.includes(key)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", `command.${key} is forbidden`);
  nonblank(c.chatId, "chatId");
  nonblank(c.reason, "reason");
  if (!ACTORS.includes(c.actor as CampaignMemoryActor)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "actor is invalid");
  if (!BASES.includes(c.basis as CampaignMemoryTransitionBasis))
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "basis is invalid");
  const source = c.source;
  if (!isRecord(source)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "source is required");
  nonblank(source.messageId, "source.messageId");
  if (
    source.sourceHash !== undefined &&
    (typeof source.sourceHash !== "string" || !/^[a-f0-9]{64}$/iu.test(source.sourceHash))
  )
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "source.sourceHash is invalid");
  if (!validEvidence(c.evidence) || (c.evidence as unknown[]).length === 0)
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "evidence is required for every transition");
  if (c.ambiguity !== undefined) stringList(c.ambiguity, "ambiguity");
  if (
    c.expectedRevisions !== undefined &&
    (!isRecord(c.expectedRevisions) ||
      Object.values(c.expectedRevisions).some((r) => !Number.isSafeInteger(r) || (r as number) < 1))
  )
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "expectedRevisions is invalid");
  optionalString(c.campaignTime, "campaignTime");
  switch (c.class) {
    case "event":
      nonblank(c.key, "key");
      stringList(c.participantEntityIds, "participantEntityIds");
      optionalString(c.locationEntityId, "locationEntityId");
      if (c.linkedTransitionIds !== undefined) stringList(c.linkedTransitionIds, "linkedTransitionIds");
      break;
    case "movement":
      nonblank(c.entityId, "entityId");
      nonblank(c.locationEntityId, "locationEntityId");
      if (c.presence !== undefined && c.presence !== "present" && c.presence !== "absent")
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "presence is invalid");
      break;
    case "item-transfer":
      optionalString(c.giverEntityId, "giverEntityId");
      optionalString(c.receiverEntityId, "receiverEntityId");
      nonblank(c.itemEntityId, "itemEntityId");
      if (!c.giverEntityId && !c.receiverEntityId)
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "item transfer needs a giver or a receiver");
      if (c.giverEntityId === c.receiverEntityId)
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "giver and receiver must differ");
      if (!Number.isSafeInteger(c.quantity) || (c.quantity as number) < 1)
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "quantity must be a positive integer");
      break;
    case "relationship":
      nonblank(c.sourceEntityId, "sourceEntityId");
      nonblank(c.targetEntityId, "targetEntityId");
      nonblank(c.type, "type");
      nonblank(c.inverseLabel, "inverseLabel");
      if (c.sourceEntityId === c.targetEntityId)
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "relationship endpoints must differ");
      if (!RELATIONSHIP_STATUSES.includes(c.status as CampaignMemoryRelationshipStatus))
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "relationship status is invalid");
      break;
    case "quest":
      nonblank(c.questEntityId, "questEntityId");
      if (!QUEST_STATUSES.includes(c.status as CampaignMemoryQuestStatus))
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "quest status is invalid");
      break;
    case "knowledge":
      nonblank(c.holderEntityId, "holderEntityId");
      optionalString(c.factId, "factId");
      if ((c.factId === undefined) === (c.claim === undefined))
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "knowledge needs exactly one of factId or claim");
      if (c.claim !== undefined) {
        const claim = c.claim;
        if (!isRecord(claim) || !("value" in claim)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "claim is invalid");
        nonblank(claim.subjectEntityId, "claim.subjectEntityId");
        nonblank(claim.predicate, "claim.predicate");
      }
      if (!EPISTEMIC_STATES.includes(c.epistemicState as CampaignMemoryEpistemicState))
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "epistemicState is invalid");
      if (c.confidence !== undefined && !["low", "medium", "high"].includes(c.confidence as string))
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "confidence is invalid");
      if (
        (c.basis === "rumor" && c.epistemicState !== "rumor") ||
        (c.basis === "speculation" && c.epistemicState === "knows")
      )
        fail(
          "CAMPAIGN_MEMORY_INVALID_VALUE",
          "rumor and speculation are attributed claims; they cannot be recorded as known",
        );
      break;
  }
}

function naturalKey(command: CampaignMemoryTransitionCommand): string {
  switch (command.class) {
    case "event":
      return `event:${command.key}`;
    case "movement":
      return `movement:${command.entityId}`;
    case "item-transfer":
      return `item:${command.giverEntityId ?? ""}>${command.receiverEntityId ?? ""}:${command.itemEntityId}`;
    case "relationship":
      return `relationship:${command.sourceEntityId}>${command.targetEntityId}:${command.type}`;
    case "quest":
      return `quest:${command.questEntityId}`;
    case "knowledge":
      return `knowledge:${command.holderEntityId}:${command.factId ? `fact:${command.factId}` : `claim:${command.claim!.subjectEntityId}:${command.claim!.predicate}`}`;
  }
}
/** Deterministic transition ID from (chatId, class, source message + swipe hash, natural key). */
export function campaignMemoryTransitionId(command: CampaignMemoryTransitionCommand, sourceHash: string): string {
  return shortId("cmt", [command.chatId, command.class, command.source.messageId, sourceHash, naturalKey(command)]);
}

type Storage = ReturnType<typeof createCampaignMemoryStorage>;
interface Ctx {
  tx: DB;
  command: CampaignMemoryTransitionCommand;
  transitionId: string;
  order: string;
  sourceHash: string;
  storage: Storage;
  operations: CampaignMemoryTransitionOperation[];
  reasons: string[];
  pending: string[];
}
const scopeOf = (ctx: Ctx) => ({ chatId: ctx.command.chatId });
const provenanceOf = (ctx: Ctx): CampaignMemorySourceProvenance => ({
  source: "campaign-memory-transitions",
  sourceRevision: ctx.sourceHash,
  actor: ctx.command.actor,
});
async function readRecord(storage: Storage, chatId: string, recordType: CampaignMemoryRecordType, recordId: string) {
  const scope = { chatId };
  switch (recordType) {
    case "entity":
      return storage.getEntity(scope, recordId);
    case "fact":
      return storage.getFact(scope, recordId);
    case "knowledge":
      return storage.getKnowledge(scope, recordId);
    case "event":
      return storage.getEvent(scope, recordId);
    case "current-state":
      return storage.getCurrentState(scope, recordId);
    case "relationship":
      return storage.getRelationship(scope, recordId);
  }
}
async function run(ctx: Ctx, command: CampaignMemoryMutationCommand, before?: unknown) {
  const after = await applyCampaignMemoryMutation(ctx.tx, command);
  const recordId = (after as unknown as Record<string, unknown>)[idKey[command.recordType]] as string;
  ctx.operations.push({
    operationId: command.operationId,
    recordType: command.recordType,
    recordId,
    action: command.action,
    ...(before === undefined ? {} : { before }),
    after,
  });
  return after;
}
const base = (ctx: Ctx, suffix: string) => ({
  chatId: ctx.command.chatId,
  operationId: `${ctx.transitionId}/${suffix}`,
  actor: ctx.command.actor,
  reason: ctx.command.reason,
  evidence: ctx.command.evidence,
});
async function entity(ctx: Ctx, entityId: string, kinds?: readonly string[]) {
  const row = await ctx.storage.getEntity(scopeOf(ctx), entityId);
  if (!row) fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `Entity ${entityId} is not in chat scope ${ctx.command.chatId}`);
  if (kinds && !kinds.includes(row!.kind))
    fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `Entity ${entityId} must be one of ${kinds.join(", ")}`);
  return row!;
}
function expectRevision(ctx: Ctx, recordId: string, revision: number) {
  const expected = ctx.command.expectedRevisions?.[recordId];
  if (expected !== undefined && expected !== revision)
    fail("CAMPAIGN_MEMORY_CAS_MISMATCH", `Record ${recordId} is at revision ${revision}, expected ${expected}`);
}
async function createEvent(
  ctx: Ctx,
  participantEntityIds: string[],
  locationEntityId?: string,
  linked: string[] = [],
): Promise<CampaignMemoryEvent> {
  const command = ctx.command;
  return (await run(ctx, {
    ...base(ctx, "event"),
    recordType: "event",
    action: "create",
    input: {
      eventId: shortId("cmev", [ctx.transitionId]),
      chatId: command.chatId,
      occurrenceOrder: ctx.order,
      ...(command.campaignTime ? { campaignTime: command.campaignTime } : {}),
      participantEntityIds: [...new Set(participantEntityIds)],
      ...(locationEntityId ? { locationEntityId } : {}),
      sourceRevision: ctx.sourceHash,
      transitions: [...new Set([ctx.transitionId, ...linked])],
      evidence: command.evidence,
      provenance: provenanceOf(ctx),
    },
  })) as CampaignMemoryEvent;
}
async function findState(ctx: Ctx, entityId: string, property: string) {
  return (await ctx.storage.listCurrentState(scopeOf(ctx))).find(
    (s) => s.entityId === entityId && s.property === property,
  );
}
/** Write one current-state row. With `monotonic`, an older capture order never overwrites a newer one (returns `stale`). */
async function setState(
  ctx: Ctx,
  entityId: string,
  property: string,
  value: CampaignMemoryJson,
  sourceEventId: string,
  monotonic: boolean,
): Promise<"applied" | "stale"> {
  const existing = await findState(ctx, entityId, property);
  const suffix = `state/${entityId}/${property}`;
  if (!existing) {
    await run(ctx, {
      ...base(ctx, suffix),
      recordType: "current-state",
      action: "create",
      input: {
        stateId: shortId("cmst", [ctx.command.chatId, entityId, property]),
        chatId: ctx.command.chatId,
        entityId,
        property,
        value,
        sourceEventId,
        validAtOrder: ctx.order,
        protected: false,
        provenance: provenanceOf(ctx),
        manualLock: false,
      },
    });
    return "applied";
  }
  expectRevision(ctx, existing.stateId, existing.revision);
  if (monotonic && compareCampaignMemoryMessageOrder(existing.validAtOrder, ctx.order) > 0) {
    ctx.reasons.push(`${entityId}.${property} already reflects the newer order ${existing.validAtOrder}`);
    return "stale";
  }
  // Storage refuses an older order or older source event; a late delta keeps the newer anchor.
  const late = compareCampaignMemoryMessageOrder(existing.validAtOrder, ctx.order) > 0;
  await run(
    ctx,
    {
      ...base(ctx, suffix),
      recordType: "current-state",
      action: "update",
      recordId: existing.stateId,
      expectedRevision: existing.revision,
      patch: {
        value,
        sourceEventId: late ? existing.sourceEventId : sourceEventId,
        validAtOrder: newer(existing.validAtOrder, ctx.order),
        provenance: provenanceOf(ctx),
      },
    },
    existing,
  );
  return "applied";
}
const holdingProperty = (itemEntityId: string) => `holding:${itemEntityId}`;
const quantityOf = (state: CampaignMemoryCurrentState | undefined) =>
  state && typeof state.value === "number" && Number.isSafeInteger(state.value) ? state.value : null;
async function findRelationship(ctx: Ctx, c: Extract<CampaignMemoryTransitionCommand, { class: "relationship" }>) {
  return (await ctx.storage.listRelationships(scopeOf(ctx))).find(
    (r) => r.sourceEntityId === c.sourceEntityId && r.targetEntityId === c.targetEntityId && r.type === c.type,
  );
}
async function findKnowledge(ctx: Ctx, c: Extract<CampaignMemoryTransitionCommand, { class: "knowledge" }>) {
  return (await ctx.storage.listKnowledge(scopeOf(ctx))).find(
    (k) =>
      k.holderEntityId === c.holderEntityId &&
      (c.factId
        ? k.factId === c.factId
        : !!k.attributedClaim &&
          k.attributedClaim.subjectEntityId === c.claim!.subjectEntityId &&
          k.attributedClaim.predicate === c.claim!.predicate),
  );
}

/** Phase 1: reads only. Fills `ctx.pending` with every reason the transition must not apply. */
async function check(ctx: Ctx) {
  const c = ctx.command;
  const pending = (reason: string) => {
    ctx.pending.push(reason);
  };
  for (const reason of c.ambiguity ?? []) pending(reason);
  const worldTruth = c.class !== "knowledge";
  if (worldTruth && (c.basis === "rumor" || c.basis === "speculation"))
    pending(`${c.basis} is recorded as an attributed claim (knowledge), never as world truth`);
  const offered = c.basis === "offer" || c.basis === "promise";
  switch (c.class) {
    case "event":
      for (const id of c.participantEntityIds) await entity(ctx, id);
      if (c.locationEntityId) await entity(ctx, c.locationEntityId, ["location"]);
      break;
    case "movement":
      await entity(ctx, c.entityId);
      await entity(ctx, c.locationEntityId, ["location"]);
      if (offered) pending(`an ${c.basis} to move is not a movement; it needs separate fulfillment`);
      break;
    case "item-transfer": {
      await entity(ctx, c.itemEntityId, ["item"]);
      if (c.giverEntityId) await entity(ctx, c.giverEntityId);
      if (c.receiverEntityId) await entity(ctx, c.receiverEntityId);
      if (offered) pending(`an ${c.basis} of an item is not a transfer; it needs separate fulfillment`);
      if (c.giverEntityId) {
        const held = quantityOf(await findState(ctx, c.giverEntityId, holdingProperty(c.itemEntityId)));
        if (held === null)
          pending(`giver ${c.giverEntityId} has no known holding of ${c.itemEntityId}; register the acquisition first`);
        else if (held < c.quantity)
          pending(`giver ${c.giverEntityId} holds ${held} of ${c.itemEntityId}, fewer than ${c.quantity}`);
      }
      break;
    }
    case "relationship":
      await entity(ctx, c.sourceEntityId);
      await entity(ctx, c.targetEntityId);
      if (offered && c.status !== "proposed")
        pending(`an ${c.basis} only proposes a ${c.type} relationship; ${c.status} needs separate fulfillment`);
      break;
    case "quest": {
      await entity(ctx, c.questEntityId, ["quest"]);
      if (offered && c.status !== "proposed")
        pending(`an ${c.basis} only proposes a quest; ${c.status} needs separate fulfillment`);
      const current = await findState(ctx, c.questEntityId, "quest.status");
      const from =
        current &&
        typeof current.value === "string" &&
        QUEST_STATUSES.includes(current.value as CampaignMemoryQuestStatus)
          ? (current.value as CampaignMemoryQuestStatus)
          : "none";
      if (from !== c.status && !QUEST_NEXT[from].includes(c.status))
        pending(`quest ${c.questEntityId} cannot move from ${from} to ${c.status} without a decision`);
      break;
    }
    case "knowledge":
      await entity(ctx, c.holderEntityId, ["character", "persona"]);
      if (c.claim) await entity(ctx, c.claim.subjectEntityId);
      break;
  }
}

/** Phase 2: writes, each through the audited mutation layer. Returns the transition status. */
async function apply(ctx: Ctx): Promise<CampaignMemoryTransitionStatus> {
  const c = ctx.command;
  switch (c.class) {
    case "event":
      await createEvent(ctx, c.participantEntityIds, c.locationEntityId, c.linkedTransitionIds);
      return "applied";
    case "movement": {
      const event = await createEvent(ctx, [c.entityId], c.locationEntityId);
      const status = await setState(ctx, c.entityId, "location", c.locationEntityId, event.eventId, true);
      if (c.presence) await setState(ctx, c.entityId, "presence", c.presence, event.eventId, true);
      return status;
    }
    case "item-transfer": {
      const event = await createEvent(
        ctx,
        [c.giverEntityId, c.receiverEntityId, c.itemEntityId].filter((x): x is string => !!x),
      );
      const property = holdingProperty(c.itemEntityId);
      if (c.giverEntityId)
        await setState(
          ctx,
          c.giverEntityId,
          property,
          (quantityOf(await findState(ctx, c.giverEntityId, property)) ?? 0) - c.quantity,
          event.eventId,
          false,
        );
      if (c.receiverEntityId)
        await setState(
          ctx,
          c.receiverEntityId,
          property,
          (quantityOf(await findState(ctx, c.receiverEntityId, property)) ?? 0) + c.quantity,
          event.eventId,
          false,
        );
      return "applied";
    }
    case "relationship": {
      const existing = await findRelationship(ctx, c);
      const orders = {
        ...(c.status === "active" || c.status === "proposed" ? { effectiveFrom: ctx.order } : {}),
        ...(c.status === "ended" ? { effectiveTo: ctx.order } : {}),
      };
      if (!existing) {
        await run(ctx, {
          ...base(ctx, "relationship"),
          recordType: "relationship",
          action: "create",
          input: {
            relationshipId: shortId("cmrl", [c.chatId, c.sourceEntityId, c.targetEntityId, c.type]),
            chatId: c.chatId,
            sourceEntityId: c.sourceEntityId,
            targetEntityId: c.targetEntityId,
            type: c.type,
            inverseLabel: c.inverseLabel,
            status: c.status,
            ...orders,
            evidence: c.evidence,
            provenance: provenanceOf(ctx),
            manualLock: false,
          },
        });
        return "applied";
      }
      expectRevision(ctx, existing.relationshipId, existing.revision);
      const effective = [existing.effectiveFrom, existing.effectiveTo]
        .filter((x): x is string => !!x)
        .sort(compareCampaignMemoryMessageOrder)
        .at(-1);
      if (effective && compareCampaignMemoryMessageOrder(effective, ctx.order) > 0) {
        ctx.reasons.push(`relationship already reflects the newer order ${effective}`);
        return "stale";
      }
      if (existing.status === c.status) return "applied";
      await run(
        ctx,
        {
          ...base(ctx, "relationship"),
          recordType: "relationship",
          action: "update",
          recordId: existing.relationshipId,
          expectedRevision: existing.revision,
          patch: {
            status: c.status,
            inverseLabel: c.inverseLabel,
            ...orders,
            evidence: c.evidence,
            provenance: provenanceOf(ctx),
          },
        },
        existing,
      );
      return "applied";
    }
    case "quest": {
      const event = await createEvent(ctx, [c.questEntityId]);
      const status = await setState(ctx, c.questEntityId, "quest.status", c.status, event.eventId, true);
      if (c.outcome !== undefined && status === "applied")
        await setState(ctx, c.questEntityId, "quest.outcome", c.outcome, event.eventId, true);
      return status;
    }
    case "knowledge": {
      const existing = await findKnowledge(ctx, c);
      const fields = {
        epistemicState: c.epistemicState,
        learnedFrom: c.evidence,
        learnedAtOrder: ctx.order,
        ...(c.confidence ? { confidence: c.confidence } : {}),
        provenance: provenanceOf(ctx),
      };
      if (!existing) {
        await run(ctx, {
          ...base(ctx, "knowledge"),
          recordType: "knowledge",
          action: "create",
          input: {
            knowledgeId: shortId("cmkn", [c.chatId, naturalKey(c)]),
            chatId: c.chatId,
            holderEntityId: c.holderEntityId,
            ...(c.factId ? { factId: c.factId } : { attributedClaim: c.claim! }),
            ...fields,
            manualLock: false,
          },
        });
        return "applied";
      }
      expectRevision(ctx, existing.knowledgeId, existing.revision);
      if (existing.learnedAtOrder && compareCampaignMemoryMessageOrder(existing.learnedAtOrder, ctx.order) > 0) {
        ctx.reasons.push(`knowledge already reflects the newer order ${existing.learnedAtOrder}`);
        return "stale";
      }
      await run(
        ctx,
        {
          ...base(ctx, "knowledge"),
          recordType: "knowledge",
          action: "update",
          recordId: existing.knowledgeId,
          expectedRevision: existing.revision,
          patch: fields,
        },
        existing,
      );
      return "applied";
    }
  }
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
async function insertJournal(
  tx: DB,
  row: {
    chatId: string;
    operationId: string;
    recordId: string;
    actor: CampaignMemoryActor;
    before: unknown;
    after: unknown;
    reason: string;
    evidence: CampaignMemoryEvidence[];
    compensationOperationId?: string;
    payloadHash: string;
  },
) {
  await tx.insert(campaignMemoryMutationJournal).values({
    journalId: randomUUID(),
    chatId: row.chatId,
    operationId: row.operationId,
    recordType: "transition",
    recordId: row.recordId,
    actor: row.actor,
    expectedRevision: null,
    before: row.before === undefined ? null : JSON.stringify(row.before),
    after: JSON.stringify(row.after),
    reason: row.reason,
    evidence: JSON.stringify(row.evidence),
    compensationOperationId: row.compensationOperationId ?? null,
    payloadHash: row.payloadHash,
    createdAt: new Date().toISOString(),
  });
}
function replay<T>(row: typeof campaignMemoryMutationJournal.$inferSelect, requestHash: string): T {
  if (row.payloadHash !== requestHash)
    fail("CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT", `Transition ${row.operationId} was already used with another payload`);
  if (row.after == null) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Committed transition has no result");
  return { ...(JSON.parse(row.after!) as T), replayed: true };
}

export async function applyCampaignMemoryTransition(
  db: DB,
  command: CampaignMemoryTransitionCommand,
): Promise<CampaignMemoryTransitionResult> {
  validateCampaignMemoryTransition(command);
  return db.transaction(
    async (tx) => {
      const sources = await readCampaignMemorySources(tx, {
        chatId: command.chatId,
        messageIds: [command.source.messageId],
      });
      const source = sources.get(command.source.messageId);
      if (!source)
        fail(
          "CAMPAIGN_MEMORY_INVALID_REFERENCE",
          `Source message ${command.source.messageId} is outside chat scope ${command.chatId}`,
        );
      if (command.source.sourceHash && command.source.sourceHash !== source!.sourceHash)
        fail(
          "CAMPAIGN_MEMORY_INVALID_REFERENCE",
          `Source message ${command.source.messageId} changed; derived transitions must be re-extracted`,
        );
      if (!source!.captureOrder)
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", `Source message ${command.source.messageId} has no capture order`);
      const sourceHash = source!.sourceHash;
      const transitionId = campaignMemoryTransitionId(command, sourceHash);
      const requestHash = hash({ ...command, source: { messageId: command.source.messageId, sourceHash } });
      const committed = await journalRow(tx, command.chatId, transitionId);
      if (committed) return replay<CampaignMemoryTransitionResult>(committed, requestHash);
      const ctx: Ctx = {
        tx,
        command,
        transitionId,
        order: source!.captureOrder!,
        sourceHash,
        storage: createCampaignMemoryStorage(tx),
        operations: [],
        reasons: [],
        pending: [],
      };
      await check(ctx);
      const result: CampaignMemoryTransitionResult = {
        transitionId,
        chatId: command.chatId,
        class: command.class,
        status: "pending",
        order: ctx.order,
        sourceHash,
        reasons: ctx.pending,
        operations: [],
        replayed: false,
      };
      if (ctx.pending.length) {
        const held = await journalRow(tx, command.chatId, `${transitionId}/pending`);
        if (!held)
          await insertJournal(tx, {
            chatId: command.chatId,
            operationId: `${transitionId}/pending`,
            recordId: transitionId,
            actor: command.actor,
            before: undefined,
            after: result,
            reason: command.reason,
            evidence: command.evidence,
            payloadHash: requestHash,
          });
        return { ...result, replayed: !!held };
      }
      result.status = await apply(ctx);
      result.reasons = ctx.reasons;
      result.operations = ctx.operations;
      await insertJournal(tx, {
        chatId: command.chatId,
        operationId: transitionId,
        recordId: transitionId,
        actor: command.actor,
        before: ctx.operations.map((op) => op.before ?? null),
        after: result,
        reason: command.reason,
        evidence: command.evidence,
        payloadHash: requestHash,
      });
      return result;
    },
    { durable: true },
  );
}

const NEUTRAL: Partial<Record<CampaignMemoryRecordType, Record<string, unknown>>> = {
  "current-state": { value: null },
  relationship: { status: "held" },
  knowledge: { epistemicState: "unknown" },
};

/**
 * Roll back one transition. Updates are restored from their journaled `before`
 * (refused when the record moved on: revision protection); records this
 * transition created are neutralised because storage has no delete. Records
 * touched by unrelated later transitions are never visited.
 */
export async function compensateCampaignMemoryTransition(
  db: DB,
  command: CampaignMemoryTransitionCompensationCommand,
): Promise<CampaignMemoryTransitionCompensationResult> {
  if (!isRecord(command)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Compensation command must be an object");
  nonblank(command.chatId, "chatId");
  nonblank(command.transitionId, "transitionId");
  nonblank(command.reason, "reason");
  optionalString(command.operationId, "operationId");
  if (!ACTORS.includes(command.actor)) fail("CAMPAIGN_MEMORY_INVALID_VALUE", "actor is invalid");
  if (command.evidence !== undefined && !validEvidence(command.evidence))
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "evidence is invalid");
  const operationId = command.operationId ?? `${command.transitionId}/compensate`;
  const evidence = command.evidence ?? [];
  const requestHash = hash({
    chatId: command.chatId,
    transitionId: command.transitionId,
    operationId,
    actor: command.actor,
    reason: command.reason,
    evidence,
    action: "compensate-transition",
  });
  return db.transaction(
    async (tx) => {
      const existing = await journalRow(tx, command.chatId, operationId);
      if (existing) return replay<CampaignMemoryTransitionCompensationResult>(existing, requestHash);
      const parent = await journalRow(tx, command.chatId, command.transitionId);
      if (!parent || parent.recordType !== "transition" || parent.after == null)
        fail("CAMPAIGN_MEMORY_NOT_FOUND", `Transition ${command.transitionId} not found`);
      const original = JSON.parse(parent!.after!) as CampaignMemoryTransitionResult;
      if (!original.operations.length)
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", `Transition ${command.transitionId} applied nothing to roll back`);
      const storage = createCampaignMemoryStorage(tx);
      const result: CampaignMemoryTransitionCompensationResult = {
        transitionId: command.transitionId,
        operationId,
        operations: [],
        skippedEventIds: [],
        replayed: false,
      };
      for (const [index, op] of [...original.operations].reverse().entries()) {
        if (op.recordType === "event") {
          result.skippedEventIds.push(op.recordId);
          continue;
        }
        const childId = `${operationId}/${index}`;
        const before = await readRecord(storage, command.chatId, op.recordType, op.recordId);
        if (!before) fail("CAMPAIGN_MEMORY_NOT_FOUND", `Record ${op.recordId} not found`);
        if (op.action === "update" && op.recordType === "current-state") {
          // Storage never lets validAtOrder regress: restore the value and provenance, keep the newest order anchor.
          const previous = op.before as CampaignMemoryCurrentState;
          if ((op.after as { revision: number }).revision !== (before as { revision: number }).revision)
            fail(
              "CAMPAIGN_MEMORY_CAS_MISMATCH",
              `Record ${op.recordId} changed since transition ${command.transitionId}`,
            );
          const after = await applyCampaignMemoryMutation(tx, {
            chatId: command.chatId,
            operationId: childId,
            actor: command.actor,
            reason: command.reason,
            evidence,
            recordType: "current-state",
            action: "update",
            recordId: op.recordId,
            expectedRevision: (before as { revision: number }).revision,
            patch: { value: previous.value, provenance: previous.provenance },
          });
          result.operations.push({
            operationId: childId,
            recordType: op.recordType,
            recordId: op.recordId,
            action: "update",
            before,
            after,
          });
          continue;
        }
        if (op.action === "update") {
          const after = await compensateCampaignMemoryMutation(tx, {
            chatId: command.chatId,
            operationId: childId,
            originalOperationId: op.operationId,
            actor: command.actor,
            reason: command.reason,
            evidence,
          });
          result.operations.push({
            operationId: childId,
            recordType: op.recordType,
            recordId: op.recordId,
            action: "update",
            before,
            after,
          });
          continue;
        }
        const patch = NEUTRAL[op.recordType];
        if (!patch) fail("CAMPAIGN_MEMORY_INVALID_VALUE", `Created ${op.recordType} records cannot be neutralised`);
        const created = op.after as { revision?: number };
        const current = before as { revision: number };
        if (created.revision !== current.revision)
          fail(
            "CAMPAIGN_MEMORY_CAS_MISMATCH",
            `Record ${op.recordId} changed since transition ${command.transitionId}`,
          );
        const after = await applyCampaignMemoryMutation(tx, {
          chatId: command.chatId,
          operationId: childId,
          actor: command.actor,
          reason: command.reason,
          evidence,
          recordType: op.recordType,
          action: "update",
          recordId: op.recordId,
          expectedRevision: current.revision,
          patch,
        } as CampaignMemoryMutationCommand);
        result.operations.push({
          operationId: childId,
          recordType: op.recordType,
          recordId: op.recordId,
          action: "update",
          before,
          after,
        });
      }
      await insertJournal(tx, {
        chatId: command.chatId,
        operationId,
        recordId: command.transitionId,
        actor: command.actor,
        before: original,
        after: result,
        reason: command.reason,
        evidence,
        compensationOperationId: command.transitionId,
        payloadHash: requestHash,
      });
      return result;
    },
    { durable: true },
  );
}
