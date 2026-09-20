import { createHash } from "node:crypto";
import { and, eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { gameContinuityBatches } from "../../db/schema/index.js";
import { now } from "../../utils/id-generator.js";
import type {
  GameContinuityHolderSnapshot,
  GameContinuityReceipt,
  GameContinuitySource,
  GameContinuityReceiptStatus,
} from "@marinara-engine/shared";
import {
  validateGameContinuityExtraction,
  validateGameContinuityReceipt,
  validateGameContinuityReview,
} from "../game/continuity-review.js";
import { logger } from "../../lib/logger.js";

const RESUMABLE_STATUSES: readonly GameContinuityReceiptStatus[] = ["queued", "extracting", "reviewing", "repairing"];
const RECEIPT_STATUSES: readonly GameContinuityReceiptStatus[] = [
  "queued",
  "extracting",
  "reviewing",
  "repairing",
  "verified",
  "published",
  "unresolved",
  "failed",
  "stale",
];

type ReceiptRow = typeof gameContinuityBatches.$inferSelect;

/**
 * Append-only per-stage timing and token usage. Declared here because the shared dist cannot be
 * rebuilt in place; the shared source carries the same optional shape on the receipt type.
 */
export interface GameContinuityTelemetryEntry {
  stage: string;
  startedAt: string;
  elapsedMs: number;
  providerMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null;
  attempt: number;
}
export type GameContinuityReceiptWithTelemetry = GameContinuityReceipt & { telemetry?: GameContinuityTelemetryEntry[] };

export type GameContinuityHistorySnapshot = Pick<
  GameContinuityReceipt,
  "status" | "attempts" | "repairAttempts" | "updatedAt" | "records" | "dispositions" | "review"
>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return value == null ? fallback : (value as T);
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error("CONTINUITY_INVALID: persisted receipt JSON is malformed", { cause: error });
  }
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Validate one telemetry entry; returns null for anything that is not a well-formed entry. */
export function normalizeContinuityTelemetryEntry(value: unknown): GameContinuityTelemetryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.stage !== "string" ||
    !entry.stage.trim() ||
    typeof entry.startedAt !== "string" ||
    Number.isNaN(Date.parse(entry.startedAt)) ||
    typeof entry.elapsedMs !== "number" ||
    !Number.isFinite(entry.elapsedMs) ||
    entry.elapsedMs < 0 ||
    !Number.isInteger(entry.attempt) ||
    (entry.attempt as number) < 0
  )
    return null;
  const usage =
    entry.usage && typeof entry.usage === "object" && !Array.isArray(entry.usage)
      ? (entry.usage as Record<string, unknown>)
      : null;
  return {
    stage: entry.stage,
    startedAt: entry.startedAt,
    elapsedMs: entry.elapsedMs,
    ...(optionalCount(entry.providerMs) === undefined ? {} : { providerMs: entry.providerMs as number }),
    ...(entry.usage === undefined
      ? {}
      : {
          usage: usage
            ? {
                ...(optionalCount(usage.inputTokens) === undefined ? {} : { inputTokens: usage.inputTokens as number }),
                ...(optionalCount(usage.outputTokens) === undefined
                  ? {}
                  : { outputTokens: usage.outputTokens as number }),
                ...(optionalCount(usage.cacheReadTokens) === undefined
                  ? {}
                  : { cacheReadTokens: usage.cacheReadTokens as number }),
              }
            : null,
        }),
    attempt: entry.attempt as number,
  };
}

function parseTelemetry(value: unknown): GameContinuityTelemetryEntry[] {
  let parsed: unknown;
  try {
    parsed = parseJson<unknown>(value, []);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => normalizeContinuityTelemetryEntry(item))
    .filter((item): item is GameContinuityTelemetryEntry => item !== null);
}

/** Append-only merge: every stored entry is kept in order, new entries are appended once. */
function mergeTelemetry(
  stored: readonly GameContinuityTelemetryEntry[],
  incoming: unknown,
): GameContinuityTelemetryEntry[] {
  const merged = [...stored];
  const seen = new Set(stored.map((entry) => JSON.stringify(entry)));
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const entry = normalizeContinuityTelemetryEntry(item);
    if (!entry) continue;
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function telemetryOf(receipt: GameContinuityReceipt): unknown {
  return (receipt as GameContinuityReceiptWithTelemetry).telemetry;
}

function holderSnapshot(value: unknown): GameContinuityHolderSnapshot[] | undefined {
  if (value == null) return undefined;
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) throw new Error("CONTINUITY_INVALID: holder snapshot must be an array");
  for (const item of parsed) {
    const snapshot = item as Record<string, unknown>;
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof snapshot.entityId !== "string" ||
      !snapshot.entityId.trim() ||
      (snapshot.kind !== "character" && snapshot.kind !== "persona") ||
      (snapshot.store !== "characters" && snapshot.store !== "personas" && snapshot.store !== "game-npcs") ||
      (snapshot.kind === "character" && snapshot.store !== "characters" && snapshot.store !== "game-npcs") ||
      (snapshot.kind === "persona" && snapshot.store !== "personas") ||
      typeof snapshot.recordId !== "string" ||
      !snapshot.recordId.trim() ||
      typeof snapshot.name !== "string" ||
      !snapshot.name.trim()
    )
      throw new Error("CONTINUITY_INVALID: holder snapshot contains an invalid entry");
  }
  return parsed as GameContinuityHolderSnapshot[];
}

function holderSnapshotHash(holders: readonly GameContinuityHolderSnapshot[]): string {
  return createHash("sha256").update(JSON.stringify(holders)).digest("hex");
}

function parseHistory(value: unknown): GameContinuityHistorySnapshot[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) {
    throw new Error("CONTINUITY_INVALID: persisted receipt history must be an array");
  }
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      throw new Error("CONTINUITY_INVALID: persisted receipt history contains an invalid snapshot");
    }
    const snapshot = item as Record<string, unknown>;
    if (
      typeof snapshot.status !== "string" ||
      !RECEIPT_STATUSES.includes(snapshot.status as GameContinuityReceiptStatus) ||
      !Number.isInteger(snapshot.attempts) ||
      (snapshot.attempts as number) < 0 ||
      !Number.isInteger(snapshot.repairAttempts) ||
      (snapshot.repairAttempts as number) < 0 ||
      typeof snapshot.updatedAt !== "string" ||
      !Array.isArray(snapshot.records) ||
      !Array.isArray(snapshot.dispositions) ||
      (snapshot.review !== null && (typeof snapshot.review !== "object" || Array.isArray(snapshot.review)))
    ) {
      throw new Error("CONTINUITY_INVALID: persisted receipt history contains an invalid snapshot");
    }
  }
  return parsed as GameContinuityHistorySnapshot[];
}

function validateHistory(history: GameContinuityHistorySnapshot[], receipt: GameContinuityReceipt): void {
  for (const snapshot of history) {
    if (snapshot.records.length === 0 && snapshot.dispositions.length === 0 && snapshot.review === null) continue;
    try {
      validateGameContinuityExtraction(
        { records: snapshot.records, dispositions: snapshot.dispositions },
        receipt.sources,
        receipt.id,
        receipt.context,
        receipt.knowledgeHolders,
      );
      if (snapshot.review !== null) {
        validateGameContinuityReview(snapshot.review, receipt.sources, snapshot.records, receipt.context);
      }
    } catch (error) {
      throw new Error("CONTINUITY_INVALID: persisted receipt history contains an invalid model result", {
        cause: error,
      });
    }
  }
}

function isUsefulModelResult(receipt: Pick<GameContinuityReceipt, "records" | "dispositions" | "review">): boolean {
  return receipt.records.length > 0 || receipt.dispositions.length > 0 || receipt.review !== null;
}

function modelResultKey(receipt: Pick<GameContinuityReceipt, "records" | "dispositions" | "review">): string {
  return JSON.stringify({ records: receipt.records, dispositions: receipt.dispositions, review: receipt.review });
}

function snapshotOf(receipt: GameContinuityReceipt): GameContinuityHistorySnapshot {
  return {
    status: receipt.status,
    attempts: receipt.attempts,
    repairAttempts: receipt.repairAttempts,
    updatedAt: receipt.updatedAt,
    records: structuredClone(receipt.records),
    dispositions: structuredClone(receipt.dispositions),
    review: receipt.review == null ? null : structuredClone(receipt.review),
  };
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function toReceipt(row: ReceiptRow): GameContinuityReceipt {
  const history = parseHistory(row.history);
  const knowledgeHolders = holderSnapshot(row.knowledgeHolders);
  if (knowledgeHolders !== undefined) {
    const expectedHash = holderSnapshotHash(knowledgeHolders);
    if (row.knowledgeHoldersHash !== expectedHash) throw new Error("CONTINUITY_INVALID: holder snapshot hash mismatch");
  } else if (row.knowledgeHoldersHash != null) {
    throw new Error("CONTINUITY_INVALID: holder snapshot hash has no snapshot");
  }
  const receipt = validateGameContinuityReceipt({
    id: row.id,
    chatId: row.chatId,
    sessionNumber: row.sessionNumber,
    sourceHash: row.sourceHash,
    sources: parseJson(row.sources, []),
    context: parseJson(row.context, []),
    configHash: row.configHash,
    config: parseJson(row.config, {}),
    status: row.status as GameContinuityReceiptStatus,
    attempts: row.attempts,
    repairAttempts: row.repairAttempts,
    records: parseJson(row.records, []),
    dispositions: parseJson(row.dispositions, []),
    review: row.review == null ? null : parseJson(row.review, null),
    ...(knowledgeHolders === undefined ? {} : { knowledgeHolders }),
    ...(row.knowledgeHoldersHash == null ? {} : { knowledgeHoldersHash: row.knowledgeHoldersHash }),
    entryIds: parseJson(row.entryIds, []),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  validateHistory(history, receipt);
  const telemetry = parseTelemetry(row.telemetry);
  return telemetry.length > 0 ? Object.assign(receipt, { telemetry }) : receipt;
}

function toRow(
  receipt: GameContinuityReceipt,
  createdAt = receipt.createdAt || now(),
  history: GameContinuityHistorySnapshot[] = [],
  telemetry: GameContinuityTelemetryEntry[] = mergeTelemetry([], telemetryOf(receipt)),
) {
  const valid = validateGameContinuityReceipt(receipt);
  if (valid.knowledgeHolders !== undefined) {
    const expectedHash = holderSnapshotHash(valid.knowledgeHolders);
    if (valid.knowledgeHoldersHash !== undefined && valid.knowledgeHoldersHash !== expectedHash)
      throw new Error("CONTINUITY_INVALID: holder snapshot hash mismatch");
  } else if (valid.knowledgeHoldersHash !== undefined) {
    throw new Error("CONTINUITY_INVALID: holder snapshot hash has no snapshot");
  }
  validateHistory(history, valid);
  return {
    id: valid.id,
    chatId: valid.chatId,
    sessionNumber: valid.sessionNumber,
    sourceHash: valid.sourceHash,
    sources: JSON.stringify(valid.sources),
    context: JSON.stringify(valid.context),
    configHash: valid.configHash,
    config: JSON.stringify(valid.config),
    status: valid.status,
    attempts: valid.attempts,
    repairAttempts: valid.repairAttempts,
    records: JSON.stringify(valid.records),
    dispositions: JSON.stringify(valid.dispositions),
    review: valid.review == null ? null : JSON.stringify(valid.review),
    knowledgeHolders: valid.knowledgeHolders == null ? null : JSON.stringify(valid.knowledgeHolders),
    knowledgeHoldersHash:
      valid.knowledgeHolders == null
        ? null
        : (valid.knowledgeHoldersHash ?? holderSnapshotHash(valid.knowledgeHolders)),
    history: JSON.stringify(history),
    entryIds: JSON.stringify(valid.entryIds),
    errorCode: valid.errorCode ?? null,
    error: valid.error ?? null,
    telemetry: JSON.stringify(telemetry),
    createdAt,
    updatedAt: receipt.updatedAt || now(),
  };
}

export function createGameContinuityStorage(db: DB) {
  async function get(id: string): Promise<GameContinuityReceipt | null> {
    const rows = await db.select().from(gameContinuityBatches).where(eq(gameContinuityBatches.id, id)).limit(1);
    return rows[0] ? toReceipt(rows[0]) : null;
  }

  async function getHistory(chatId: string, id: string): Promise<GameContinuityHistorySnapshot[]> {
    const rows = await db
      .select()
      .from(gameContinuityBatches)
      .where(and(eq(gameContinuityBatches.chatId, chatId), eq(gameContinuityBatches.id, id)))
      .limit(1);
    if (!rows[0]) return [];
    const row = rows[0];
    const history = parseHistory(row.history).map((snapshot) => structuredClone(snapshot));
    const current = toReceipt(row);
    if (
      isUsefulModelResult(current) &&
      (history.length === 0 || modelResultKey(current) !== modelResultKey(history[history.length - 1]!))
    ) {
      history.push(snapshotOf(current));
    }
    return freezeDeep(history);
  }

  async function list(chatId?: string): Promise<GameContinuityReceipt[]> {
    return (await inspect(chatId)).receipts;
  }

  async function inspect(chatId?: string): Promise<{
    receipts: GameContinuityReceipt[];
    invalid: Array<{ id: string; code: "CONTINUITY_INVALID_RECEIPT" }>;
  }> {
    const rows = await db
      .select()
      .from(gameContinuityBatches)
      .where(chatId ? eq(gameContinuityBatches.chatId, chatId) : undefined);
    const receipts: GameContinuityReceipt[] = [];
    const invalid: Array<{ id: string; code: "CONTINUITY_INVALID_RECEIPT" }> = [];
    for (const row of rows) {
      try {
        receipts.push(toReceipt(row));
      } catch {
        invalid.push({ id: row.id, code: "CONTINUITY_INVALID_RECEIPT" });
        logger.warn({ receiptId: row.id }, "Skipping malformed game continuity receipt");
      }
    }
    return { receipts, invalid };
  }

  async function enqueue(
    receipt: GameContinuityReceipt,
  ): Promise<{ receipt: GameContinuityReceipt; created: boolean }> {
    return db.transaction(
      async (tx) => {
        const existing = await tx
          .select()
          .from(gameContinuityBatches)
          .where(eq(gameContinuityBatches.id, receipt.id))
          .limit(1);
        if (existing[0]) return { receipt: toReceipt(existing[0]), created: false };
        const createdAt = receipt.createdAt || now();
        const next = { ...receipt, createdAt, updatedAt: receipt.updatedAt || createdAt };
        await tx.insert(gameContinuityBatches).values(toRow(next, createdAt));
        return { receipt: next, created: true };
      },
      { durable: true },
    );
  }

  async function save(receipt: GameContinuityReceipt): Promise<GameContinuityReceipt> {
    return db.transaction(
      async (tx) => {
        const updatedAt = receipt.updatedAt || now();
        const current = await tx
          .select()
          .from(gameContinuityBatches)
          .where(eq(gameContinuityBatches.id, receipt.id))
          .limit(1);
        if (current.length === 0) {
          const next = { ...receipt, updatedAt, createdAt: receipt.createdAt || updatedAt };
          await tx.insert(gameContinuityBatches).values(toRow(next, next.createdAt));
          return next;
        }
        const currentReceipt = toReceipt(current[0]!);
        if (currentReceipt.status === "published") {
          throw new Error("CONTINUITY_IMMUTABLE: published receipts cannot be changed");
        }
        const history = parseHistory(current[0]!.history);
        if (isUsefulModelResult(currentReceipt) && modelResultKey(currentReceipt) !== modelResultKey(receipt)) {
          history.push(snapshotOf(currentReceipt));
        }
        const telemetry = mergeTelemetry(parseTelemetry(current[0]!.telemetry), telemetryOf(receipt));
        await tx
          .update(gameContinuityBatches)
          .set(toRow({ ...receipt, updatedAt }, current[0]!.createdAt, history, telemetry))
          .where(eq(gameContinuityBatches.id, receipt.id));
        return {
          ...receipt,
          createdAt: current[0]!.createdAt,
          updatedAt,
          ...(telemetry.length > 0 ? { telemetry } : {}),
        };
      },
      { durable: true },
    );
  }

  async function recover(): Promise<GameContinuityReceipt[]> {
    const receipts = (await inspect()).receipts;
    return receipts.filter(
      (receipt) =>
        RESUMABLE_STATUSES.includes(receipt.status) && (receipt.attempts < 3 || (!receipt.errorCode && !receipt.error)),
    );
  }

  async function publish(
    id: string,
    callback: (tx: DB, receipt: GameContinuityReceipt) => Promise<string[]>,
    options: { replayPublished?: boolean } = {},
  ): Promise<GameContinuityReceipt> {
    return db.transaction(
      async (tx) => {
        const rows = await tx.select().from(gameContinuityBatches).where(eq(gameContinuityBatches.id, id)).limit(1);
        const row = rows[0];
        if (!row) throw new Error("Game continuity receipt not found");
        const receipt = toReceipt(row);
        if (receipt.status === "published") {
          if (options.replayPublished) await callback(tx, receipt);
          return receipt;
        }
        if (receipt.status !== "verified") throw new Error(`Receipt is not ready to publish: ${receipt.status}`);
        const entryIds = await callback(tx, receipt);
        const next = { ...receipt, status: "published" as const, entryIds, updatedAt: now() };
        const history = parseHistory(row.history);
        await tx
          .update(gameContinuityBatches)
          .set(
            toRow(next, receipt.createdAt, history, mergeTelemetry(parseTelemetry(row.telemetry), telemetryOf(next))),
          )
          .where(eq(gameContinuityBatches.id, id));
        return next;
      },
      { durable: true },
    );
  }

  /**
   * Take a published receipt out of service when the text it was read from has changed. Published receipts are
   * otherwise immutable; this is the one sanctioned transition, run in the same transaction as the memory cleanup.
   */
  async function retire(
    id: string,
    callback: (tx: DB, receipt: GameContinuityReceipt) => Promise<void>,
    reason: { errorCode: string; error: string },
  ): Promise<GameContinuityReceipt | null> {
    return db.transaction(
      async (tx) => {
        const rows = await tx.select().from(gameContinuityBatches).where(eq(gameContinuityBatches.id, id)).limit(1);
        const row = rows[0];
        if (!row) return null;
        const receipt = toReceipt(row);
        if (receipt.status !== "published") return null;
        await callback(tx, receipt);
        const next = { ...receipt, status: "stale" as const, ...reason, updatedAt: now() };
        await tx
          .update(gameContinuityBatches)
          .set(
            toRow(
              next,
              receipt.createdAt,
              parseHistory(row.history),
              mergeTelemetry(parseTelemetry(row.telemetry), telemetryOf(next)),
            ),
          )
          .where(eq(gameContinuityBatches.id, id));
        return next;
      },
      { durable: true },
    );
  }

  /**
   * Point a published receipt at the current text of its sources after a small edit that left every quoted line
   * intact. Only the source slices change; what was read and published stays as it is.
   */
  async function reanchor(
    id: string,
    sources: GameContinuitySource[],
    callback: (tx: DB, receipt: GameContinuityReceipt) => Promise<void>,
  ): Promise<GameContinuityReceipt | null> {
    return db.transaction(
      async (tx) => {
        const rows = await tx.select().from(gameContinuityBatches).where(eq(gameContinuityBatches.id, id)).limit(1);
        const row = rows[0];
        if (!row) return null;
        const receipt = toReceipt(row);
        if (receipt.status !== "published") return null;
        await callback(tx, receipt);
        const next = { ...receipt, sources, updatedAt: now() };
        await tx
          .update(gameContinuityBatches)
          .set(
            toRow(
              next,
              receipt.createdAt,
              parseHistory(row.history),
              mergeTelemetry(parseTelemetry(row.telemetry), telemetryOf(next)),
            ),
          )
          .where(eq(gameContinuityBatches.id, id));
        return next;
      },
      { durable: true },
    );
  }

  return { get, getHistory, list, inspect, enqueue, save, recover, publish, retire, reanchor };
}
