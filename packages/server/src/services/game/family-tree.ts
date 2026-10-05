import { createHash } from "node:crypto";
import type { DB } from "../../db/connection.js";
import { and, eq, inArray } from "../../db/file-query.js";
import { characters, personas, chats, campaignMemoryMutationJournal } from "../../db/schema/index.js";
import { createCampaignMemoryStorage, type CampaignMemoryWriteAdmission } from "../storage/campaign-memory.storage.js";
import { listCampaignSessionChats } from "./campaign-memory-campaign-scope.js";
import { applyCampaignMemoryMutation, CampaignMemoryMutationError } from "./campaign-memory-mutations.js";
import { requireCampaignSurface } from "../features/campaign-surface-opt-in.js";
import {
  normalizeAvatarCrop,
  FAMILY_FACT_PREDICATE,
  familyPersonId,
  familyKind,
  familyLinkKey,
  familyCreatesCycle,
  type FamilyLink,
  type FamilyPerson,
  type FamilyTreeData,
  type FamilyKind,
} from "@marinara-engine/shared";

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Read raw sessions: the general wiki projection can fold similar names; kinship must not. */
export async function readFamilyTree(db: DB, chatId: string): Promise<FamilyTreeData> {
  const chat = (await db.select().from(chats).where(eq(chats.id, chatId)).limit(1))[0];
  if (!chat || chat.mode !== "game") throw new CampaignMemoryMutationError("FAMILY_NOT_FOUND", "Game not found");
  const sessions = await listCampaignSessionChats(db, chatId);
  if (!sessions.length) throw new CampaignMemoryMutationError("FAMILY_NOT_FOUND", "Chat not found");
  const storage = createCampaignMemoryStorage(db);
  const people = new Map<string, FamilyPerson>();
  const links = new Map<string, FamilyLink>();
  const manual = new Map<string, FamilyLink | null>();
  for (const session of sessions) {
    const scope = { chatId: session.id };
    const [entities, relationships, facts] = await Promise.all([
      storage.listEntities(scope),
      storage.listRelationships(scope),
      storage.listFacts(scope),
    ]);
    const ids = new Map<string, string>();
    for (const entity of entities) {
      if (entity.kind !== "character" && entity.kind !== "persona") continue;
      const id = familyPersonId(entity);
      ids.set(entity.entityId, id);
      const existing = people.get(id);
      people.set(id, {
        id,
        owner: entity.owner,
        entityId: entity.entityId,
        chatId: session.id,
        sessionNumber: session.sessionNumber,
        name: entity.aliases[0] || entity.owner.recordId,
        tags: [...new Set([...(existing?.tags ?? []), ...entity.tags])],
        available: entity.status === "active",
      });
    }
    for (const record of relationships) {
      const kind = familyKind(record.type);
      const sourceId = ids.get(record.sourceEntityId);
      const targetId = ids.get(record.targetEntityId);
      if (!kind || !sourceId || !targetId) continue;
      const link: FamilyLink = {
        id: record.relationshipId,
        chatId: session.id,
        sessionNumber: session.sessionNumber,
        revision: record.revision,
        recordType: "relationship",
        sourceId,
        targetId,
        kind,
        note: record.notes ?? "",
        confirmed: record.status === "active" && (record.manualLock || record.provenance.actor === "user"),
      };
      const key = familyLinkKey(link);
      if (record.status === "held" || record.status === "ended") {
        if (record.manualLock || record.provenance.actor === "user") manual.set(key, null);
        continue;
      }
      if (link.confirmed) manual.set(key, link);
      else links.set(key, link);
    }
    for (const fact of facts) {
      if (fact.predicate !== FAMILY_FACT_PREDICATE || fact.author !== "user" || !fact.manualLock) continue;
      const value = object(fact.value);
      const kind = typeof value.kind === "string" ? familyKind(value.kind) : null;
      const sourceId = ids.get(fact.subjectEntityId);
      if (!kind || !sourceId || (value.targetId !== null && typeof value.targetId !== "string")) continue;
      const link: FamilyLink = {
        id: fact.factId,
        chatId: session.id,
        sessionNumber: session.sessionNumber,
        revision: fact.revision,
        recordType: "fact",
        sourceId,
        targetId: value.targetId as string | null,
        kind,
        note: typeof value.note === "string" ? value.note : "",
        confirmed: true,
      };
      manual.set(familyLinkKey(link), fact.status === "verified" ? link : null);
    }
  }
  // User assertions (including removals) take precedence over later automatic guesses.
  for (const [key, link] of manual) {
    if (link) links.set(key, link);
    else links.delete(key);
  }
  // Display current library names and portraits by stable owner ID, never by alias matching.
  const sessionRows = await db
    .select()
    .from(chats)
    .where(
      inArray(
        chats.id,
        sessions.map((session) => session.id),
      ),
    );
  const metadata = new Map(sessionRows.map((row) => [row.id, object(row.metadata)]));
  const cardIds = [...people.values()].filter((p) => p.owner.store === "characters").map((p) => p.owner.recordId);
  for (const meta of metadata.values()) {
    if (!Array.isArray(meta.gameNpcs)) continue;
    for (const value of meta.gameNpcs) {
      const npc = object(value);
      if (typeof npc.characterId === "string") cardIds.push(npc.characterId);
    }
  }
  const personaIds = [...people.values()].filter((p) => p.owner.store === "personas").map((p) => p.owner.recordId);
  const [cards, personaRows] = await Promise.all([
    cardIds.length ? db.select().from(characters).where(inArray(characters.id, cardIds)) : [],
    personaIds.length ? db.select().from(personas).where(inArray(personas.id, personaIds)) : [],
  ]);
  const owners = new Map<string, Pick<FamilyPerson, "name" | "avatarUrl" | "avatarCrop">>();
  for (const card of cards) {
    const data = object(card.data);
    owners.set(JSON.stringify(["characters", card.id]), {
      name: typeof data.name === "string" ? data.name : card.id,
      avatarUrl: card.avatarPath,
      avatarCrop: normalizeAvatarCrop(object(data.extensions).avatarCrop),
    });
  }
  for (const persona of personaRows)
    owners.set(JSON.stringify(["personas", persona.id]), {
      name: persona.name,
      avatarUrl: persona.avatarPath,
      avatarCrop: normalizeAvatarCrop(persona.avatarCrop),
    });
  // Iterate in campaign order, not database order. Only exact NPC ids qualify.
  for (const session of sessions) {
    const npcs = metadata.get(session.id)?.gameNpcs;
    if (!Array.isArray(npcs)) continue;
    for (const value of npcs) {
      const npc = object(value);
      if (typeof npc.id !== "string" || typeof npc.name !== "string") continue;
      const linked =
        typeof npc.characterId === "string" ? owners.get(JSON.stringify(["characters", npc.characterId])) : undefined;
      owners.set(JSON.stringify(["game-npcs", npc.id]), {
        name: npc.name,
        // An explicit library-card reference can supply presentation without merging identities.
        avatarUrl: linked?.avatarUrl || (typeof npc.avatarUrl === "string" ? npc.avatarUrl : null),
        avatarCrop: linked?.avatarUrl ? linked.avatarCrop : null,
      });
    }
  }
  for (const person of people.values()) {
    const owner = owners.get(person.id);
    if (owner) Object.assign(person, owner);
    else if (person.owner.type === "existing") person.available = false;
  }
  return {
    people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    links: [...links.values()],
  };
}

export interface FamilyTreeWrite {
  operationId: string;
  action: "save" | "remove";
  id?: string;
  revision?: number;
  sourceId: string;
  targetId: string | null;
  kind: FamilyKind;
  note?: string;
}

/** One transaction covers the fresh graph, cycle check, revision check and journaled write. */
export async function writeFamilyTree(
  db: DB,
  chatId: string,
  input: FamilyTreeWrite,
  assertWriteAllowed: CampaignMemoryWriteAdmission = () => requireCampaignSurface("campaignMemory", "familyTree"),
) {
  // Existing journal storage is also the retry receipt. Hash the public request in a fixed
  // field order, so a reused operation id cannot silently accept a different edit.
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        chatId,
        action: input.action,
        id: input.id,
        revision: input.revision,
        sourceId: input.sourceId,
        targetId: input.targetId,
        kind: input.kind,
        note: input.note,
      }),
    )
    .digest("hex");
  const reason = `Family tree edit [${requestHash}]`;
  return db.transaction(
    async (tx) => {
      requireCampaignSurface("campaignMemory", "familyTree");
      const sessions = await listCampaignSessionChats(tx, chatId);
      const replay = sessions.length
        ? (
            await tx
              .select()
              .from(campaignMemoryMutationJournal)
              .where(
                and(
                  inArray(
                    campaignMemoryMutationJournal.chatId,
                    sessions.map((session) => session.id),
                  ),
                  eq(campaignMemoryMutationJournal.operationId, input.operationId),
                ),
              )
              .limit(1)
          )[0]
        : undefined;
      if (replay) {
        if (replay.reason !== reason)
          throw new CampaignMemoryMutationError(
            "CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT",
            "This operation id was used for another edit",
          );
        if (!replay.after)
          throw new CampaignMemoryMutationError("FAMILY_CONFLICT", "The saved operation has no result");
        return JSON.parse(replay.after);
      }
      const graph = await readFamilyTree(tx, chatId);
      const source = graph.people.find((p) => p.id === input.sourceId);
      const target = graph.people.find((p) => p.id === input.targetId);
      const current = input.id ? graph.links.find((link) => link.id === input.id) : undefined;
      const fail = (code: string, message: string): never => {
        throw new CampaignMemoryMutationError(code, message);
      };
      if (!source) fail("FAMILY_NOT_FOUND", "The selected person is no longer available in this campaign");
      if (input.id && (!current || current.sourceId !== input.sourceId))
        fail("FAMILY_CONFLICT", "The family link changed. Reload before editing.");
      if (current && current.revision !== input.revision)
        fail("FAMILY_CONFLICT", "The family link changed. Reload before editing.");
      // Omitted notes preserve the stored value. Removal never rewrites any assertion.
      const value =
        input.action === "remove" && current
          ? { kind: current.kind, targetId: current.targetId, note: current.note }
          : { kind: input.kind, targetId: input.targetId, note: input.note ?? current?.note ?? "" };
      if (input.action === "save") {
        if (value.note.length > (current?.recordType === "relationship" ? 20_000 : 2_000))
          fail("FAMILY_INVALID", "The note exceeds the record's length limit");
        if (input.targetId && !target)
          fail("FAMILY_NOT_FOUND", "The selected relative is no longer available in this campaign");
        if (current?.recordType === "relationship" && current.targetId !== input.targetId)
          fail(
            "FAMILY_CONFLICT",
            "Existing wiki relationships keep their endpoints. Remove the link and add a new one.",
          );
        if (input.sourceId === input.targetId) fail("FAMILY_SELF_LINK", "A person cannot be their own relative");
        if (!input.targetId && !value.note.trim())
          fail("FAMILY_UNKNOWN_NOTE", "Describe the unknown or uncertain relative");
        if (
          familyCreatesCycle(
            graph.links.filter((link) => link.id !== input.id),
            input,
          )
        )
          fail("FAMILY_CYCLE", "This link would make a person their own ancestor");
        if (
          graph.links.some(
            (link) =>
              link.id !== input.id &&
              link.confirmed &&
              familyLinkKey(link) === familyLinkKey({ ...input, note: value.note }),
          )
        )
          fail("FAMILY_DUPLICATE", "This family link already exists");
      } else if (!current) fail("FAMILY_NOT_FOUND", "Family link not found");
      const writeChatId = current?.chatId ?? source!.chatId;
      const command = {
        chatId: writeChatId,
        operationId: input.operationId,
        actor: "user" as const,
        reason,
      };
      if (current?.recordType === "relationship") {
        // Existing wiki relationships retain their original record, evidence and revision history.
        requireCampaignSurface("campaignMemory", "familyTree");
        return applyCampaignMemoryMutation(
          tx,
          {
            ...command,
            recordType: "relationship",
            action: "update",
            recordId: current.id,
            expectedRevision: input.revision!,
            patch: {
              ...(input.action === "save" && input.note !== undefined ? { notes: input.note } : {}),
              type: `${value.kind}-of`,
              inverseLabel:
                value.kind === "parent"
                  ? "child-of"
                  : value.kind === "child"
                    ? "parent-of"
                    : value.kind === "adoptive-parent"
                      ? "adopted-child-of"
                      : value.kind === "guardian"
                        ? "ward-of"
                        : `${value.kind}-of`,
              status: input.action === "remove" ? "held" : "active",
              manualLock: true,
            },
          },
          assertWriteAllowed,
        );
      }
      if (current) {
        requireCampaignSurface("campaignMemory", "familyTree");
        return applyCampaignMemoryMutation(
          tx,
          {
            ...command,
            recordType: "fact",
            action: "update",
            recordId: current.id,
            expectedRevision: input.revision!,
            patch: { value, status: input.action === "remove" ? "retracted" : "verified", manualLock: true },
          },
          assertWriteAllowed,
        );
      }
      // Unknown relatives are unresolved facts, never invented people. Cross-session links use the existing
      // target owner key in the value; only the subject's real wiki entity owns this assertion.
      requireCampaignSurface("campaignMemory", "familyTree");
      return applyCampaignMemoryMutation(
        tx,
        {
          ...command,
          recordType: "fact",
          action: "create",
          input: {
            chatId: writeChatId,
            subjectEntityId: source!.entityId,
            predicate: FAMILY_FACT_PREDICATE,
            value,
            conditions: [],
            status: "verified",
            sourceRevision: input.operationId,
            evidence: [],
            author: "user",
            manualLock: true,
            provenance: { source: "family-tree", sourceRevision: input.operationId, actor: "user" },
          },
        },
        assertWriteAllowed,
      );
    },
    { durable: true },
  );
}
