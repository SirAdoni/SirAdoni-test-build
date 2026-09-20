import { createHash } from "node:crypto";
import type {
  CampaignMemoryCurrentState,
  CampaignMemoryEntity,
  CampaignMemoryEvent,
  CampaignMemoryFact,
  CampaignMemoryKnowledge,
  CampaignMemoryRelationship,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { chats } from "../../db/schema/index.js";
import { createCampaignMemoryStorage } from "../storage/campaign-memory.storage.js";
import { createLorebooksStorage } from "../storage/lorebooks.storage.js";
import { resolveLorebookScopeExclusions } from "../lorebook/game-lorebook-scope.js";
import { createCampaignMemoryOwnerReader } from "./campaign-memory-owners.js";
import { parseCampaignMemoryMessageOrder } from "./campaign-memory-order.js";
import { readCampaignMemorySources } from "./campaign-memory-sources.js";
import { readGameContinuityState } from "./continuity-state.js";
import { logger } from "../../lib/logger.js";

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

export type CampaignMemoryAudience = { kind: "gm" } | { kind: "character"; entityId: string };
export interface CampaignMemoryContextInput {
  chatId: string;
  audience: CampaignMemoryAudience;
  entities: readonly CampaignMemoryEntity[];
  facts: readonly CampaignMemoryFact[];
  knowledge: readonly CampaignMemoryKnowledge[];
  events: readonly CampaignMemoryEvent[];
  currentState: readonly CampaignMemoryCurrentState[];
  relationships: readonly CampaignMemoryRelationship[];
  maxCharacters: number;
  cutoffOrder?: string;
  /** Current source text, keyed by message ID. Omitted sources are not freshness-checked. */
  sourceContents?: Readonly<
    Record<string, { chatId: string; content: string; sourceHash?: string; captureOrder?: string }>
  >;
  /**
   * Entity IDs physically present in the current scene, supplied by the authoritative
   * game-state presence. Undefined means presence is unknown for this request.
   */
  presentEntityIds?: readonly string[];
  /**
   * Entity IDs the current scene is about: people and places named in the player's message and the latest turns.
   * GM ordering only; this never asserts presence or grants a character audience any knowledge.
   */
  focusEntityIds?: readonly string[];
  /** Continuity records rendered as receipts on the same request; a matching fact is merged instead of repeated. */
  continuityReceiptRecords?: readonly CampaignMemoryContinuityReceiptRecord[];
}

export interface CampaignMemoryContinuityReceiptRecord {
  receiptId: string;
  recordId: string;
  evidenceMessageIds: readonly string[];
  subjects: readonly string[];
}

/** What one present character may use from the rendered GM block. */
export interface CampaignMemoryCharacterBoundary {
  entityId: string;
  kind: CampaignMemoryEntity["kind"];
  aliases: string[];
  /** Included record IDs this holder may use: its own knowledge (and the facts they cite) plus evidence-backed world-scope facts. */
  mayUseIds: string[];
}

export interface CampaignMemoryOmissions {
  /** Records that passed validation but did not fit the character budget. */
  budgetOmitted: number;
  /** Facts already rendered as continuity receipts on the same request. */
  duplicatesMerged: number;
  mergedIds: string[];
}

export interface CampaignMemoryContextResult {
  text: string;
  includedIds: string[];
  exclusions: Array<{ id: string; reason: string }>;
  degraded: boolean;
  /** Present only when the caller supplied presence for a GM projection. */
  characterBoundaries?: CampaignMemoryCharacterBoundary[];
  omissions?: CampaignMemoryOmissions;
  /** Rows rendered in the `[current_state]` section; they override stale card text. */
  currentStateCount?: number;
}

type Block = {
  id: string;
  text: string;
  priority: number;
  entityRefs: readonly string[];
  order?: string;
  section?: "current_state";
};
const RECENT_EVENT_WINDOW = 5;
const CURRENT_STATE_HEADER = "[current_state]";

function normalizedSubject(value: string): string {
  return value.trim().normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
}

/** A fact duplicates a receipt record when every evidence message matches and the subject matches. */
function duplicateReceiptRecord(
  fact: CampaignMemoryFact,
  subjectAliases: readonly string[],
  records: readonly CampaignMemoryContinuityReceiptRecord[],
): CampaignMemoryContinuityReceiptRecord | null {
  const messageIds = [...new Set(fact.evidence.map((item) => item.messageId))];
  if (!messageIds.length) return null;
  const factValue = objectValue(fact.value);
  const factSubjects = new Set(
    [...(Array.isArray(factValue.subjects) ? factValue.subjects : []), ...subjectAliases]
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map(normalizedSubject),
  );
  for (const record of records) {
    if (!messageIds.every((id) => record.evidenceMessageIds.includes(id))) continue;
    if (factValue.recordId === record.recordId && factValue.receiptId === record.receiptId) return record;
    if (record.subjects.some((subject) => factSubjects.has(normalizedSubject(subject)))) return record;
  }
  return null;
}

/** Evidence-backed common knowledge: a verified fact whose reviewed scope is world-wide. */
function isWorldScopeFact(fact: CampaignMemoryFact): boolean {
  const knowledge = objectValue(objectValue(fact.value).knowledge);
  return fact.evidence.length > 0 && knowledge.scope === "world";
}
/** A state row every character may see: its value carries the same reviewed world scope as a world fact. */
function isWorldScopeState(state: CampaignMemoryCurrentState): boolean {
  return objectValue(objectValue(state.value).knowledge).scope === "world";
}
const readableFact = new Set(["verified"]);
const validKnowledge = new Set(["knows", "believes", "rumor"]);

function before(a: string | undefined, cutoff: string | undefined): boolean {
  if (!cutoff) return true;
  if (!a) return false;
  const parsedOrder = parseCampaignMemoryMessageOrder(a);
  const parsedCutoff = parseCampaignMemoryMessageOrder(cutoff);
  return Boolean(parsedOrder && parsedCutoff && a <= cutoff);
}
function value(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
function fresh(
  evidence: readonly { messageId: string; quote: string; sourceHash?: string }[],
  sourceContents: CampaignMemoryContextInput["sourceContents"],
  chatId: string,
  cutoff?: string,
): string | null {
  if (!sourceContents) return cutoff && evidence.length ? "evidence source order unavailable at cutoff" : null;
  for (const item of evidence) {
    const source = sourceContents[item.messageId];
    if (!source || source.chatId !== chatId) return "stale or cross-chat evidence";
    if (!item.sourceHash) return "legacy evidence has no verified source revision";
    if (createHash("sha256").update(source.content).digest("hex") !== item.sourceHash) return "stale source revision";
    if (!source.content.includes(item.quote)) return "stale evidence quote";
    if (cutoff) {
      const sourceOrder = source.captureOrder ? parseCampaignMemoryMessageOrder(source.captureOrder) : null;
      const cutoffOrder = parseCampaignMemoryMessageOrder(cutoff);
      if (!sourceOrder || !cutoffOrder || source.captureOrder! > cutoff)
        return "evidence source is after or unknown at cutoff";
    }
  }
  return null;
}

/** Pure, deterministic role projection. It never resolves names or reads owner stores. */
export function buildCampaignMemoryContext(input: CampaignMemoryContextInput): CampaignMemoryContextResult {
  const exclusions: Array<{ id: string; reason: string }> = [];
  const blocks: Block[] = [];
  const cutoff = input.cutoffOrder;
  const characterEntityId = input.audience.kind === "character" ? input.audience.entityId : null;
  const facts = new Map(input.facts.filter((fact) => fact.chatId === input.chatId).map((fact) => [fact.factId, fact]));
  const entityIds = new Set(
    input.entities.filter((entity) => entity.chatId === input.chatId).map((entity) => entity.entityId),
  );
  const audienceEntity = characterEntityId
    ? input.entities.find((entity) => entity.entityId === characterEntityId && entity.chatId === input.chatId)
    : null;
  if (characterEntityId && (!audienceEntity || !["character", "persona"].includes(audienceEntity.kind))) {
    exclusions.push({ id: characterEntityId, reason: "character audience entity is missing or invalid" });
    return { text: "", includedIds: [], exclusions, degraded: true };
  }
  const eligibleFacts = new Map<string, CampaignMemoryFact>();
  const referencedEntityIds = new Set<string>();
  const audienceIsGm = input.audience.kind === "gm";
  const entityById = new Map(
    input.entities.filter((entity) => entity.chatId === input.chatId).map((entity) => [entity.entityId, entity]),
  );
  const receiptRecords = audienceIsGm ? (input.continuityReceiptRecords ?? []) : [];
  const mergedIds: string[] = [];
  const worldFactIds = new Set<string>();

  for (const fact of facts.values()) {
    if (!entityIds.has(fact.subjectEntityId)) {
      exclusions.push({ id: fact.factId, reason: "fact subject is outside the supplied chat projection" });
      continue;
    }
    if (!readableFact.has(fact.status)) {
      exclusions.push({ id: fact.factId, reason: `fact status ${fact.status} is not readable` });
      continue;
    }
    if ((cutoff && !fact.validFromOrder) || (fact.validFromOrder && !before(fact.validFromOrder, cutoff))) {
      exclusions.push({ id: fact.factId, reason: "fact is from the future" });
      continue;
    }
    if (fact.validToOrder && cutoff && fact.validToOrder <= cutoff) {
      exclusions.push({ id: fact.factId, reason: "fact is no longer valid at cutoff" });
      continue;
    }
    const stale = fresh(fact.evidence, input.sourceContents, input.chatId, cutoff);
    if (stale) {
      exclusions.push({ id: fact.factId, reason: stale });
      continue;
    }
    eligibleFacts.set(fact.factId, fact);
    if (audienceIsGm) {
      if (isWorldScopeFact(fact)) worldFactIds.add(fact.factId);
      const duplicate = receiptRecords.length
        ? duplicateReceiptRecord(fact, entityById.get(fact.subjectEntityId)?.aliases ?? [], receiptRecords)
        : null;
      if (duplicate) {
        // The receipt line already carries this text; keep the fact eligible for knowledge attribution.
        mergedIds.push(fact.factId);
        exclusions.push({
          id: fact.factId,
          reason: `merged with continuity receipt ${duplicate.receiptId} record ${duplicate.recordId}`,
        });
        continue;
      }
      referencedEntityIds.add(fact.subjectEntityId);
      const conditions = fact.conditions.length
        ? ` conditions=${fact.conditions.map((condition) => `${condition.kind}:${value(condition.value)}`).join(",")}`
        : "";
      blocks.push({
        id: fact.factId,
        priority: 0,
        entityRefs: [fact.subjectEntityId],
        order: fact.validFromOrder,
        text: `[fact ${fact.factId}] ${fact.subjectEntityId}.${fact.predicate} = ${value(fact.value)}${conditions}`,
      });
    }
  }

  for (const knowledge of input.knowledge.filter((item) => item.chatId === input.chatId)) {
    if (!entityIds.has(knowledge.holderEntityId)) {
      exclusions.push({
        id: knowledge.knowledgeId,
        reason: "knowledge holder is outside the supplied chat projection",
      });
      continue;
    }
    if (
      !validKnowledge.has(knowledge.epistemicState) ||
      (cutoff && !knowledge.learnedAtOrder) ||
      !before(knowledge.learnedAtOrder, cutoff)
    ) {
      exclusions.push({ id: knowledge.knowledgeId, reason: "knowledge is unknown or learned after cutoff" });
      continue;
    }
    const stale = fresh(knowledge.learnedFrom, input.sourceContents, input.chatId, cutoff);
    if (stale) {
      exclusions.push({ id: knowledge.knowledgeId, reason: stale });
      continue;
    }
    if (!audienceIsGm && knowledge.holderEntityId !== characterEntityId) {
      exclusions.push({ id: knowledge.knowledgeId, reason: "knowledge is held by another entity" });
      continue;
    }
    if (knowledge.factId) {
      const fact = eligibleFacts.get(knowledge.factId);
      if (!fact) {
        exclusions.push({ id: knowledge.knowledgeId, reason: "knowledge references an unavailable fact" });
        continue;
      }
      referencedEntityIds.add(fact.subjectEntityId);
      const conditions = fact.conditions.length
        ? ` conditions=${fact.conditions.map((condition) => `${condition.kind}:${value(condition.value)}`).join(",")}`
        : "";
      referencedEntityIds.add(knowledge.holderEntityId);
      blocks.push({
        id: knowledge.knowledgeId,
        priority: 0,
        entityRefs: [knowledge.holderEntityId, fact.subjectEntityId],
        order: knowledge.learnedAtOrder,
        text: `[knowledge ${knowledge.knowledgeId} holder=${knowledge.holderEntityId}] ${fact.subjectEntityId}.${fact.predicate} = ${value(fact.value)}${conditions} (${knowledge.epistemicState})`,
      });
    } else if (knowledge.attributedClaim) {
      if (!entityIds.has(knowledge.attributedClaim.subjectEntityId)) {
        exclusions.push({ id: knowledge.knowledgeId, reason: "claim subject is outside the supplied chat projection" });
        continue;
      }
      const claim = knowledge.attributedClaim;
      referencedEntityIds.add(claim.subjectEntityId);
      referencedEntityIds.add(knowledge.holderEntityId);
      blocks.push({
        id: knowledge.knowledgeId,
        priority: 0,
        entityRefs: [knowledge.holderEntityId, claim.subjectEntityId],
        order: knowledge.learnedAtOrder,
        text: `[claim ${knowledge.knowledgeId} holder=${knowledge.holderEntityId}] ${claim.subjectEntityId}.${claim.predicate} = ${value(claim.value)} (${knowledge.epistemicState})`,
      });
    } else {
      exclusions.push({ id: knowledge.knowledgeId, reason: "knowledge has no fact or attributed claim" });
    }
  }

  for (const entity of input.entities.filter((item) => item.chatId === input.chatId && item.status === "active")) {
    if (!referencedEntityIds.has(entity.entityId)) continue;
    const aliases = entity.aliases.length ? ` aliases=${entity.aliases.join(",")}` : "";
    blocks.push({
      id: entity.entityId,
      priority: 2,
      entityRefs: [entity.entityId],
      text: `[entity ${entity.entityId}${aliases}]`,
    });
  }
  const validEvents = new Set<string>();
  const eventEntityIds = new Set<string>();
  for (const event of input.events.filter(
    (item) => item.chatId === input.chatId && before(item.occurrenceOrder, cutoff),
  )) {
    const stale = fresh(event.evidence, input.sourceContents, input.chatId, cutoff);
    const refs = [...event.participantEntityIds, ...(event.locationEntityId ? [event.locationEntityId] : [])];
    if (stale || !refs.every((id) => entityIds.has(id))) {
      if (audienceIsGm)
        exclusions.push({
          id: event.eventId,
          reason: stale ?? "event references an entity outside the supplied chat projection",
        });
      continue;
    }
    validEvents.add(event.eventId);
    for (const id of refs) eventEntityIds.add(id);
    if (audienceIsGm)
      blocks.push({
        id: event.eventId,
        priority: 1,
        entityRefs: refs,
        order: event.occurrenceOrder,
        text: `[event ${event.eventId}] ${event.transitions.join("; ")}`,
      });
  }
  // Current state overrides stale card text, so it renders ahead of facts. The GM sees every
  // present or referenced entity; a character sees only itself, entities its knowledge names,
  // and world-scope state.
  const presentIds = new Set(input.presentEntityIds ?? []);
  const focusIds = new Set(audienceIsGm ? (input.focusEntityIds ?? []) : []);
  for (const state of input.currentState.filter(
    (item) => item.chatId === input.chatId && before(item.validAtOrder, cutoff),
  )) {
    if (!validEvents.has(state.sourceEventId) || !entityIds.has(state.entityId)) {
      exclusions.push({ id: state.stateId, reason: "current state references an unavailable event or entity" });
      continue;
    }
    const known = audienceIsGm
      ? presentIds.has(state.entityId) ||
        focusIds.has(state.entityId) ||
        referencedEntityIds.has(state.entityId) ||
        eventEntityIds.has(state.entityId)
      : state.entityId === characterEntityId || referencedEntityIds.has(state.entityId);
    if (!known && !isWorldScopeState(state)) {
      exclusions.push({ id: state.stateId, reason: "current state entity is not present, referenced, or known" });
      continue;
    }
    blocks.push({
      id: state.stateId,
      priority: -1,
      section: "current_state",
      entityRefs: [state.entityId],
      order: state.validAtOrder,
      text: `${state.entityId}.${state.property} = ${value(state.value)} (since ${state.validAtOrder}, source event ${state.sourceEventId})`,
    });
  }
  if (audienceIsGm) {
    for (const relationship of input.relationships.filter(
      (item) => item.chatId === input.chatId && item.status === "active",
    )) {
      const stale = fresh(relationship.evidence, input.sourceContents, input.chatId, cutoff);
      if (
        stale ||
        !entityIds.has(relationship.sourceEntityId) ||
        !entityIds.has(relationship.targetEntityId) ||
        !before(relationship.effectiveFrom, cutoff) ||
        (cutoff && relationship.effectiveTo && relationship.effectiveTo <= cutoff)
      ) {
        exclusions.push({
          id: relationship.relationshipId,
          reason: stale ?? "relationship is outside the valid scoped projection",
        });
        continue;
      }
      blocks.push({
        id: relationship.relationshipId,
        priority: 2,
        entityRefs: [relationship.sourceEntityId, relationship.targetEntityId],
        order: relationship.effectiveFrom,
        text: `[relationship ${relationship.relationshipId}] ${relationship.sourceEntityId} ${relationship.type} ${relationship.targetEntityId}`,
      });
    }
  }

  // Relevance: present entities first, then participants of the newest events, then everything else.
  // Within a tier the newest source order wins; records without an order keep their ID order last.
  const present = presentIds;
  const recentParticipants = new Set<string>();
  const eventIds = new Set(input.events.map((event) => event.eventId));
  const newestEvents = blocks
    .filter((block) => block.priority === 1 && eventIds.has(block.id))
    .sort((a, b) => (b.order ?? "").localeCompare(a.order ?? ""))
    .slice(0, RECENT_EVENT_WINDOW);
  for (const block of newestEvents) for (const ref of block.entityRefs) recentParticipants.add(ref);
  // Present first, then whoever the scene is talking about, then participants of the newest events.
  const relevance = (block: Block): number =>
    block.entityRefs.some((ref) => present.has(ref))
      ? 0
      : block.entityRefs.some((ref) => focusIds.has(ref))
        ? 1
        : block.entityRefs.some((ref) => recentParticipants.has(ref))
          ? 2
          : 3;
  const orderRank = (a: Block, b: Block): number => {
    if (a.order && b.order) return b.order.localeCompare(a.order);
    if (a.order || b.order) return a.order ? -1 : 1;
    return 0;
  };
  blocks.sort(
    (a, b) => a.priority - b.priority || relevance(a) - relevance(b) || orderRank(a, b) || a.id.localeCompare(b.id),
  );
  const max = Math.max(0, Math.floor(input.maxCharacters));
  const chosen: Block[] = [];
  const lines: string[] = [];
  let used = 0;
  let budgetOmitted = 0;
  let currentStateCount = 0;
  for (const block of blocks) {
    // The section header is charged to the budget together with its first row.
    const header = block.section === "current_state" && !currentStateCount ? `${CURRENT_STATE_HEADER}\n` : "";
    const addition = (chosen.length ? "\n" : "") + header + block.text;
    if (used + addition.length > max) {
      budgetOmitted += 1;
      exclusions.push({ id: block.id, reason: "omitted by character budget" });
      continue;
    }
    if (header) lines.push(CURRENT_STATE_HEADER);
    if (block.section === "current_state") currentStateCount += 1;
    lines.push(block.text);
    chosen.push(block);
    used += addition.length;
  }
  const degraded = exclusions.some(
    ({ reason }) =>
      reason.includes("budget") ||
      reason.includes("stale") ||
      reason.includes("cross-chat") ||
      reason.includes("outside the supplied") ||
      reason.includes("unavailable") ||
      reason.includes("invalid"),
  );
  const includedIds = chosen.map((block) => block.id);
  const result: CampaignMemoryContextResult = {
    text: lines.join("\n"),
    includedIds,
    exclusions,
    degraded,
    omissions: { budgetOmitted, duplicatesMerged: mergedIds.length, mergedIds },
    currentStateCount,
  };
  if (audienceIsGm && input.presentEntityIds) {
    const included = new Set(includedIds);
    const includedKnowledge = input.knowledge.filter(
      (item) => item.chatId === input.chatId && included.has(item.knowledgeId),
    );
    result.characterBoundaries = [...present]
      .map((entityId) => entityById.get(entityId))
      .filter(
        (entity): entity is CampaignMemoryEntity =>
          Boolean(entity) && entity!.status === "active" && ["character", "persona"].includes(entity!.kind),
      )
      .sort((a, b) => a.entityId.localeCompare(b.entityId))
      .map((entity) => {
        const mayUse = new Set<string>();
        for (const item of includedKnowledge) {
          if (item.holderEntityId !== entity.entityId) continue;
          mayUse.add(item.knowledgeId);
          if (item.factId && included.has(item.factId)) mayUse.add(item.factId);
        }
        for (const factId of worldFactIds) if (included.has(factId)) mayUse.add(factId);
        return {
          entityId: entity.entityId,
          kind: entity.kind,
          aliases: [...entity.aliases],
          mayUseIds: [...mayUse].sort(),
        };
      });
  }
  return result;
}

export interface CampaignMemoryPresenceInput {
  /** Stable character/NPC ids present in the current scene (game-state snapshot presentCharacters). */
  characterIds: readonly string[];
  /** The player persona is always present in its own scene. */
  personaId?: string | null;
}

type StorageContextInput = Omit<
  CampaignMemoryContextInput,
  | "entities"
  | "facts"
  | "knowledge"
  | "events"
  | "currentState"
  | "relationships"
  | "sourceContents"
  | "presentEntityIds"
  | "continuityReceiptRecords"
> & {
  /** Resolved to entity IDs through existing owner refs only; names are never used as identity. */
  presence?: CampaignMemoryPresenceInput;
  /** Merge facts already rendered as continuity receipts on the same request (GM audience only). */
  dedupeContinuityReceipts?: boolean;
  /** Recent scene text; registered people and places it names are prioritised for the GM. */
  focusTexts?: readonly string[];
};

function focusKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Registered people, places, groups and items whose names appear in the scene text. Ordering only, never identity. */
export function resolveFocusEntityIds(entities: readonly CampaignMemoryEntity[], texts: readonly string[]): string[] {
  const haystack = ` ${texts.map(focusKey).join(" ")} `;
  if (!haystack.trim()) return [];
  const kinds = new Set(["character", "persona", "location", "organization", "item", "quest"]);
  return entities
    .filter(
      (entity) =>
        entity.status === "active" &&
        kinds.has(entity.kind) &&
        entity.aliases.some((alias) => {
          const key = focusKey(alias);
          return key.length >= 4 && haystack.includes(` ${key} `);
        }),
    )
    .map((entity) => entity.entityId)
    .sort();
}

/** Map authoritative presence to entity IDs through exact owner references. */
export function resolvePresentEntityIds(
  entities: readonly CampaignMemoryEntity[],
  presence: CampaignMemoryPresenceInput,
): string[] {
  const characterIds = new Set(presence.characterIds.map((id) => id.trim()).filter(Boolean));
  return entities
    .filter((entity) => {
      if (entity.status !== "active" || entity.owner.type !== "existing") return false;
      if (entity.owner.store === "characters" || entity.owner.store === "game-npcs")
        return characterIds.has(entity.owner.recordId);
      if (entity.owner.store === "personas")
        return Boolean(presence.personaId) && entity.owner.recordId === presence.personaId;
      return false;
    })
    .map((entity) => entity.entityId)
    .sort();
}

async function readContinuityReceiptRecords(
  db: DB,
  chatId: string,
): Promise<CampaignMemoryContinuityReceiptRecord[] | undefined> {
  try {
    const state = await readGameContinuityState(db, chatId);
    return state.records
      .filter((record) => record.evidence.length > 0)
      .map((record) => ({
        receiptId: record.receiptId,
        recordId: record.id,
        evidenceMessageIds: [...new Set(record.evidence.map((item) => item.messageId))],
        subjects: [...record.subjects],
      }));
  } catch (err) {
    logger.warn(
      { err, code: "CAMPAIGN_MEMORY_RECEIPT_DEDUP_UNAVAILABLE", chatId },
      "Continuity receipts unavailable; campaign memory is not deduplicated",
    );
    return undefined;
  }
}

/** Production read wrapper: every list is scoped to the requested chat and evidence is checked against current messages. */
export async function buildCampaignMemoryContextFromStorage(
  db: DB,
  input: StorageContextInput,
): Promise<CampaignMemoryContextResult> {
  const { presence, dedupeContinuityReceipts, focusTexts, ...contextInput } = input;
  const continuityReceiptRecords =
    dedupeContinuityReceipts && contextInput.audience.kind === "gm"
      ? await readContinuityReceiptRecords(db, input.chatId)
      : undefined;
  return db.transaction(async (tx) => {
    const storage = createCampaignMemoryStorage(tx);
    const scope = { chatId: input.chatId };
    const [entities, facts, knowledge, events, currentState, relationships, sourceRows] = await Promise.all([
      storage.listEntities(scope),
      storage.listFacts(scope),
      storage.listKnowledge(scope),
      storage.listEvents(scope),
      storage.listCurrentState(scope),
      storage.listRelationships(scope),
      readCampaignMemorySources(tx, scope),
    ]);
    const chat = (
      await tx
        .select({ mode: chats.mode, metadata: chats.metadata })
        .from(chats)
        .where(eq(chats.id, input.chatId))
        .limit(1)
    )[0];
    const loreEntities = entities.filter(
      (entity) => entity.owner.type === "existing" && entity.owner.store === "lorebook-entries",
    );
    const ownerScope = await createCampaignMemoryOwnerReader(tx).readChatScope(input.chatId);
    const scopedLoreIds = new Set(ownerScope?.lorebookEntryIds ?? []);
    const eligibleLoreIds = new Set(
      (
        await createLorebooksStorage(tx).listEligibleEntriesByIds(
          loreEntities
            .filter((entity) => scopedLoreIds.has(entity.owner.recordId))
            .map((entity) => entity.owner.recordId),
          resolveLorebookScopeExclusions(chat?.mode, objectValue(chat?.metadata)),
        )
      ).map((entry) => entry.id),
    );
    const hiddenEntities = new Set(
      loreEntities.filter((entity) => !eligibleLoreIds.has(entity.owner.recordId)).map((entity) => entity.entityId),
    );
    const visibleEntities = entities.filter((entity) => !hiddenEntities.has(entity.entityId));
    const visibleFacts = facts.filter((fact) => !hiddenEntities.has(fact.subjectEntityId));
    const visibleFactIds = new Set(visibleFacts.map((fact) => fact.factId));
    const visibleKnowledge = knowledge.filter(
      (item) =>
        !hiddenEntities.has(item.holderEntityId) &&
        (!item.factId || visibleFactIds.has(item.factId)) &&
        (!item.attributedClaim || !hiddenEntities.has(item.attributedClaim.subjectEntityId)),
    );
    const visibleEvents = events.filter(
      (event) =>
        !event.participantEntityIds.some((id) => hiddenEntities.has(id)) &&
        (!event.locationEntityId || !hiddenEntities.has(event.locationEntityId)),
    );
    const visibleEventIds = new Set(visibleEvents.map((event) => event.eventId));
    const visibleCurrentState = currentState.filter(
      (state) => !hiddenEntities.has(state.entityId) && visibleEventIds.has(state.sourceEventId),
    );
    const visibleRelationships = relationships.filter(
      (relationship) =>
        !hiddenEntities.has(relationship.sourceEntityId) && !hiddenEntities.has(relationship.targetEntityId),
    );
    const sourceContents = Object.fromEntries(sourceRows);
    return buildCampaignMemoryContext({
      ...contextInput,
      entities: visibleEntities,
      facts: visibleFacts,
      knowledge: visibleKnowledge,
      events: visibleEvents,
      currentState: visibleCurrentState,
      relationships: visibleRelationships,
      sourceContents,
      ...(presence ? { presentEntityIds: resolvePresentEntityIds(visibleEntities, presence) } : {}),
      ...(focusTexts?.length ? { focusEntityIds: resolveFocusEntityIds(visibleEntities, focusTexts) } : {}),
      ...(continuityReceiptRecords ? { continuityReceiptRecords } : {}),
    });
  });
}
