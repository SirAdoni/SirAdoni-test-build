import { createHash, randomUUID } from "node:crypto";
import type {
  CampaignMemoryCurrentState,
  CampaignMemoryEvidence,
  CampaignMemoryEvent,
  CampaignMemoryFact,
  CampaignMemoryKnowledge,
  CampaignMemoryRelationship,
  CampaignMemorySourceProvenance,
} from "@marinara-engine/shared";
import { and, eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import {
  campaignMemoryCurrentState,
  campaignMemoryEntities,
  campaignMemoryEvents,
  campaignMemoryFacts,
  campaignMemoryKnowledge,
  campaignMemoryMutationJournal,
  campaignMemoryRelationships,
  chats,
  messages,
} from "../../db/schema/index.js";
import { createCampaignMemoryOwnerReader, validateCampaignMemoryEntityOwner } from "./campaign-memory-owners.js";
import { createCampaignMemoryStorage } from "../storage/campaign-memory.storage.js";
import { readCampaignMemorySources, type CampaignMemorySource } from "./campaign-memory-sources.js";
import {
  buildCampaignMemoryMessageOrderMap,
  compareCampaignMemoryMessageOrder,
  parseCampaignMemoryMessageOrder,
  remapCampaignMemoryMessageOrder,
} from "./campaign-memory-order.js";

export interface CampaignMemoryBranchProjectionInput {
  sourceChatId: string;
  targetChatId: string;
  cutoffOrder: string;
  messageIdMap: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  operationId: string;
}
export interface CampaignMemoryBranchHeld {
  recordType: "entity" | "fact" | "knowledge" | "event" | "current-state" | "relationship";
  recordId: string;
  reason: string;
}
export interface CampaignMemoryBranchProjectionResult {
  sourceChatId: string;
  targetChatId: string;
  operationId: string;
  copied: {
    entities: number;
    facts: number;
    knowledge: number;
    events: number;
    currentState: number;
    relationships: number;
  };
  held: CampaignMemoryBranchHeld[];
  idMap: Record<string, string>;
  messageIdMap: Record<string, string>;
}
export class CampaignMemoryBranchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CampaignMemoryBranchError";
  }
}
const fail = (code: string, message: string): never => {
  throw new CampaignMemoryBranchError(code, message);
};
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, stable(v)]),
        )
      : value;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
const branchProvenance = (
  value: CampaignMemorySourceProvenance,
  sourceChatId: string,
  sourceRecordId: string,
  sourceOrders?: NonNullable<CampaignMemorySourceProvenance["origin"]>["sourceOrders"],
): CampaignMemorySourceProvenance => ({
  ...value,
  origin: {
    sourceChatId,
    sourceRecordId,
    ...(sourceOrders === undefined ? {} : { sourceOrders }),
  },
});
const parse = <T>(value: string | null | undefined, fallback: T): T => {
  if (value == null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fail("CAMPAIGN_MEMORY_INVALID_VALUE", "Malformed campaign-memory JSON");
  }
};
const mapOf = (value: CampaignMemoryBranchProjectionInput["messageIdMap"]): Map<string, string> =>
  value instanceof Map ? new Map(value) : new Map(Object.entries(value));
const copyEvidence = async (
  evidence: readonly CampaignMemoryEvidence[],
  messagesById: Map<string, string>,
  sourceSources: ReadonlyMap<string, CampaignMemorySource>,
  targetSources: ReadonlyMap<string, CampaignMemorySource>,
) => {
  const result: CampaignMemoryEvidence[] = [];
  for (const item of evidence) {
    const targetId = messagesById.get(item.messageId);
    const source = sourceSources.get(item.messageId);
    const target = targetId ? targetSources.get(targetId) : null;
    const sourceHash = (item as CampaignMemoryEvidence & { sourceHash?: unknown }).sourceHash;
    if (
      !targetId ||
      !source ||
      !source?.content.includes(item.quote) ||
      !target ||
      !target.content.includes(item.quote) ||
      (typeof sourceHash === "string" && (source.sourceHash !== sourceHash || target.sourceHash !== sourceHash))
    )
      return null;
    result.push({ messageId: targetId, quote: item.quote, ...(typeof sourceHash === "string" ? { sourceHash } : {}) });
  }
  return result;
};
const atOrBefore = (order: string | undefined, cutoff: string) => Boolean(order && order <= cutoff);

export async function projectCampaignMemoryBranch(
  db: DB,
  input: CampaignMemoryBranchProjectionInput,
): Promise<CampaignMemoryBranchProjectionResult> {
  if (
    !input.sourceChatId.trim() ||
    !input.targetChatId.trim() ||
    !input.operationId.trim() ||
    !input.cutoffOrder.trim()
  )
    fail("CAMPAIGN_MEMORY_INVALID_VALUE", "sourceChatId, targetChatId, cutoffOrder, and operationId are required");
  if (input.sourceChatId === input.targetChatId)
    fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", "Source and target chats must differ");
  const messageMap = mapOf(input.messageIdMap);
  const requestHash = hash({
    ...input,
    messageIdMap: [...messageMap.entries()].sort(([a], [b]) => a.localeCompare(b)),
  });
  return db.transaction(
    async (tx) => {
      const journal = (
        await tx
          .select()
          .from(campaignMemoryMutationJournal)
          .where(
            and(
              eq(campaignMemoryMutationJournal.chatId, input.targetChatId),
              eq(campaignMemoryMutationJournal.operationId, input.operationId),
            ),
          )
          .limit(1)
      )[0];
      if (journal) {
        if (journal.payloadHash !== requestHash)
          fail(
            "CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT",
            `Operation ${input.operationId} was already used with another payload`,
          );
        return parse<CampaignMemoryBranchProjectionResult>(journal.after, null as never);
      }
      const sourceChat = (await tx.select().from(chats).where(eq(chats.id, input.sourceChatId)).limit(1))[0];
      const targetChat = (await tx.select().from(chats).where(eq(chats.id, input.targetChatId)).limit(1))[0];
      if (!sourceChat || sourceChat.mode !== "game" || !targetChat || targetChat.mode !== "game")
        fail("CAMPAIGN_MEMORY_CHAT_NOT_FOUND", "Both chats must be existing game chats");
      const storage = createCampaignMemoryStorage(tx);
      const [sourceSources, targetSources] = await Promise.all([
        readCampaignMemorySources(tx, { chatId: input.sourceChatId, messageIds: [...messageMap.keys()] }),
        readCampaignMemorySources(tx, { chatId: input.targetChatId, messageIds: [...messageMap.values()] }),
      ]);
      const sourceMessageRows = await tx
        .select({ id: messages.id, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.chatId, input.sourceChatId));
      const targetMessageRows = await tx
        .select({ id: messages.id, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.chatId, input.targetChatId));
      const sourceMessageById = new Map(sourceMessageRows.map((row) => [row.id, row]));
      const targetMessageById = new Map(targetMessageRows.map((row) => [row.id, row]));
      const targetIds = new Set<string>();
      for (const [sourceId, targetId] of messageMap) {
        if (!sourceMessageById.has(sourceId))
          fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `Message map source ${sourceId} is outside source chat`);
        if (!targetMessageById.has(targetId))
          fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `Message map target ${targetId} is outside target chat`);
        if (targetIds.has(targetId))
          fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `Message map target ${targetId} is duplicated`);
        targetIds.add(targetId);
      }
      const sourceOrderMessages = [...messageMap.keys()]
        .map((id) => sourceMessageById.get(id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row));
      const sourceOrderMap = buildCampaignMemoryMessageOrderMap(sourceOrderMessages);
      const parsedCutoff =
        parseCampaignMemoryMessageOrder(input.cutoffOrder) ??
        fail("CAMPAIGN_MEMORY_INVALID_VALUE", "cutoffOrder must be a valid campaign-memory message order");
      if (sourceOrderMap.get(parsedCutoff.messageId) !== input.cutoffOrder)
        fail(
          "CAMPAIGN_MEMORY_INVALID_REFERENCE",
          `Cutoff message ${parsedCutoff.messageId} is not mapped into the target branch`,
        );
      const targetOrderBySourceId = new Map<string, { id: string; createdAt: string }>();
      for (const [sourceId, targetId] of messageMap) {
        const target =
          targetMessageById.get(targetId) ??
          fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `Message map target ${targetId} is outside target chat`);
        targetOrderBySourceId.set(sourceId, { id: target.id, createdAt: target.createdAt });
      }
      const sourceOrderIds = [...sourceOrderMessages]
        .sort((left, right) =>
          compareCampaignMemoryMessageOrder(sourceOrderMap.get(left.id)!, sourceOrderMap.get(right.id)!),
        )
        .map((message) => message.id);
      const targetOrderIds = [...sourceOrderIds].sort((left, right) => {
        const targetLeft = targetOrderBySourceId.get(left)!;
        const targetRight = targetOrderBySourceId.get(right)!;
        const leftOrder = `${targetLeft.createdAt}|${targetLeft.id}`;
        const rightOrder = `${targetRight.createdAt}|${targetRight.id}`;
        return compareCampaignMemoryMessageOrder(leftOrder, rightOrder);
      });
      const reorderedMessageIds = new Set<string>();
      sourceOrderIds.forEach((sourceId, index) => {
        if (targetOrderIds[index] !== sourceId) reorderedMessageIds.add(sourceId);
      });
      const [entities, facts, knowledge, events, states, relationships] = await Promise.all([
        storage.listEntities({ chatId: input.sourceChatId }),
        storage.listFacts({ chatId: input.sourceChatId }),
        storage.listKnowledge({ chatId: input.sourceChatId }),
        storage.listEvents({ chatId: input.sourceChatId }),
        storage.listCurrentState({ chatId: input.sourceChatId }),
        storage.listRelationships({ chatId: input.sourceChatId }),
      ]);
      const held: CampaignMemoryBranchHeld[] = [];
      const hold = (recordType: CampaignMemoryBranchHeld["recordType"], recordId: string, reason: string) => {
        if (!held.some((item) => item.recordType === recordType && item.recordId === recordId))
          held.push({ recordType, recordId, reason });
      };
      const factById = new Map(facts.map((r) => [r.factId, r]));
      const knowledgeById = new Map(knowledge.map((r) => [r.knowledgeId, r]));
      const eventById = new Map(events.map((r) => [r.eventId, r]));
      const stateById = new Map(states.map((r) => [r.stateId, r]));
      const relationshipById = new Map(relationships.map((r) => [r.relationshipId, r]));
      const factIds = new Set(
        facts
          .filter(
            (r) =>
              atOrBefore(r.validFromOrder, input.cutoffOrder) &&
              (r.validToOrder === undefined || atOrBefore(r.validToOrder, input.cutoffOrder)),
          )
          .map((r) => r.factId),
      );
      const knowledgeIds = new Set(
        knowledge.filter((r) => atOrBefore(r.learnedAtOrder, input.cutoffOrder)).map((r) => r.knowledgeId),
      );
      const eventIds = new Set(
        events.filter((r) => atOrBefore(r.occurrenceOrder, input.cutoffOrder)).map((r) => r.eventId),
      );
      const stateIds = new Set(
        states.filter((r) => atOrBefore(r.validAtOrder, input.cutoffOrder)).map((r) => r.stateId),
      );
      const relationshipIds = new Set(
        relationships
          .filter(
            (r) =>
              atOrBefore(r.effectiveFrom, input.cutoffOrder) &&
              (r.effectiveTo === undefined || atOrBefore(r.effectiveTo, input.cutoffOrder)),
          )
          .map((r) => r.relationshipId),
      );
      for (const r of facts)
        if (!factIds.has(r.factId))
          hold(
            "fact",
            r.factId,
            atOrBefore(r.validFromOrder, input.cutoffOrder) &&
              r.validToOrder !== undefined &&
              !atOrBefore(r.validToOrder, input.cutoffOrder)
              ? "fact interval extends beyond the branch cutoff"
              : "fact has no provable validFromOrder at or before branch cutoff",
          );
      for (const r of knowledge)
        if (!knowledgeIds.has(r.knowledgeId))
          hold("knowledge", r.knowledgeId, "knowledge is unknown-time or learned after branch cutoff");
      for (const r of events)
        if (!eventIds.has(r.eventId))
          hold("event", r.eventId, "event has no provable occurrenceOrder at or before branch cutoff");
      for (const r of states)
        if (!stateIds.has(r.stateId))
          hold("current-state", r.stateId, "state has no provable validAtOrder at or before branch cutoff");
      for (const r of relationships)
        if (!relationshipIds.has(r.relationshipId))
          hold(
            "relationship",
            r.relationshipId,
            atOrBefore(r.effectiveFrom, input.cutoffOrder) &&
              r.effectiveTo !== undefined &&
              !atOrBefore(r.effectiveTo, input.cutoffOrder)
              ? "relationship interval extends beyond the branch cutoff"
              : "relationship has no provable effectiveFrom at or before branch cutoff",
          );
      const entityIds = new Set(entities.map((r) => r.entityId));
      const assertInternal = (id: string, label: string) => {
        if (!entityIds.has(id)) fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `${label} ${id} is outside source chat`);
      };
      for (const r of facts) {
        assertInternal(r.subjectEntityId, "Fact subject");
        if (r.supersedesFactId && !factById.has(r.supersedesFactId))
          hold("fact", r.factId, "supersedesFactId points outside the source chat");
      }
      for (const r of knowledge) {
        assertInternal(r.holderEntityId, "Knowledge holder");
        if (r.factId && !factById.has(r.factId))
          fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `Knowledge fact ${r.factId} is outside source chat`);
        if (r.attributedClaim) assertInternal(r.attributedClaim.subjectEntityId, "Knowledge claim subject");
      }
      for (const r of events) {
        r.participantEntityIds.forEach((id) => assertInternal(id, "Event participant"));
        if (r.locationEntityId) assertInternal(r.locationEntityId, "Event location");
      }
      for (const r of states) {
        assertInternal(r.entityId, "State entity");
        if (!eventById.has(r.sourceEventId))
          fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `State event ${r.sourceEventId} is outside source chat`);
      }
      for (const r of relationships) {
        assertInternal(r.sourceEntityId, "Relationship source");
        assertInternal(r.targetEntityId, "Relationship target");
      }
      const evidenceFor = async (
        type: CampaignMemoryBranchHeld["recordType"],
        id: string,
        evidence: CampaignMemoryEvidence[],
      ) => {
        if (
          evidence.some(
            (item) => typeof (item as CampaignMemoryEvidence & { sourceHash?: unknown }).sourceHash !== "string",
          )
        ) {
          hold(type, id, "evidence has no current sourceHash");
          return null;
        }
        if (
          evidence.some((item) => {
            const order = sourceOrderMap.get(item.messageId);
            return !order || compareCampaignMemoryMessageOrder(order, input.cutoffOrder) > 0;
          })
        ) {
          hold(type, id, "evidence cites a source message after the branch cutoff");
          return null;
        }
        const copied = await copyEvidence(evidence, messageMap, sourceSources, targetSources);
        if (!copied) {
          hold(type, id, "evidence source is unmapped, missing, or quote is not current");
          return null;
        }
        return copied;
      };
      const dropSupersessionDependents = () => {
        let changed = true;
        while (changed) {
          changed = false;
          for (const r of facts)
            if (factIds.has(r.factId) && r.supersedesFactId && !factIds.has(r.supersedesFactId)) {
              factIds.delete(r.factId);
              hold("fact", r.factId, "supersedesFactId points to a fact that was not copied");
              changed = true;
            }
        }
      };
      for (const r of facts)
        if (factIds.has(r.factId) && r.supersedesFactId && !factById.has(r.supersedesFactId)) {
          factIds.delete(r.factId);
          hold("fact", r.factId, "supersedesFactId points outside the source chat");
        }
      dropSupersessionDependents();
      const factEvidence = new Map<string, CampaignMemoryEvidence[]>();
      for (const id of [...factIds]) {
        const value = await evidenceFor("fact", id, factById.get(id)!.evidence);
        if (value) factEvidence.set(id, value);
        else factIds.delete(id);
      }
      dropSupersessionDependents();
      const knowledgeEvidence = new Map<string, CampaignMemoryEvidence[]>();
      for (const id of [...knowledgeIds]) {
        const r = knowledgeById.get(id)!;
        if (r.factId && !factIds.has(r.factId)) {
          knowledgeIds.delete(id);
          hold("knowledge", id, "knowledge fact was not copied");
          continue;
        }
        const value = await evidenceFor("knowledge", id, r.learnedFrom);
        if (value) knowledgeEvidence.set(id, value);
        else knowledgeIds.delete(id);
      }
      const eventEvidence = new Map<string, CampaignMemoryEvidence[]>();
      for (const id of [...eventIds]) {
        const value = await evidenceFor("event", id, eventById.get(id)!.evidence);
        if (value) eventEvidence.set(id, value);
        else eventIds.delete(id);
      }
      for (const id of [...stateIds])
        if (!eventIds.has(stateById.get(id)!.sourceEventId)) {
          stateIds.delete(id);
          hold("current-state", id, "state source event was not copied");
        }
      const relationshipEvidence = new Map<string, CampaignMemoryEvidence[]>();
      for (const id of [...relationshipIds]) {
        const value = await evidenceFor("relationship", id, relationshipById.get(id)!.evidence);
        if (value) relationshipEvidence.set(id, value);
        else relationshipIds.delete(id);
      }
      const temporalOrderReason = "temporal order is unmapped or reordered by target message IDs";
      const remapTemporalOrder = (value: string | undefined): string | undefined | null => {
        if (value === undefined) return undefined;
        if (!value.startsWith("m1|")) return null;
        const parsed = parseCampaignMemoryMessageOrder(value);
        if (!parsed || sourceOrderMap.get(parsed.messageId) !== value || reorderedMessageIds.has(parsed.messageId))
          return null;
        return remapCampaignMemoryMessageOrder(value, targetOrderBySourceId);
      };
      const factOrders = new Map<string, { validFromOrder?: string; validToOrder?: string }>();
      for (const id of [...factIds]) {
        const source = factById.get(id)!;
        const validFromOrder = remapTemporalOrder(source.validFromOrder);
        const validToOrder = remapTemporalOrder(source.validToOrder);
        if (validFromOrder === null || validToOrder === null) {
          factIds.delete(id);
          hold("fact", id, temporalOrderReason);
        } else factOrders.set(id, { validFromOrder, validToOrder });
      }
      dropSupersessionDependents();
      const knowledgeOrders = new Map<string, string | undefined>();
      for (const id of [...knowledgeIds]) {
        const value = remapTemporalOrder(knowledgeById.get(id)!.learnedAtOrder);
        if (value === null) {
          knowledgeIds.delete(id);
          hold("knowledge", id, temporalOrderReason);
        } else knowledgeOrders.set(id, value);
      }
      const eventOrders = new Map<string, string>();
      for (const id of [...eventIds]) {
        const value = remapTemporalOrder(eventById.get(id)!.occurrenceOrder);
        if (value === null || value === undefined) {
          eventIds.delete(id);
          hold("event", id, temporalOrderReason);
        } else eventOrders.set(id, value);
      }
      const stateOrders = new Map<string, string>();
      for (const id of [...stateIds]) {
        const value = remapTemporalOrder(stateById.get(id)!.validAtOrder);
        if (value === null || value === undefined) {
          stateIds.delete(id);
          hold("current-state", id, temporalOrderReason);
        } else stateOrders.set(id, value);
      }
      const relationshipOrders = new Map<string, { effectiveFrom?: string; effectiveTo?: string }>();
      for (const id of [...relationshipIds]) {
        const source = relationshipById.get(id)!;
        const effectiveFrom = remapTemporalOrder(source.effectiveFrom);
        const effectiveTo = remapTemporalOrder(source.effectiveTo);
        if (effectiveFrom === null || effectiveTo === null) {
          relationshipIds.delete(id);
          hold("relationship", id, temporalOrderReason);
        } else relationshipOrders.set(id, { effectiveFrom, effectiveTo });
      }
      for (const id of [...knowledgeIds]) {
        const source = knowledgeById.get(id)!;
        if (source.factId && !factIds.has(source.factId)) {
          knowledgeIds.delete(id);
          hold("knowledge", id, "knowledge depends on a fact that was not copied");
        }
      }
      for (const id of [...stateIds]) {
        const source = stateById.get(id)!;
        if (!eventIds.has(source.sourceEventId)) {
          stateIds.delete(id);
          hold("current-state", id, "state depends on an event that was not copied");
        }
      }
      const requiredEntities = () => {
        const result = new Set<string>();
        for (const id of factIds) result.add(factById.get(id)!.subjectEntityId);
        for (const id of knowledgeIds) {
          const r = knowledgeById.get(id)!;
          result.add(r.holderEntityId);
          if (r.attributedClaim) result.add(r.attributedClaim.subjectEntityId);
        }
        for (const id of eventIds) {
          const r = eventById.get(id)!;
          r.participantEntityIds.forEach((entityId) => result.add(entityId));
          if (r.locationEntityId) result.add(r.locationEntityId);
        }
        for (const id of stateIds) result.add(stateById.get(id)!.entityId);
        for (const id of relationshipIds) {
          const r = relationshipById.get(id)!;
          result.add(r.sourceEntityId);
          result.add(r.targetEntityId);
        }
        return result;
      };
      const unavailableEntities = new Set<string>();
      const ownerReader = createCampaignMemoryOwnerReader(tx);
      // Built once: rebuilding the set per entity made branching a large campaign quadratic.
      const required = requiredEntities();
      for (const source of entities.filter((item) => required.has(item.entityId))) {
        const owner = source.owner;
        if (owner.type === "registry") {
          if (owner.store !== "campaign-memory" || owner.recordId !== source.entityId) {
            unavailableEntities.add(source.entityId);
            hold("entity", source.entityId, "registry owner is not self-owned");
          }
          continue;
        }
        const resolution = await validateCampaignMemoryEntityOwner(
          { ...source, chatId: input.targetChatId, owner },
          ownerReader,
        );
        if (!resolution.selected) {
          unavailableEntities.add(source.entityId);
          hold("entity", source.entityId, "entity owner is unavailable or not visible in target chat");
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const id of [...factIds])
          if (unavailableEntities.has(factById.get(id)!.subjectEntityId)) {
            factIds.delete(id);
            hold("fact", id, "fact depends on an entity with an unavailable owner");
            changed = true;
          }
        const beforeSupersession = factIds.size;
        dropSupersessionDependents();
        if (factIds.size !== beforeSupersession) changed = true;
        for (const id of [...knowledgeIds]) {
          const r = knowledgeById.get(id)!;
          if (
            unavailableEntities.has(r.holderEntityId) ||
            (r.attributedClaim && unavailableEntities.has(r.attributedClaim.subjectEntityId)) ||
            (r.factId && !factIds.has(r.factId))
          ) {
            knowledgeIds.delete(id);
            hold("knowledge", id, "knowledge depends on a record or entity that was not copied");
            changed = true;
          }
        }
        for (const id of [...eventIds]) {
          const r = eventById.get(id)!;
          if (
            r.participantEntityIds.some((entityId) => unavailableEntities.has(entityId)) ||
            (r.locationEntityId && unavailableEntities.has(r.locationEntityId))
          ) {
            eventIds.delete(id);
            hold("event", id, "event depends on an entity with an unavailable owner");
            changed = true;
          }
        }
        for (const id of [...stateIds]) {
          const r = stateById.get(id)!;
          if (!eventIds.has(r.sourceEventId) || unavailableEntities.has(r.entityId)) {
            stateIds.delete(id);
            hold("current-state", id, "state depends on a record or entity that was not copied");
            changed = true;
          }
        }
        for (const id of [...relationshipIds]) {
          const r = relationshipById.get(id)!;
          if (unavailableEntities.has(r.sourceEntityId) || unavailableEntities.has(r.targetEntityId)) {
            relationshipIds.delete(id);
            hold("relationship", id, "relationship depends on an entity with an unavailable owner");
            changed = true;
          }
        }
      }
      dropSupersessionDependents();
      const neededEntities = requiredEntities();
      const idMap = new Map<string, string>();
      for (const id of neededEntities) if (!unavailableEntities.has(id)) idMap.set(id, randomUUID());
      for (const id of factIds) idMap.set(id, randomUUID());
      for (const id of knowledgeIds) idMap.set(id, randomUUID());
      for (const id of eventIds) idMap.set(id, randomUUID());
      for (const id of stateIds) idMap.set(id, randomUUID());
      for (const id of relationshipIds) idMap.set(id, randomUUID());
      const mapped = (id: string, label: string) =>
        idMap.get(id) ?? fail("CAMPAIGN_MEMORY_INVALID_REFERENCE", `${label} ${id} was not copied`);
      const copyFacts: CampaignMemoryFact[] = [...factIds].map((id) => {
        const r = factById.get(id)!;
        return {
          ...r,
          factId: mapped(r.factId, "Fact"),
          chatId: input.targetChatId,
          subjectEntityId: mapped(r.subjectEntityId, "Fact subject"),
          validFromOrder: factOrders.get(id)?.validFromOrder,
          validToOrder: factOrders.get(id)?.validToOrder,
          supersedesFactId: r.supersedesFactId ? mapped(r.supersedesFactId, "Superseded fact") : undefined,
          evidence: factEvidence.get(id)!,
          provenance: branchProvenance(r.provenance, input.sourceChatId, r.factId, {
            ...(r.validFromOrder === undefined ? {} : { validFromOrder: r.validFromOrder }),
            ...(r.validToOrder === undefined ? {} : { validToOrder: r.validToOrder }),
          }),
        };
      });
      const copyKnowledge: CampaignMemoryKnowledge[] = [...knowledgeIds].map((id) => {
        const r = knowledgeById.get(id)!;
        return {
          ...r,
          knowledgeId: mapped(r.knowledgeId, "Knowledge"),
          chatId: input.targetChatId,
          holderEntityId: mapped(r.holderEntityId, "Knowledge holder"),
          learnedAtOrder: knowledgeOrders.get(id),
          factId: r.factId ? mapped(r.factId, "Knowledge fact") : undefined,
          attributedClaim: r.attributedClaim
            ? {
                ...r.attributedClaim,
                subjectEntityId: mapped(r.attributedClaim.subjectEntityId, "Knowledge claim subject"),
              }
            : undefined,
          learnedFrom: knowledgeEvidence.get(id)!,
          provenance: branchProvenance(
            r.provenance,
            input.sourceChatId,
            r.knowledgeId,
            r.learnedAtOrder === undefined ? undefined : { learnedAtOrder: r.learnedAtOrder },
          ),
        };
      });
      const copyEvents: CampaignMemoryEvent[] = [...eventIds].map((id) => {
        const r = eventById.get(id)!;
        return {
          ...r,
          eventId: mapped(r.eventId, "Event"),
          chatId: input.targetChatId,
          occurrenceOrder: eventOrders.get(id)!,
          participantEntityIds: r.participantEntityIds.map((entityId) => mapped(entityId, "Event participant")),
          locationEntityId: r.locationEntityId ? mapped(r.locationEntityId, "Event location") : undefined,
          evidence: eventEvidence.get(id)!,
          provenance: branchProvenance(r.provenance, input.sourceChatId, r.eventId, {
            occurrenceOrder: r.occurrenceOrder,
          }),
        };
      });
      const copyStates: CampaignMemoryCurrentState[] = [...stateIds].map((id) => {
        const r = stateById.get(id)!;
        return {
          ...r,
          stateId: mapped(r.stateId, "State"),
          chatId: input.targetChatId,
          validAtOrder: stateOrders.get(id)!,
          entityId: mapped(r.entityId, "State entity"),
          sourceEventId: mapped(r.sourceEventId, "State event"),
          provenance: branchProvenance(r.provenance, input.sourceChatId, r.stateId, { validAtOrder: r.validAtOrder }),
        };
      });
      const copyRelationships: CampaignMemoryRelationship[] = [...relationshipIds].map((id) => {
        const r = relationshipById.get(id)!;
        return {
          ...r,
          relationshipId: mapped(r.relationshipId, "Relationship"),
          chatId: input.targetChatId,
          effectiveFrom: relationshipOrders.get(id)?.effectiveFrom,
          effectiveTo: relationshipOrders.get(id)?.effectiveTo,
          sourceEntityId: mapped(r.sourceEntityId, "Relationship source"),
          targetEntityId: mapped(r.targetEntityId, "Relationship target"),
          evidence: relationshipEvidence.get(id)!,
          provenance: branchProvenance(r.provenance, input.sourceChatId, r.relationshipId, {
            ...(r.effectiveFrom === undefined ? {} : { effectiveFrom: r.effectiveFrom }),
            ...(r.effectiveTo === undefined ? {} : { effectiveTo: r.effectiveTo }),
          }),
        };
      });
      for (const entity of entities)
        if (neededEntities.has(entity.entityId) && !unavailableEntities.has(entity.entityId))
          hold(
            "entity",
            entity.entityId,
            "entity metadata history is not ordered; only stable identity fields were projected",
          );
      const copiedEntities = entities
        .filter((r) => neededEntities.has(r.entityId) && !unavailableEntities.has(r.entityId))
        .map((r) => ({
          ...r,
          entityId: mapped(r.entityId, "Entity"),
          chatId: input.targetChatId,
          owner: r.owner.type === "registry" ? { ...r.owner, recordId: mapped(r.entityId, "Entity") } : r.owner,
          aliases: [],
          tags: [],
          summary: undefined,
          attributes: {},
          provenance: branchProvenance(r.provenance, input.sourceChatId, r.entityId),
        }));
      if (copiedEntities.length)
        await tx.insert(campaignMemoryEntities).values(
          copiedEntities.map((r) => ({
            ...r,
            owner: JSON.stringify(r.owner),
            aliases: JSON.stringify(r.aliases),
            tags: JSON.stringify(r.tags),
            attributes: JSON.stringify(r.attributes),
            manualLock: r.manualLock ? 1 : 0,
            provenance: JSON.stringify(r.provenance),
          })),
        );
      if (copyFacts.length)
        await tx.insert(campaignMemoryFacts).values(
          copyFacts.map((r) => ({
            ...r,
            value: JSON.stringify(r.value),
            conditions: JSON.stringify(r.conditions),
            evidence: JSON.stringify(r.evidence),
            provenance: JSON.stringify(r.provenance),
            manualLock: r.manualLock ? 1 : 0,
          })),
        );
      if (copyKnowledge.length)
        await tx.insert(campaignMemoryKnowledge).values(
          copyKnowledge.map((r) => ({
            ...r,
            learnedFrom: JSON.stringify(r.learnedFrom),
            attributedClaim: r.attributedClaim ? JSON.stringify(r.attributedClaim) : null,
            provenance: JSON.stringify(r.provenance),
            manualLock: r.manualLock ? 1 : 0,
          })),
        );
      if (copyEvents.length)
        await tx.insert(campaignMemoryEvents).values(
          copyEvents.map((r) => ({
            ...r,
            participantEntityIds: JSON.stringify(r.participantEntityIds),
            transitions: JSON.stringify(r.transitions),
            evidence: JSON.stringify(r.evidence),
            provenance: JSON.stringify(r.provenance),
            immutable: 1,
          })),
        );
      if (copyStates.length)
        await tx.insert(campaignMemoryCurrentState).values(
          copyStates.map((r) => ({
            ...r,
            value: JSON.stringify(r.value),
            protected: r.protected ? 1 : 0,
            provenance: JSON.stringify(r.provenance),
            manualLock: r.manualLock ? 1 : 0,
          })),
        );
      if (copyRelationships.length)
        await tx.insert(campaignMemoryRelationships).values(
          copyRelationships.map((r) => ({
            ...r,
            evidence: JSON.stringify(r.evidence),
            provenance: JSON.stringify(r.provenance),
            manualLock: r.manualLock ? 1 : 0,
          })),
        );
      const result: CampaignMemoryBranchProjectionResult = {
        sourceChatId: input.sourceChatId,
        targetChatId: input.targetChatId,
        operationId: input.operationId,
        copied: {
          entities: copiedEntities.length,
          facts: copyFacts.length,
          knowledge: copyKnowledge.length,
          events: copyEvents.length,
          currentState: copyStates.length,
          relationships: copyRelationships.length,
        },
        held,
        idMap: Object.fromEntries(idMap),
        messageIdMap: Object.fromEntries(messageMap),
      };
      await tx.insert(campaignMemoryMutationJournal).values({
        journalId: randomUUID(),
        chatId: input.targetChatId,
        operationId: input.operationId,
        recordType: "branch-projection",
        recordId: input.targetChatId,
        actor: "system",
        expectedRevision: null,
        before: null,
        after: JSON.stringify(result),
        reason: `Branch memory projection from ${input.sourceChatId} at ${input.cutoffOrder}`,
        evidence: "[]",
        compensationOperationId: null,
        payloadHash: requestHash,
        createdAt: new Date().toISOString(),
      });
      return result;
    },
    { durable: true },
  );
}
export const copyCampaignMemoryToBranch = projectCampaignMemoryBranch;
