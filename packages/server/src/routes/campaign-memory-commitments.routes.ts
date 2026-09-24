import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { CampaignMemoryEvidence, CampaignMemoryFact, CampaignMemoryJson } from "@marinara-engine/shared";
import {
  CampaignMemoryStorageError,
  createCampaignMemoryStorage,
} from "../services/storage/campaign-memory.storage.js";
import { logger } from "../lib/logger.js";
import {
  applyCampaignMemoryMutation,
  CampaignMemoryMutationError,
  findCampaignMemoryOperation,
} from "../services/game/campaign-memory-mutations.js";
import { readCampaignMemorySources } from "../services/game/campaign-memory-sources.js";
import { compareCampaignMemoryMessageOrder } from "../services/game/campaign-memory-order.js";
import {
  CAMPAIGN_MEMORY_COMMITMENT_PREDICATE,
  COMMITMENT_STATES,
  canTransitionCampaignMemoryCommitment,
  commitmentInvolves,
  projectCampaignMemoryCommitments,
  readCampaignMemoryCommitmentValue,
  validateCampaignMemoryCommitmentValue,
  type CampaignMemoryCommitmentItem,
  type CampaignMemoryCommitmentValue,
} from "../services/game/campaign-memory-commitments.js";

const MAX_BODY_BYTES = 256 * 1024;
const SOURCE = "campaign-memory-commitments";
const evidenceSchema = z
  .object({
    messageId: z.string().trim().min(1).max(200),
    quote: z.string().trim().min(1).max(10_000),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .strict();
const listQuerySchema = z.object({
  entityId: z.string().trim().min(1).max(200).optional(),
  state: z.enum(COMMITMENT_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(300).optional(),
});
const createSchema = z
  .object({
    operationId: z.string().trim().min(1).max(128).optional(),
    value: z.unknown(),
    /** Defaults to the first participant. */
    subjectEntityId: z.string().trim().min(1).max(300).optional(),
    evidence: z.array(evidenceSchema).max(100).default([]),
    /** Only `user` may create a commitment without evidence; the write is always user-actored. */
    author: z.literal("user").optional(),
    reason: z.string().trim().min(1).max(2_000).default("Record a commitment"),
  })
  .strict();
const transitionSchema = z
  .object({
    operationId: z.string().trim().min(1).max(128).optional(),
    state: z.enum(COMMITMENT_STATES),
    conditions: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
    deadline: z.string().trim().max(500).nullable().optional(),
    notes: z.string().max(10_000).optional(),
    evidence: z.array(evidenceSchema).max(100).default([]),
    expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    reason: z.string().trim().min(1).max(2_000).default("Commitment state change"),
  })
  .strict();

function errorResponse(reply: FastifyReply, error: unknown) {
  const known = error instanceof CampaignMemoryMutationError || error instanceof CampaignMemoryStorageError;
  const code = known ? error.code : "CAMPAIGN_MEMORY_COMMITMENT_FAILED";
  const message = error instanceof Error ? error.message : "Campaign memory commitment request failed";
  const status = !known
    ? 500
    : code === "CAMPAIGN_MEMORY_NOT_FOUND" ||
        code === "CAMPAIGN_MEMORY_CHAT_NOT_FOUND" ||
        code === "CAMPAIGN_MEMORY_INVALID_REFERENCE"
      ? 404
      : code === "CAMPAIGN_MEMORY_CAS_MISMATCH" ||
          code === "CAMPAIGN_MEMORY_LOCKED" ||
          code === "CAMPAIGN_MEMORY_CONFLICT" ||
          code === "CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT"
        ? 409
        : 400;
  if (!known) logger.error({ err: error }, "Campaign memory commitment request failed");
  return reply.status(status).send({ error: { code, message } });
}
const invalid = (reply: FastifyReply, message: string, details?: unknown) =>
  reply
    .status(400)
    .send({ error: { code: "CAMPAIGN_MEMORY_INVALID_VALUE", message, ...(details === undefined ? {} : { details }) } });

/** Capture order of the newest cited message; null when there is no evidence. */
async function sourceOrder(app: FastifyInstance, chatId: string, evidence: readonly CampaignMemoryEvidence[]) {
  if (!evidence.length) return undefined;
  const sources = await readCampaignMemorySources(app.db, { chatId, messageIds: evidence.map((e) => e.messageId) });
  let newest: string | undefined;
  for (const source of sources.values())
    if (source.captureOrder && (!newest || compareCampaignMemoryMessageOrder(source.captureOrder, newest) > 0))
      newest = source.captureOrder;
  return newest;
}
/** The value is plain JSON by construction; the fact store types it as CampaignMemoryJson. */
const asJson = (value: CampaignMemoryCommitmentValue) => value as unknown as CampaignMemoryJson;

/** One listed commitment: the projected chain heads of every copy of the same promise, merged. */
export type CampaignMemoryGroupedCommitmentItem = CampaignMemoryCommitmentItem & {
  /** Head fact ids of every merged copy; `commitmentId` is the representative among them. */
  memberCommitmentIds: string[];
};

/**
 * Continuity publishes one fact per resolved subject (plus a lore-entity fallback), so a single promise arrives as
 * several facts that share `value.receiptId` + `value.recordId`. Those copies are one commitment: the key is read
 * from the ROOT fact of each chain, so a user transition (a `commitment` fact without those keys) stays with the
 * copies it grew from. Facts without both keys group alone under their own head fact id.
 *
 * The representative (`commitmentId`, `revision`, `state`, `transitions`) is the copy whose head fact was written
 * last (createdAt, then the projection's newest-first order), which is the newest status: a user transition or a
 * continuity republication is always written after the copies it updates. Mutation endpoints act on that
 * representative head fact id; the other copies are left as they are and stay merged under it.
 */
function groupCommitments(
  items: readonly CampaignMemoryCommitmentItem[],
  facts: ReadonlyMap<string, CampaignMemoryFact>,
  aliasOf: (entityId: string) => string,
): CampaignMemoryGroupedCommitmentItem[] {
  const keyOf = (item: CampaignMemoryCommitmentItem) => {
    const root = facts.get(item.transitions[0]?.factId ?? item.commitmentId);
    const value = root?.value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const { receiptId, recordId } = value as Record<string, unknown>;
      if (typeof receiptId === "string" && receiptId && typeof recordId === "string" && recordId)
        return `record:${receiptId}\u0000${recordId}`;
    }
    return `fact:${item.commitmentId}`;
  };
  const groups = new Map<string, CampaignMemoryCommitmentItem[]>();
  // `items` is newest-first; group order follows each group's newest member.
  for (const item of items) {
    const key = keyOf(item);
    const members = groups.get(key);
    if (members) members.push(item);
    else groups.set(key, [item]);
  }
  const createdAt = (item: CampaignMemoryCommitmentItem) => facts.get(item.commitmentId)?.createdAt ?? "";
  const result: CampaignMemoryGroupedCommitmentItem[] = [];
  for (const members of groups.values()) {
    const representative = members.reduce((best, item) => (createdAt(item) > createdAt(best) ? item : best));
    const participants: CampaignMemoryCommitmentItem["participants"] = [];
    const seenParticipants = new Set<string>();
    const evidence: CampaignMemoryCommitmentItem["evidence"] = [];
    const seenEvidence = new Set<string>();
    for (const member of [representative, ...members.filter((item) => item !== representative)]) {
      const listed = member.participants.some((p) => p.entityId === member.subjectEntityId);
      for (const participant of listed
        ? member.participants
        : [
            ...member.participants,
            // A copy's subject is always one of the people the promise involves, even when its value omits it.
            { entityId: member.subjectEntityId, role: "subject", alias: aliasOf(member.subjectEntityId) },
          ]) {
        if (seenParticipants.has(participant.entityId)) continue;
        seenParticipants.add(participant.entityId);
        participants.push({ ...participant });
      }
      for (const item of member.evidence) {
        const key = `${item.messageId}\u0000${item.quote}`;
        if (seenEvidence.has(key)) continue;
        seenEvidence.add(key);
        evidence.push(item);
      }
    }
    const openOrders = members
      .map((member) => member.openSince)
      .filter((order): order is string => typeof order === "string")
      .sort(compareCampaignMemoryMessageOrder);
    result.push({
      ...representative,
      participants,
      evidence,
      historical: members.some((member) => member.historical),
      openSince: representative.openSince === null ? null : (openOrders[0] ?? representative.openSince),
      memberCommitmentIds: members.map((member) => member.commitmentId),
    });
  }
  return result;
}

export async function campaignMemoryCommitmentsRoutes(app: FastifyInstance) {
  const storage = createCampaignMemoryStorage(app.db);
  const options = { bodyLimit: MAX_BODY_BYTES };
  const project = async (chatId: string) => {
    const scope = { chatId };
    const [facts, entities] = await Promise.all([storage.listFacts(scope), storage.listEntities(scope)]);
    const aliases = new Map(
      entities.map((entity) => [entity.entityId, entity.aliases[0] || entity.summary || entity.entityId]),
    );
    return groupCommitments(
      projectCampaignMemoryCommitments(facts, entities),
      new Map(facts.map((fact) => [fact.factId, fact])),
      (entityId) => aliases.get(entityId) ?? entityId,
    );
  };
  /** The grouped commitment containing `factId` as one of its merged heads. */
  const projected = async (chatId: string, factId: string) =>
    (await project(chatId)).find((item) => item.memberCommitmentIds.includes(factId));

  app.get<{ Params: { chatId: string } }>("/:chatId/memory/commitments", async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return invalid(reply, "Invalid campaign memory commitments query", query.error.flatten());
    try {
      const { entityId, state, limit, cursor } = query.data;
      const items = (await project(request.params.chatId))
        .filter((item) => !entityId || commitmentInvolves(item, entityId))
        .filter((item) => !state || item.state === state);
      let start = 0;
      if (cursor) {
        // Cursors are representative ids; a member id (for example a cursor issued before a merge) resolves too.
        const index = items.findIndex((item) => item.memberCommitmentIds.includes(cursor));
        if (index < 0)
          return reply
            .status(400)
            .send({ error: { code: "INVALID_CURSOR", message: "Campaign memory commitments cursor is unknown" } });
        start = index + 1;
      }
      const slice = items.slice(start, start + limit);
      return {
        items: slice,
        nextCursor: start + limit < items.length ? (slice.at(-1)?.commitmentId ?? null) : null,
        /** Grouped commitments matching the filters, the same unit the pages count. */
        total: items.length,
      };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post<{ Params: { chatId: string } }>("/:chatId/memory/commitments", options, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "Invalid campaign memory commitment request", parsed.error.flatten());
    const { chatId } = request.params;
    try {
      const body = parsed.data;
      validateCampaignMemoryCommitmentValue(body.value);
      const value: CampaignMemoryCommitmentValue = body.value;
      if (!body.evidence.length && body.author !== "user")
        return invalid(reply, "Evidence is required unless the commitment is user-authored");
      const subjectEntityId = body.subjectEntityId ?? value.participants[0]?.entityId;
      if (!subjectEntityId) return invalid(reply, "A commitment needs a subject entity or at least one participant");
      const operationId = body.operationId ?? randomUUID();
      const validFromOrder = await sourceOrder(app, chatId, body.evidence);
      const fact = (await applyCampaignMemoryMutation(app.db, {
        chatId,
        operationId,
        actor: "user",
        reason: body.reason,
        evidence: body.evidence,
        recordType: "fact",
        action: "create",
        input: {
          chatId,
          subjectEntityId,
          predicate: CAMPAIGN_MEMORY_COMMITMENT_PREDICATE,
          value: asJson(value),
          conditions: [],
          status: body.evidence.length ? "verified" : "proposed",
          ...(validFromOrder ? { validFromOrder } : {}),
          sourceRevision: operationId,
          evidence: body.evidence,
          author: "user",
          provenance: { source: SOURCE, sourceRevision: operationId, actor: "user" },
          manualLock: false,
        },
      })) as CampaignMemoryFact;
      return reply.status(201).send(await projected(chatId, fact.factId));
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.post<{ Params: { chatId: string; commitmentId: string } }>(
    "/:chatId/memory/commitments/:commitmentId/transition",
    options,
    async (request, reply) => {
      const parsed = transitionSchema.safeParse(request.body);
      if (!parsed.success)
        return invalid(reply, "Invalid campaign memory commitment transition", parsed.error.flatten());
      const { chatId, commitmentId } = request.params;
      try {
        const body = parsed.data;
        const scope = { chatId };
        // A retry of a transition that already committed (the response was lost) replays its result. The
        // revision and already-transitioned checks below would otherwise report the retry as a conflict.
        if (body.operationId) {
          const done = await findCampaignMemoryOperation(app.db, chatId, `${body.operationId}/create`);
          if (done?.recordType === "fact") {
            const createdFact = await storage.getFact(scope, done.recordId);
            const replayed =
              createdFact?.supersedesFactId === commitmentId ? await projected(chatId, done.recordId) : null;
            if (replayed) return replayed;
          }
        }
        const current = await storage.getFact(scope, commitmentId);
        const read = current ? readCampaignMemoryCommitmentValue(current) : null;
        if (!current || !read)
          return reply
            .status(404)
            .send({ error: { code: "CAMPAIGN_MEMORY_NOT_FOUND", message: "Campaign memory commitment not found" } });
        if (current.revision !== body.expectedRevision)
          return reply.status(409).send({
            error: {
              code: "CAMPAIGN_MEMORY_CAS_MISMATCH",
              message: `Commitment ${commitmentId} is at revision ${current.revision}, expected ${body.expectedRevision}`,
            },
          });
        const facts = await storage.listFacts(scope);
        if (facts.some((fact) => fact.supersedesFactId === commitmentId && readCampaignMemoryCommitmentValue(fact)))
          return reply.status(409).send({
            error: {
              code: "CAMPAIGN_MEMORY_CONFLICT",
              message: `Commitment ${commitmentId} was already transitioned; reload to see the newest state`,
            },
          });
        if (!canTransitionCampaignMemoryCommitment(read.value.state, body.state))
          return reply.status(400).send({
            error: {
              code: "CAMPAIGN_MEMORY_ILLEGAL_TRANSITION",
              message: `Commitment cannot move from ${read.value.state} to ${body.state}`,
            },
          });
        const value: CampaignMemoryCommitmentValue = {
          ...read.value,
          state: body.state,
          conditions: body.conditions ?? read.value.conditions,
          deadline: body.deadline === undefined ? read.value.deadline : body.deadline || null,
          notes: body.notes ?? read.value.notes,
        };
        const operationId = body.operationId ?? randomUUID();
        const validFromOrder = (await sourceOrder(app, chatId, body.evidence)) ?? current.validFromOrder;
        // One durable transaction: the superseding fact is created and the old head is marked
        // superseded (its value is never touched) through the audited mutation layer.
        const next = (await app.db.transaction(
          async (tx) => {
            const created = await applyCampaignMemoryMutation(tx, {
              chatId,
              operationId: `${operationId}/create`,
              actor: "user",
              reason: body.reason,
              evidence: body.evidence,
              recordType: "fact",
              action: "create",
              input: {
                chatId,
                subjectEntityId: current.subjectEntityId,
                predicate: CAMPAIGN_MEMORY_COMMITMENT_PREDICATE,
                value: asJson(value),
                conditions: current.conditions,
                status: body.evidence.length ? "verified" : "proposed",
                ...(validFromOrder ? { validFromOrder } : {}),
                sourceRevision: operationId,
                evidence: body.evidence,
                author: "user",
                provenance: { source: SOURCE, sourceRevision: operationId, actor: "user" },
                manualLock: false,
                supersedesFactId: commitmentId,
              },
            });
            if (current.status !== "superseded")
              await applyCampaignMemoryMutation(tx, {
                chatId,
                operationId: `${operationId}/supersede`,
                actor: "user",
                reason: body.reason,
                evidence: [],
                recordType: "fact",
                action: "update",
                recordId: commitmentId,
                expectedRevision: body.expectedRevision,
                patch: { status: "superseded" },
              });
            return created;
          },
          { durable: true },
        )) as CampaignMemoryFact;
        return await projected(chatId, next.factId);
      } catch (error) {
        return errorResponse(reply, error);
      }
    },
  );
}
