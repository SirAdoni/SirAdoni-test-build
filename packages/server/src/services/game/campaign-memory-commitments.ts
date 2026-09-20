import type { CampaignMemoryEntity, CampaignMemoryFact } from "@marinara-engine/shared";
import { CampaignMemoryMutationError } from "./campaign-memory-mutations.js";
import { compareCampaignMemoryMessageOrder } from "./campaign-memory-order.js";

/**
 * Pulse 8 commitments: a pure projection of facts into quest/promise/offer/invitation
 * views. A commitment is a fact with predicate `commitment`; every state change is a
 * new fact linked by `supersedesFactId`, so the supersession chain is the history.
 * Continuity-published facts (predicate = record kind `promise|offer|invitation`, or
 * their `continuity.<kind>` lore-entity fallback) are read as commitments too, so
 * historical data appears without migration.
 */
export const CAMPAIGN_MEMORY_COMMITMENT_PREDICATE = "commitment";
export const COMMITMENT_KINDS = [
  "invitation",
  "promise",
  "offer",
  "quest",
  "employment",
  "candidacy",
  "other",
] as const;
export const COMMITMENT_STATES = [
  "proposed",
  "accepted",
  "active",
  "completed",
  "declined",
  "cancelled",
  "unresolved",
] as const;
export type CampaignMemoryCommitmentKind = (typeof COMMITMENT_KINDS)[number];
export type CampaignMemoryCommitmentState = (typeof COMMITMENT_STATES)[number];
export interface CampaignMemoryCommitmentParticipant {
  entityId: string;
  role: string;
}
export interface CampaignMemoryCommitmentValue {
  kind: CampaignMemoryCommitmentKind;
  title: string;
  state: CampaignMemoryCommitmentState;
  conditions: string[];
  /** Campaign-time text; never a wall-clock date. */
  deadline: string | null;
  participants: CampaignMemoryCommitmentParticipant[];
  notes: string;
}
export interface CampaignMemoryCommitmentTransition {
  factId: string;
  state: CampaignMemoryCommitmentState;
  sourceOrder: string | null;
  evidenceMessageIds: string[];
}
export interface CampaignMemoryCommitmentItem {
  /** Newest fact in the supersession chain; the record a transition must name. */
  commitmentId: string;
  subjectEntityId: string;
  kind: CampaignMemoryCommitmentKind;
  title: string;
  state: CampaignMemoryCommitmentState;
  conditions: string[];
  deadline: string | null;
  notes: string;
  participants: Array<CampaignMemoryCommitmentParticipant & { alias: string }>;
  evidence: CampaignMemoryFact["evidence"];
  transitions: CampaignMemoryCommitmentTransition[];
  /** Read from continuity publication or import provenance rather than authored as a commitment. */
  historical: boolean;
  /** Source order of the first transition while the commitment is still open; null once closed. */
  openSince: string | null;
  revision: number;
}

const OPEN_STATES: readonly CampaignMemoryCommitmentState[] = ["proposed", "accepted", "active"];
/** Mirrors the quest machine in campaign-memory-transitions.ts (QUEST_NEXT); re-asserting the same state is allowed. */
const COMMITMENT_NEXT: Record<CampaignMemoryCommitmentState, readonly CampaignMemoryCommitmentState[]> = {
  proposed: ["accepted", "active", "declined", "cancelled", "unresolved"],
  accepted: ["active", "completed", "cancelled", "unresolved"],
  active: ["completed", "cancelled", "unresolved"],
  completed: [],
  declined: [],
  cancelled: [],
  unresolved: [...COMMITMENT_STATES],
};
const CONTINUITY_PREDICATE = /^(?:continuity\.)?(promise|offer|invitation)$/u;

const fail = (message: string): never => {
  throw new CampaignMemoryMutationError("CAMPAIGN_MEMORY_INVALID_VALUE", message);
};
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function isCampaignMemoryCommitmentState(value: unknown): value is CampaignMemoryCommitmentState {
  return COMMITMENT_STATES.includes(value as CampaignMemoryCommitmentState);
}
export function canTransitionCampaignMemoryCommitment(
  from: CampaignMemoryCommitmentState,
  to: CampaignMemoryCommitmentState,
): boolean {
  return from === to || COMMITMENT_NEXT[from].includes(to);
}

/** Strict schema for the value of a `commitment` fact. */
export function validateCampaignMemoryCommitmentValue(raw: unknown): asserts raw is CampaignMemoryCommitmentValue {
  if (!isRecord(raw)) fail("commitment value must be an object");
  const v = raw as Record<string, unknown>;
  const allowed = ["kind", "title", "state", "conditions", "deadline", "participants", "notes"];
  for (const key of Object.keys(v)) if (!allowed.includes(key)) fail(`commitment.${key} is forbidden`);
  if (!COMMITMENT_KINDS.includes(v.kind as CampaignMemoryCommitmentKind)) fail("commitment.kind is invalid");
  if (typeof v.title !== "string" || !v.title.trim()) fail("commitment.title is required");
  if (!isCampaignMemoryCommitmentState(v.state)) fail("commitment.state is invalid");
  if (!isStringList(v.conditions) || v.conditions.some((c) => !c.trim()))
    fail("commitment.conditions must be a list of non-empty strings");
  if (v.deadline !== null && (typeof v.deadline !== "string" || !v.deadline.trim()))
    fail("commitment.deadline must be campaign time text or null");
  if (
    !Array.isArray(v.participants) ||
    v.participants.some(
      (p: unknown) =>
        !isRecord(p) ||
        typeof p.entityId !== "string" ||
        !p.entityId.trim() ||
        typeof p.role !== "string" ||
        !p.role.trim() ||
        Object.keys(p).length !== 2,
    )
  )
    fail("commitment.participants must be a list of { entityId, role }");
  if (typeof v.notes !== "string") fail("commitment.notes must be a string");
}

/** Read one fact as a commitment value, or null when the fact is not a commitment. */
export function readCampaignMemoryCommitmentValue(
  fact: CampaignMemoryFact,
): { value: CampaignMemoryCommitmentValue; historical: boolean } | null {
  if (fact.predicate === CAMPAIGN_MEMORY_COMMITMENT_PREDICATE) {
    try {
      validateCampaignMemoryCommitmentValue(fact.value);
    } catch {
      return null;
    }
    return { value: fact.value, historical: fact.provenance.actor === "import" };
  }
  const kind = CONTINUITY_PREDICATE.exec(fact.predicate)?.[1] as CampaignMemoryCommitmentKind | undefined;
  if (!kind || !isRecord(fact.value)) return null;
  const record = fact.value;
  const state = isCampaignMemoryCommitmentState(record.status) ? record.status : "unresolved";
  const title = typeof record.text === "string" && record.text.trim() ? record.text : fact.predicate;
  return {
    value: {
      kind,
      title,
      state,
      conditions: isStringList(record.conditions) ? [...record.conditions] : [],
      deadline: null,
      participants: [{ entityId: fact.subjectEntityId, role: "subject" }],
      notes: "",
    },
    historical: record.historical === true || fact.provenance.actor === "import",
  };
}

interface Chained {
  fact: CampaignMemoryFact;
  value: CampaignMemoryCommitmentValue;
  historical: boolean;
}
const orderOf = (fact: CampaignMemoryFact) => fact.validFromOrder ?? null;
const newest = (left: CampaignMemoryFact, right: CampaignMemoryFact) =>
  compareCampaignMemoryMessageOrder(right.validFromOrder ?? "", left.validFromOrder ?? "") ||
  right.createdAt.localeCompare(left.createdAt) ||
  right.factId.localeCompare(left.factId);

/** Fact -> commitment chains. Heads are facts no commitment fact supersedes. */
export function projectCampaignMemoryCommitments(
  facts: readonly CampaignMemoryFact[],
  entities: readonly CampaignMemoryEntity[],
): CampaignMemoryCommitmentItem[] {
  const chained = new Map<string, Chained>();
  for (const fact of facts) {
    const read = readCampaignMemoryCommitmentValue(fact);
    if (read) chained.set(fact.factId, { fact, ...read });
  }
  const superseded = new Set<string>();
  for (const { fact } of chained.values())
    if (fact.supersedesFactId && chained.has(fact.supersedesFactId)) superseded.add(fact.supersedesFactId);
  const alias = new Map(
    entities.map((entity) => [entity.entityId, entity.aliases[0] || entity.summary || entity.entityId]),
  );
  const items: CampaignMemoryCommitmentItem[] = [];
  for (const head of chained.values()) {
    if (superseded.has(head.fact.factId)) continue;
    const chain: Chained[] = [];
    const seen = new Set<string>();
    for (
      let current: Chained | undefined = head;
      current && !seen.has(current.fact.factId);
      current = current.fact.supersedesFactId ? chained.get(current.fact.supersedesFactId) : undefined
    ) {
      seen.add(current.fact.factId);
      chain.unshift(current);
    }
    const { value } = head;
    items.push({
      commitmentId: head.fact.factId,
      subjectEntityId: head.fact.subjectEntityId,
      kind: value.kind,
      title: value.title,
      state: value.state,
      conditions: [...value.conditions],
      deadline: value.deadline,
      notes: value.notes,
      participants: value.participants.map((p) => ({ ...p, alias: alias.get(p.entityId) ?? p.entityId })),
      evidence: head.fact.evidence,
      transitions: chain.map((link) => ({
        factId: link.fact.factId,
        state: link.value.state,
        sourceOrder: orderOf(link.fact),
        evidenceMessageIds: [...new Set(link.fact.evidence.map((e) => e.messageId))],
      })),
      historical: chain.some((link) => link.historical),
      openSince: OPEN_STATES.includes(value.state) ? orderOf(chain[0]!.fact) : null,
      revision: head.fact.revision,
    });
  }
  const headFact = (item: CampaignMemoryCommitmentItem) => chained.get(item.commitmentId)!.fact;
  return items.sort((left, right) => newest(headFact(left), headFact(right)));
}

export function commitmentInvolves(item: CampaignMemoryCommitmentItem, entityId: string): boolean {
  return item.subjectEntityId === entityId || item.participants.some((p) => p.entityId === entityId);
}
