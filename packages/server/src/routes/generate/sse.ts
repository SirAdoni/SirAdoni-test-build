import type { FastifyReply } from "fastify";
import type { DiagnosticReference } from "@marinara-engine/shared";
import { reportDiagnosticError } from "../../lib/diagnostic-operation.js";
import { sanitizeDiagnosticText } from "../../lib/diagnostics.js";
import { routeLabel } from "../../lib/http-diagnostics.js";

type SsePayload = Record<string, unknown>;

export function isSseReplyWritable(reply: FastifyReply): boolean {
  return !reply.raw.destroyed && !reply.raw.writableEnded && !reply.raw.writableFinished;
}

export function startSseReply(reply: FastifyReply, extraHeaders: Record<string, string> = {}) {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Connection: "keep-alive",
    ...extraHeaders,
  });
}

export function startSseKeepalive(reply: FastifyReply, intervalMs = 15_000): () => void {
  const timer = setInterval(() => {
    try {
      if (isSseReplyWritable(reply)) {
        reply.raw.write(": keepalive\n\n");
      }
    } catch {
      // Ignore writes after the client disconnects.
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function sendSseEvent(reply: FastifyReply, payload: SsePayload): boolean {
  let event = payload;
  const isFailedAgentResult =
    payload.type === "agent_result" &&
    payload.data &&
    typeof payload.data === "object" &&
    !Array.isArray(payload.data) &&
    (payload.data as Record<string, unknown>).success === false;
  if (payload.type === "error" || payload.type === "agent_error" || isFailedAgentResult) {
    const rawData = payload.data;
    const supplied =
      rawData && typeof rawData === "object" && !Array.isArray(rawData)
        ? (rawData as Record<string, unknown>)
        : payload;
    const referenceSource = typeof payload.errorId === "string" ? payload : supplied;
    const existingReference =
      typeof referenceSource.code === "string" && typeof referenceSource.errorId === "string"
        ? {
            code: referenceSource.code,
            errorId: referenceSource.errorId,
            ...(typeof referenceSource.requestId === "string" ? { requestId: referenceSource.requestId } : {}),
          }
        : null;
    const message =
      typeof rawData === "string"
        ? rawData
        : rawData && typeof rawData === "object" && typeof (rawData as Record<string, unknown>).error === "string"
          ? String((rawData as Record<string, unknown>).error)
          : `SSE ${String(payload.type)} failed`;
    // Callers should use emitSseFailure, which reports the real error. This fallback
    // keeps a durable record for an error event that arrived without a reference.
    const reference =
      existingReference ??
      reportDiagnosticError(
        new Error(message),
        {
          requestId: reply.request.id,
          operation: `${reply.request.method ?? "SSE"} ${routeLabel(reply.request)}`,
          stage: "stream",
        },
        undefined,
        {
          level: "warn",
          event: "sse.unreferenced_error",
          fields: {
            sseType: payload.type,
            agentType:
              rawData && typeof rawData === "object" && !Array.isArray(rawData)
                ? (rawData as Record<string, unknown>).agentType
                : undefined,
          },
        },
      );
    const visibleError = (value: string) => {
      const safe = sanitizeDiagnosticText(value);
      return safe.includes(reference.errorId) ? safe : `${safe} [${reference.code} ${reference.errorId}]`;
    };
    if (typeof rawData === "string") {
      event = { ...payload, ...reference, data: visibleError(rawData) };
    } else if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
      const data = rawData as Record<string, unknown>;
      event = {
        ...payload,
        data: {
          ...data,
          ...(typeof data.error === "string" ? { error: visibleError(data.error) } : {}),
          ...reference,
        },
      };
    } else {
      event = { ...payload, ...reference };
    }
  }
  // Report errors before checking writability: disconnected clients still need
  // a durable record for HTTP-200 SSE failures.
  if (!isSseReplyWritable(reply)) return false;
  try {
    return reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch (error) {
    reportDiagnosticError(
      error,
      {
        requestId: reply.request.id,
        operation: `${reply.request.method ?? "SSE"} ${routeLabel(reply.request)}`,
        stage: "stream-write",
      },
      "ME_STREAM_WRITE",
    );
    return false;
  }
}

export interface SseFailureOptions {
  /** SSE event type. Default "error". */
  type?: "error" | "agent_error";
  /** Event data. Default: the sanitized error message. */
  data?: unknown;
  agentType?: string;
  agentName?: string;
  retryTarget?: string;
  /** Log level. Default: levelFor(code), so a cancellation logs info. */
  level?: "info" | "warn" | "error";
  /** Event name for the log line, for example "generation.abort" or "agent.run". */
  event: string;
  message?: string;
  /** Extra log fields. Never prompt text or message content. */
  fields?: Record<string, unknown>;
}

/**
 * Reports `error` once and sends it to the client as an SSE error event that
 * carries the same code and errorId. An error the caller already logged keeps
 * its errorId and only adds a debug `diagnostic.rethrown` line.
 */
export function emitSseFailure(reply: FastifyReply, error: unknown, opts: SseFailureOptions): DiagnosticReference {
  const reference = reportDiagnosticError(error, { stage: "stream" }, undefined, {
    level: opts.level,
    event: opts.event,
    message: opts.message ?? opts.event,
    fields: { ...(opts.agentType ? { agentType: opts.agentType } : {}), ...opts.fields },
  });
  const safeMessage = sanitizeDiagnosticText(
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unexpected error",
  );
  sendSseEvent(reply, {
    type: opts.type ?? "error",
    data: opts.data ?? safeMessage,
    ...reference,
    ...(opts.agentType ? { agentType: opts.agentType } : {}),
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
    ...(opts.retryTarget ? { retryTarget: opts.retryTarget } : {}),
  });
  return reference;
}
