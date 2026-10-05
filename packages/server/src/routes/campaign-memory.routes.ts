import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { worldHistoryPage } from "@marinara-engine/shared";
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
import { logger } from "../lib/logger.js";
import {
  rejectCampaignFeatureWhenDisabled,
  sendCampaignFeatureDisabled,
} from "../services/features/campaign-opt-in.js";
import { rejectCampaignSurfaceWhenDisabled } from "../services/features/campaign-surface-opt-in.js";
import { readCampaignMemorySources, type CampaignMemorySource } from "../services/game/campaign-memory-sources.js";
import { buildCampaignFactionWeb } from "../services/game/campaign-faction-web.js";
import {
  createCampaignScopedMemoryReader,
  readCampaignMemoryProjection,
  readCampaignMemorySourcesForProjection,
  type CampaignMemoryProjection,
} from "../services/game/campaign-memory-campaign-scope.js";
import { compareCampaignMemoryMessageOrder } from "../services/game/campaign-memory-order.js";
import { chats } from "../db/schema/index.js";
import { eq } from "../db/file-query.js";

const ENTITY_KINDS = ["character", "persona", "location", "organization", "item", "quest", "lore", "note"] as const;
const EVENT_FACT_EXCLUDED_STATUSES = new Set<CampaignMemoryFact["status"]>(["superseded", "retracted"]);
function isPinnedFact(fact: Pick<CampaignMemoryFact, "value" | "manualLock">): boolean {
  const value = fact.value as unknown;
  return (
    fact.manualLock === true &&
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { pinned?: unknown }).pinned === true
  );
}
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
  /** Entity detail only: case-insensitive text match over a fact's predicate and value. */
  factQuery: z.string().trim().max(200).optional(),
  /** Entity detail only: a fact kind as listed in `factKinds`. */
  factKind: z.string().trim().max(60).optional(),
  /** Entity detail only: facts from this session number. */
  session: z.coerce.number().int().min(1).optional(),
  /** Entity list only: "kind" leads with people and places (ENTITY_KINDS order), then name. */
  sort: z.enum(["name", "kind"]).optional(),
});
const timelineQuerySchema = z.object({
  entityId: z.string().trim().min(1).max(200).optional(),
  locationId: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(200).optional(),
  /** "desc" pages newest first ("latest in the story"); the cursor follows the same direction. */
  order: z.enum(["asc", "desc"]).default("asc"),
});
const factsQuerySchema = z.object({
  /** Only facts the player pinned as canon (manualLock and value.pinned === true). */
  pinned: z.enum(["true", "false"]).optional(),
  /** Case-insensitive text match over the predicate and value. */
  q: z.string().trim().max(200).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const sectionSchema = z.enum(["facts", "knowledge", "events", "current-state", "relationships"]);
const sourceParamsSchema = z.object({ chatId: z.string().trim().min(1), messageId: z.string().trim().min(1) });
const sourceQuerySchema = z.object({ sourceHash: z.string().regex(/^[0-9a-f]{64}$/i) });

type MatchTier = "id" | "alias" | "prefix" | "text";
const MATCH_TIER_RANK: Record<MatchTier, number> = { id: 0, alias: 1, prefix: 2, text: 3 };
const REFERENCE_SAMPLE_LIMIT = 5;
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

/** The session a fact was recorded in; null when it predates session numbering. */
function factSessionOf(fact: CampaignMemoryFact): number | null {
  const session = (fact as { originSessionNumber?: unknown }).originSessionNumber;
  return typeof session === "number" ? session : null;
}

/** A continuity fact's record kind (decision, commitment, ...), else its predicate. */
function factKindOf(fact: CampaignMemoryFact): string {
  const kind = fact.value && typeof fact.value === "object" && !Array.isArray(fact.value) ? fact.value.kind : undefined;
  return typeof kind === "string" && kind.trim() ? kind.trim() : fact.predicate.replace(/^continuity\./u, "");
}

function sortEntities(left: CampaignMemoryEntity, right: CampaignMemoryEntity): number {
  const archived = Number(left.status === "archived") - Number(right.status === "archived");
  return archived || displayName(left).localeCompare(displayName(right)) || left.entityId.localeCompare(right.entityId);
}

/** People and places first (ENTITY_KINDS order), archived last, then by name. */
function sortEntitiesByKind(left: CampaignMemoryEntity, right: CampaignMemoryEntity): number {
  const rank = (entity: CampaignMemoryEntity) => {
    const index = (ENTITY_KINDS as readonly string[]).indexOf(entity.kind);
    return index < 0 ? ENTITY_KINDS.length : index;
  };
  const archived = Number(left.status === "archived") - Number(right.status === "archived");
  return archived || rank(left) - rank(right) || sortEntities(left, right);
}

/**
 * Continuity publishes each reviewed batch into the Lorebook Keeper and registers the entry as a lore entity. Its
 * facts and events already live in the memory tables under their real subjects, so the mirror page is an empty,
 * unnamed row ("Untitled Lore"); a campaign with hundreds of batches would bury the wiki in them.
 */
async function hideEmptyContinuityMirrors(
  reader: {
    listFacts(scope: { chatId: string }): Promise<Array<{ subjectEntityId: string }>>;
    listEvents(scope: {
      chatId: string;
    }): Promise<Array<{ participantEntityIds: string[]; locationEntityId?: string | null }>>;
    listKnowledge(scope: { chatId: string }): Promise<Array<{ holderEntityId: string }>>;
  },
  chatId: string,
  entities: CampaignMemoryEntity[],
): Promise<CampaignMemoryEntity[]> {
  const mirror = (entity: CampaignMemoryEntity) =>
    entity.kind === "lore" &&
    entity.owner.store === "lorebook-entries" &&
    // Unnamed, or named only after its lorebook entry ("Game continuity 8").
    // Both live continuity and the legacy import created these; the name, not the source, marks a mirror.
    entity.aliases.every((alias) => /^game continuity \d+$/iu.test(alias.trim()));
  if (!entities.some(mirror)) return entities;
  const [facts, events, knowledge] = await Promise.all([
    reader.listFacts({ chatId }),
    reader.listEvents({ chatId }),
    reader.listKnowledge({ chatId }),
  ]);
  const used = new Set<string>([
    ...facts.map((fact) => fact.subjectEntityId),
    ...events.flatMap((event) => [...event.participantEntityIds, event.locationEntityId ?? ""]),
    ...knowledge.map((item) => item.holderEntityId),
  ]);
  return entities.filter((entity) => !mirror(entity) || used.has(entity.entityId));
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

/**
 * Events store only transition ids and evidence, so their readable text comes from what the same transition wrote:
 * the facts citing the same quote, then the state it changed, then the quote itself. Never the ids.
 */
function eventSummaries(
  events: CampaignMemoryEvent[],
  facts: CampaignMemoryFact[],
  currentState: CampaignMemoryCurrentState[],
  entityById: ReadonlyMap<string, CampaignMemoryEntity>,
  /**
   * Every event the listing could show (defaults to `events`). Events that share a source message are deduplicated
   * against this set in occurrence order, so a paged slice gets the same text it would get in the full list.
   */
  contextEvents: readonly CampaignMemoryEvent[] = events,
): Map<string, string> {
  const evidenceKey = (item: { messageId: string; quote: string }) => `${item.messageId}\u0000${item.quote.trim()}`;
  const factsByEvidence = new Map<string, CampaignMemoryFact[]>();
  for (const fact of facts) {
    if (EVENT_FACT_EXCLUDED_STATUSES.has(fact.status)) continue;
    if (!factText(fact)) continue;
    for (const item of fact.evidence) {
      const list = factsByEvidence.get(evidenceKey(item)) ?? [];
      if (!list.includes(fact)) list.push(fact);
      factsByEvidence.set(evidenceKey(item), list);
    }
  }
  const statesByEvent = new Map<string, string[]>();
  for (const state of currentState) {
    const entity = entityById.get(state.entityId);
    const value =
      typeof state.value === "string"
        ? entityById.get(state.value)
          ? displayName(entityById.get(state.value)!)
          : state.value
        : JSON.stringify(state.value);
    const list = statesByEvent.get(state.sourceEventId) ?? [];
    list.push(`${entity ? displayName(entity) : state.entityId}: ${state.property} = ${value}`);
    statesByEvent.set(state.sourceEventId, list);
  }
  /**
   * Readable options for one event, best first. A message usually yields several events (one per transition) and
   * every fact from that message cites the same quote, so the facts are narrowed to the ones about this event: a
   * subject among its participants or location, or a record/receipt/fact id among its transitions.
   */
  const candidates = (event: CampaignMemoryEvent): string[] => {
    const citing = [...new Set(event.evidence.flatMap((item) => factsByEvidence.get(evidenceKey(item)) ?? []))];
    const involved = new Set([
      ...event.participantEntityIds,
      ...(event.locationEntityId ? [event.locationEntityId] : []),
    ]);
    const transitions = new Set(event.transitions);
    const related = citing.filter((fact) => {
      if (involved.has(fact.subjectEntityId) || transitions.has(fact.factId)) return true;
      const value = fact.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const { recordId, receiptId } = value as Record<string, unknown>;
      return (
        (typeof recordId === "string" && transitions.has(recordId)) ||
        (typeof receiptId === "string" && transitions.has(receiptId))
      );
    });
    const quote = event.evidence.find((item) => item.quote.trim())?.quote.trim() ?? "";
    return [
      joinSentences(related.map(factText)),
      statesByEvent.get(event.eventId)?.join("; ") ?? "",
      joinSentences(citing.map(factText)),
      quote,
    ].filter(Boolean);
  };
  // Walk every event in occurrence order; an event whose text an earlier event from the same message already
  // shows takes its next option, or stays empty rather than repeating it.
  const wanted = new Set(events.map((event) => event.eventId));
  const all = new Map<string, CampaignMemoryEvent>();
  for (const event of [...contextEvents, ...events]) all.set(event.eventId, event);
  const relevantMessages = new Set(events.flatMap((event) => event.evidence.map((item) => item.messageId)));
  const walk = [...all.values()]
    .filter((event) => wanted.has(event.eventId) || event.evidence.some((item) => relevantMessages.has(item.messageId)))
    .sort(sortRecords) as CampaignMemoryEvent[];
  const usedByMessage = new Map<string, Set<string>>();
  const summaries = new Map<string, string>();
  for (const event of walk) {
    const messageIds = [...new Set(event.evidence.map((item) => item.messageId))];
    const used = (text: string) => messageIds.some((id) => usedByMessage.get(id)?.has(text));
    const text = candidates(event).find((option) => !used(option)) ?? "";
    if (text)
      for (const id of messageIds) {
        const set = usedByMessage.get(id) ?? new Set<string>();
        set.add(text);
        usedByMessage.set(id, set);
      }
    if (wanted.has(event.eventId)) summaries.set(event.eventId, text);
  }
  return summaries;
}

/**
 * Up to three sentences joined with one space. When there are several, one without closing punctuation gets a full
 * stop so they do not run together; a single sentence is returned exactly as recorded.
 */
function joinSentences(sentences: readonly string[]): string {
  const unique = [...new Set(sentences.map((sentence) => sentence.trim()).filter(Boolean))].slice(0, 3);
  if (unique.length <= 1) return unique[0] ?? "";
  return unique.map((sentence) => (/[.!?…]["'”’)\]]*$/u.test(sentence) ? sentence : `${sentence}.`)).join(" ");
}

function factText(fact: CampaignMemoryFact): string {
  const value = fact.value as unknown;
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string")
    return (value as { text: string }).text.trim();
  return "";
}

function originFields(record: object): { originChatId?: string; originSessionNumber?: number } {
  const origin = record as { originChatId?: unknown; originSessionNumber?: unknown };
  return {
    ...(typeof origin.originChatId === "string" ? { originChatId: origin.originChatId } : {}),
    ...(typeof origin.originSessionNumber === "number" ? { originSessionNumber: origin.originSessionNumber } : {}),
  };
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
  if (sendCampaignFeatureDisabled(reply, error)) return reply;

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
  app.addHook("preHandler", async (_request, reply) => {
    if (rejectCampaignFeatureWhenDisabled(reply, "campaignMemory")) return reply;
  });

  const storage = createCampaignMemoryStorage(app.db);

  /**
   * Read routes default to the whole campaign: every earlier session of the game merged into this chat
   * (`?scope=session` reads this chat alone). Records keep `originChatId` so edits go to the chat that owns them.
   */
  async function memoryScope(req: { query?: unknown }, chatId: string) {
    const requested = (req.query as { scope?: unknown } | undefined)?.scope;
    if (requested === "session") return { reader: storage, projection: null as CampaignMemoryProjection | null };
    const projection = await readCampaignMemoryProjection(app.db, chatId);
    // A single-session projection is the chat's own memory; it is still used because it is cached between requests.
    return { reader: createCampaignScopedMemoryReader(projection), projection };
  }
  const canonicalEntityId = (projection: CampaignMemoryProjection | null, entityId: string) =>
    projection?.entityIdMap.get(entityId) ?? entityId;

  app.get("/:chatId/memory/sources/:messageId", async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "campaignWiki")) return;
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
        let source = (
          await readCampaignMemorySources(tx, {
            chatId: params.data.chatId,
            messageIds: [params.data.messageId],
          })
        ).get(params.data.messageId);
        // Campaign-scoped records cite messages of earlier sessions of the same game.
        if (!source && (req.query as { scope?: unknown } | undefined)?.scope !== "session") {
          const { listCampaignSessionChats } = await import("../services/game/campaign-memory-campaign-scope.js");
          for (const session of await listCampaignSessionChats(tx, params.data.chatId)) {
            if (session.id === params.data.chatId) continue;
            source = (
              await readCampaignMemorySources(tx, { chatId: session.id, messageIds: [params.data.messageId] })
            ).get(params.data.messageId);
            if (source) break;
          }
        }
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

  app.get("/:chatId/memory/world-history/entities", async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "worldHistory")) return;
    const query = z
      .object({
        scope: z.enum(["session", "campaign"]).optional(),
        q: z.string().trim().max(100).optional(),
        kind: z.enum(["character", "organization", "location"]).optional(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .safeParse(req.query ?? {});
    if (!query.success)
      return reply
        .status(400)
        .send({ error: { code: "INVALID_QUERY", message: "Invalid World History entity query" } });
    const { chatId } = req.params as { chatId: string };
    const kinds = new Set(["character", "organization", "location"]);
    try {
      const { reader } = await memoryScope(req, chatId);
      const search = query.data.q?.toLocaleLowerCase();
      const entities = (await reader.listEntities({ chatId }))
        .filter((entity) => kinds.has(entity.kind) && (!query.data.kind || entity.kind === query.data.kind))
        .filter(
          (entity) =>
            !search ||
            entity.entityId.toLocaleLowerCase().includes(search) ||
            entity.aliases.some((alias) => alias.toLocaleLowerCase().includes(search)),
        )
        .map(({ entityId, aliases, kind, status }) => ({ entityId, aliases, kind, status }));
      return page(entities, query.data.offset, query.data.limit);
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/world-history", async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "worldHistory")) return;
    const query = z
      .object({
        q: z.string().trim().max(100).optional(),
        era: z.string().max(100).optional(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        archived: z.enum(["true", "false"]).optional(),
      })
      .safeParse(req.query ?? {});
    if (!query.success)
      return reply.status(400).send({
        error: {
          code: "INVALID_QUERY",
          message: "Invalid world history query",
        },
      });
    const { chatId } = req.params as { chatId: string };
    try {
      const { reader, projection } = await memoryScope(req, chatId);
      return worldHistoryPage(
        await reader.listEntities({ chatId }),
        { ...query.data, archived: query.data.archived === "true" },
        (id) => canonicalEntityId(projection, id),
      );
    } catch (error) {
      return errorResponse(reply, error);
    }
  });
  app.get("/:chatId/memory/entities", async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "campaignWiki")) return;
    const query = querySchema.safeParse(req.query ?? {});
    if (!query.success)
      return reply.status(400).send({
        error: { code: "INVALID_QUERY", message: "Invalid campaign memory query", details: query.error.flatten() },
      });
    const { chatId } = req.params as { chatId: string };
    try {
      const { reader } = await memoryScope(req, chatId);
      let entities = await hideEmptyContinuityMirrors(reader, chatId, await reader.listEntities({ chatId }));
      // Totals per kind over every listed page, before the kind filter, so one request can label every kind chip.
      const kindTotals = Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, 0])) as Record<string, number>;
      for (const entity of entities) kindTotals[entity.kind] = (kindTotals[entity.kind] ?? 0) + 1;
      const order = query.data.sort === "kind" ? sortEntitiesByKind : sortEntities;
      if (query.data.kind) entities = entities.filter((entity) => entity.kind === query.data.kind);
      if (query.data.owner) {
        const separator = query.data.owner.indexOf(":");
        const store = query.data.owner.slice(0, separator);
        const recordId = query.data.owner.slice(separator + 1);
        entities = entities.filter((entity) => entity.owner.store === store && entity.owner.recordId === recordId);
      }
      const search = query.data.q?.toLocaleLowerCase();
      if (!search) {
        entities.sort(order);
        return { ...page(entities, query.data.offset, query.data.limit), kindTotals };
      }
      const ranked = entities.flatMap((entity) => {
        const tier = matchTier(entity, search);
        return tier ? [{ ...entity, matchTier: tier }] : [];
      });
      ranked.sort(
        (left, right) => MATCH_TIER_RANK[left.matchTier] - MATCH_TIER_RANK[right.matchTier] || order(left, right),
      );
      return { ...page(ranked, query.data.offset, query.data.limit), kindTotals };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/entities/:entityId", async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "campaignWiki")) return;
    const query = querySchema.safeParse(req.query ?? {});
    if (!query.success)
      return reply.status(400).send({
        error: { code: "INVALID_QUERY", message: "Invalid campaign memory query", details: query.error.flatten() },
      });
    const { chatId, entityId: requestedEntityId } = req.params as { chatId: string; entityId: string };
    try {
      const scope = { chatId };
      const { reader: storage, projection } = await memoryScope(req, chatId);
      const entityId = canonicalEntityId(projection, requestedEntityId);
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
        projection
          ? readCampaignMemorySourcesForProjection(app.db, projection)
          : readCampaignMemorySources(app.db, { chatId }),
      ]);
      const entityById = new Map(allEntities.map((item) => [item.entityId, item]));
      const knowledgeByFact = new Map<string, typeof knowledge>();
      for (const item of knowledge) {
        if (!item.factId) continue;
        const list = knowledgeByFact.get(item.factId) ?? [];
        list.push(item);
        knowledgeByFact.set(item.factId, list);
      }
      const coHoldersOf = (factId: string) =>
        (knowledgeByFact.get(factId) ?? [])
          .filter((item) => item.holderEntityId !== entityId)
          .map((item) => ({ ...entityRef(entityById, item.holderEntityId), epistemicState: item.epistemicState }))
          .sort((left, right) => left.alias.localeCompare(right.alias) || left.entityId.localeCompare(right.entityId));
      const withCoHolders = (item: CampaignMemoryFact) => ({ ...item, coHolders: coHoldersOf(item.factId) });
      // Per-session and per-kind counts cover every fact about the entity, whatever the filters and page.
      const entityFacts = facts.filter((item) => item.subjectEntityId === entityId);
      const tally = <K>(keyOf: (fact: CampaignMemoryFact) => K) => {
        const counts = new Map<K, number>();
        for (const fact of entityFacts) counts.set(keyOf(fact), (counts.get(keyOf(fact)) ?? 0) + 1);
        return counts;
      };
      const factSessions = [...tally(factSessionOf)]
        .map(([sessionNumber, total]) => ({ sessionNumber, total }))
        .sort((left, right) => (right.sessionNumber ?? 0) - (left.sessionNumber ?? 0));
      const factKinds = [...tally(factKindOf)]
        .map(([kind, total]) => ({ kind, total }))
        .sort((left, right) => right.total - left.total || left.kind.localeCompare(right.kind));
      const factSearch = query.data.factQuery?.toLocaleLowerCase();
      const factPage = page(
        entityFacts
          .filter((item) => !query.data.session || factSessionOf(item) === query.data.session)
          .filter((item) => !query.data.factKind || factKindOf(item) === query.data.factKind)
          .filter(
            (item) =>
              !factSearch || `${item.predicate} ${JSON.stringify(item.value)}`.toLocaleLowerCase().includes(factSearch),
          )
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
      const checkedFactIds = new Set(knowledgePage.items.flatMap((item) => (item.factId ? [item.factId] : [])));
      const allFactRecords: EvidenceRecord[] = facts
        .filter((item) => checkedFactIds.has(item.factId))
        .map((item) => ({
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
            events
              .filter((item) => referencedEventIds.has(item.eventId))
              .map((item) => ({
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
      const detail: CampaignMemoryEntityDetail & {
        factSessions: Array<{ sessionNumber: number | null; total: number }>;
        factKinds: Array<{ kind: string; total: number }>;
      } = {
        entity,
        factSessions,
        factKinds,
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
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "campaignWiki")) return;
    const parsedQuery = querySchema.safeParse(req.query ?? {});
    const parsedSection = sectionSchema.safeParse((req.params as { section: string }).section);
    if (!parsedQuery.success || !parsedSection.success)
      return reply
        .status(400)
        .send({ error: { code: "INVALID_QUERY", message: "Invalid campaign memory section query" } });
    const { chatId, entityId: requestedEntityId } = req.params as { chatId: string; entityId: string };
    try {
      // Inside the try: building the projection can fail (a missing chat), which must answer as an error response.
      const { reader: storage, projection } = await memoryScope(req, chatId);
      const entityId = canonicalEntityId(projection, requestedEntityId);
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
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "campaignWiki")) return;
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
      const { reader: storage, projection } = await memoryScope(req, chatId);
      const scope = { chatId };
      const [events, currentState, entities, facts] = await Promise.all([
        storage.listEvents(scope),
        storage.listCurrentState(scope),
        storage.listEntities(scope),
        storage.listFacts(scope),
      ]);
      // Events carry projected ids; a filter naming another session's copy of the entity must still match.
      const entityId = query.data.entityId ? canonicalEntityId(projection, query.data.entityId) : undefined;
      const locationId = query.data.locationId ? canonicalEntityId(projection, query.data.locationId) : undefined;
      const ordered = events
        .filter((event) => !entityId || eventInvolves(event, entityId))
        .filter((event) => !locationId || event.locationEntityId === locationId)
        .sort(sortRecords);
      if (query.data.order === "desc") ordered.reverse();
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
      const summaries = eventSummaries(slice, facts, currentState, entityById, events);
      return {
        items: slice.map((event) => ({
          eventId: event.eventId,
          occurrenceOrder: event.occurrenceOrder,
          campaignTime: event.campaignTime ?? null,
          location: event.locationEntityId ? entityRef(entityById, event.locationEntityId) : null,
          participants: event.participantEntityIds.map((id) => entityRef(entityById, id)),
          summary: summaries.get(event.eventId) ?? "",
          stateChanges: (changesByEvent.get(event.eventId) ?? []).sort(
            (left, right) => left.entityId.localeCompare(right.entityId) || left.key.localeCompare(right.key),
          ),
          sourceMessageId: event.evidence[0]?.messageId ?? null,
          // Campaign scope: the session the event was recorded in, so the timeline can group by session.
          ...originFields(event),
        })),
        nextCursor: start + query.data.limit < ordered.length ? (slice.at(-1)?.eventId ?? null) : null,
      };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/factions/entities", async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "factionWeb")) return;
    const query = z
      .object({
        scope: z.enum(["session", "campaign"]).optional(),
        q: z.string().trim().max(100).optional(),
        kind: z.literal("organization").optional(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .safeParse(req.query ?? {});
    if (!query.success)
      return reply.status(400).send({ error: { code: "INVALID_QUERY", message: "Invalid faction entity query" } });
    const { chatId } = req.params as { chatId: string };
    try {
      const { reader } = await memoryScope(req, chatId);
      const search = query.data.q?.toLocaleLowerCase();
      const entities = (await reader.listEntities({ chatId }))
        .filter((entity) => entity.kind === "organization")
        .filter(
          (entity) =>
            !search ||
            entity.entityId.toLocaleLowerCase().includes(search) ||
            entity.aliases.some((alias) => alias.toLocaleLowerCase().includes(search)),
        )
        .map(({ entityId, aliases, kind, status }) => ({ entityId, aliases, kind, status }));
      return page(entities, query.data.offset, query.data.limit);
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/factions", async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "factionWeb")) return;
    const query = z
      .object({
        entityId: z.string().trim().min(1).max(300),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(20).default(8),
        includeEnded: z.enum(["true", "false"]).default("false"),
      })
      .safeParse(req.query);
    if (!query.success)
      return reply.status(400).send({
        error: { code: "INVALID_QUERY", message: "Invalid faction query" },
      });
    const { chatId } = req.params as { chatId: string };
    try {
      const { reader, projection } = await memoryScope(req, chatId);
      const [entities, relationships] = await Promise.all([
        reader.listEntities({ chatId }),
        reader.listRelationships({ chatId }),
      ]);
      const entityId = canonicalEntityId(projection, query.data.entityId);
      if (!entities.some((entity) => entity.entityId === entityId && entity.kind === "organization"))
        return reply.status(404).send({
          error: {
            code: "CAMPAIGN_MEMORY_NOT_FOUND",
            message: "Organization not found",
          },
        });
      return buildCampaignFactionWeb(
        entities,
        relationships,
        entityId,
        query.data.offset,
        query.data.limit,
        query.data.includeEnded === "true",
      );
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  // Campaign-wide fact list, for the wiki's Canon page: newest session first, each with its subject's name.
  app.get("/:chatId/memory/facts", async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "campaignWiki")) return;
    const query = factsQuerySchema.safeParse(req.query ?? {});
    if (!query.success)
      return reply.status(400).send({
        error: {
          code: "INVALID_QUERY",
          message: "Invalid campaign memory facts query",
          details: query.error.flatten(),
        },
      });
    const { chatId } = req.params as { chatId: string };
    try {
      const { reader } = await memoryScope(req, chatId);
      const [facts, entities] = await Promise.all([reader.listFacts({ chatId }), reader.listEntities({ chatId })]);
      const entityById = new Map(entities.map((item) => [item.entityId, item]));
      const search = query.data.q?.toLocaleLowerCase();
      const matching = facts
        .filter((fact) => query.data.pinned === undefined || isPinnedFact(fact) === (query.data.pinned === "true"))
        .filter(
          (fact) => !search || `${fact.predicate} ${JSON.stringify(fact.value)}`.toLocaleLowerCase().includes(search),
        )
        .sort(
          (left, right) =>
            (factSessionOf(right) ?? 0) - (factSessionOf(left) ?? 0) ||
            String(right.validFromOrder ?? "").localeCompare(String(left.validFromOrder ?? "")) ||
            left.factId.localeCompare(right.factId),
        );
      const result = page(matching, query.data.offset, query.data.limit);
      return {
        ...result,
        items: result.items.map((fact) => ({
          ...fact,
          subject: entityRef(entityById, fact.subjectEntityId),
          ...originFields(fact),
        })),
      };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/facts/:factId/dependents", async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "campaignWiki")) return;
    const { chatId, factId } = req.params as { chatId: string; factId: string };
    try {
      const { reader: storage } = await memoryScope(req, chatId);
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
      const summaries = eventSummaries(
        dependentEvents,
        await storage.listFacts(scope),
        currentState,
        entityById,
        events,
      );
      return {
        knowledge: knowledge
          .filter((item) => item.factId === fact.factId)
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
        events: dependentEvents.map((event) => ({
          eventId: event.eventId,
          summary: summaries.get(event.eventId) ?? "",
        })),
      };
    } catch (error) {
      return errorResponse(reply, error);
    }
  });

  app.get("/:chatId/memory/entities/:entityId/references", async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "campaignWiki")) return;
    const { chatId, entityId: requestedEntityId } = req.params as { chatId: string; entityId: string };
    try {
      // Inside the try: building the projection can fail (a missing chat), which must answer as an error response.
      const { reader: storage, projection } = await memoryScope(req, chatId);
      const entityId = canonicalEntityId(projection, requestedEntityId);
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
}
