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
import { createLorebooksStorage } from "../storage/lorebooks.storage.js";
import { resolveLorebookScopeExclusions } from "../lorebook/game-lorebook-scope.js";
import { createCampaignMemoryOwnerReader } from "./campaign-memory-owners.js";
import { parseCampaignMemoryMessageOrder } from "./campaign-memory-order.js";
import {
  readCampaignMemoryProjection,
  readCampaignMemorySourcesForProjection,
} from "./campaign-memory-campaign-scope.js";
import { buildGameContinuityPromptContext } from "./continuity-context.js";
import { readGameContinuityState } from "./continuity-state.js";
import { logger } from "../../lib/logger.js";

export const DEFAULT_CAMPAIGN_MEMORY_MAX_CHARACTERS = 10_000;
export const MIN_CAMPAIGN_MEMORY_MAX_CHARACTERS = 1_000;
export const MAX_CAMPAIGN_MEMORY_MAX_CHARACTERS = 100_000;

/** Metadata is user-editable; enforce the UI's hard ceiling again at the prompt boundary. */
export function normalizeCampaignMemoryMaxCharacters(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_CAMPAIGN_MEMORY_MAX_CHARACTERS &&
    value <= MAX_CAMPAIGN_MEMORY_MAX_CHARACTERS
    ? value
    : DEFAULT_CAMPAIGN_MEMORY_MAX_CHARACTERS;
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
  /** Recent scene text (lower relevance than named people): facts whose reviewed keywords appear in it rank higher. */
  focusText?: string;
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
  /** A GM knowledge line that points at a fact line by id; if that line is not rendered, `standaloneText` is used. */
  citesFactId?: string;
  standaloneText?: string;
};
const RECENT_EVENT_WINDOW = 5;
const CURRENT_STATE_HEADER = "[current_state]";

/**
 * A fact duplicates a receipt record only through an exact provenance link: the same reviewed record of the same
 * receipt, with every evidence message cited by that record. A same-subject fact from the same message is a
 * different statement and stays in the block.
 */
function duplicateReceiptRecord(
  fact: CampaignMemoryFact,
  records: readonly CampaignMemoryContinuityReceiptRecord[],
): CampaignMemoryContinuityReceiptRecord | null {
  const messageIds = [...new Set(fact.evidence.map((item) => item.messageId))];
  if (!messageIds.length) return null;
  const factValue = objectValue(fact.value);
  if (typeof factValue.recordId !== "string" || typeof factValue.receiptId !== "string") return null;
  return (
    records.find(
      (record) =>
        record.recordId === factValue.recordId &&
        record.receiptId === factValue.receiptId &&
        messageIds.every((id) => record.evidenceMessageIds.includes(id)),
    ) ?? null
  );
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
/** Continuity facts store an object with the reviewed sentence in `text`; show the sentence, not the envelope. */
function readableValue(raw: unknown, nameOf: (id: string) => string): string {
  const object = objectValue(raw);
  if (typeof object.text === "string" && object.text.trim()) return object.text.trim();
  if (typeof raw === "string") return nameOf(raw);
  return value(raw);
}
/** "condition: x" reads as just "x"; other kinds (when, until, unless) keep their word. */
function conditionText(kind: string, text: string): string {
  const label = kind.replace(/^continuity\./u, "");
  return label === "condition" ? text : `${label}: ${text}`;
}
/** A fact the player pinned as canon: `value.pinned === true` on a manually locked fact. */
export function isPinnedFact(fact: Pick<CampaignMemoryFact, "value" | "manualLock">): boolean {
  const value = fact.value as unknown;
  return (
    fact.manualLock === true &&
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { pinned?: unknown }).pinned === true
  );
}

/**
 * How a retracted statement is recognised in its other copies: the same text read from the same messages. That
 * matches its twin on another subject and a re-read of the same turn, but not the same words said again later
 * (a rumour retracted in one scene must not hide the real event in another). Same key as continuity publication.
 */
function retractedKey(fact: Pick<CampaignMemoryFact, "value" | "evidence">): string {
  const text = statementText(fact);
  if (!text) return "";
  const messageIds = [...new Set(fact.evidence.map((item) => item.messageId))].sort();
  return `${text}|${messageIds.join(",")}`;
}

/** Normalized statement text of a fact, for recognising the same claim across copies. */
function statementText(fact: Pick<CampaignMemoryFact, "value">): string {
  const value = fact.value as unknown;
  const text =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string"
        ? (value as { text: string }).text
        : "";
  return text.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function sessionTag(record: object): string {
  const number = (record as { originSessionNumber?: unknown }).originSessionNumber;
  return typeof number === "number" ? ` S${number}` : "";
}
function recordKey(fact: CampaignMemoryFact): string | null {
  const object = objectValue(fact.value);
  return typeof object.recordId === "string" && typeof object.receiptId === "string"
    ? `${object.receiptId}\u0000${object.recordId}`
    : null;
}
function keywordsOf(fact: CampaignMemoryFact): string[] {
  const keys = objectValue(fact.value).keys;
  return Array.isArray(keys)
    ? keys.filter((key): key is string => typeof key === "string" && key.trim().length >= 3)
    : [];
}
const sourceHashMemo = new WeakMap<object, Map<string, string>>();
function sourceHash(sourceContents: object, messageId: string, content: string): string {
  let memo = sourceHashMemo.get(sourceContents);
  if (!memo) {
    memo = new Map();
    sourceHashMemo.set(sourceContents, memo);
  }
  let hash = memo.get(messageId);
  if (hash === undefined) {
    hash = createHash("sha256").update(content).digest("hex");
    memo.set(messageId, hash);
  }
  return hash;
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
    if (sourceHash(sourceContents, item.messageId, source.content) !== item.sourceHash) return "stale source revision";
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
  const nameOf = (id: string): string => entityById.get(id)?.aliases.find((alias) => alias.trim()) ?? id;
  // Continuity publishes a record once per resolved subject and once more on its lore entity ("continuity.*").
  // Render each reviewed record once; the extra copies stay eligible for knowledge attribution through their twin.
  // The representative is chosen among eligible copies only (a subject copy before the lore fallback), so a held or
  // superseded copy never hides a readable twin, and knowledge or world scope on any copy follows the rendered one.
  const recordKeyOf = new Map<string, string>();
  const recordCopies = new Map<string, CampaignMemoryFact[]>();
  for (const fact of facts.values()) {
    const key = recordKey(fact);
    if (!key) continue;
    recordKeyOf.set(fact.factId, key);
    recordCopies.set(key, [...(recordCopies.get(key) ?? []), fact]);
  }
  const representative = new Map<string, string>();
  const repOf = (factId: string): string => {
    const key = recordKeyOf.get(factId);
    return (key && representative.get(key)) ?? factId;
  };
  // A statement the user retracted and locked is false canon: every other copy of it (a twin, an earlier or later
  // session's read) stays out of the block too.
  const retractedCanon = new Set(
    [...facts.values()]
      .filter((fact) => fact.status === "retracted" && fact.manualLock)
      .map(retractedKey)
      .filter(Boolean),
  );
  const focusHaystack = ` ${(input.focusText ?? "").toLowerCase()} `;
  const keywordHit = (fact: CampaignMemoryFact): boolean =>
    focusHaystack.trim().length > 0 && keywordsOf(fact).some((key) => focusHaystack.includes(key.toLowerCase()));
  const keywordFactIds = new Set<string>();
  const receiptRecords = audienceIsGm ? (input.continuityReceiptRecords ?? []) : [];
  const mergedIds: string[] = [];
  const twinIds: string[] = [];
  const worldFactIds = new Set<string>();
  const worldStateIds = new Set<string>();

  for (const fact of facts.values()) {
    if (!entityIds.has(fact.subjectEntityId)) {
      exclusions.push({ id: fact.factId, reason: "fact subject is outside the supplied chat projection" });
      continue;
    }
    if (!readableFact.has(fact.status)) {
      exclusions.push({ id: fact.factId, reason: `fact status ${fact.status} is not readable` });
      continue;
    }
    if (retractedCanon.size && retractedCanon.has(retractedKey(fact))) {
      exclusions.push({ id: fact.factId, reason: "the user retracted this statement" });
      continue;
    }
    if ((cutoff && !fact.validFromOrder) || (fact.validFromOrder && !before(fact.validFromOrder, cutoff))) {
      exclusions.push({ id: fact.factId, reason: "fact is from the future" });
      continue;
    }
    if (fact.validToOrder && (!cutoff || fact.validToOrder <= cutoff)) {
      exclusions.push({ id: fact.factId, reason: "fact is no longer valid at cutoff" });
      continue;
    }
    const stale = fresh(fact.evidence, input.sourceContents, input.chatId, cutoff);
    if (stale) {
      exclusions.push({ id: fact.factId, reason: stale });
      continue;
    }
    eligibleFacts.set(fact.factId, fact);
  }
  for (const [key, copies] of recordCopies) {
    const eligible = copies
      .filter((copy) => eligibleFacts.has(copy.factId))
      .sort(
        (a, b) =>
          Number(a.predicate.startsWith("continuity.")) - Number(b.predicate.startsWith("continuity.")) ||
          a.factId.localeCompare(b.factId),
      );
    if (eligible[0]) representative.set(key, eligible[0].factId);
  }
  for (const fact of eligibleFacts.values()) {
    if (audienceIsGm) {
      // World scope is recorded on the lore fallback; the rendered copy carries it for every character.
      const copies = recordCopies.get(recordKeyOf.get(fact.factId) ?? "") ?? [fact];
      if (copies.some(isWorldScopeFact)) worldFactIds.add(fact.factId);
      const duplicate = receiptRecords.length ? duplicateReceiptRecord(fact, receiptRecords) : null;
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
      if (repOf(fact.factId) !== fact.factId) {
        twinIds.push(fact.factId);
        exclusions.push({ id: fact.factId, reason: "same reviewed record as another rendered fact" });
        continue;
      }
      const conditions = fact.conditions.length
        ? ` (if ${fact.conditions.map((condition) => conditionText(condition.kind, readableValue(condition.value, nameOf))).join("; ")})`
        : "";
      if (keywordHit(fact)) keywordFactIds.add(fact.factId);
      const canon = isPinnedFact(fact);
      blocks.push({
        id: fact.factId,
        // Pinned canon outranks every relevance tier: the player marked it as always true.
        priority: canon ? -0.5 : 0,
        entityRefs: [fact.subjectEntityId],
        order: fact.validFromOrder,
        text: `[fact ${fact.factId}${sessionTag(fact)}${canon ? " canon" : ""}] ${nameOf(fact.subjectEntityId)}, ${fact.predicate.replace(/^continuity\./u, "")}: ${readableValue(fact.value, nameOf)}${conditions}`,
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
      const shownFactId = repOf(knowledge.factId);
      const fact = eligibleFacts.get(knowledge.factId) ?? eligibleFacts.get(shownFactId);
      if (!fact) {
        exclusions.push({ id: knowledge.knowledgeId, reason: "knowledge references an unavailable fact" });
        continue;
      }
      referencedEntityIds.add(fact.subjectEntityId);
      const conditions = fact.conditions.length
        ? ` (if ${fact.conditions.map((condition) => conditionText(condition.kind, readableValue(condition.value, nameOf))).join("; ")})`
        : "";
      referencedEntityIds.add(knowledge.holderEntityId);
      // The GM already reads the fact line; a character projection needs the sentence itself.
      const sentence = `${nameOf(fact.subjectEntityId)}, ${fact.predicate.replace(/^continuity\./u, "")}: ${readableValue(fact.value, nameOf)}${conditions}`;
      const prefix = `[knowledge ${knowledge.knowledgeId}${sessionTag(knowledge)}] ${nameOf(knowledge.holderEntityId)} ${knowledge.epistemicState}: `;
      blocks.push({
        id: knowledge.knowledgeId,
        priority: 0,
        entityRefs: [knowledge.holderEntityId, fact.subjectEntityId],
        order: knowledge.learnedAtOrder,
        text: prefix + (audienceIsGm ? `fact ${shownFactId}` : sentence),
        ...(audienceIsGm ? { citesFactId: shownFactId, standaloneText: prefix + sentence } : {}),
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
        text: `[claim ${knowledge.knowledgeId}${sessionTag(knowledge)}] ${nameOf(knowledge.holderEntityId)} ${knowledge.epistemicState}: ${nameOf(claim.subjectEntityId)}, ${claim.predicate.replace(/^continuity\./u, "")}: ${readableValue(claim.value, nameOf)}`,
      });
    } else {
      exclusions.push({ id: knowledge.knowledgeId, reason: "knowledge has no fact or attributed claim" });
    }
  }

  for (const entity of input.entities.filter((item) => item.chatId === input.chatId && item.status === "active")) {
    if (!referencedEntityIds.has(entity.entityId) || entity.aliases.length < 2) continue;
    blocks.push({
      id: entity.entityId,
      priority: 2,
      entityRefs: [entity.entityId],
      text: `[aka] ${entity.aliases[0]} = ${entity.aliases.slice(1).join(", ")}`,
    });
  }
  const validEvents = new Set<string>();
  const eventParticipants = new Map<string, string[]>();
  const recentEventRefs: Array<{ order: string; refs: string[] }> = [];
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
    eventParticipants.set(event.eventId, refs);
    for (const id of refs) eventEntityIds.add(id);
    // Events only anchor current state and recency; their readable text is already carried by the event facts.
    recentEventRefs.push({ order: event.occurrenceOrder, refs });
  }
  // Current state overrides stale card text, so it renders ahead of facts. The GM sees every
  // present or referenced entity; a character sees only itself, entities its knowledge names,
  // and world-scope state.
  const presentIds = new Set(input.presentEntityIds ?? []);
  const focusIds = new Set(audienceIsGm ? (input.focusEntityIds ?? []) : []);
  const stateAtCutoff = new Map<string, CampaignMemoryCurrentState>();
  for (const state of input.currentState) {
    if (state.chatId !== input.chatId || !before(state.validAtOrder, cutoff)) continue;
    const key = `${state.entityId}\u0000${state.property}`;
    const kept = stateAtCutoff.get(key);
    if (!kept || state.validAtOrder > kept.validAtOrder) stateAtCutoff.set(key, state);
  }
  for (const state of stateAtCutoff.values()) {
    if (!validEvents.has(state.sourceEventId) || !entityIds.has(state.entityId)) {
      exclusions.push({ id: state.stateId, reason: "current state references an unavailable event or entity" });
      continue;
    }
    const known = audienceIsGm
      ? presentIds.has(state.entityId) ||
        focusIds.has(state.entityId) ||
        referencedEntityIds.has(state.entityId) ||
        eventEntityIds.has(state.entityId)
      : state.entityId === characterEntityId ||
        referencedEntityIds.has(state.entityId) ||
        Boolean(characterEntityId && eventParticipants.get(state.sourceEventId)?.includes(characterEntityId));
    if (!known && !isWorldScopeState(state)) {
      exclusions.push({ id: state.stateId, reason: "current state entity is not present, referenced, or known" });
      continue;
    }
    if (isWorldScopeState(state)) worldStateIds.add(state.stateId);
    blocks.push({
      id: state.stateId,
      priority: -1,
      section: "current_state",
      entityRefs: [state.entityId],
      order: state.validAtOrder,
      // A value carried over from an earlier session is the last known one, not a claim about this scene.
      text:
        (state as { originChatId?: string }).originChatId &&
        (state as { originChatId?: string }).originChatId !== input.chatId
          ? `${nameOf(state.entityId)}: last known ${state.property} = ${readableValue(state.value, nameOf)} (${sessionTag(state).trim()})`
          : `${nameOf(state.entityId)}: ${state.property} = ${readableValue(state.value, nameOf)}`,
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
        text: `[relationship ${relationship.relationshipId}${sessionTag(relationship)}] ${nameOf(relationship.sourceEntityId)} ${relationship.type.replace(/-/gu, " ")} ${nameOf(relationship.targetEntityId)}`,
      });
    }
  }

  // Relevance: present entities first, then participants of the newest events, then everything else.
  // Within a tier the newest source order wins; records without an order keep their ID order last.
  const present = presentIds;
  const recentParticipants = new Set<string>();
  const newestEvents = [...recentEventRefs]
    .sort((a, b) => b.order.localeCompare(a.order))
    .slice(0, RECENT_EVENT_WINDOW);
  for (const event of newestEvents) for (const ref of event.refs) recentParticipants.add(ref);
  // Present first, then whoever the scene is talking about, then participants of the newest events.
  const relevance = (block: Block): number =>
    block.entityRefs.some((ref) => present.has(ref))
      ? 0
      : block.entityRefs.some((ref) => focusIds.has(ref))
        ? 1
        : keywordFactIds.has(block.id)
          ? 2
          : block.entityRefs.some((ref) => recentParticipants.has(ref))
            ? 3
            : 4;
  const orderRank = (a: Block, b: Block): number => {
    if (a.order && b.order) return b.order.localeCompare(a.order);
    if (a.order || b.order) return a.order ? -1 : 1;
    return 0;
  };
  blocks.sort(
    (a, b) => a.priority - b.priority || relevance(a) - relevance(b) || orderRank(a, b) || a.id.localeCompare(b.id),
  );
  const max = normalizeCampaignMemoryMaxCharacters(input.maxCharacters);
  const chosen: Block[] = [];
  const lines: string[] = [];
  const lineOf = new Map<string, number>();
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
    lineOf.set(block.id, lines.length - 1);
    chosen.push(block);
    used += addition.length;
  }
  // A knowledge line cites its fact by id; when that fact line is not rendered (merged into a continuity receipt, or
  // cut by the budget) the id points at nothing, so the line carries the sentence itself when the budget allows.
  const renderedIds = new Set(chosen.map((block) => block.id));
  for (const block of chosen) {
    if (!block.citesFactId || !block.standaloneText || renderedIds.has(block.citesFactId)) continue;
    const growth = block.standaloneText.length - block.text.length;
    if (used + growth > max) continue;
    lines[lineOf.get(block.id)!] = block.standaloneText;
    used += growth;
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
          if (item.factId && included.has(repOf(item.factId))) mayUse.add(repOf(item.factId));
        }
        for (const factId of worldFactIds) if (included.has(factId)) mayUse.add(factId);
        for (const stateId of worldStateIds) if (included.has(stateId)) mayUse.add(stateId);
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
  /** The continuity block's cutoff on this request (regenerate or continue); the latest message when omitted. */
  continuityThroughMessageId?: string;
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
  throughMessageId?: string,
): Promise<CampaignMemoryContinuityReceiptRecord[] | undefined> {
  try {
    // Only a record the continuity block renders on this request carries a merged fact's text. Off or shadow mode,
    // a record cut by the continuity budget, or one past the regenerate cutoff would leave the fact in neither block.
    const rendered = await buildGameContinuityPromptContext(db, chatId, {
      ...(throughMessageId ? { throughMessageId } : {}),
    });
    if (rendered.metadata.mode !== "active" || !rendered.text) return [];
    const renderedKeys = new Set(rendered.metadata.includedRecordKeys);
    if (!renderedKeys.size) return [];
    const state = await readGameContinuityState(db, chatId);
    return state.records
      .filter((record) => record.evidence.length > 0 && renderedKeys.has(`${record.receiptId}:${record.id}`))
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
  const {
    presence,
    dedupeContinuityReceipts,
    focusTexts,
    continuityThroughMessageId: _through,
    ...contextInput
  } = input;
  const continuityReceiptRecords =
    dedupeContinuityReceipts && contextInput.audience.kind === "gm"
      ? await readContinuityReceiptRecords(db, input.chatId, input.continuityThroughMessageId)
      : undefined;
  return db.transaction(async (tx) => {
    // Campaign scope: every earlier session of this game is merged into a read-only projection of this chat.
    const projection = await readCampaignMemoryProjection(tx, input.chatId);
    const { entities, facts, knowledge, events, relationships } = projection;
    const currentState = [...projection.currentState, ...projection.supersededStates];
    const sourceRows = await readCampaignMemorySourcesForProjection(tx, projection);
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
      ...(focusTexts?.length
        ? { focusEntityIds: resolveFocusEntityIds(visibleEntities, focusTexts), focusText: focusTexts.join("\n") }
        : {}),
      ...(continuityReceiptRecords ? { continuityReceiptRecords } : {}),
    });
  });
}
