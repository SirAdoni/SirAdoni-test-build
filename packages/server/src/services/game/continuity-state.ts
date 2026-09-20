import { createHash } from "node:crypto";
import type { DB } from "../../db/connection.js";
import { desc, eq, inArray } from "../../db/file-query.js";
import { chats, gameStateSnapshots, lorebookEntries, messages } from "../../db/schema/index.js";
import type { GameContinuityReceipt, GameContinuityRecord } from "@marinara-engine/shared";
import { createGameContinuityStorage } from "../storage/game-continuity.storage.js";
import {
  planContinuityTurnBatches,
  prepareContinuitySources,
  validateContinuityManifest,
} from "./continuity-sources.js";

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

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface GameContinuityState {
  gameChat: boolean;
  receipts: Array<{ receipt: GameContinuityReceipt; sourceCurrent: boolean }>;
  records: Array<GameContinuityRecord & { receiptId: string; sessionNumber: number; sourceOrder: number }>;
  excludedEntryIds: string[];
  manualOverrideEntryIds: string[];
  allowedEntryIds: string[];
  /**
   * Whether generated (not hand-edited) continuity lore entries are injected into prompts. Off by default:
   * their facts reach the GM through the ranked, budgeted campaign-memory block, while injecting every entry
   * as dynamic lore rewrote tens of thousands of uncached tokens on every turn and grew without bound.
   * Opt back in per chat with `gameContinuity.injectGeneratedLore: true`.
   */
  injectGeneratedLore: boolean;
  currentPublishedReceiptIds: string[];
  supersededReceiptIds: string[];
  /** Highest eligible prepared message with every eligible range up to it covered by a current verified or published receipt. */
  verifiedThroughMessageId: string | null;
  /** `messageId` names an eligible accepted assistant turn that never received a receipt (`batchId` is empty then). */
  gaps: Array<{ batchId: string; status: string; reason: string; messageId?: string }>;
}

type ChatMessage = typeof messages.$inferSelect;

/**
 * Mirror of the runtime acceptance rule (continuity-runtime reconcileChat): an assistant after the
 * activation boundary is accepted when its snapshot is committed, or it has no snapshot and a user replied.
 */
async function readAcceptedAssistantIds(
  db: DB,
  allMessages: ChatMessage[],
  continuity: Record<string, unknown>,
): Promise<string[]> {
  if (continuity.mode !== "shadow" && continuity.mode !== "active") return [];
  const boundary = typeof continuity.activationMessageId === "string" ? continuity.activationMessageId : "";
  const boundaryIndex = boundary ? allMessages.findIndex((message) => message.id === boundary) : -1;
  const activationAt = typeof continuity.activationAt === "string" ? Date.parse(continuity.activationAt) : Number.NaN;
  if (boundaryIndex < 0 && Number.isNaN(activationAt)) return [];
  const eligible = allMessages.filter(
    (message, index) =>
      message.role === "assistant" &&
      (boundaryIndex >= 0 ? index >= boundaryIndex : Date.parse(String(message.createdAt)) >= activationAt),
  );
  if (eligible.length === 0) return [];
  const snapshots = await db
    .select({
      messageId: gameStateSnapshots.messageId,
      swipeIndex: gameStateSnapshots.swipeIndex,
      committed: gameStateSnapshots.committed,
    })
    .from(gameStateSnapshots)
    .where(
      inArray(
        gameStateSnapshots.messageId,
        eligible.map((message) => message.id),
      ),
    )
    .orderBy(desc(gameStateSnapshots.createdAt));
  const latestCommitted = new Map<string, number>();
  for (const row of snapshots) {
    const key = `${row.messageId}:${row.swipeIndex}`;
    if (!latestCommitted.has(key)) latestCommitted.set(key, row.committed);
  }
  return eligible
    .filter((message) => {
      const committed = latestCommitted.get(`${message.id}:${message.activeSwipeIndex ?? 0}`);
      const followedByUser = allMessages[allMessages.indexOf(message) + 1]?.role === "user";
      return committed === 1 || (committed === undefined && followedByUser);
    })
    .map((message) => message.id);
}

export async function readGameContinuityState(db: DB, chatId: string): Promise<GameContinuityState> {
  const chatRows = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  const chat = chatRows[0];
  const empty = (gameChat: boolean): GameContinuityState => ({
    gameChat,
    receipts: [],
    records: [],
    excludedEntryIds: [],
    manualOverrideEntryIds: [],
    allowedEntryIds: [],
    injectGeneratedLore: false,
    currentPublishedReceiptIds: [],
    supersededReceiptIds: [],
    verifiedThroughMessageId: null,
    gaps: [],
  });
  if (!chat || chat.mode !== "game") return empty(false);

  const allMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(messages.createdAt, messages.id);
  const prepared = prepareContinuitySources(allMessages, objectValue(chat.metadata));
  const storage = createGameContinuityStorage(db);
  const inspected = await storage.inspect(chatId);
  const receipts = inspected.receipts;
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  receipts.sort(
    (left, right) =>
      left.sessionNumber - right.sessionNumber ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
  const entries = await db.select().from(lorebookEntries);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const excludedEntryIds = new Set<string>();
  const manualOverrideEntryIds = new Set<string>();
  const allowedEntryIds = new Set<string>();
  const gaps: GameContinuityState["gaps"] = [];
  for (const invalid of inspected.invalid) gaps.push({ batchId: invalid.id, status: "invalid", reason: invalid.code });
  const records: GameContinuityState["records"] = [];
  const publishedIds = new Set<string>();
  const receiptStates = receipts.map((receipt) => ({
    receipt,
    sourceCurrent: validateContinuityManifest(prepared, receipt.sources, receipt.context),
  }));

  const entryIsManualOverride = (entryId: string, receipt: GameContinuityReceipt | null): boolean => {
    const row = entriesById.get(entryId);
    if (!row || !receipt) return false;
    const state = objectValue(row.dynamicState);
    return (
      state.source === "incremental-game-continuity" &&
      state.receiptId === receipt.id &&
      typeof state.publishedContentHash === "string" &&
      state.publishedContentHash !== hash(row.content)
    );
  };

  const publishedEntriesAreCurrent = (receipt: GameContinuityReceipt): boolean =>
    receipt.entryIds.length === 0
      ? receipt.records.length === 0
      : receipt.entryIds.every((entryId) => {
          const row = entriesById.get(entryId);
          if (!row) return false;
          const state = objectValue(row.dynamicState);
          return (
            state.source === "incremental-game-continuity" &&
            state.receiptId === receipt.id &&
            typeof state.publishedContentHash === "string" &&
            state.publishedContentHash === hash(row.content)
          );
        });
  const preparedLengths = new Map(prepared.map((source) => [source.messageId, Array.from(source.content).length]));
  const currentPublished = receiptStates.filter(
    (item) => item.sourceCurrent && item.receipt.status === "published" && publishedEntriesAreCurrent(item.receipt),
  );
  const currentCoverage = new Map<string, Array<[number, number]>>();
  for (const { receipt } of currentPublished) {
    for (const source of receipt.sources) {
      const ranges = currentCoverage.get(source.messageId) ?? [];
      ranges.push([source.start ?? 0, source.end ?? Array.from(source.content).length]);
      currentCoverage.set(source.messageId, ranges);
    }
  }
  const fullyCovered = (coverage: Map<string, Array<[number, number]>>, messageId: string): boolean => {
    const total = preparedLengths.get(messageId);
    if (total === undefined) return false;
    const ranges = (coverage.get(messageId) ?? [])
      .map(([start, end]) => [Math.max(0, start), Math.min(total, end)] as [number, number])
      .filter(([start, end]) => end > start)
      .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    let coveredEnd = 0;
    for (const [start, end] of ranges) {
      if (start > coveredEnd) return false;
      coveredEnd = Math.max(coveredEnd, end);
      if (coveredEnd >= total) return true;
    }
    return total === 0;
  };
  const fullyCoveredCurrentMessage = (messageId: string): boolean => fullyCovered(currentCoverage, messageId);
  const supersededReceiptIds = new Set(
    receiptStates
      .filter(
        ({ receipt, sourceCurrent }) =>
          ["stale", "failed", "unresolved", "published"].includes(receipt.status) &&
          !sourceCurrent &&
          receipt.sources.length > 0 &&
          receipt.sources.every((source) => fullyCoveredCurrentMessage(source.messageId)),
      )
      .map(({ receipt }) => receipt.id),
  );

  for (const { receipt, sourceCurrent } of receiptStates) {
    const generatedIds = receipt.entryIds;
    generatedIds.forEach((entryId) => publishedIds.add(entryId));
    const publicationCurrent = publishedEntriesAreCurrent(receipt);
    if (!sourceCurrent || receipt.status !== "published" || !publicationCurrent) {
      if (!supersededReceiptIds.has(receipt.id))
        gaps.push({
          batchId: receipt.id,
          status: receipt.status,
          reason: !sourceCurrent
            ? "CONTINUITY_SOURCE_CHANGED"
            : receipt.status === "published" && !publicationCurrent
              ? "CONTINUITY_PUBLICATION_INVALID"
              : "CONTINUITY_BATCH_NOT_PUBLISHED",
        });
      for (const entryId of generatedIds) {
        if (entryIsManualOverride(entryId, receipt)) manualOverrideEntryIds.add(entryId);
        else excludedEntryIds.add(entryId);
      }
      continue;
    }
    let hasManualOverride = false;
    for (const entryId of generatedIds) {
      if (entryIsManualOverride(entryId, receipt)) {
        manualOverrideEntryIds.add(entryId);
        hasManualOverride = true;
        gaps.push({ batchId: receipt.id, status: "published", reason: `CONTINUITY_MANUAL_OVERRIDE:${entryId}` });
      } else {
        allowedEntryIds.add(entryId);
      }
    }
    if (!hasManualOverride)
      receipt.records.forEach((record, sourceOrder) =>
        records.push({ ...record, receiptId: receipt.id, sessionNumber: receipt.sessionNumber, sourceOrder }),
      );
  }

  // Continuous verified watermark over eligible accepted turns; a turn with no receipt at all is a gap.
  const verifiedCoverage = new Map([...currentCoverage].map(([messageId, ranges]) => [messageId, [...ranges]]));
  for (const { receipt, sourceCurrent } of receiptStates) {
    if (!sourceCurrent || receipt.status !== "verified") continue;
    for (const source of receipt.sources) {
      const ranges = verifiedCoverage.get(source.messageId) ?? [];
      ranges.push([source.start ?? 0, source.end ?? Array.from(source.content).length]);
      verifiedCoverage.set(source.messageId, ranges);
    }
  }
  const acceptedIds = await readAcceptedAssistantIds(
    db,
    allMessages,
    objectValue(objectValue(chat.metadata).gameContinuity),
  );
  const eligibleMessageIds = new Set<string>();
  for (const assistantId of acceptedIds) {
    if (!preparedLengths.has(assistantId)) continue;
    for (const batch of planContinuityTurnBatches(prepared, assistantId))
      batch.sources.forEach((source) => eligibleMessageIds.add(source.messageId));
    if (!receipts.some((receipt) => receipt.sources.some((source) => source.messageId === assistantId)))
      gaps.push({ batchId: "", status: "missing", reason: "CONTINUITY_TURN_NOT_ENQUEUED", messageId: assistantId });
  }
  let verifiedThroughMessageId: string | null = null;
  for (const source of prepared) {
    if (!eligibleMessageIds.has(source.messageId)) continue;
    if (!fullyCovered(verifiedCoverage, source.messageId)) break;
    verifiedThroughMessageId = source.messageId;
  }

  for (const row of entries) {
    const state = objectValue(row.dynamicState);
    if (state.source !== "incremental-game-continuity") continue;
    const receiptId = typeof state.receiptId === "string" ? state.receiptId : "";
    const receipt = receiptById.get(receiptId) ?? null;
    if (!receipt || receipt.chatId !== chatId || !publishedIds.has(row.id)) {
      if (typeof state.publishedContentHash === "string" && state.publishedContentHash !== hash(row.content))
        manualOverrideEntryIds.add(row.id);
      else excludedEntryIds.add(row.id);
    }
  }

  return {
    gameChat: true,
    receipts: receiptStates,
    records,
    excludedEntryIds: [...excludedEntryIds],
    manualOverrideEntryIds: [...manualOverrideEntryIds],
    allowedEntryIds: [...allowedEntryIds, ...manualOverrideEntryIds],
    injectGeneratedLore: objectValue(objectValue(chat.metadata).gameContinuity).injectGeneratedLore === true,
    currentPublishedReceiptIds: currentPublished.map(({ receipt }) => receipt.id).sort(),
    supersededReceiptIds: [...supersededReceiptIds].sort(),
    verifiedThroughMessageId,
    gaps,
  };
}
