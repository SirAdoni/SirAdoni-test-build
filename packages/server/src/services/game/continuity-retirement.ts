import type { CampaignMemoryActor, GameContinuityReceipt, GameContinuitySource } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { chats, lorebookEntries } from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { createCampaignMemoryStorage } from "../storage/campaign-memory.storage.js";
import { createGameContinuityStorage } from "../storage/game-continuity.storage.js";
import { applyCampaignMemoryMutation } from "./campaign-memory-mutations.js";
import { readCampaignMemorySources } from "./campaign-memory-sources.js";
import { validateContinuityManifest } from "./continuity-sources.js";
import { campaignIdentity } from "./game-keeper-lorebook.js";

/**
 * A published receipt stops being true when the player edits, deletes, hides or swipes away a message it was
 * read from. Retiring it takes its memory back out: its facts are retracted, its generated lore entry and owner
 * entity are removed, and the receipt is kept as stale with this code so a fresh read can take its place.
 */
export const CONTINUITY_SOURCE_RETIRED = "CONTINUITY_SOURCE_RETIRED";

const SOURCE = "incremental-game-continuity";

export interface ContinuityRetirementResult {
  receiptId: string;
  retractedFacts: number;
  keptFacts: number;
  removedEntries: number;
}

function sourceKey(source: GameContinuitySource): string {
  return JSON.stringify([source.messageId, source.swipeIndex, source.hash, source.start ?? null, source.end ?? null]);
}

/** Two source lists cover exactly the same text. */
export function continuitySourceListsMatch(a: GameContinuitySource[], b: GameContinuitySource[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(sourceKey));
  return b.every((source) => keys.has(sourceKey(source)));
}

/** Two receipts were read from exactly the same text, so the newer one replaces the older. */
export function continuityReceiptsShareSources(a: GameContinuityReceipt, b: GameContinuityReceipt): boolean {
  return continuitySourceListsMatch(a.sources, b.sources);
}

function messageKey(source: GameContinuitySource): string {
  return JSON.stringify([source.messageId, source.swipeIndex, source.hash]);
}

/**
 * Every message the older receipt read is also read, unchanged, by the newer one. A grouped archive read of eight
 * turns replaces the single-turn read of one of them, so the same text is not remembered twice.
 */
export function continuityReceiptCovers(newer: GameContinuityReceipt, older: GameContinuityReceipt): boolean {
  if (!older.sources.length) return false;
  const keys = new Set(newer.sources.map(messageKey));
  return older.sources.every((source) => keys.has(messageKey(source)));
}

/** Largest edit, in characters, that can keep a turn's memory without reading it again. */
export const CONTINUITY_SMALL_EDIT_MAX_CHANGED_CHARS = 200;
/** Messages above this size may have been split across receipts, so their slices cannot be re-pointed safely. */
const CONTINUITY_REANCHOR_MAX_MESSAGE_CHARS = 7000;

function codePointLength(value: string): number {
  return [...value].length;
}

/** Characters that differ between two texts once their shared start and end are set aside. */
export function continuityChangedCharacters(before: string, after: string): number {
  const a = [...before];
  const b = [...after];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix += 1;
  return Math.max(a.length, b.length) - prefix - suffix;
}

/**
 * A small edit (a typo, a reworded sentence) that leaves every line the receipt quoted still present does not need
 * a fresh read: the receipt is re-pointed at the current text instead. Returns the new source list, or null when
 * the change is too large, touches a quote, changes swipe or role, or removes a message, in which case the receipt
 * is retired and the turn read again.
 */
export function planContinuityReanchor(
  receipt: GameContinuityReceipt,
  prepared: GameContinuitySource[],
): GameContinuitySource[] | null {
  const current = new Map(prepared.map((message) => [message.messageId, message]));
  let changed = false;
  const next: GameContinuitySource[] = [];
  for (const source of receipt.sources) {
    const message = current.get(source.messageId);
    if (!message || message.swipeIndex !== source.swipeIndex || message.role !== source.role) return null;
    if (validateContinuityManifest(prepared, [source], [])) {
      next.push(source);
      continue;
    }
    const length = codePointLength(message.content);
    const wholeBefore =
      (source.start ?? 0) === 0 && (source.end ?? codePointLength(source.content)) === codePointLength(source.content);
    if (!wholeBefore || length > CONTINUITY_REANCHOR_MAX_MESSAGE_CHARS) return null;
    if (codePointLength(source.content) > CONTINUITY_REANCHOR_MAX_MESSAGE_CHARS) return null;
    if (continuityChangedCharacters(source.content, message.content) > CONTINUITY_SMALL_EDIT_MAX_CHANGED_CHARS)
      return null;
    for (const record of receipt.records)
      for (const item of record.evidence)
        if (item.messageId === source.messageId && !message.content.includes(item.quote)) return null;
    next.push({
      messageId: message.messageId,
      swipeIndex: message.swipeIndex,
      hash: message.hash,
      role: message.role,
      content: message.content,
      start: 0,
      end: length,
    });
    changed = true;
  }
  return changed ? next : null;
}

/** Keep a receipt's memory through a small edit: re-point it at the current text and refresh its evidence stamps. */
export async function reanchorContinuityReceipt(
  db: DB,
  receiptId: string,
  sources: GameContinuitySource[],
): Promise<{ receiptId: string; refreshedFacts: number; refreshedKnowledge: number } | null> {
  const storage = createGameContinuityStorage(db);
  const result = { receiptId, refreshedFacts: 0, refreshedKnowledge: 0 };
  const changedIds = new Set(sources.map((source) => source.messageId));
  const reason = "Small edit kept every quoted line; evidence re-stamped against the current text.";
  const reanchored = await storage.reanchor(receiptId, sources, async (tx, receipt) => {
    const historical = receipt.config.historicalBackfill !== undefined || receipt.id.startsWith("gch_");
    const actor: CampaignMemoryActor = historical ? "import" : "system";
    const scope = { chatId: receipt.chatId };
    const memory = createCampaignMemoryStorage(tx);
    const facts = (await memory.listFacts(scope)).filter(
      (fact) =>
        fact.provenance?.source === SOURCE &&
        receiptIdOf(fact.value) === receipt.id &&
        fact.status !== "retracted" &&
        fact.status !== "superseded",
    );
    const factIds = new Set<string>();
    for (const fact of facts) {
      factIds.add(fact.factId);
      if (fact.manualLock || fact.author === "user") continue;
      if (!fact.evidence.some((item) => changedIds.has(item.messageId))) continue;
      // Dropping the stored stamp lets the write re-stamp each quote against the text it is in now.
      await applyCampaignMemoryMutation(tx, {
        chatId: receipt.chatId,
        operationId: `continuity-reanchor:${receipt.id}:fact:${fact.factId}:${fact.revision}`,
        actor,
        reason,
        recordType: "fact",
        action: "update",
        recordId: fact.factId,
        expectedRevision: fact.revision,
        patch: { evidence: fact.evidence.map((item) => ({ messageId: item.messageId, quote: item.quote })) },
      });
      result.refreshedFacts += 1;
    }
    for (const knowledge of await memory.listKnowledge(scope)) {
      if (!knowledge.factId || !factIds.has(knowledge.factId) || knowledge.manualLock) continue;
      if (!knowledge.learnedFrom.some((item) => changedIds.has(item.messageId))) continue;
      await applyCampaignMemoryMutation(tx, {
        chatId: receipt.chatId,
        operationId: `continuity-reanchor:${receipt.id}:knowledge:${knowledge.knowledgeId}:${knowledge.revision}`,
        actor,
        reason,
        recordType: "knowledge",
        action: "update",
        recordId: knowledge.knowledgeId,
        expectedRevision: knowledge.revision,
        patch: {
          learnedFrom: knowledge.learnedFrom.map((item) => ({ messageId: item.messageId, quote: item.quote })),
        },
      });
      result.refreshedKnowledge += 1;
    }
  });
  if (!reanchored) return null;
  logger.info(
    { ...result, chatId: reanchored.chatId },
    "[game-continuity] kept receipt %s through a small edit: %d facts and %d knowledge records re-stamped",
    receiptId,
    result.refreshedFacts,
    result.refreshedKnowledge,
  );
  return result;
}

/**
 * Published receipts whose own source text no longer matches the chat. Only receipts that read one of the changed
 * messages are considered, so an unrelated reconcile (a restart, a new turn) can never retract the archive.
 * A change that only touches a receipt's surrounding context does not retire it here: the fresh read of that turn
 * replaces it when it publishes.
 */
export function findSourceChangedReceipts(
  receipts: GameContinuityReceipt[],
  prepared: GameContinuitySource[],
  changedMessageIds: Iterable<string>,
): GameContinuityReceipt[] {
  const changed = new Set(changedMessageIds);
  if (changed.size === 0) return [];
  return receipts.filter(
    (receipt) =>
      receipt.status === "published" &&
      receipt.sources.some((source) => changed.has(source.messageId)) &&
      !validateContinuityManifest(prepared, receipt.sources, []),
  );
}

function receiptIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receiptId = (value as Record<string, unknown>).receiptId;
  return typeof receiptId === "string" ? receiptId : null;
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The other game chats of the receipt's campaign (every session and branch, earlier or later), excluding the
 * receipt's own chat. Campaign identity is the chat's gameId, else its group, as the Keeper book uses it.
 */
async function otherCampaignSessionChatIds(tx: DB, chatId: string): Promise<string[]> {
  const current = (await tx.select().from(chats).where(eq(chats.id, chatId)).limit(1))[0];
  if (!current || current.mode !== "game") return [];
  const identity = campaignIdentity(current.id, metadataObject(current.metadata), current.groupId);
  if (!identity || identity === current.id) return [];
  const rows = await tx.select().from(chats).where(eq(chats.groupId, identity));
  return rows
    .filter(
      (row) =>
        row.id !== chatId &&
        row.mode === "game" &&
        campaignIdentity(row.id, metadataObject(row.metadata), row.groupId) === identity,
    )
    .map((row) => row.id);
}

/** Retire one published receipt and take its memory back out. Locked or player-authored facts are left alone. */
export async function retireContinuityReceipt(
  db: DB,
  receiptId: string,
  reason: string,
): Promise<ContinuityRetirementResult | null> {
  const storage = createGameContinuityStorage(db);
  const result: ContinuityRetirementResult = { receiptId, retractedFacts: 0, keptFacts: 0, removedEntries: 0 };
  const retired = await storage.retire(
    receiptId,
    async (tx, receipt) => {
      const historical = receipt.config.historicalBackfill !== undefined || receipt.id.startsWith("gch_");
      const actor: CampaignMemoryActor = historical ? "import" : "system";
      const scope = { chatId: receipt.chatId };
      const memory = createCampaignMemoryStorage(tx);
      const facts = (await memory.listFacts(scope)).filter(
        (fact) =>
          fact.provenance?.source === SOURCE &&
          receiptIdOf(fact.value) === receipt.id &&
          fact.status !== "retracted" &&
          fact.status !== "superseded",
      );
      const sources = await readCampaignMemorySources(tx, {
        chatId: receipt.chatId,
        messageIds: [...new Set(facts.flatMap((fact) => fact.evidence.map((item) => item.messageId)))],
      });
      for (const fact of facts) {
        if (fact.manualLock || fact.author === "user") {
          result.keptFacts += 1;
          continue;
        }
        // Evidence is revalidated on every write, so keep only quotes the current text still contains.
        const evidence = fact.evidence
          .filter((item) => sources.get(item.messageId)?.content.includes(item.quote))
          .map((item) => ({ messageId: item.messageId, quote: item.quote }));
        await applyCampaignMemoryMutation(tx, {
          chatId: receipt.chatId,
          operationId: `continuity-retire:${receipt.id}:fact:${fact.factId}:${fact.revision}`,
          actor,
          reason,
          recordType: "fact",
          action: "update",
          recordId: fact.factId,
          expectedRevision: fact.revision,
          patch: { status: "retracted", evidence },
        });
        result.retractedFacts += 1;
      }

      const entryIds = new Set(receipt.entryIds);
      for (const entity of await memory.listEntities(scope)) {
        if (
          entity.status === "archived" ||
          entity.owner.type !== "existing" ||
          entity.owner.store !== "lorebook-entries" ||
          !entryIds.has(entity.owner.recordId) ||
          entity.manualLock
        )
          continue;
        await applyCampaignMemoryMutation(tx, {
          chatId: receipt.chatId,
          operationId: `continuity-retire:${receipt.id}:entity:${entity.entityId}:${entity.revision}`,
          actor,
          reason,
          recordType: "entity",
          action: "update",
          recordId: entity.entityId,
          expectedRevision: entity.revision,
          patch: { status: "archived" },
        });
      }
      // The legacy import copied every Keeper lorebook entry, these batch pages included, into every session of the
      // campaign. Archive those copies too so no orphan "Game continuity" page outlives its batch, but only where
      // the copy holds no live fact of its own (a fact written in that session is not this receipt's to retract).
      if (entryIds.size) {
        for (const otherChatId of await otherCampaignSessionChatIds(tx, receipt.chatId)) {
          const otherScope = { chatId: otherChatId };
          const copies = (await memory.listEntities(otherScope)).filter(
            (entity) =>
              entity.status !== "archived" &&
              entity.kind === "lore" &&
              entity.owner.type === "existing" &&
              entity.owner.store === "lorebook-entries" &&
              entryIds.has(entity.owner.recordId) &&
              !entity.manualLock,
          );
          if (!copies.length) continue;
          const liveSubjects = new Set(
            (await memory.listFacts(otherScope))
              .filter((fact) => fact.status === "verified" || fact.status === "proposed")
              .map((fact) => fact.subjectEntityId),
          );
          for (const entity of copies) {
            if (liveSubjects.has(entity.entityId)) continue;
            await applyCampaignMemoryMutation(tx, {
              chatId: otherChatId,
              operationId: `continuity-retire:${receipt.id}:entity:${otherChatId}:${entity.entityId}:${entity.revision}`,
              actor,
              reason,
              recordType: "entity",
              action: "update",
              recordId: entity.entityId,
              expectedRevision: entity.revision,
              patch: { status: "archived" },
            });
          }
        }
      }
      for (const entryId of entryIds) {
        const rows = await tx.select().from(lorebookEntries).where(eq(lorebookEntries.id, entryId)).limit(1);
        const row = rows[0];
        if (!row) continue;
        let owner: unknown = null;
        try {
          owner = JSON.parse(String(row.dynamicState ?? "{}"));
        } catch {
          owner = null;
        }
        if (receiptIdOf(owner) !== receipt.id) continue;
        await tx.delete(lorebookEntries).where(eq(lorebookEntries.id, entryId));
        result.removedEntries += 1;
      }
    },
    { errorCode: CONTINUITY_SOURCE_RETIRED, error: reason },
  );
  if (!retired) return null;
  logger.info(
    { ...result, chatId: retired.chatId },
    "[game-continuity] retired receipt %s: %d facts retracted, %d kept, %d lore entries removed",
    receiptId,
    result.retractedFacts,
    result.keptFacts,
    result.removedEntries,
  );
  return result;
}
