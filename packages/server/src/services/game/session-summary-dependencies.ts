import { createHash } from "node:crypto";
import type { DB } from "../../db/connection.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { readGameContinuityState } from "./continuity-state.js";
import { prepareContinuitySources, type ContinuityRawMessage } from "./continuity-sources.js";

export const SESSION_SUMMARY_REFRESHES_VERSION = 1 as const;

export type SessionSummaryRefreshStatus =
  | "pending"
  | "provisional"
  | "ready"
  | "queued"
  | "completed"
  | "stale"
  | "conflict"
  | "failed";

export type SessionSummarySourceManifest = {
  messageId: string;
  swipeIndex: number;
  preparedHash: string;
  start: number;
  end: number;
};

export type SessionSummaryRefreshDescriptor = {
  version: typeof SESSION_SUMMARY_REFRESHES_VERSION;
  sessionNumber: number;
  sourceRange: {
    startMessageId: string | null;
    endMessageId: string | null;
    messages: SessionSummarySourceManifest[];
    sourceHash: string;
  };
  expectedSummaryHash: string;
  dependencies: {
    continuityRequired: boolean;
    continuityReceiptIds: string[];
    sceneTimelineHash: string | null;
  };
  status: SessionSummaryRefreshStatus;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  nextRetryAt?: string;
  reason?: "missing_continuity" | "held_continuity" | "source_changed" | "summary_changed";
  updatedAt: string;
};

export type SessionSummaryRefreshMetadata = Record<string, SessionSummaryRefreshDescriptor>;

export type SessionSummaryRefreshEvaluation = {
  status: "pending" | "ready" | "stale" | "conflict";
  reason?: SessionSummaryRefreshDescriptor["reason"];
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export function hashSessionSummaryValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function sourceHash(messages: SessionSummarySourceManifest[]): string {
  return hashSessionSummaryValue(messages);
}

function sourceOverlapsRange(
  source: { messageId: string; start?: number; end?: number },
  range: SessionSummarySourceManifest,
): boolean {
  return (
    source.messageId === range.messageId &&
    (source.start ?? 0) < range.end &&
    (source.end ?? Number.MAX_SAFE_INTEGER) > range.start
  );
}

function parsePersistedMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function buildSessionSummaryRefreshDescriptor(args: {
  messages: ContinuityRawMessage[];
  metadata: Record<string, unknown>;
  sessionNumber: number;
  summary: unknown;
  continuityReceiptIds?: string[];
  continuityRequired?: boolean;
  sceneTimelineHash?: string | null;
  now?: string;
}): SessionSummaryRefreshDescriptor {
  const prepared = prepareContinuitySources(args.messages, args.metadata);
  const manifests = prepared.map((message) => ({
    messageId: message.messageId,
    swipeIndex: message.swipeIndex,
    preparedHash: message.hash,
    start: message.start ?? 0,
    end: message.end ?? Array.from(message.content).length,
  }));
  return {
    version: SESSION_SUMMARY_REFRESHES_VERSION,
    sessionNumber: args.sessionNumber,
    sourceRange: {
      startMessageId: manifests[0]?.messageId ?? null,
      endMessageId: manifests.at(-1)?.messageId ?? null,
      messages: manifests,
      sourceHash: sourceHash(manifests),
    },
    expectedSummaryHash: hashSessionSummaryValue(args.summary),
    dependencies: {
      continuityRequired: args.continuityRequired === true,
      continuityReceiptIds: [...new Set(args.continuityReceiptIds ?? [])].sort(),
      sceneTimelineHash: args.sceneTimelineHash ?? null,
    },
    status: args.continuityRequired === true ? "provisional" : "completed",
    attempts: 0,
    maxAttempts: 3,
    updatedAt: args.now ?? new Date().toISOString(),
  };
}

export async function evaluateSessionSummaryRefresh(
  db: DB,
  chatId: string,
  descriptor: SessionSummaryRefreshDescriptor,
  currentSummary: unknown,
): Promise<SessionSummaryRefreshEvaluation> {
  if (descriptor.version !== SESSION_SUMMARY_REFRESHES_VERSION) return { status: "stale", reason: "source_changed" };
  return db.transaction((tx) => evaluateSessionSummaryRefreshInTransaction(tx, chatId, descriptor, currentSummary));
}

export async function evaluateSessionSummaryRefreshInTransaction(
  db: DB,
  chatId: string,
  descriptor: SessionSummaryRefreshDescriptor,
  currentSummary: unknown,
): Promise<SessionSummaryRefreshEvaluation> {
  const chats = createChatsStorage(db);
  const chat = await chats.getById(chatId);
  if (!chat) return { status: "stale", reason: "source_changed" };
  const prepared = prepareContinuitySources(await chats.listMessages(chatId), parsePersistedMetadata(chat.metadata));
  const startIndex = descriptor.sourceRange.startMessageId
    ? prepared.findIndex((message) => message.messageId === descriptor.sourceRange.startMessageId)
    : -1;
  const endIndex = descriptor.sourceRange.endMessageId
    ? prepared.findIndex((message) => message.messageId === descriptor.sourceRange.endMessageId)
    : -1;
  if (startIndex < 0 || endIndex < startIndex) return { status: "stale", reason: "source_changed" };
  const bounded = prepared.slice(startIndex, endIndex + 1);
  const current = bounded.map((message) => ({
    messageId: message.messageId,
    swipeIndex: message.swipeIndex,
    preparedHash: message.hash,
    start: message.start ?? 0,
    end: message.end ?? Array.from(message.content).length,
  }));
  if (
    sourceHash(current) !== descriptor.sourceRange.sourceHash ||
    JSON.stringify(current) !== JSON.stringify(descriptor.sourceRange.messages)
  )
    return { status: "stale", reason: "source_changed" };
  if (hashSessionSummaryValue(currentSummary) !== descriptor.expectedSummaryHash)
    return { status: "conflict", reason: "summary_changed" };
  if (!descriptor.dependencies.continuityRequired) return { status: "ready" };

  const continuity = await readGameContinuityState(db, chatId);
  const published = continuity.receipts.filter(
    ({ receipt, sourceCurrent }) =>
      sourceCurrent && receipt.status === "published" && continuity.currentPublishedReceiptIds.includes(receipt.id),
  );
  const coverage = new Map<string, Array<[number, number]>>();
  for (const { receipt } of published) {
    for (const source of receipt.sources) {
      const ranges = coverage.get(source.messageId) ?? [];
      ranges.push([source.start ?? 0, source.end ?? Array.from(source.content).length]);
      coverage.set(source.messageId, ranges);
    }
  }
  for (const expected of descriptor.sourceRange.messages) {
    const ranges = (coverage.get(expected.messageId) ?? [])
      .filter(([start, end]) => end > expected.start && start < expected.end)
      .map(([start, end]) => [Math.max(start, expected.start), Math.min(end, expected.end)] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    let end = expected.start;
    for (const [start, finish] of ranges) {
      if (start > end) break;
      end = Math.max(end, finish);
    }
    if (end < expected.end)
      return {
        status: "pending",
        reason: published.length === 0 ? "missing_continuity" : "held_continuity",
      };
  }
  return { status: "ready" };
}

export function continuityDependenciesForRange(
  state: Awaited<ReturnType<typeof readGameContinuityState>>,
  range: SessionSummarySourceManifest[],
): string[] {
  return state.receipts
    .filter(({ receipt }) =>
      receipt.sources.some((source) => range.some((expected) => sourceOverlapsRange(source, expected))),
    )
    .map(({ receipt }) => receipt.id)
    .sort();
}
