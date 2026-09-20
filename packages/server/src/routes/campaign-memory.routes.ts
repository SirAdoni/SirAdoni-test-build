import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type {
  CampaignMemoryBacklink,
  CampaignMemoryCurrentState,
  CampaignMemoryEntity,
  CampaignMemoryEntityDetail,
  CampaignMemoryEvent,
  CampaignMemoryFact,
  CampaignMemoryKnowledge,
  CampaignMemoryPage,
  CampaignMemorySourceCheck,
} from "@marinara-engine/shared";
import {
  CampaignMemoryStorageError,
  createCampaignMemoryStorage,
} from "../services/storage/campaign-memory.storage.js";
import {
  applyCampaignMemoryMutation,
  CampaignMemoryMutationError,
} from "../services/game/campaign-memory-mutations.js";
import { createHash } from "node:crypto";
import { logger } from "../lib/logger.js";
import { readCampaignMemorySources, type CampaignMemorySource } from "../services/game/campaign-memory-sources.js";
import { compareCampaignMemoryMessageOrder } from "../services/game/campaign-memory-order.js";
import { chats } from "../db/schema/index.js";
import { eq } from "../db/file-query.js";

const ENTITY_KINDS = ["character", "persona", "location", "organization", "item", "quest", "lore", "note"] as const;
const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(ENTITY_KINDS).optional(),
  /** `<store>:<recordId>` as stored on `entity.owner`; matches by stable identity only. */
  owner: z
    .string()
    .trim()
    .regex(/^[^:\s]+:.+$/)
    .max(300)
    .optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const timelineQuerySchema = z.object({
  entityId: z.string().trim().min(1).max(200).optional(),
  locationId: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(200).optional(),
});
const duplicatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(200).optional(),
});
const duplicatesResolveSchema = z
  .object({
    keepFactId: z.string().trim().min(1).max(300),
    retireFactIds: z.array(z.string().trim().min(1).max(300)).min(1).max(100),
    expectedRevisions: z.record(z.string(), z.number().int().min(1)),
  })
  .strict();
const sectionSchema = z.enum(["facts", "knowledge", "events", "current-state", "relationships"]);
const sourceParamsSchema = z.object({ chatId: z.string().trim().min(1), messageId: z.string().trim().min(1) });
const sourceQuerySchema = z.object({ sourceHash: z.string().regex(/^[0-9a-f]{64}$/i) });

type MatchTier = "id" | "alias" | "prefix" | "text";
const MATCH_TIER_RANK: Record<MatchTier, number> = { id: 0, alias: 1, prefix: 2, text: 3 };
const REFERENCE_SAMPLE_LIMIT = 5;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.8;
/** Facts in a terminal state never enter a duplicate group; resolving retires by superseding. */
const DUPLICATE_EXCLUDED_STATUSES = new Set<CampaignMemoryFact["status"]>(["superseded", "retracted"]);

type DuplicateReason = "overlapping-evidence" | "similar-text";
type DuplicateFactView = {
  factId: string;
  receiptId: string | null;
  status: CampaignMemoryFact["status"];
  text: string;
  evidenceMessageIds: string[];
  sourceOrder: string | null;
  historical: boolean;
};
type DuplicateGroup = {
  groupId: string;
  subjectEntityId: string;
  predicate: string;
  facts: DuplicateFactView[];
  reason: DuplicateReason;
  similarity: number | null;
};

/** Continuity publication stores the receipt and the record text inside the fact value. */
function duplicateFactView(fact: CampaignMemoryFact): DuplicateFactView {
  const value =
    fact.value && typeof fact.value === "object" && !Array.isArray(fact.value)
      ? (fact.value as Record<string, unknown>)
      : null;
  const text =
    typeof value?.text === "string"
      ? value.text
      : typeof fact.value === "string"
        ? fact.value
        : JSON.stringify(fact.value ?? null);
  return {
    factId: fact.factId,
    receiptId: typeof value?.receiptId === "string" ? value.receiptId : null,
    status: fact.status,
    text,
    evidenceMessageIds: [...new Set(fact.evidence.map((item) => item.messageId))],
    sourceOrder: fact.validFromOrder ?? null,
    historical: value?.historical === true,
  };
}

function textTokens(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function tokenJaccard(left: Set<string>, right: Set<string>): number | null {
  if (!left.size && !right.size) return null;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function duplicateGroupId(factIds: readonly string[]): string {
  return `dup_${createHash("sha256")
    .update(JSON.stringify([...factIds].sort()))
    .digest("hex")
    .slice(0, 24)}`;
}

function compareSourceOrder(left: DuplicateFactView, right: DuplicateFactView): number {
  if (left.sourceOrder && right.sourceOrder) {
    const order = compareCampaignMemoryMessageOrder(left.sourceOrder, right.sourceOrder);
    if (order) return order;
  } else if (left.sourceOrder || right.sourceOrder) return left.sourceOrder ? -1 : 1;
  return left.factId.localeCompare(right.factId);
}

/**
 * Candidate duplicate groups: same subject and predicate, different receipts, evidence
 * message overlap or token Jaccard on the text at or above the threshold. Facts already
 * linked through supersedesFactId never pair. Groups are the connected components of
 * qualifying pairs; nothing is merged here.
 */
function findDuplicateGroups(facts: readonly CampaignMemoryFact[]): DuplicateGroup[] {
  const byKey = new Map<string, CampaignMemoryFact[]>();
  for (const fact of facts) {
    if (DUPLICATE_EXCLUDED_STATUSES.has(fact.status)) continue;
    const key = `${fact.subjectEntityId}|${fact.predicate}`;
    byKey.set(key, [...(byKey.get(key) ?? []), fact]);
  }
  const groups: DuplicateGroup[] = [];
  for (const members of byKey.values()) {
    if (members.length < 2) continue;
    const views = members.map(duplicateFactView);
    const tokens = views.map((view) => textTokens(view.text));
    const parent = views.map((_, index) => index);
    const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
    const pairReason = new Map<string, { reason: DuplicateReason; similarity: number | null }>();
    for (let a = 0; a < views.length; a += 1) {
      for (let b = a + 1; b < views.length; b += 1) {
        const left = members[a]!;
        const right = members[b]!;
        if (views[a]!.receiptId === views[b]!.receiptId) continue;
        if (left.supersedesFactId === right.factId || right.supersedesFactId === left.factId) continue;
        const overlap = views[a]!.evidenceMessageIds.some((id) => views[b]!.evidenceMessageIds.includes(id));
        const similarity = tokenJaccard(tokens[a]!, tokens[b]!);
        if (!overlap && (similarity === null || similarity < DUPLICATE_SIMILARITY_THRESHOLD)) continue;
        pairReason.set(`${a}:${b}`, { reason: overlap ? "overlapping-evidence" : "similar-text", similarity });
        parent[find(a)] = find(b);
      }
    }
    const components = new Map<number, number[]>();
    for (let index = 0; index < views.length; index += 1) {
      const root = find(index);
      components.set(root, [...(components.get(root) ?? []), index]);
    }
    for (const component of components.values()) {
      if (component.length < 2) continue;
      let reason: DuplicateReason = "similar-text";
      let similarity: number | null = null;
      for (const [pair, info] of pairReason) {
        const [a, b] = pair.split(":").map(Number);
        if (!component.includes(a!) || !component.includes(b!)) continue;
        if (info.reason === "overlapping-evidence") reason = "overlapping-evidence";
        if (info.similarity !== null && (similarity === null || info.similarity > similarity))
          similarity = info.similarity;
      }
      const groupFacts = component.map((index) => views[index]!).sort(compareSourceOrder);
      groups.push({
        groupId: duplicateGroupId(groupFacts.map((view) => view.factId)),
        subjectEntityId: members[0]!.subjectEntityId,
        predicate: members[0]!.predicate,
        facts: groupFacts,
        reason,
        similarity,
      });
    }
  }
  return groups.sort(
    (left, right) =>
      left.subjectEntityId.localeCompare(right.subjectEntityId) ||
      left.predicate.localeCompare(right.predicate) ||
      left.facts[0]!.factId.localeCompare(right.facts[0]!.factId),
  );
}

type MemoryRecord =
  | CampaignMemoryFact
  | CampaignMemoryKnowledge
  | CampaignMemoryEvent
  | CampaignMemoryCurrentState
  | CampaignMemoryBacklink;

type EvidenceRecord = {
  id: string;
  evidence: readonly { messageId: string; quote: string; sourceHash?: string }[];
  manual: boolean;
  factId?: string;
};

function page<T>(items: T[], offset: number, limit: number): CampaignMemoryPage<T> {
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
}

function displayName(entity: CampaignMemoryEntity): string {
  return entity.aliases[0] || entity.summary || entity.entityId;
}

function sortEntities(left: CampaignMemoryEntity, right: CampaignMemoryEntity): number {
  return displayName(left).localeCompare(displayName(right)) || left.entityId.localeCompare(right.entityId);
}

/** Events order by occurrence (source capture chronology), never by their ID; other records by ID. */
function sortRecords(left: MemoryRecord, right: MemoryRecord): number {
  if ("eventId" in left && "eventId" in right) {
    return (
      compareCampaignMemoryMessageOrder(left.occurrenceOrder, right.occurrenceOrder) ||
      left.eventId.localeCompare(right.eventId)
    );
  }
  return recordId(left).localeCompare(recordId(right));
}

function matchTier(entity: CampaignMemoryEntity, search: string): MatchTier | null {
  if (entity.entityId.toLocaleLowerCase() === search) return "id";
  const aliases = entity.aliases.map((alias) => alias.toLocaleLowerCase());
  if (aliases.some((alias) => alias === search)) return "alias";
  if (aliases.some((alias) => alias.startsWith(search))) return "prefix";
  const haystack = [entity.entityId, entity.kind, entity.summary ?? "", ...entity.aliases, ...entity.tags];
  return haystack.some((value) => value.toLocaleLowerCase().includes(search)) ? "text" : null;
}

function entityRef(entities: ReadonlyMap<string, CampaignMemoryEntity>, entityId: string) {
  const entity = entities.get(entityId);
  return { entityId, alias: entity ? displayName(entity) : entityId };
}

function eventSummary(event: CampaignMemoryEvent): string {
  return event.transitions.join(" ");
}

function eventInvolves(event: CampaignMemoryEvent, entityId: string): boolean {
  return event.participantEntityIds.includes(entityId) || event.locationEntityId === entityId;
}

function recordId(record: MemoryRecord): string {
  if ("knowledgeId" in record) return record.knowledgeId;
  if ("factId" in record) return record.factId;
  if ("eventId" in record) return record.eventId;
  if ("stateId" in record) return record.stateId;
  return record.relationshipId;
}

function collectStrings(value: unknown, output: Set<string>): void {
  if (typeof value === "string") output.add(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, output));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => collectStrings(entry, output));
}

function sourceChecks(
  records: readonly EvidenceRecord[],
  factChecks: ReadonlyMap<string, CampaignMemorySourceCheck>,
  activeMessages: ReadonlyMap<string, CampaignMemorySource>,
): Record<string, CampaignMemorySourceCheck> {
  const checks: Record<string, CampaignMemorySourceCheck> = {};
  for (const record of records) {
    const referencedFact = record.factId ? factChecks.get(record.factId) : undefined;
    if (record.factId && !referencedFact) {
      checks[record.id] = { state: "stale", reason: "Referenced fact is missing from this chat" };
      continue;
    }
    if (record.evidence.length === 0) {
      const check: CampaignMemorySourceCheck = record.manual
        ? { state: "manual", reason: "Explicit user-authored record has no source evidence" }
        : { state: "legacy", reason: "Record has no source evidence" };
      checks[record.id] =
        referencedFact?.state === "stale" ? { state: "stale", reason: "Referenced fact source is stale" } : check;
      continue;
    }
    let state: CampaignMemorySourceCheck = { state: "current" };
    for (const evidence of record.evidence) {
      const source = activeMessages.get(evidence.messageId);
      if (!source) {
        state = { state: "stale", reason: "Source message is missing from this chat" };
        break;
      }
      if (!source.content.includes(evidence.quote)) {
        state = { state: "stale", reason: "Evidence quote is no longer present in the source message" };
        break;
      }
      if (!evidence.sourceHash) {
        if (state.state === "current") state = { state: "legacy", reason: "Evidence has no verified source hash" };
        continue;
      }
      if (source.sourceHash !== evidence.sourceHash) {
        state = { state: "stale", reason: "Source message changed since evidence was recorded" };
        break;
      }
    }
    if (state.state !== "stale" && record.factId) {
      if (referencedFact?.state === "stale") state = { state: "stale", reason: "Referenced fact source is stale" };
    }
    checks[record.id] = state;
  }
  return checks;
}

function errorResponse(reply: FastifyReply, error: unknown) {
  if (error instanceof CampaignMemoryStorageError) {
    const status =
      error.code === "CAMPAIGN_MEMORY_CHAT_NOT_FOUND" ||
      error.code === "CAMPAIGN_MEMORY_NOT_FOUND" ||
      error.code === "CAMPAIGN_MEMORY_INVALID_REFERENCE"
        ? 404
        : 400;
    return reply.status(status).send({ error: { code: error.code, message: error.message } });
  }
  logger.error({ err: error }, "Campaign memory read failed");
  return reply
    .status(500)
    .send({ error: { code: "CAMPAIGN_MEMORY_READ_FAILED", message: "Campaign memory could not be read" } });
}

export async function campaignMemoryRoutes(app: FastifyInstance) {
  const storage = createCampaignMemoryStorage(app.db);

  app.get("/:chatId/memory/sources/:messageId", async (req, reply) => {
    const params = sourceParamsSchema.safeParse(req.params);
    const query = sourceQuerySchema.safeParse(req.query ?? {});
    if (!params.success || !query.success)
      return reply
        .status(400)
        .send({ error: { code: "INVALID_QUERY", message: "Invalid campaign memory source query" } });
    try {
      const result = await app.db.transaction(async (tx) => {
        const chat = (await tx.select().from(chats).where(eq(chats.id, params.data.chatId)).limit(1))[0];
        if (!chat || chat.mode !== "game") return { kind: "unavailable" as const };
        const source = (
          await readCampaignMemorySources(tx, {
            chatId: params.data.chatId,
            messageIds: [params.data.messageId],
          })
        ).get(params.data.messageId);
        if (!source) return { kind: "unavailable" as const };
        if (source.sourceHash.toLowerCase() !== query.data.sourceHash.toLowerCase()) {
          return { kind: "changed" as const, sourceHash: source.sourceHash };
        }
        return {
          kind: "ok" as const,
          messageId: params.data.messageId,
          sourceHash: source.sourceHash,
          swipeIndex: source.swipeIndex,
          content: source.content,
        };
      });
      if (result.kind === "unavailable")
        return reply.status(404).send({
          error: { code: "CAMPAIGN_MEMORY_SOURCE_UNAVAILABLE", message: "Campaign memory source is unavailable" },
        });
      if (result.kind === "changed")
        return reply
          .status(409)
          .send({ error: { code: "CAMPAIGN_MEMORY_SOURCE_CHANGED", message: "Campaign memory source changed" } });
      return {
        messageId: result.messageId,
        sourceHash: result.sourceHash,
        swipeIndex: result.swipeIndex,
        content: result.content,
      };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/entities", async (req, reply) => {
    const query = querySchema.safeParse(req.query ?? {});
    if (!query.success)
      return reply.status(400).send({
        error: { code: "INVALID_QUERY", message: "Invalid campaign memory query", details: query.error.flatten() },
      });
    const { chatId } = req.params as { chatId: string };
    try {
      let entities = await storage.listEntities({ chatId });
      if (query.data.kind) entities = entities.filter((entity) => entity.kind === query.data.kind);
      if (query.data.owner) {
        const separator = query.data.owner.indexOf(":");
        const store = query.data.owner.slice(0, separator);
        const recordId = query.data.owner.slice(separator + 1);
        entities = entities.filter((entity) => entity.owner.store === store && entity.owner.recordId === recordId);
      }
      const search = query.data.q?.toLocaleLowerCase();
      if (!search) {
        entities.sort(sortEntities);
        return page(entities, query.data.offset, query.data.limit);
      }
      const ranked = entities.flatMap((entity) => {
        const tier = matchTier(entity, search);
        return tier ? [{ ...entity, matchTier: tier }] : [];
      });
      ranked.sort(
        (left, right) =>
          MATCH_TIER_RANK[left.matchTier] - MATCH_TIER_RANK[right.matchTier] || sortEntities(left, right),
      );
      return page(ranked, query.data.offset, query.data.limit);
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/entities/:entityId", async (req, reply) => {
    const query = querySchema.safeParse(req.query ?? {});
    if (!query.success)
      return reply.status(400).send({
        error: { code: "INVALID_QUERY", message: "Invalid campaign memory query", details: query.error.flatten() },
      });
    const { chatId, entityId } = req.params as { chatId: string; entityId: string };
    try {
      const scope = { chatId };
      const entity = await storage.getEntity(scope, entityId);
      if (!entity)
        return reply
          .status(404)
          .send({ error: { code: "CAMPAIGN_MEMORY_NOT_FOUND", message: "Campaign memory entity not found" } });
      const [facts, knowledge, events, currentState, relationships, allEntities, activeMessages] = await Promise.all([
        storage.listFacts(scope),
        storage.listKnowledge(scope),
        storage.listEvents(scope),
        storage.listCurrentState(scope),
        storage.listBacklinks(scope, entityId),
        storage.listEntities(scope),
        readCampaignMemorySources(app.db, { chatId }),
      ]);
      const entityById = new Map(allEntities.map((item) => [item.entityId, item]));
      const coHoldersOf = (factId: string) =>
        knowledge
          .filter((item) => item.factId === factId && item.holderEntityId !== entityId)
          .map((item) => ({ ...entityRef(entityById, item.holderEntityId), epistemicState: item.epistemicState }))
          .sort((left, right) => left.alias.localeCompare(right.alias) || left.entityId.localeCompare(right.entityId));
      const withCoHolders = (item: CampaignMemoryFact) => ({ ...item, coHolders: coHoldersOf(item.factId) });
      const factPage = page(
        facts
          .filter((item) => item.subjectEntityId === entityId)
          .sort(sortRecords)
          .map(withCoHolders),
        query.data.offset,
        query.data.limit,
      );
      const knowledgePage = page(
        knowledge.filter((item) => item.holderEntityId === entityId).sort(sortRecords),
        query.data.offset,
        query.data.limit,
      );
      const eventPage = page(
        events
          .filter((item) => item.participantEntityIds.includes(entityId) || item.locationEntityId === entityId)
          .sort(sortRecords),
        query.data.offset,
        query.data.limit,
      );
      const statePage = page(
        currentState.filter((item) => item.entityId === entityId).sort(sortRecords),
        query.data.offset,
        query.data.limit,
      );
      const relationshipPage = page(relationships.sort(sortRecords), query.data.offset, query.data.limit);
      const referencedEventIds = new Set(statePage.items.map((item) => item.sourceEventId));
      const referencedEvents = events.filter((item) => referencedEventIds.has(item.eventId)).sort(sortRecords);
      const referencedFactIds = new Set(knowledgePage.items.flatMap((item) => (item.factId ? [item.factId] : [])));
      const referencedFacts = facts
        .filter((item) => referencedFactIds.has(item.factId))
        .sort(sortRecords)
        .map(withCoHolders);
      const referenced = new Set<string>();
      for (const record of [
        ...factPage.items,
        ...knowledgePage.items,
        ...eventPage.items,
        ...statePage.items,
        ...relationshipPage.items,
        ...referencedEvents,
      ]) {
        if ("subjectEntityId" in record) referenced.add(record.subjectEntityId);
        if ("holderEntityId" in record) referenced.add(record.holderEntityId);
        if ("attributedClaim" in record && record.attributedClaim)
          referenced.add(record.attributedClaim.subjectEntityId);
        if ("participantEntityIds" in record) record.participantEntityIds.forEach((id) => referenced.add(id));
        if ("locationEntityId" in record && record.locationEntityId) referenced.add(record.locationEntityId);
        if ("entityId" in record) referenced.add(record.entityId);
        if ("sourceEntityId" in record) {
          referenced.add(record.sourceEntityId);
          referenced.add(record.targetEntityId);
        }
        if ("value" in record) collectStrings(record.value, referenced);
      }
      const relatedEntities = allEntities
        .filter((item) => item.entityId !== entityId && referenced.has(item.entityId))
        .sort(sortEntities);
      const allFactRecords: EvidenceRecord[] = facts.map((item) => ({
        id: item.factId,
        evidence: item.evidence,
        manual: item.author === "user" || item.provenance.actor === "user",
      }));
      const factChecks = new Map(Object.entries(sourceChecks(allFactRecords, new Map(), activeMessages)));
      const displayedSourceRecords: EvidenceRecord[] = [
        ...factPage.items.map((item) => ({
          id: item.factId,
          evidence: item.evidence,
          manual: item.author === "user" || item.provenance.actor === "user",
        })),
        ...knowledgePage.items.map((item) => ({
          id: item.knowledgeId,
          evidence: item.learnedFrom,
          manual: item.provenance.actor === "user",
          ...(item.factId ? { factId: item.factId } : {}),
        })),
        ...eventPage.items.map((item) => ({
          id: item.eventId,
          evidence: item.evidence,
          manual: item.provenance.actor === "user",
        })),
        ...relationshipPage.items.map((item) => ({
          id: item.relationshipId,
          evidence: item.evidence,
          manual: item.provenance.actor === "user",
        })),
      ];
      const eventChecks = new Map(
        Object.entries(
          sourceChecks(
            events.map((item) => ({
              id: item.eventId,
              evidence: item.evidence,
              manual: item.provenance.actor === "user",
            })),
            new Map(),
            activeMessages,
          ),
        ),
      );
      const stateChecks = new Map<string, CampaignMemorySourceCheck>();
      for (const state of statePage.items) {
        const eventCheck = eventChecks.get(state.sourceEventId);
        stateChecks.set(
          state.stateId,
          eventCheck ?? { state: "stale", reason: "Current-state source event is unavailable" },
        );
      }
      const referencedEventChecks = Object.fromEntries(
        referencedEvents.flatMap((event) => {
          const check = eventChecks.get(event.eventId);
          return check ? [[event.eventId, check] as const] : [];
        }),
      );
      const detail: CampaignMemoryEntityDetail = {
        entity,
        facts: factPage,
        knowledge: knowledgePage,
        events: eventPage,
        referencedEvents,
        currentState: statePage,
        relationships: relationshipPage,
        relatedEntities,
        referencedFacts,
        sourceChecks: {
          ...sourceChecks(displayedSourceRecords, factChecks, activeMessages),
          ...referencedEventChecks,
          ...Object.fromEntries(stateChecks),
        },
      };
      return detail;
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/entities/:entityId/:section", async (req, reply) => {
    const parsedQuery = querySchema.safeParse(req.query ?? {});
    const parsedSection = sectionSchema.safeParse((req.params as { section: string }).section);
    if (!parsedQuery.success || !parsedSection.success)
      return reply
        .status(400)
        .send({ error: { code: "INVALID_QUERY", message: "Invalid campaign memory section query" } });
    const { chatId, entityId } = req.params as { chatId: string; entityId: string };
    try {
      const scope = { chatId };
      const entity = await storage.getEntity(scope, entityId);
      if (!entity)
        return reply
          .status(404)
          .send({ error: { code: "CAMPAIGN_MEMORY_NOT_FOUND", message: "Campaign memory entity not found" } });
      const section = parsedSection.data;
      let records: MemoryRecord[];
      if (section === "facts")
        records = (await storage.listFacts(scope)).filter((item) => item.subjectEntityId === entityId);
      else if (section === "knowledge")
        records = (await storage.listKnowledge(scope)).filter((item) => item.holderEntityId === entityId);
      else if (section === "events")
        records = (await storage.listEvents(scope)).filter(
          (item) => item.participantEntityIds.includes(entityId) || item.locationEntityId === entityId,
        );
      else if (section === "current-state")
        records = (await storage.listCurrentState(scope)).filter((item) => item.entityId === entityId);
      else records = await storage.listBacklinks(scope, entityId);
      records.sort(sortRecords);
      return page(records, parsedQuery.data.offset, parsedQuery.data.limit);
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/timeline", async (req, reply) => {
    const query = timelineQuerySchema.safeParse(req.query ?? {});
    if (!query.success)
      return reply.status(400).send({
        error: {
          code: "INVALID_QUERY",
          message: "Invalid campaign memory timeline query",
          details: query.error.flatten(),
        },
      });
    const { chatId } = req.params as { chatId: string };
    try {
      const scope = { chatId };
      const [events, currentState, entities] = await Promise.all([
        storage.listEvents(scope),
        storage.listCurrentState(scope),
        storage.listEntities(scope),
      ]);
      const { entityId, locationId } = query.data;
      const ordered = events
        .filter((event) => !entityId || eventInvolves(event, entityId))
        .filter((event) => !locationId || event.locationEntityId === locationId)
        .sort(sortRecords);
      let start = 0;
      if (query.data.cursor) {
        const index = ordered.findIndex((event) => event.eventId === query.data.cursor);
        if (index < 0)
          return reply
            .status(400)
            .send({ error: { code: "INVALID_CURSOR", message: "Campaign memory timeline cursor is unknown" } });
        start = index + 1;
      }
      const slice = ordered.slice(start, start + query.data.limit);
      const entityById = new Map(entities.map((item) => [item.entityId, item]));
      const changesByEvent = new Map<
        string,
        { entityId: string; key: string; value: CampaignMemoryCurrentState["value"] }[]
      >();
      for (const state of currentState) {
        const list = changesByEvent.get(state.sourceEventId) ?? [];
        list.push({ entityId: state.entityId, key: state.property, value: state.value });
        changesByEvent.set(state.sourceEventId, list);
      }
      return {
        items: slice.map((event) => ({
          eventId: event.eventId,
          occurrenceOrder: event.occurrenceOrder,
          campaignTime: event.campaignTime ?? null,
          location: event.locationEntityId ? entityRef(entityById, event.locationEntityId) : null,
          participants: event.participantEntityIds.map((id) => entityRef(entityById, id)),
          summary: eventSummary(event),
          stateChanges: (changesByEvent.get(event.eventId) ?? []).sort(
            (left, right) => left.entityId.localeCompare(right.entityId) || left.key.localeCompare(right.key),
          ),
          sourceMessageId: event.evidence[0]?.messageId ?? null,
        })),
        nextCursor: start + query.data.limit < ordered.length ? (slice.at(-1)?.eventId ?? null) : null,
      };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/facts/:factId/dependents", async (req, reply) => {
    const { chatId, factId } = req.params as { chatId: string; factId: string };
    try {
      const scope = { chatId };
      const fact = await storage.getFact(scope, factId);
      if (!fact)
        return reply
          .status(404)
          .send({ error: { code: "CAMPAIGN_MEMORY_NOT_FOUND", message: "Campaign memory fact not found" } });
      const [knowledge, events, currentState, entities] = await Promise.all([
        storage.listKnowledge(scope),
        storage.listEvents(scope),
        storage.listCurrentState(scope),
        storage.listEntities(scope),
      ]);
      const entityById = new Map(entities.map((item) => [item.entityId, item]));
      // Events carry no fact reference; an event depends on the fact when it cites the same source message.
      const citedMessages = new Set(fact.evidence.map((item) => item.messageId));
      const dependentEvents = events
        .filter((event) => event.evidence.some((item) => citedMessages.has(item.messageId)))
        .sort(sortRecords);
      const dependentEventIds = new Set(dependentEvents.map((event) => event.eventId));
      return {
        knowledge: knowledge
          .filter((item) => item.factId === factId)
          .sort(sortRecords)
          .map((item) => ({
            knowledgeId: item.knowledgeId,
            holder: entityRef(entityById, item.holderEntityId),
            epistemicState: item.epistemicState,
          })),
        states: currentState
          .filter((item) => dependentEventIds.has(item.sourceEventId))
          .sort(sortRecords)
          .map((item) => ({ entityId: item.entityId, key: item.property, causeEventId: item.sourceEventId })),
        events: dependentEvents.map((event) => ({ eventId: event.eventId, summary: eventSummary(event) })),
      };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/entities/:entityId/references", async (req, reply) => {
    const { chatId, entityId } = req.params as { chatId: string; entityId: string };
    try {
      const scope = { chatId };
      const entity = await storage.getEntity(scope, entityId);
      if (!entity)
        return reply
          .status(404)
          .send({ error: { code: "CAMPAIGN_MEMORY_NOT_FOUND", message: "Campaign memory entity not found" } });
      const [facts, knowledge, events, relationships, currentState] = await Promise.all([
        storage.listFacts(scope),
        storage.listKnowledge(scope),
        storage.listEvents(scope),
        storage.listRelationships(scope),
        storage.listCurrentState(scope),
      ]);
      const ids = {
        facts: facts
          .filter((item) => item.subjectEntityId === entityId)
          .sort(sortRecords)
          .map((item) => item.factId),
        knowledge: knowledge
          .filter((item) => item.holderEntityId === entityId || item.attributedClaim?.subjectEntityId === entityId)
          .sort(sortRecords)
          .map((item) => item.knowledgeId),
        events: events
          .filter((event) => eventInvolves(event, entityId))
          .sort(sortRecords)
          .map((item) => item.eventId),
        relationships: relationships
          .filter((item) => item.sourceEntityId === entityId || item.targetEntityId === entityId)
          .map((item) => item.relationshipId)
          .sort((left, right) => left.localeCompare(right)),
        states: currentState
          .filter((item) => item.entityId === entityId)
          .sort(sortRecords)
          .map((item) => item.stateId),
      };
      return {
        facts: ids.facts.length,
        knowledge: ids.knowledge.length,
        events: ids.events.length,
        relationships: ids.relationships.length,
        states: ids.states.length,
        samples: Object.fromEntries(
          Object.entries(ids).map(([key, list]) => [key, list.slice(0, REFERENCE_SAMPLE_LIMIT)]),
        ),
      };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/review/duplicates", async (req, reply) => {
    const query = duplicatesQuerySchema.safeParse(req.query ?? {});
    if (!query.success)
      return reply.status(400).send({
        error: {
          code: "INVALID_QUERY",
          message: "Invalid campaign memory duplicates query",
          details: query.error.flatten(),
        },
      });
    const { chatId } = req.params as { chatId: string };
    try {
      const groups = findDuplicateGroups(await storage.listFacts({ chatId }));
      let start = 0;
      if (query.data.cursor) {
        const index = groups.findIndex((group) => group.groupId === query.data.cursor);
        if (index < 0)
          return reply
            .status(400)
            .send({ error: { code: "INVALID_CURSOR", message: "Campaign memory duplicates cursor is unknown" } });
        start = index + 1;
      }
      const slice = groups.slice(start, start + query.data.limit);
      return {
        groups: slice,
        nextCursor: start + query.data.limit < groups.length ? (slice.at(-1)?.groupId ?? null) : null,
      };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  // Resolve a duplicate group: every retired fact becomes `superseded` and points at the
  // kept fact. Each retirement is one journaled, CAS-checked mutation whose operation id is
  // derived from the group, so a repeated request replays instead of mutating again.
  app.post("/:chatId/memory/review/duplicates/:groupId/resolve", async (req, reply) => {
    const body = duplicatesResolveSchema.safeParse(req.body ?? {});
    if (!body.success)
      return reply.status(400).send({
        error: {
          code: "INVALID_BODY",
          message: "Invalid campaign memory duplicates resolution",
          details: body.error.flatten(),
        },
      });
    const { chatId, groupId } = req.params as { chatId: string; groupId: string };
    const { keepFactId, expectedRevisions } = body.data;
    const retireFactIds = [...new Set(body.data.retireFactIds)];
    if (retireFactIds.includes(keepFactId))
      return reply
        .status(400)
        .send({ error: { code: "INVALID_BODY", message: "The kept fact cannot also be retired" } });
    try {
      const scope = { chatId };
      const keep = await storage.getFact(scope, keepFactId);
      if (!keep)
        return reply
          .status(404)
          .send({ error: { code: "CAMPAIGN_MEMORY_NOT_FOUND", message: "Campaign memory fact not found" } });
      // `supersedesFactId` reads newer -> older: the kept fact points at the retired one.
      // Retired facts only change status; the keep links to the first retired fact when it
      // has no link yet (single-link field), each step CAS-checked with its own revision.
      const revisionOf = (factId: string) => {
        const expectedRevision = expectedRevisions[factId];
        if (expectedRevision === undefined)
          throw new CampaignMemoryMutationError(
            "CAMPAIGN_MEMORY_INVALID_VALUE",
            `expectedRevisions.${factId} is required`,
          );
        return expectedRevision;
      };
      const linkedFactId = await app.db.transaction(
        async (tx) => {
          const txStorage = createCampaignMemoryStorage(tx);
          for (const factId of retireFactIds) {
            const fact = await txStorage.getFact(scope, factId);
            if (!fact) throw new CampaignMemoryMutationError("CAMPAIGN_MEMORY_NOT_FOUND", `Fact ${factId} not found`);
            if (fact.subjectEntityId !== keep.subjectEntityId || fact.predicate !== keep.predicate)
              throw new CampaignMemoryMutationError(
                "CAMPAIGN_MEMORY_INVALID_VALUE",
                `Fact ${factId} is not a duplicate of ${keepFactId}`,
              );
            if (fact.status === "superseded") continue;
            await applyCampaignMemoryMutation(tx, {
              chatId,
              operationId: `campaign-memory-duplicates:${groupId}:${factId}`,
              actor: "user",
              reason: `Duplicate review: superseded by ${keepFactId}`,
              recordType: "fact",
              action: "update",
              recordId: factId,
              expectedRevision: revisionOf(factId),
              patch: { status: "superseded" },
            });
          }
          const current = await txStorage.getFact(scope, keepFactId);
          if (!current)
            throw new CampaignMemoryMutationError("CAMPAIGN_MEMORY_NOT_FOUND", `Fact ${keepFactId} not found`);
          if (current.supersedesFactId) return current.supersedesFactId;
          const target = retireFactIds[0];
          if (!target) return null;
          const after = (await applyCampaignMemoryMutation(tx, {
            chatId,
            operationId: `campaign-memory-duplicates:${groupId}:link:${keepFactId}`,
            actor: "user",
            reason: `Duplicate review: supersedes ${target}`,
            recordType: "fact",
            action: "update",
            recordId: keepFactId,
            expectedRevision: revisionOf(keepFactId),
            patch: { supersedesFactId: target },
          })) as CampaignMemoryFact;
          return after.supersedesFactId ?? null;
        },
        { durable: true },
      );
      return { groupId, keepFactId, retiredFactIds: retireFactIds, linkedFactId };
    } catch (error) {
      if (error instanceof CampaignMemoryMutationError || error instanceof CampaignMemoryStorageError) {
        const status =
          error.code === "CAMPAIGN_MEMORY_NOT_FOUND" ||
          error.code === "CAMPAIGN_MEMORY_CHAT_NOT_FOUND" ||
          error.code === "CAMPAIGN_MEMORY_INVALID_REFERENCE"
            ? 404
            : error.code === "CAMPAIGN_MEMORY_CAS_MISMATCH" ||
                error.code === "CAMPAIGN_MEMORY_LOCKED" ||
                error.code === "CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT"
              ? 409
              : 400;
        return reply.status(status).send({ error: { code: error.code, message: error.message } });
      }
      logger.error({ err: error }, "Campaign memory duplicate resolution failed");
      return reply.status(500).send({
        error: { code: "CAMPAIGN_MEMORY_WRITE_FAILED", message: "Campaign memory duplicates could not be resolved" },
      });
    }
  });
}
