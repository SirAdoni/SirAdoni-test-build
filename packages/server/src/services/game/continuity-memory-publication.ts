import { createHash, randomUUID } from "node:crypto";
import type {
  CampaignMemoryEntity,
  CampaignMemoryEntityKind,
  CampaignMemoryEvidence,
  CampaignMemoryActor,
  CampaignMemoryRelationshipStatus,
  CampaignMemorySourceProvenance,
  GameContinuityReceipt,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { and, eq } from "../../db/file-query.js";
import {
  campaignMemoryKnowledge,
  campaignMemoryMutationJournal,
  lorebookEntries,
  lorebooks,
} from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { applyCampaignMemoryMutation } from "./campaign-memory-mutations.js";
import {
  applyCampaignMemoryTransition,
  campaignMemoryTransitionId,
  type CampaignMemoryQuestStatus,
  type CampaignMemoryTransitionBasis,
  type CampaignMemoryTransitionClass,
  type CampaignMemoryTransitionCommand,
  type CampaignMemoryTransitionResult,
} from "./campaign-memory-transitions.js";
import { createCampaignMemoryStorage } from "../storage/campaign-memory.storage.js";
import type { CampaignMemoryFactInput } from "../storage/campaign-memory.storage.js";
import { createCampaignMemoryOwnerReader, validateCampaignMemoryEntityOwner } from "./campaign-memory-owners.js";
import { readCampaignMemorySources } from "./campaign-memory-sources.js";
import { resolveSnapshotHolder } from "./continuity-holder-snapshot.js";
import { buildCampaignMemoryMessageOrderMap, deriveCampaignMemoryCaptureOrder } from "./campaign-memory-order.js";
import type { GameContinuityKnowledge, GameContinuityRecord, GameContinuitySource } from "@marinara-engine/shared";

const SOURCE = "incremental-game-continuity";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function comparableFactValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  if (copy.knowledge && typeof copy.knowledge === "object" && !Array.isArray(copy.knowledge)) {
    const knowledge = copy.knowledge as Record<string, unknown>;
    delete knowledge.holderRefs;
    delete knowledge.holderMappings;
    delete knowledge.holderMappingStatus;
  }
  delete copy.unresolvedSubjects;
  delete copy.resolvedSubjects;
  return copy;
}

type SubjectResolutionReason = "no-candidate" | "ambiguous-candidates" | "owner-unresolved";
type SubjectResolution = {
  resolved: Array<{ name: string; entityId: string }>;
  unresolved: Array<{ name: string; reason: SubjectResolutionReason }>;
};

/**
 * Subject names are matched only against the receipt's immutable holder
 * snapshot and the current chat entities' aliases; a name is never identity
 * on its own, so every candidate is re-validated through owner resolution and
 * anything but exactly one resolved entity stays on the lore-entity fallback.
 */
async function createSubjectResolver(
  tx: DB,
  receipt: GameContinuityReceipt,
  entities: readonly CampaignMemoryEntity[],
) {
  const candidatesByName = new Map<string, Set<string>>();
  const add = (name: string, entityId: string) => {
    const key = normalizedHolderName(name);
    if (!key) return;
    const set = candidatesByName.get(key) ?? new Set<string>();
    set.add(entityId);
    candidatesByName.set(key, set);
  };
  for (const holder of receipt.knowledgeHolders ?? []) add(holder.name, holder.entityId);
  for (const entity of entities) {
    if (entity.status !== "active") continue;
    for (const alias of entity.aliases) add(alias, entity.entityId);
  }
  const entityById = new Map(entities.map((entity) => [entity.entityId, entity]));
  const ownerReader = createCampaignMemoryOwnerReader(tx);
  const validated = new Map<string, Promise<boolean>>();
  const isResolvable = (entityId: string): Promise<boolean> => {
    let pending = validated.get(entityId);
    if (!pending) {
      pending = (async () => {
        const entity = entityById.get(entityId);
        if (!entity || entity.chatId !== receipt.chatId || entity.status !== "active") return false;
        return Boolean((await validateCampaignMemoryEntityOwner(entity, ownerReader)).selected);
      })();
      validated.set(entityId, pending);
    }
    return pending;
  };
  const resolveSubjects = async (record: GameContinuityRecord): Promise<SubjectResolution> => {
    const result: SubjectResolution = { resolved: [], unresolved: [] };
    const seen = new Set<string>();
    for (const name of record.subjects) {
      const candidates = [...(candidatesByName.get(normalizedHolderName(name)) ?? [])];
      if (!candidates.length) {
        result.unresolved.push({ name, reason: "no-candidate" });
        continue;
      }
      const resolvable: string[] = [];
      for (const entityId of candidates) if (await isResolvable(entityId)) resolvable.push(entityId);
      if (resolvable.length !== 1) {
        result.unresolved.push({ name, reason: resolvable.length ? "ambiguous-candidates" : "owner-unresolved" });
        continue;
      }
      if (seen.has(resolvable[0]!)) continue;
      seen.add(resolvable[0]!);
      result.resolved.push({ name, entityId: resolvable[0]! });
    }
    return result;
  };
  /** Registered entities of `kinds` whose alias is mentioned verbatim (whole words) in any of `texts`; never fuzzy. */
  const resolveAliasIn = async (
    texts: readonly string[],
    kinds: readonly CampaignMemoryEntityKind[],
  ): Promise<AliasResolution> => {
    const haystacks = texts.map((text) => ` ${normalizedHolderName(text)} `);
    const matches: AliasMatch[] = [];
    for (const entity of entities) {
      if (entity.status !== "active" || !kinds.includes(entity.kind)) continue;
      const alias = entity.aliases.find((candidate) => {
        const key = normalizedHolderName(candidate);
        return key.length > 0 && haystacks.some((text) => mentions(text, key));
      });
      if (alias && (await isResolvable(entity.entityId))) matches.push({ entityId: entity.entityId, alias });
    }
    return { matches, resolved: matches.length === 1 ? matches[0]! : null, ambiguous: matches.length > 1 };
  };
  return { resolveSubjects, resolveAliasIn };
}

type AliasMatch = { entityId: string; alias: string };
type AliasResolution = { matches: AliasMatch[]; resolved: AliasMatch | null; ambiguous: boolean };

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
/** Whole-word occurrence of `key` in `text`; both already normalized. */
function mentions(text: string, key: string): boolean {
  let from = 0;
  for (;;) {
    const index = text.indexOf(key, from);
    if (index < 0) return false;
    if (!isWordChar(text[index - 1]) && !isWordChar(text[index + key.length])) return true;
    from = index + 1;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizedHolderName(value: string): string {
  return value.trim().normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Resolve reviewed holder names against the immutable receipt snapshot. Names
 * are only usable when they identify exactly one snapshot holder; an explicit
 * ref is still checked against its snapshot name independently of array order.
 */
function holderRefsForKnowledge(
  knowledge: GameContinuityKnowledge,
  snapshots: NonNullable<GameContinuityReceipt["knowledgeHolders"]>,
): string[] {
  if (knowledge.holderRefs?.length) return [...knowledge.holderRefs];
  const byName = new Map<string, typeof snapshots>();
  for (const snapshot of snapshots) {
    const key = normalizedHolderName(snapshot.name);
    const matches = byName.get(key) ?? [];
    matches.push(snapshot);
    byName.set(key, matches);
  }
  const refs: string[] = [];
  for (const name of knowledge.holders) {
    const matches = byName.get(normalizedHolderName(name)) ?? [];
    if (matches.length === 1) refs.push(matches[0]!.entityId);
  }
  return [...new Set(refs)];
}

export interface ContinuityMemoryTransitionOutcome {
  recordId: string;
  class: CampaignMemoryTransitionClass;
  status: "applied" | "stale" | "pending" | "skipped";
  transitionId?: string;
  reasons: string[];
}
export interface ContinuityMemoryPublicationResult {
  /** `applied` includes `stale` (event recorded, newer state kept); `skipped` is a derivation or write failure. */
  transitions: {
    applied: ContinuityMemoryTransitionOutcome[];
    pending: ContinuityMemoryTransitionOutcome[];
    skipped: ContinuityMemoryTransitionOutcome[];
  };
}

/*
 * Reviewed record -> typed transition. Extractor kinds are a closed set (event, promise, ...) and
 * keys are free-form, so a record is classed by an exact marker in its kind or keys first, then by
 * a completed event, then by completed arrival wording. Anything else produces no transition.
 * ponytail: the marker vocabulary is deliberately small and exact; the upgrade path is a typed
 * `transition` hint on the record once the shared contract can be rebuilt.
 */
const MOVEMENT_MARKERS = new Set(["movement", "arrival", "arrived", "travel", "presence"]);
const DEPARTURE_MARKERS = new Set(["departure", "departed"]);
const ITEM_MARKERS = new Set(["item-transfer", "item transfer", "transfer", "gift"]);
const RELATIONSHIP_MARKERS = new Set(["relationship"]);
const QUEST_MARKERS = new Set(["quest"]);
const ARRIVAL_TEXT =
  /\b(?:arriv(?:ed|es)|reach(?:ed|es)|enter(?:ed|s)|return(?:ed|s) to|(?:is|are|was|were|has been|have been) now (?:at|in)|(?:went|came|travel{1,2}ed|walked|rode|sailed|marched) to)\b/iu;
const RECEIVE_TEXT = /\b(?:receiv(?:ed|es)|took|takes|accept(?:ed|s)|got|obtain(?:ed|s)|was given|were given)\b/iu;
const GIVE_TEXT =
  /\b(?:gave|gives|hand(?:ed|s)|pass(?:ed|es)|sold|sells|deliver(?:ed|s)|lent|lends|return(?:ed|s))\b/iu;
const RELATIONSHIP_TYPES: ReadonlyArray<[RegExp, string, string]> = [
  [/\b(?:ally|allies|allied|alliance)\b/iu, "ally", "ally"],
  [/\b(?:enemy|enemies|foe|foes|enmity)\b/iu, "enemy", "enemy"],
  [/\b(?:rival|rivals|rivalry)\b/iu, "rival", "rival"],
  [/\b(?:friend|friends|friendship)\b/iu, "friend", "friend"],
  [/\b(?:lover|lovers|romance|courting)\b/iu, "lover", "lover"],
  [/\b(?:spouse|married|marriage|wife|husband|wed)\b/iu, "spouse", "spouse"],
  [/\b(?:betrothed|betrothal|engaged)\b/iu, "betrothed", "betrothed"],
  [/\b(?:mentor|mentors|apprentice|apprenticed)\b/iu, "mentor", "apprentice"],
  [/\b(?:employ(?:ed|s|er|ee)|hired|hire|hiring)\b/iu, "employer", "employee"],
  [/\b(?:patron|patronage|sponsor(?:ed|s|ship)?)\b/iu, "patron", "client"],
  [/\b(?:servant|serves|service|master)\b/iu, "servant", "master"],
];
const QUEST_STATUS: Record<GameContinuityRecord["status"], CampaignMemoryQuestStatus> = {
  proposed: "proposed",
  accepted: "accepted",
  completed: "completed",
  declined: "declined",
  cancelled: "cancelled",
  unresolved: "unresolved",
  asserted: "active",
};
const PEOPLE: readonly CampaignMemoryEntityKind[] = ["character", "persona"];

function classifyRecord(record: GameContinuityRecord): CampaignMemoryTransitionClass | null {
  const markers = new Set([record.kind as string, ...record.keys].map(normalizedHolderName));
  const has = (set: Set<string>) => [...markers].some((marker) => set.has(marker));
  if (has(MOVEMENT_MARKERS) || has(DEPARTURE_MARKERS)) return "movement";
  if (has(ITEM_MARKERS)) return "item-transfer";
  if (has(RELATIONSHIP_MARKERS)) return "relationship";
  if (has(QUEST_MARKERS)) return "quest";
  if (record.status === "completed" && ARRIVAL_TEXT.test(record.text)) return "movement";
  if (record.kind === "event" && record.status === "completed") return "event";
  return null;
}

/** Rumor and belief never become world truth; a promise or an open proposal only ever proposes. */
function basisOf(record: GameContinuityRecord): CampaignMemoryTransitionBasis {
  if (record.knowledge?.scope === "rumor") return "rumor";
  if (record.knowledge?.scope === "belief") return "speculation";
  if (record.kind === "promise") return "promise";
  if (record.status === "proposed") return "offer";
  return "observed";
}

type DerivedTransition = { command: CampaignMemoryTransitionCommand; missing: string[] };
type DeriveInput = {
  receipt: GameContinuityReceipt;
  record: GameContinuityRecord;
  actor: CampaignMemoryActor;
  source: { messageId: string; sourceHash: string };
  evidence: CampaignMemoryEvidence[];
  subjects: SubjectResolution;
  kindOf: (entityId: string) => CampaignMemoryEntityKind | undefined;
  resolveAliasIn: (texts: readonly string[], kinds: readonly CampaignMemoryEntityKind[]) => Promise<AliasResolution>;
};

async function deriveTransition(input: DeriveInput): Promise<DerivedTransition | null> {
  const { receipt, record, subjects, kindOf } = input;
  const cls = classifyRecord(record);
  if (!cls) return null;
  const texts = [record.text, ...record.evidence.map((item) => item.quote), ...record.keys];
  const base = {
    chatId: receipt.chatId,
    actor: input.actor,
    reason: record.text,
    source: input.source,
    evidence: input.evidence,
    basis: basisOf(record),
  };
  const missing: string[] = [];
  const names = (matches: AliasMatch[]) => matches.map((match) => match.alias).join(", ");
  const people = subjects.resolved.filter((subject) => PEOPLE.includes(kindOf(subject.entityId) ?? "lore"));
  const orderedPeople = [...people].sort(
    (a, b) =>
      normalizedHolderName(record.text).indexOf(normalizedHolderName(a.name)) -
      normalizedHolderName(record.text).indexOf(normalizedHolderName(b.name)),
  );
  const location = await input.resolveAliasIn(texts, ["location"]);
  for (const subject of subjects.resolved)
    if (kindOf(subject.entityId) === "location" && !location.matches.some((m) => m.entityId === subject.entityId))
      location.matches.push({ entityId: subject.entityId, alias: subject.name });
  location.resolved = location.matches.length === 1 ? location.matches[0]! : null;
  location.ambiguous = location.matches.length > 1;
  if (location.ambiguous) missing.push(`ambiguous location: ${names(location.matches)}`);
  switch (cls) {
    case "event": {
      const participants = subjects.resolved
        .filter((subject) => kindOf(subject.entityId) !== "location")
        .map((subject) => subject.entityId);
      if (!participants.length && !location.resolved) missing.push("no resolvable participant or location");
      return {
        command: {
          ...base,
          class: "event",
          key: `continuity:${receipt.id}:${record.id}`,
          participantEntityIds: participants,
          ...(location.resolved ? { locationEntityId: location.resolved.entityId } : {}),
        },
        missing,
      };
    }
    case "movement": {
      if (!people.length) missing.push("no resolvable character subject to move");
      if (people.length > 1) missing.push(`ambiguous mover: ${people.map((p) => p.name).join(", ")}`);
      if (!location.matches.length) missing.push("no registered location alias in the record text or evidence");
      const markers = new Set([record.kind as string, ...record.keys].map(normalizedHolderName));
      const presence = [...markers].some((marker) => DEPARTURE_MARKERS.has(marker)) ? "absent" : "present";
      // Invitation-versus-arrival: only a completed, observed record moves anyone.
      const ambiguity =
        record.status === "completed"
          ? []
          : [`record status ${record.status} is not completed; an invitation, plan or offer is not an arrival`];
      return {
        command: {
          ...base,
          class: "movement",
          entityId: people[0]?.entityId ?? "unresolved:character",
          locationEntityId: location.resolved?.entityId ?? "unresolved:location",
          presence,
          ...(ambiguity.length ? { ambiguity } : {}),
        },
        missing,
      };
    }
    case "item-transfer": {
      const item = await input.resolveAliasIn(texts, ["item"]);
      if (!item.matches.length) missing.push("no registered item alias in the record text or evidence");
      if (item.ambiguous) missing.push(`ambiguous item: ${names(item.matches)}`);
      let giver: string | undefined;
      let receiver: string | undefined;
      if (orderedPeople.length === 2) {
        const [first, second] = orderedPeople as [
          SubjectResolution["resolved"][number],
          SubjectResolution["resolved"][number],
        ];
        [giver, receiver] = RECEIVE_TEXT.test(record.text)
          ? [second.entityId, first.entityId]
          : [first.entityId, second.entityId];
      } else if (orderedPeople.length === 1 && RECEIVE_TEXT.test(record.text)) receiver = orderedPeople[0]!.entityId;
      else if (orderedPeople.length === 1 && GIVE_TEXT.test(record.text)) giver = orderedPeople[0]!.entityId;
      else missing.push("cannot tell the giver from the receiver");
      const quantity = Number(/\b(\d+)\b/u.exec(record.text)?.[1] ?? "1");
      return {
        command: {
          ...base,
          class: "item-transfer",
          ...(giver ? { giverEntityId: giver } : {}),
          ...(receiver ? { receiverEntityId: receiver } : {}),
          ...(!giver && !receiver ? { giverEntityId: "unresolved:giver" } : {}),
          itemEntityId: item.resolved?.entityId ?? "unresolved:item",
          quantity: Number.isSafeInteger(quantity) && quantity >= 1 ? quantity : 1,
        },
        missing,
      };
    }
    case "relationship": {
      if (orderedPeople.length !== 2)
        missing.push(`a relationship needs exactly two resolvable characters, found ${orderedPeople.length}`);
      const haystack = texts.join(" ");
      const [, type, inverseLabel] = RELATIONSHIP_TYPES.find(([pattern]) => pattern.test(haystack)) ?? [
        null,
        "associated",
        "associated",
      ];
      const status: CampaignMemoryRelationshipStatus =
        record.status === "completed"
          ? "active"
          : record.status === "declined" || record.status === "cancelled"
            ? "ended"
            : "proposed";
      return {
        command: {
          ...base,
          class: "relationship",
          sourceEntityId: orderedPeople[0]?.entityId ?? "unresolved:source",
          targetEntityId: orderedPeople[1]?.entityId ?? "unresolved:target",
          type,
          inverseLabel,
          status,
        },
        missing,
      };
    }
    case "quest": {
      const quest = await input.resolveAliasIn(texts, ["quest"]);
      if (!quest.matches.length) missing.push("no registered quest alias in the record text or evidence");
      if (quest.ambiguous) missing.push(`ambiguous quest: ${names(quest.matches)}`);
      return {
        command: {
          ...base,
          class: "quest",
          questEntityId: quest.resolved?.entityId ?? "unresolved:quest",
          status: QUEST_STATUS[record.status],
        },
        missing,
      };
    }
    default:
      return null;
  }
}

/** Nothing is written for an unresolvable record; the decision is journaled once under `<transitionId>/pending`. */
async function journalPendingTransition(
  tx: DB,
  command: CampaignMemoryTransitionCommand,
  source: { sourceHash: string; order: string },
  reasons: string[],
): Promise<CampaignMemoryTransitionResult> {
  const transitionId = campaignMemoryTransitionId(command, source.sourceHash);
  const operationId = `${transitionId}/pending`;
  const result: CampaignMemoryTransitionResult = {
    transitionId,
    chatId: command.chatId,
    class: command.class,
    status: "pending",
    order: source.order,
    sourceHash: source.sourceHash,
    reasons,
    operations: [],
    replayed: false,
  };
  const held = await tx
    .select({ journalId: campaignMemoryMutationJournal.journalId })
    .from(campaignMemoryMutationJournal)
    .where(
      and(
        eq(campaignMemoryMutationJournal.chatId, command.chatId),
        eq(campaignMemoryMutationJournal.operationId, operationId),
      ),
    )
    .limit(1);
  if (held[0]) return { ...result, replayed: true };
  await tx.insert(campaignMemoryMutationJournal).values({
    journalId: randomUUID(),
    chatId: command.chatId,
    operationId,
    recordType: "transition",
    recordId: transitionId,
    actor: command.actor,
    expectedRevision: null,
    before: null,
    after: JSON.stringify(result),
    reason: command.reason,
    evidence: JSON.stringify(command.evidence),
    compensationOperationId: null,
    payloadHash: hash(command),
    createdAt: new Date().toISOString(),
  });
  return result;
}

export async function assertContinuityMemoryEntry(
  tx: DB,
  receipt: Pick<GameContinuityReceipt, "id" | "chatId">,
  entryId: string,
) {
  const entries = await tx.select().from(lorebookEntries).where(eq(lorebookEntries.id, entryId)).limit(1);
  const entry = entries[0];
  if (!entry) throw new Error("CONTINUITY_MEMORY_ENTRY_MISSING");
  const books = await tx
    .select({ chatId: lorebooks.chatId })
    .from(lorebooks)
    .where(eq(lorebooks.id, entry.lorebookId))
    .limit(1);
  if (!books[0] || books[0].chatId !== receipt.chatId) throw new Error("CONTINUITY_MEMORY_ENTRY_CHAT_MISMATCH");
  const state = objectValue(entry.dynamicState);
  if (state.receiptId !== receipt.id) throw new Error("CONTINUITY_MEMORY_ENTRY_RECEIPT_MISMATCH");
  if (typeof state.publishedContentHash === "string" && hash(entry.content) !== state.publishedContentHash)
    throw new Error("CONTINUITY_MEMORY_ENTRY_MANUALLY_EDITED");
  return entry;
}

type SourceMessage = { id: string; createdAt: string };

/** Project reviewed records into canonical facts; order is source capture order, never in-world time. */
export async function publishContinuityMemory(
  tx: DB,
  receipt: GameContinuityReceipt,
  entry: { id: string; lorebookId: string; name: string },
  messages: readonly SourceMessage[],
  prepared: readonly GameContinuitySource[],
  options: { supersedeResolvedFallback?: boolean } = {},
): Promise<ContinuityMemoryPublicationResult> {
  if (receipt.status !== "verified" && receipt.status !== "published")
    throw new Error(`CONTINUITY_NOT_READY: ${receipt.status}`);
  await assertContinuityMemoryEntry(tx, receipt, entry.id);
  const owner = { type: "existing" as const, store: "lorebook-entries", recordId: entry.id };
  const sourceOrders = buildCampaignMemoryMessageOrderMap(messages);
  const preparedById = new Map(prepared.map((source) => [source.messageId, source]));
  const canonicalSources = await readCampaignMemorySources(tx, { chatId: receipt.chatId });
  const entityId = `cme_${hash({ chatId: receipt.chatId, owner }).slice(0, 32)}`;
  const sourceRevision = receipt.sourceHash;
  // Historical backfill receipts are imported archive memory; live reviewed turns are system-authored.
  // The reader labels import-provenance facts as legacy, so the two must not share an actor.
  const historical = receipt.config.historicalBackfill !== undefined || receipt.id.startsWith("gch_");
  const publicationActor: CampaignMemoryActor = historical ? "import" : "system";
  const provenance: CampaignMemorySourceProvenance = {
    source: SOURCE,
    sourceRevision,
    actor: publicationActor,
    origin: { sourceChatId: receipt.chatId, sourceRecordId: entry.id },
  };
  const memoryStorage = createCampaignMemoryStorage(tx);
  const chatEntities = await memoryStorage.listEntities({ chatId: receipt.chatId });
  const { resolveSubjects, resolveAliasIn } = await createSubjectResolver(tx, receipt, chatEntities);
  const entityKinds = new Map(chatEntities.map((entity) => [entity.entityId, entity.kind]));
  const transitions: ContinuityMemoryPublicationResult["transitions"] = { applied: [], pending: [], skipped: [] };
  const existingEntities = chatEntities.filter(
    (entity) =>
      entity.kind === "lore" &&
      entity.owner.type === "existing" &&
      entity.owner.store === owner.store &&
      entity.owner.recordId === owner.recordId,
  );
  if (existingEntities.length > 1) throw new Error("CONTINUITY_MEMORY_OWNER_CONFLICT");
  const resolvedEntityId = existingEntities[0]?.entityId ?? entityId;
  if (!existingEntities[0])
    await applyCampaignMemoryMutation(tx, {
      chatId: receipt.chatId,
      operationId: `continuity-memory:${receipt.id}:entity:${entry.id}:${sourceRevision}`,
      actor: publicationActor,
      reason: "Publish reviewed continuity receipt owner",
      recordType: "entity",
      action: "create",
      input: {
        chatId: receipt.chatId,
        entityId: resolvedEntityId,
        kind: "lore",
        owner,
        aliases: [],
        tags: ["continuity"],
        summary: entry.name,
        attributes: { sourceReceiptId: receipt.id },
        status: "active",
        manualLock: false,
        provenance,
      },
    });
  for (const record of receipt.records) {
    if (!record.evidence.length) throw new Error(`CONTINUITY_MEMORY_EVIDENCE_UNAVAILABLE: ${record.id}`);
    const evidence = record.evidence.map((item) => {
      const source = preparedById.get(item.messageId);
      const canonical = canonicalSources.get(item.messageId);
      if (!source || !canonical || !canonical.content.includes(item.quote))
        throw new Error(`CONTINUITY_MEMORY_EVIDENCE_UNAVAILABLE: ${record.id}/${item.messageId}`);
      return { messageId: item.messageId, quote: item.quote, sourceHash: canonical.sourceHash };
    });
    const validFromOrder = deriveCampaignMemoryCaptureOrder(evidence, sourceOrders);
    if (!validFromOrder) throw new Error(`CONTINUITY_MEMORY_ORDER_UNAVAILABLE: ${record.id}`);
    const knowledge = record.knowledge;
    const holderRefs = knowledge ? holderRefsForKnowledge(knowledge, receipt.knowledgeHolders ?? []) : [];
    const holderMappings: Array<Record<string, string>> = [];
    const authorizedHolders: string[] = [];
    if (!knowledge || knowledge.scope === "unknown") {
      holderMappings.push({ status: "not-applicable", reason: "unknown-scope" });
    } else {
      for (const holderRef of holderRefs) {
        const snapshot = receipt.knowledgeHolders?.find((candidate) => candidate.entityId === holderRef);
        const holderName =
          snapshot &&
          knowledge.holders.find((name) => normalizedHolderName(name) === normalizedHolderName(snapshot.name));
        if (!snapshot) {
          holderMappings.push({
            ref: holderRef,
            ...(holderName ? { name: holderName } : {}),
            status: "unresolved",
            reason: "holder-snapshot-missing",
          });
          continue;
        }
        if (!holderName) {
          holderMappings.push({
            ref: holderRef,
            name: snapshot.name,
            status: "unresolved",
            reason: "holder-name-mismatch",
          });
          continue;
        }
        const holder = await resolveSnapshotHolder(tx, receipt.chatId, snapshot);
        if (!holder) {
          holderMappings.push({
            ref: holderRef,
            ...(holderName ? { name: holderName } : {}),
            status: "unresolved",
            reason: "holder-unavailable-current-scope",
          });
          continue;
        }
        authorizedHolders.push(holder.entityId);
        holderMappings.push({
          ref: holderRef,
          ...(holderName ? { name: holderName } : {}),
          status: "resolved",
          entityId: holder.entityId,
        });
      }
      if (!holderRefs.length) holderMappings.push({ status: "unresolved", reason: "holder-refs-missing" });
    }
    const holderMappingStatus =
      !knowledge || knowledge.scope === "unknown"
        ? "not-applicable"
        : holderRefs.length > 0 && authorizedHolders.length === holderRefs.length
          ? "resolved"
          : authorizedHolders.length
            ? "partial"
            : "unresolved";
    const subjects = await resolveSubjects(record);
    const fallbackFactId = `cmf_${hash({ chatId: receipt.chatId, receiptId: receipt.id, recordId: record.id, sourceRevision }).slice(0, 32)}`;
    if (options.supersedeResolvedFallback && subjects.resolved.length > 0 && subjects.unresolved.length === 0) {
      // Every subject now resolves to a registered person or place, so the per-subject facts published below carry
      // this record. The lore-entity fallback written while they were unknown would only repeat it.
      const fallback = await memoryStorage.getFact({ chatId: receipt.chatId }, fallbackFactId);
      if (fallback && fallback.status === "verified" && !fallback.manualLock && fallback.author !== "user") {
        await applyCampaignMemoryMutation(tx, {
          chatId: receipt.chatId,
          operationId: `continuity-relink:${receipt.id}:fallback:${fallbackFactId}:${fallback.revision}`,
          actor: publicationActor,
          reason: "Every subject of this record now resolves; its per-subject facts replace the fallback.",
          recordType: "fact",
          action: "update",
          recordId: fallbackFactId,
          expectedRevision: fallback.revision,
          patch: {
            status: "superseded",
            evidence: fallback.evidence.map((item) => ({ messageId: item.messageId, quote: item.quote })),
          },
        });
      }
    }
    const legacyFactId = `cmf_${hash({ chatId: receipt.chatId, receiptId: receipt.id, recordId: record.id, sourceRevision }).slice(0, 32)}`;
    const factProvenance = {
      source: provenance.source,
      sourceRevision: provenance.sourceRevision,
      actor: provenance.actor,
      origin: { sourceChatId: receipt.chatId, sourceRecordId: record.id },
    };
    const baseFact = {
      chatId: receipt.chatId,
      conditions: record.conditions.map((condition) => ({ kind: "continuity.condition", value: condition })),
      status: "verified" as const,
      validFromOrder,
      sourceRevision,
      evidence,
      author: publicationActor,
      provenance: factProvenance,
      manualLock: false,
    };
    const publishedFacts: CampaignMemoryFactInput[] = [];
    // One structured fact per resolved subject: predicate is the record kind and the
    // value is the record itself, so the GM projection reads `<entity>.<kind> = {...}`.
    for (const subject of subjects.resolved) {
      publishedFacts.push({
        ...baseFact,
        factId: `cmf_${hash({ chatId: receipt.chatId, receiptId: receipt.id, recordId: record.id, sourceRevision, subjectEntityId: subject.entityId }).slice(0, 32)}`,
        subjectEntityId: subject.entityId,
        predicate: record.kind,
        value: {
          text: record.text,
          status: record.status,
          conditions: [...record.conditions],
          evidence: evidence.map((item) => ({ ...item })),
          subject: subject.name,
          kind: record.kind,
          keys: [...record.keys],
          receiptId: receipt.id,
          historical,
          recordId: record.id,
        },
      });
    }
    // The lore-entity fallback keeps the legacy shape and ID. It is published when any
    // subject is unresolved or ambiguous (or the record names no subject) and reports them.
    if (subjects.unresolved.length || !subjects.resolved.length) {
      publishedFacts.push({
        ...baseFact,
        factId: legacyFactId,
        subjectEntityId: resolvedEntityId,
        predicate: `continuity.${record.kind}`,
        value: {
          text: record.text,
          status: record.status,
          subjects: [...record.subjects],
          knowledge: record.knowledge
            ? {
                scope: record.knowledge.scope,
                holders: [...record.knowledge.holders],
                holderRefs: [...holderRefs],
                holderMappings,
                holderMappingStatus,
              }
            : null,
          kind: record.kind,
          keys: [...record.keys],
          receiptId: receipt.id,
          recordId: record.id,
          unresolvedSubjects: subjects.unresolved.map((subject) => ({ ...subject })),
          resolvedSubjects: subjects.resolved.map((subject) => ({ ...subject })),
        },
      });
    }
    // Knowledge attaches to one fact per record: the fallback when it exists (legacy
    // knowledge IDs stay stable), otherwise the first per-subject fact.
    const primaryFact = publishedFacts.find((fact) => fact.factId === legacyFactId) ?? publishedFacts[0]!;
    let primaryLocked = false;
    for (const factInput of publishedFacts) {
      const factId = factInput.factId!;
      const existingFact = await memoryStorage.getFact({ chatId: receipt.chatId }, factId);
      if (existingFact) {
        if (existingFact.manualLock) {
          if (factId === primaryFact.factId) primaryLocked = true;
          continue;
        }
        if (
          existingFact.subjectEntityId !== factInput.subjectEntityId ||
          existingFact.predicate !== factInput.predicate ||
          existingFact.sourceRevision !== factInput.sourceRevision ||
          stable(existingFact.evidence) !== stable(factInput.evidence) ||
          stable(comparableFactValue(existingFact.value)) !== stable(comparableFactValue(factInput.value)) ||
          stable(existingFact.conditions) !== stable(factInput.conditions) ||
          existingFact.status !== factInput.status ||
          existingFact.validFromOrder !== factInput.validFromOrder ||
          stable(existingFact.provenance) !== stable(factInput.provenance)
        )
          throw new Error(`CONTINUITY_MEMORY_FACT_CONFLICT: ${factId}`);
        continue;
      }
      await applyCampaignMemoryMutation(tx, {
        chatId: receipt.chatId,
        operationId:
          factId === legacyFactId
            ? `continuity-memory:${receipt.id}:fact:${record.id}:${sourceRevision}`
            : `continuity-memory:${receipt.id}:fact:${record.id}:${factInput.subjectEntityId}:${sourceRevision}`,
        actor: publicationActor,
        reason: "Publish reviewed continuity record",
        evidence,
        recordType: "fact",
        action: "create",
        input: factInput,
      });
    }
    // Zero or one typed transition per record, keyed to the primary evidence message and swipe so a
    // republish replays. Derivation or write failures never fail publication; they are reported.
    await applyRecordTransition({
      tx,
      receipt,
      record,
      actor: publicationActor,
      evidence,
      canonical: canonicalSources.get(evidence[0]!.messageId),
      subjects,
      kindOf: (id) => entityKinds.get(id),
      resolveAliasIn,
      transitions,
    });
    if (primaryLocked) continue;
    const factId = primaryFact.factId!;
    if (knowledge && knowledge.scope !== "unknown" && authorizedHolders.length) {
      const epistemicState =
        knowledge.scope === "world" || knowledge.scope === "private"
          ? "knows"
          : knowledge.scope === "belief"
            ? "believes"
            : "rumor";
      for (const holderRef of authorizedHolders) {
        const knowledgeId =
          factId === legacyFactId
            ? `cmk_${hash({ chatId: receipt.chatId, receiptId: receipt.id, recordId: record.id, holderRef, sourceRevision }).slice(0, 32)}`
            : `cmk_${hash({ chatId: receipt.chatId, receiptId: receipt.id, recordId: record.id, factId, holderRef, sourceRevision }).slice(0, 32)}`;
        const rawKnowledge = await tx
          .select({ knowledgeId: campaignMemoryKnowledge.knowledgeId, manualLock: campaignMemoryKnowledge.manualLock })
          .from(campaignMemoryKnowledge)
          .where(
            and(
              eq(campaignMemoryKnowledge.chatId, receipt.chatId),
              eq(campaignMemoryKnowledge.knowledgeId, knowledgeId),
            ),
          )
          .limit(1);
        if (rawKnowledge[0]?.manualLock === 1) continue;
        const existingKnowledge = await memoryStorage.getKnowledge({ chatId: receipt.chatId }, knowledgeId);
        if (existingKnowledge) {
          if (
            existingKnowledge.holderEntityId !== holderRef ||
            existingKnowledge.factId !== factId ||
            existingKnowledge.epistemicState !== epistemicState ||
            stable(existingKnowledge.learnedFrom) !== stable(evidence) ||
            existingKnowledge.learnedAtOrder !== validFromOrder
          )
            throw new Error(`CONTINUITY_MEMORY_KNOWLEDGE_CONFLICT: ${knowledgeId}`);
          continue;
        }
        await applyCampaignMemoryMutation(tx, {
          chatId: receipt.chatId,
          operationId: `continuity-memory:${receipt.id}:knowledge:${record.id}:${holderRef}:${sourceRevision}:projection:${randomUUID()}`,
          actor: publicationActor,
          reason: "Publish reviewed continuity knowledge holder",
          evidence,
          recordType: "knowledge",
          action: "create",
          input: {
            chatId: receipt.chatId,
            knowledgeId,
            holderEntityId: holderRef,
            factId,
            epistemicState,
            learnedFrom: evidence,
            learnedAtOrder: validFromOrder,
            provenance,
            manualLock: false,
          },
        });
      }
    }
  }
  return { transitions };
}

async function applyRecordTransition(input: {
  tx: DB;
  receipt: GameContinuityReceipt;
  record: GameContinuityRecord;
  actor: CampaignMemoryActor;
  evidence: CampaignMemoryEvidence[];
  canonical: { sourceHash: string; captureOrder?: string } | undefined;
  subjects: SubjectResolution;
  kindOf: DeriveInput["kindOf"];
  resolveAliasIn: DeriveInput["resolveAliasIn"];
  transitions: ContinuityMemoryPublicationResult["transitions"];
}): Promise<void> {
  const { receipt, record, canonical, transitions } = input;
  const messageId = input.evidence[0]!.messageId;
  let cls: CampaignMemoryTransitionClass | null = null;
  try {
    if (!canonical?.captureOrder) throw new Error("primary evidence message has no capture order");
    const source = { messageId, sourceHash: canonical.sourceHash };
    const derived = await deriveTransition({
      receipt,
      record,
      actor: input.actor,
      source,
      evidence: input.evidence,
      subjects: input.subjects,
      kindOf: input.kindOf,
      resolveAliasIn: input.resolveAliasIn,
    });
    if (!derived) return;
    cls = derived.command.class;
    const result = derived.missing.length
      ? await journalPendingTransition(
          input.tx,
          derived.command,
          { sourceHash: canonical.sourceHash, order: canonical.captureOrder },
          derived.missing,
        )
      : await applyCampaignMemoryTransition(input.tx, derived.command);
    const outcome: ContinuityMemoryTransitionOutcome = {
      recordId: record.id,
      class: cls,
      status: result.status,
      transitionId: result.transitionId,
      reasons: result.reasons,
    };
    (result.status === "pending" ? transitions.pending : transitions.applied).push(outcome);
  } catch (error) {
    if (!cls) cls = classifyRecord(record);
    if (!cls) return;
    logger.warn(
      { err: error, chatId: receipt.chatId, receiptId: receipt.id, recordId: record.id, class: cls, messageId },
      "[continuity] Reviewed record transition was not recorded",
    );
    transitions.skipped.push({
      recordId: record.id,
      class: cls,
      status: "skipped",
      reasons: [error instanceof Error ? error.message : String(error)],
    });
  }
}
