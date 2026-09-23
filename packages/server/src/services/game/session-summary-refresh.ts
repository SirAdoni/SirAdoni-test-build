import { createHash } from "node:crypto";
import type { SessionSummary } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { chats as chatsTable, messages } from "../../db/schema/index.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { logger as sharedLogger } from "../../lib/logger.js";
import { createDiagnostic, runWithRootDiagnosticContext, sanitizeDiagnosticText } from "../../lib/diagnostics.js";
import { registerWorkerGauge } from "../../lib/worker-gauges.js";
import {
  evaluateSessionSummaryRefreshInTransaction,
  hashSessionSummaryValue,
  type SessionSummaryRefreshDescriptor,
  type SessionSummaryRefreshMetadata,
} from "./session-summary-dependencies.js";
import { prepareContinuitySources } from "./continuity-sources.js";
import { readGameContinuityState } from "./continuity-state.js";
import { validateSessionSummaryRefreshDraft } from "./session-summary-review.js";

export type SessionSummaryRefreshDraft = Omit<SessionSummary, "timestamp" | "sessionNumber"> & {
  sessionNumber?: number;
  timestamp?: string;
};

export type SessionSummaryRefreshProvider = (input: {
  chatId: string;
  sessionNumber: number;
  savedSummary: SessionSummary;
  transcript: string;
  continuityEvidence: string;
  signal: AbortSignal;
}) => Promise<SessionSummaryRefreshDraft>;

export type SessionSummaryRefreshServiceOptions = {
  generate: SessionSummaryRefreshProvider;
  maxConcurrent?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  logger?: { warn(error: unknown, message: string, ...args: unknown[]): void };
};

function metadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function descriptors(value: unknown): SessionSummaryRefreshMetadata {
  const root = metadata(value);
  const parsed = Object.hasOwn(root, "gameSessionSummaryRefreshes") ? root.gameSessionSummaryRefreshes : root;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as SessionSummaryRefreshMetadata)
    : {};
}

function summaryAt(value: unknown, sessionNumber: number): unknown {
  const summaries = metadata(value).gamePreviousSessionSummaries;
  return Array.isArray(summaries) ? summaries[sessionNumber - 1] : undefined;
}

function messageHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatConclusion(summary: SessionSummary): string {
  const sections = [`**Session ${summary.sessionNumber} Concluded**`, summary.summary.trim()];
  if (summary.partyDynamics.trim()) sections.push(`**Relationship Changes**\n\n${summary.partyDynamics.trim()}`);
  if (summary.characterMoments.length)
    sections.push(`**Character Moments**\n\n${summary.characterMoments.map((item) => `- ${item}`).join("\n")}`);
  if (summary.resumePoint.trim()) sections.push(`**Next Session**\n\n${summary.resumePoint.trim()}`);
  return sections.filter(Boolean).join("\n\n");
}

function readyStatus(status: SessionSummaryRefreshDescriptor["status"]): boolean {
  return status === "pending" || status === "provisional" || status === "queued";
}

export function createSessionSummaryRefreshService(db: DB, options: SessionSummaryRefreshServiceOptions) {
  const chats = createChatsStorage(db);
  const pending = new Array<string>();
  const queued = new Set<string>();
  const activeChats = new Set<string>();
  const activeKeys = new Set<string>();
  const flights = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;
  let active = 0;
  let pumping = false;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
  const timeoutMs = options.timeoutMs ?? 600_000;
  /** job.state lines. An injected logger only has warn, so it receives the warn and error lines and no debug. */
  const logJob = (level: "debug" | "warn" | "error", fields: Record<string, unknown>, message: string): void => {
    const line = { event: "job.state", jobKind: "session-summary", ...fields };
    if (options.logger) {
      if (level !== "debug") options.logger.warn(line, message);
      return;
    }
    sharedLogger[level](line, message);
  };
  const unregisterGauge = registerWorkerGauge("sessionSummary", () => ({
    pending: pending.length,
    active,
    retryScheduled: retryTimers.size,
  }));

  const enqueue = (chatId: string, sessionNumber: number) => {
    const key = `${chatId}:${sessionNumber}`;
    if (stopped || queued.has(key) || activeKeys.has(key)) return;
    queued.add(key);
    pending.push(key);
    void pump();
  };

  const scheduleRetry = (chatId: string, sessionNumber: number, at: string) => {
    const key = `${chatId}:${sessionNumber}`;
    if (stopped || retryTimers.has(key)) return;
    const delay = Math.max(0, new Date(at).getTime() - Date.now());
    retryTimers.set(
      key,
      setTimeout(() => {
        retryTimers.delete(key);
        enqueue(chatId, sessionNumber);
      }, delay),
    );
  };

  async function process(key: string): Promise<void> {
    const separator = key.lastIndexOf(":");
    const chatId = key.slice(0, separator);
    const sessionNumber = Number(key.slice(separator + 1));
    const snapshot = await db.transaction(
      async (tx) => {
        const txChats = createChatsStorage(tx);
        const chat = await txChats.getById(chatId);
        if (!chat) return null;
        const meta = metadata(chat.metadata);
        const descriptor = descriptors(chat.metadata)[String(sessionNumber)];
        const savedSummary = summaryAt(chat.metadata, sessionNumber);
        if (!descriptor || !savedSummary || !readyStatus(descriptor.status)) return null;
        if (descriptor.nextRetryAt && new Date(descriptor.nextRetryAt).getTime() > Date.now()) {
          scheduleRetry(chatId, sessionNumber, descriptor.nextRetryAt);
          return null;
        }
        if (
          !descriptor.dependencies.continuityRequired &&
          descriptor.status !== "queued" &&
          (descriptor.attempts ?? 0) === 0
        )
          return null;
        const evaluation = await evaluateSessionSummaryRefreshInTransaction(tx, chatId, descriptor, savedSummary);
        if (evaluation.status !== "ready") {
          if (evaluation.status === "stale" || evaluation.status === "conflict") {
            const currentDescriptors = descriptors(meta.gameSessionSummaryRefreshes);
            currentDescriptors[String(sessionNumber)] = {
              ...descriptor,
              status: evaluation.status,
              reason: evaluation.reason,
              updatedAt: new Date().toISOString(),
            };
            await tx
              .update(chatsTable)
              .set({ metadata: JSON.stringify({ ...meta, gameSessionSummaryRefreshes: currentDescriptors }) })
              .where(eq(chatsTable.id, chatId));
          }
          return null;
        }
        const attempts = descriptor.attempts ?? 0;
        const maxAttempts = descriptor.maxAttempts ?? options.maxAttempts ?? 3;
        if (attempts >= maxAttempts) {
          const currentDescriptors = descriptors(meta.gameSessionSummaryRefreshes);
          currentDescriptors[String(sessionNumber)] = {
            ...descriptor,
            status: "failed",
            updatedAt: new Date().toISOString(),
          };
          await tx
            .update(chatsTable)
            .set({ metadata: JSON.stringify({ ...meta, gameSessionSummaryRefreshes: currentDescriptors }) })
            .where(eq(chatsTable.id, chatId));
          return null;
        }
        const prepared = prepareContinuitySources(await txChats.listMessages(chatId), meta);
        const start = prepared.findIndex((item) => item.messageId === descriptor.sourceRange.startMessageId);
        const end = prepared.findIndex((item) => item.messageId === descriptor.sourceRange.endMessageId);
        if (start < 0 || end < start) return null;
        const bounded = prepared.slice(start, end + 1);
        const boundedIds = new Set(bounded.map((item) => item.messageId));
        const state = await readGameContinuityState(tx, chatId);
        const continuityEvidence = state.records
          .filter(
            (record) => record.evidence.length > 0 && record.evidence.every((item) => boundedIds.has(item.messageId)),
          )
          .map(
            (record) =>
              `${record.text} [${record.evidence.map((item) => `${item.messageId}: ${item.quote}`).join("; ")}]`,
          )
          .join("\n");
        const conclusionHeader = `**Session ${sessionNumber} Concluded**`;
        const conclusion = [...(await txChats.listMessages(chatId))]
          .reverse()
          .find(
            (message) =>
              message.content.trim().startsWith(conclusionHeader) &&
              (message.role === "narrator" ||
                metadata(message.extra).isNarrator === true ||
                metadata(message.extra).continuitySource === "derived_session_summary"),
          );
        const claimedDescriptor = {
          ...descriptor,
          status: "queued" as const,
          attempts: attempts + 1,
          maxAttempts,
          nextRetryAt: undefined,
          updatedAt: new Date().toISOString(),
        };
        const nextDescriptors = descriptors(meta.gameSessionSummaryRefreshes);
        nextDescriptors[String(sessionNumber)] = claimedDescriptor;
        await tx
          .update(chatsTable)
          .set({ metadata: JSON.stringify({ ...meta, gameSessionSummaryRefreshes: nextDescriptors }) })
          .where(eq(chatsTable.id, chatId));
        return {
          descriptor: claimedDescriptor,
          savedSummary: savedSummary as SessionSummary,
          transcript: bounded.map((item) => `[${item.role}] ${item.content}`).join("\n\n"),
          continuityEvidence,
          conclusionSnapshot: conclusion ? { id: conclusion.id, hash: messageHash(conclusion.content) } : null,
        };
      },
      { durable: true },
    );
    if (!snapshot) return;
    const { descriptor, savedSummary: previous, transcript, continuityEvidence, conclusionSnapshot } = snapshot;
    if (stopped) return;
    const attempts = descriptor.attempts ?? 1;
    const maxAttempts = descriptor.maxAttempts ?? options.maxAttempts ?? 3;
    const controller = new AbortController();
    controllers.add(controller);
    const startedAt = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        Object.assign(new Error("SESSION_SUMMARY_REFRESH_TIMEOUT"), { name: "TimeoutError", code: "ETIMEDOUT" }),
      );
    }, timeoutMs);
    // An abort that ends the attempt without an exception still gets one line: a stop is a quiet
    // cancellation, a timeout is a failed attempt.
    const logAborted = (): void => {
      if (stopped || !timedOut) {
        logJob(
          "debug",
          {
            jobId: key,
            chatId,
            sessionNumber,
            attempt: attempts,
            maxAttempts,
            state: "cancelled",
            outcome: "cancelled",
          },
          "[game/session-summary-refresh] refresh stopped",
        );
        return;
      }
      logJob(
        "warn",
        {
          jobId: key,
          chatId,
          sessionNumber,
          attempt: attempts,
          maxAttempts,
          state: "failed",
          outcome: "failed",
          errorCode: "ME_TIMEOUT",
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
        },
        "[game/session-summary-refresh] refresh timed out",
      );
    };
    try {
      if (stopped || controller.signal.aborted) {
        logAborted();
        return;
      }
      const draft = await options.generate({
        chatId,
        sessionNumber,
        savedSummary: previous,
        transcript,
        continuityEvidence,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        logAborted();
        return;
      }
      const refreshed = validateSessionSummaryRefreshDraft(draft, sessionNumber, previous);
      await db.transaction(
        async (tx) => {
          const rows = await tx.select().from(chatsTable).where(eq(chatsTable.id, chatId)).limit(1);
          const currentChat = rows[0];
          if (!currentChat) return;
          const currentMeta = metadata(currentChat.metadata);
          const currentDescriptor = descriptors(currentMeta.gameSessionSummaryRefreshes)[String(sessionNumber)];
          const currentSummary = summaryAt(currentMeta, sessionNumber);
          if (
            !currentDescriptor ||
            currentDescriptor.version !== descriptor.version ||
            currentDescriptor.status !== "queued" ||
            currentDescriptor.attempts !== attempts
          )
            return;
          const descriptorMap = descriptors(currentMeta.gameSessionSummaryRefreshes);
          const markChanged = (status: "stale" | "conflict", reason: "source_changed" | "summary_changed") => {
            descriptorMap[String(sessionNumber)] = {
              ...currentDescriptor,
              status,
              reason,
              updatedAt: new Date().toISOString(),
            };
            return tx
              .update(chatsTable)
              .set({ metadata: JSON.stringify({ ...currentMeta, gameSessionSummaryRefreshes: descriptorMap }) })
              .where(eq(chatsTable.id, chatId));
          };
          if (
            currentDescriptor.sourceRange.sourceHash !== descriptor.sourceRange.sourceHash ||
            currentDescriptor.expectedSummaryHash !== descriptor.expectedSummaryHash
          )
            return;
          if (hashSessionSummaryValue(currentSummary) !== descriptor.expectedSummaryHash) {
            await markChanged("conflict", "summary_changed");
            return;
          }
          const check = await evaluateSessionSummaryRefreshInTransaction(tx, chatId, currentDescriptor, currentSummary);
          if (check.status !== "ready") {
            if (check.status === "stale") await markChanged("stale", "source_changed");
            else if (check.status === "conflict") await markChanged("conflict", "summary_changed");
            return;
          }
          const summaries = Array.isArray(currentMeta.gamePreviousSessionSummaries)
            ? [...currentMeta.gamePreviousSessionSummaries]
            : [];
          summaries[sessionNumber - 1] = refreshed;
          const nextDescriptors = descriptors(currentMeta.gameSessionSummaryRefreshes);
          nextDescriptors[String(sessionNumber)] = {
            ...currentDescriptor,
            status: "completed",
            expectedSummaryHash: hashSessionSummaryValue(refreshed),
            lastError: undefined,
            updatedAt: new Date().toISOString(),
          };
          await tx
            .update(chatsTable)
            .set({
              metadata: JSON.stringify({
                ...currentMeta,
                gamePreviousSessionSummaries: summaries,
                gameSessionSummaryRefreshes: nextDescriptors,
              }),
            })
            .where(eq(chatsTable.id, chatId));
          if (conclusionSnapshot) {
            const conclusion = (
              await tx.select().from(messages).where(eq(messages.id, conclusionSnapshot.id)).limit(1)
            )[0];
            const conclusionExtra = metadata(conclusion?.extra);
            const isDerivedConclusion = conclusionExtra.continuitySource === "derived_session_summary";
            if (conclusion && isDerivedConclusion && messageHash(conclusion.content) === conclusionSnapshot.hash)
              await createChatsStorage(tx).updateMessageContent(conclusion.id, formatConclusion(refreshed));
          }
        },
        { durable: true },
      );
    } catch (error) {
      const reference = createDiagnostic(
        error,
        { operation: "game.session-summary", stage: "background-refresh", chatId },
        "SESSION_SUMMARY_REFRESH_FAILED",
      );
      if (stopped) {
        logJob(
          "debug",
          {
            jobId: key,
            chatId,
            sessionNumber,
            attempt: attempts,
            maxAttempts,
            state: "cancelled",
            outcome: "cancelled",
            errorId: reference.errorId,
          },
          "[game/session-summary-refresh] refresh stopped",
        );
        return;
      }
      // What the descriptor recorded for this failure; stays null when a newer claim replaced it meanwhile.
      let recorded: { attempts: number; failed: boolean; nextRetryAt?: string } | null = null;
      await chats.patchMetadata(chatId, (current) => {
        const currentDescriptors = descriptors(current.gameSessionSummaryRefreshes);
        const currentDescriptor = currentDescriptors[String(sessionNumber)];
        if (
          !currentDescriptor ||
          currentDescriptor.version !== descriptor.version ||
          currentDescriptor.status !== "queued" ||
          currentDescriptor.attempts !== attempts ||
          currentDescriptor.sourceRange.sourceHash !== descriptor.sourceRange.sourceHash ||
          currentDescriptor.expectedSummaryHash !== descriptor.expectedSummaryHash
        )
          return {};
        const nextAttempts = currentDescriptor.attempts ?? attempts;
        const nextRetryAt =
          nextAttempts >= maxAttempts
            ? undefined
            : new Date(Date.now() + (options.retryDelayMs ?? 30_000)).toISOString();
        recorded = { attempts: nextAttempts, failed: nextAttempts >= maxAttempts, nextRetryAt };
        return {
          gameSessionSummaryRefreshes: {
            ...currentDescriptors,
            [String(sessionNumber)]: {
              ...currentDescriptor,
              attempts: nextAttempts,
              status: nextAttempts >= maxAttempts ? "failed" : "pending",
              lastError: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), 500),
              nextRetryAt,
              updatedAt: new Date().toISOString(),
            },
          },
        };
      });
      const latest = await chats.getById(chatId);
      const next = latest ? descriptors(latest.metadata)[String(sessionNumber)] : undefined;
      if (next?.status === "pending" && next.nextRetryAt) scheduleRetry(chatId, sessionNumber, next.nextRetryAt);
      const outcome = recorded as { attempts: number; failed: boolean; nextRetryAt?: string } | null;
      const failed = outcome ? outcome.failed : attempts >= maxAttempts;
      logJob(
        failed ? "error" : "warn",
        {
          jobId: key,
          chatId,
          sessionNumber,
          attempt: outcome?.attempts ?? attempts,
          maxAttempts,
          state: failed ? "failed" : "progress",
          ...(failed ? { outcome: "failed" } : {}),
          willRetry: !failed && Boolean(outcome?.nextRetryAt),
          nextRetryAt: outcome?.nextRetryAt,
          descriptorUpdated: outcome !== null,
          timedOut,
          elapsedMs: Date.now() - startedAt,
          errorCode: "SESSION_SUMMARY_REFRESH_FAILED",
          errorId: reference.errorId,
          err: error,
        },
        "[game/session-summary-refresh] refresh attempt failed",
      );
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  async function pump(): Promise<void> {
    if (pumping || stopped) return;
    pumping = true;
    try {
      while (!stopped && active < maxConcurrent) {
        const index = pending.findIndex((item) => !activeChats.has(item.slice(0, item.lastIndexOf(":"))));
        if (index < 0) break;
        const key = pending.splice(index, 1)[0]!;
        queued.delete(key);
        activeKeys.add(key);
        const chatId = key.slice(0, key.lastIndexOf(":"));
        activeChats.add(chatId);
        active += 1;
        const flight = runWithRootDiagnosticContext({ operation: "game.session-summary", jobId: key, chatId }, () =>
          process(key),
        )
          .catch((error) => {
            const reference = createDiagnostic(
              error,
              { operation: "game.session-summary", stage: "background-refresh-flight", chatId },
              "SESSION_SUMMARY_REFRESH_FAILED",
            );
            // The claim or the failure bookkeeping itself threw, so the attempt count is unknown here.
            logJob(
              "error",
              {
                jobId: key,
                chatId,
                stage: "background-refresh-flight",
                state: "failed",
                outcome: "failed",
                errorCode: "SESSION_SUMMARY_REFRESH_FAILED",
                errorId: reference.errorId,
                err: error,
              },
              "[game/session-summary-refresh] refresh flight failed",
            );
          })
          .finally(() => {
            activeChats.delete(chatId);
            activeKeys.delete(key);
            flights.delete(flight);
            active -= 1;
            void pump();
          });
        flights.add(flight);
      }
    } finally {
      pumping = false;
    }
  }

  return {
    async start() {
      for (const chat of await chats.list()) {
        const all = descriptors(chat.metadata);
        for (const [key, descriptor] of Object.entries(all)) {
          // Chats without a descriptor map fall back to the metadata root, whose values (summary,
          // tags, ...) are not descriptors; never let one of them abort the whole boot scan.
          if (
            !descriptor ||
            typeof descriptor !== "object" ||
            Array.isArray(descriptor) ||
            !Number.isInteger(Number(key))
          )
            continue;
          if (
            readyStatus(descriptor.status) &&
            (descriptor.dependencies?.continuityRequired || descriptor.status === "queued")
          )
            enqueue(chat.id, Number(key));
          if (descriptor.status === "pending" && descriptor.nextRetryAt)
            scheduleRetry(chat.id, Number(key), descriptor.nextRetryAt);
        }
      }
    },
    async onDependencyChanged(chatId: string) {
      const chat = await chats.getById(chatId);
      if (!chat) return;
      // A session slot can hold null (a summary that was cleared); skip it instead of failing every publication.
      for (const [key, descriptor] of Object.entries(descriptors(chat.metadata)))
        if (descriptor && readyStatus(descriptor.status)) enqueue(chatId, Number(key));
      for (const [key, descriptor] of Object.entries(descriptors(chat.metadata)))
        if (descriptor && descriptor.status === "pending" && descriptor.nextRetryAt)
          scheduleRetry(chatId, Number(key), descriptor.nextRetryAt);
    },
    async stop() {
      stopped = true;
      unregisterGauge();
      pending.length = 0;
      retryTimers.forEach((timer) => clearTimeout(timer));
      retryTimers.clear();
      controllers.forEach((controller) => controller.abort(new Error("SESSION_SUMMARY_REFRESH_STOPPED")));
      await Promise.allSettled([...flights]);
    },
  };
}
