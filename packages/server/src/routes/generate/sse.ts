import type { FastifyReply } from "fastify";
import type { DiagnosticReference } from "@marinara-engine/shared";
import { reportDiagnosticError } from "../../lib/diagnostic-operation.js";
import { sanitizeDiagnosticText } from "../../lib/diagnostics.js";
import { routeLabel } from "../../lib/http-diagnostics.js";

type SsePayload = Record<string, unknown>;

/** Internal generation events are privileged data, not a peer protocol. */
export interface GenerationEventSink {
  readonly kind: "generation-event-sink";
  readonly ended: boolean;
  readonly started: boolean;
  start(headers: Record<string, string>): void;
  emit(payload: SsePayload): boolean;
  header(name: string, value: string): void;
  finish(statusCode: number, body?: unknown): void;
}

export type GenerationOutput = FastifyReply | GenerationEventSink;

export function createGenerationEventSink(callbacks: {
  onEvent(payload: SsePayload): void;
  onFinish(result: { statusCode: number; headers: Record<string, string>; body?: unknown }): void;
}): GenerationEventSink {
  let ended = false;
  let started = false;
  const headers: Record<string, string> = {};
  return {
    kind: "generation-event-sink",
    get ended() {
      return ended;
    },
    get started() {
      return started;
    },
    start(values) {
      if (!ended) {
        Object.assign(headers, values);
        started = true;
      }
    },
    emit(payload) {
      if (ended) return false;
      callbacks.onEvent(payload);
      return true;
    },
    header(name, value) {
      if (!started && !ended) headers[name] = value;
    },
    finish(statusCode, body) {
      if (ended) return;
      ended = true;
      callbacks.onFinish({ statusCode, headers: { ...headers }, ...(body === undefined ? {} : { body }) });
    },
  };
}

function isEventSink(reply: GenerationOutput): reply is GenerationEventSink {
  return "kind" in reply && reply.kind === "generation-event-sink";
}

function generationDiagnosticContext(reply: GenerationOutput, stage: "stream" | "stream-write") {
  return isEventSink(reply)
    ? { stage }
    : {
        requestId: reply.request.id,
        operation: `${reply.request.method ?? "SSE"} ${routeLabel(reply.request)}`,
        stage,
      };
}

export function isSseReplyWritable(reply: GenerationOutput): boolean {
  if (isEventSink(reply)) return !reply.ended;
  return !reply.raw.destroyed && !reply.raw.writableEnded && !reply.raw.writableFinished;
}

export function startSseReply(reply: GenerationOutput, extraHeaders: Record<string, string> = {}) {
  if (isEventSink(reply)) return reply.start(extraHeaders);
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Connection: "keep-alive",
    ...extraHeaders,
  });
}

export function startSseKeepalive(reply: GenerationOutput, intervalMs = 15_000): () => void {
  if (isEventSink(reply)) return () => {};
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

export function sendSseEvent(reply: GenerationOutput, payload: SsePayload): boolean {
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
      reportDiagnosticError(new Error(message), generationDiagnosticContext(reply, "stream"), undefined, {
        level: "warn",
        event: "sse.unreferenced_error",
        fields: {
          sseType: payload.type,
          agentType:
            rawData && typeof rawData === "object" && !Array.isArray(rawData)
              ? (rawData as Record<string, unknown>).agentType
              : undefined,
        },
      });
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
    if (isEventSink(reply)) return reply.emit(event);
    return reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch (error) {
    reportDiagnosticError(error, generationDiagnosticContext(reply, "stream-write"), "ME_STREAM_WRITE");
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
export function emitSseFailure(reply: GenerationOutput, error: unknown, opts: SseFailureOptions): DiagnosticReference {
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
export function endGenerationOutput(reply: GenerationOutput): void {
  if (isEventSink(reply)) reply.finish(200);
  else reply.raw.end();
}

export function rejectGenerationOutput(reply: GenerationOutput, statusCode: number, body: unknown): unknown {
  if (isEventSink(reply)) return reply.finish(statusCode, body);
  return reply.status(statusCode).send(body);
}

/** Internal jobs outlive an individual viewer; only the HTTP adapter observes passive disconnects. */
export function onGenerationOutputClose(reply: GenerationOutput, listener: () => void): () => void {
  if (isEventSink(reply)) return () => {};
  reply.raw.on("close", listener);
  return () => reply.raw.off("close", listener);
}

export function generationOutputStarted(reply: GenerationOutput): boolean {
  return isEventSink(reply) ? reply.started : reply.raw.headersSent;
}

export function setGenerationOutputHeader(reply: GenerationOutput, name: string, value: string): void {
  if (generationOutputStarted(reply)) return;
  reply.header(name, value);
}
