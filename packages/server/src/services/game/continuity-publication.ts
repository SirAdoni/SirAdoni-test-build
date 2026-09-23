import { createHash } from "node:crypto";
import type { DB } from "../../db/connection.js";
import { asc, eq } from "../../db/file-query.js";
import { chats, lorebookEntries, messages } from "../../db/schema/index.js";
import type { GameContinuityReceipt } from "@marinara-engine/shared";
import { createGameContinuityStorage } from "../storage/game-continuity.storage.js";
import { prepareContinuitySources, validateContinuityManifest } from "./continuity-sources.js";
import { resolveGameKeeperLorebook } from "./game-keeper-lorebook.js";
import { readContinuityConfig } from "./continuity-provider.js";
import { publishContinuityMemory, assertContinuityMemoryEntry } from "./continuity-memory-publication.js";

const SOURCE = "incremental-game-continuity";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

function continuityEntryContent(receipt: GameContinuityReceipt): string {
  return receipt.records
    .map((record) => {
      const subjects = record.subjects.length ? `Subjects: ${record.subjects.join(", ")}` : "";
      const conditions = record.conditions.length ? `Conditions: ${record.conditions.join("; ")}` : "";
      const evidence = record.evidence.length
        ? `Evidence: ${record.evidence.map((item) => `[${item.messageId}] ${item.quote}`).join(" | ")}`
        : "";
      const knowledge = record.knowledge
        ? `Knowledge: ${record.knowledge.scope}${record.knowledge.holders.length ? `; holders=${record.knowledge.holders.join(", ")}` : ""}`
        : "";
      return [`[${record.kind}/${record.status}] ${record.text}`, subjects, conditions, knowledge, evidence]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

async function resolveTargetLorebook(tx: DB, chatId: string, metadata: Record<string, unknown>) {
  return resolveGameKeeperLorebook(tx, chatId, metadata);
}

export interface ContinuityRelinkResult {
  chatId: string;
  receipts: number;
  relinked: number;
  skipped: Record<string, number>;
}

/**
 * Run publication again for a chat's published receipts, in the order they were published, after new people or
 * places were registered. Records whose subjects could not be resolved before now attach to those entities; the
 * fallback fact written while they were unknown is superseded. Existing facts are left as they are, and a receipt
 * whose memory no longer matches (for example after a manual correction) is skipped rather than overwritten.
 */
export async function relinkPublishedContinuityMemory(
  db: DB,
  chatId: string,
  options: { onReceipt?: () => Promise<void> } = {},
): Promise<ContinuityRelinkResult> {
  const storage = createGameContinuityStorage(db);
  const receipts = (await storage.list(chatId))
    .filter((receipt) => receipt.status === "published" && receipt.records.length > 0 && receipt.entryIds.length > 0)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  const result: ContinuityRelinkResult = { chatId, receipts: receipts.length, relinked: 0, skipped: {} };
  const skip = (code: string) => {
    result.skipped[code] = (result.skipped[code] ?? 0) + 1;
  };
  for (const receipt of receipts) {
    try {
      await db.transaction(
        async (tx) => {
          const entryRows = await tx
            .select()
            .from(lorebookEntries)
            .where(eq(lorebookEntries.id, receipt.entryIds[0]!))
            .limit(1);
          const entry = entryRows[0];
          if (!entry || objectValue(entry.dynamicState).receiptId !== receipt.id)
            throw new Error("CONTINUITY_RELINK_ENTRY_UNAVAILABLE");
          const chatRows = await tx.select().from(chats).where(eq(chats.id, chatId)).limit(1);
          const currentMessages = await tx
            .select()
            .from(messages)
            .where(eq(messages.chatId, chatId))
            .orderBy(asc(messages.createdAt), asc(messages.id));
          const prepared = prepareContinuitySources(currentMessages, objectValue(chatRows[0]?.metadata));
          await publishContinuityMemory(tx, receipt, entry, currentMessages, prepared, {
            supersedeResolvedFallback: true,
          });
        },
        { durable: true },
      );
      result.relinked += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skip(message.match(/^[A-Z][A-Z_]+/u)?.[0] ?? "CONTINUITY_RELINK_FAILED");
    }
    await options.onReceipt?.();
  }
  return result;
}

/** Publish one already-reviewed receipt with source/config checks inside the durable transaction. */
export async function publishContinuityReceipt(
  db: DB,
  id: string,
  options: { allowHistoricalBackfill?: boolean } = {},
): Promise<GameContinuityReceipt | null> {
  const storage = createGameContinuityStorage(db);
  const existing = await storage.get(id);
  if (!existing) return null;
  if (existing.status !== "verified" && existing.status !== "published") {
    throw new Error(`CONTINUITY_NOT_READY: ${existing.status}`);
  }
  const historicalBackfill = existing.config.historicalBackfill !== undefined;
  if (historicalBackfill && !options.allowHistoricalBackfill) return existing;
  const config = await readContinuityConfig(db, existing.chatId, {
    allowHistoricalBackfill: options.allowHistoricalBackfill === true,
  });
  if (config.mode !== "active" && !options.allowHistoricalBackfill) return existing;
  if (config.hash !== existing.configHash) throw new Error("CONTINUITY_CONFIG_CHANGED");

  return storage.publish(
    id,
    async (tx, receipt) => {
      const chatRows = await tx.select().from(chats).where(eq(chats.id, receipt.chatId)).limit(1);
      const currentConfig = await readContinuityConfig(db, receipt.chatId, {
        allowHistoricalBackfill: options.allowHistoricalBackfill === true,
      });
      if (
        (currentConfig.mode !== "active" && !options.allowHistoricalBackfill) ||
        currentConfig.hash !== receipt.configHash
      )
        throw new Error("CONTINUITY_CONFIG_CHANGED");

      const currentMessages = await tx
        .select()
        .from(messages)
        .where(eq(messages.chatId, receipt.chatId))
        .orderBy(asc(messages.createdAt), asc(messages.id));
      const prepared = prepareContinuitySources(currentMessages, objectValue(chatRows[0]?.metadata));
      if (!validateContinuityManifest(prepared, receipt.sources, receipt.context)) {
        throw new Error("CONTINUITY_SOURCE_CHANGED");
      }
      if (!receipt.records.length) return [];
      const metadata = objectValue(chatRows[0]?.metadata);
      const book = await resolveTargetLorebook(tx, receipt.chatId, metadata);
      if (!book) throw new Error("CONTINUITY_LOREBOOK_UNAVAILABLE");

      const entryId = `gce_${hash(receipt.id).slice(0, 32)}`;
      const rows = await tx.select().from(lorebookEntries).where(eq(lorebookEntries.id, entryId)).limit(1);
      if (rows[0]) {
        const state = objectValue(rows[0].dynamicState);
        if (state.receiptId !== receipt.id) throw new Error("CONTINUITY_ENTRY_ID_COLLISION");
        await assertContinuityMemoryEntry(tx, receipt, entryId);
        await publishContinuityMemory(tx, receipt, rows[0], currentMessages, prepared);
        return [entryId];
      }
      const timestamp = new Date().toISOString();
      const content = continuityEntryContent(receipt);
      await tx.insert(lorebookEntries).values({
        id: entryId,
        lorebookId: book.id,
        name: `Game continuity ${receipt.sessionNumber}`,
        content,
        keys: JSON.stringify([...new Set(receipt.records.flatMap((record) => record.keys))]),
        dynamicState: JSON.stringify({
          receiptId: receipt.id,
          publishedContentHash: hash(content),
          source: SOURCE,
          keeperSourceChatId: receipt.chatId,
        }),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const inserted = await tx.select().from(lorebookEntries).where(eq(lorebookEntries.id, entryId)).limit(1);
      if (!inserted[0]) throw new Error("CONTINUITY_ENTRY_INSERT_FAILED");
      await publishContinuityMemory(tx, receipt, inserted[0], currentMessages, prepared);
      return [entryId];
    },
    { replayPublished: historicalBackfill && options.allowHistoricalBackfill === true },
  );
}
