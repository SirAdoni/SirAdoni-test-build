// ──────────────────────────────────────────────
// HTTP request logging and error replies
// ──────────────────────────────────────────────
import type { DiagnosticReference } from "@marinara-engine/shared";
import { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import { createDiagnostic, sanitizeDiagnosticText } from "./diagnostics.js";
import { reportDiagnosticError } from "./diagnostic-operation.js";
import { isRequestLoggingDisabled } from "../config/runtime-config.js";

/** Request property holding the root DiagnosticContext set in onRequest. */
export const kDiagnosticContext = Symbol("marinara.diagnosticContext");

const INCOMING_REQUEST_ID = /^[A-Za-z0-9._:-]{8,80}$/;

function slowRequestMs(): number {
  const value = Number(process.env.MARINARA_SLOW_REQUEST_MS);
  return Number.isFinite(value) && value > 0 ? value : 5_000;
}

/** Accepts a client-supplied x-request-id only when it is a plain 8 to 80 character token. */
export function sanitizeIncomingRequestId(value: unknown): string | undefined {
  return typeof value === "string" && INCOMING_REQUEST_ID.test(value) ? value : undefined;
}

/** The route pattern ("/api/chats/:id"), never the raw path, so ids and query strings stay out of logs. */
export function routeLabel(request: FastifyRequest): string {
  return request.routeOptions?.url ?? "<unmatched>";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected error";
}

/**
 * Replaces Fastify's "incoming request" and "request completed" pair with one
 * `request.end` line (or `request.slow`, `request.stream.end`) per request.
 */
export class MarinaraLogController extends LogController {
  constructor() {
    super({ requestIdLogLabel: "requestId", disableRequestLogging: false });
  }

  override incomingRequest(): void {
    // One line per request is written on completion.
  }

  override routeNotFound(request: FastifyRequest): void {
    request.log.debug(
      { event: "request.end", method: request.method, route: "<unmatched>", statusCode: 404 },
      "Route not found",
    );
  }

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    const elapsedMs = Math.round(reply.elapsedTime);
    const route = routeLabel(request);
    const sse = String(reply.getHeader("content-type") ?? "").startsWith("text/event-stream");
    const base = {
      requestId: request.id,
      operation: `${request.method} ${route}`,
      method: request.method,
      route,
      statusCode: reply.statusCode,
      elapsedMs,
    };
    const summary = `${request.method} ${route} -> ${reply.statusCode} in ${elapsedMs} ms`;
    if (sse) {
      request.log.info({ ...base, event: "request.stream.end" }, summary);
    } else if (elapsedMs >= slowRequestMs()) {
      request.log.warn({ ...base, event: "request.slow" }, summary);
    } else if (reply.statusCode >= 500 || error) {
      // The error handler already logged the error in full; this line only closes the request.
      const errorId = error ? createDiagnostic(error).errorId : undefined;
      request.log.info({ ...base, event: "request.end", ...(errorId ? { errorId } : {}) }, summary);
    } else if (isRequestLoggingDisabled()) {
      request.log.debug({ ...base, event: "request.end" }, summary);
    } else {
      request.log.info({ ...base, event: "request.end" }, summary);
    }
  }
}

/**
 * Logs `error` once (event `request.error`, error level for 5xx and warn below)
 * and sends `{ error, code, errorId, ... }` with the given status. The body
 * carries code and errorId, so onSend does not report it again.
 */
export function replyWithDiagnostic(
  reply: FastifyReply,
  status: number,
  error: unknown,
  opts: { message?: string; body?: Record<string, unknown>; event?: string; fields?: Record<string, unknown> } = {},
): FastifyReply {
  const request = reply.request;
  const route = routeLabel(request);
  const ref: DiagnosticReference = reportDiagnosticError(error, { stage: "http" }, undefined, {
    event: opts.event ?? "request.error",
    level: status >= 500 ? undefined : "warn",
    message: `${request.method} ${route} -> ${status}`,
    fields: { method: request.method, route, statusCode: status, ...opts.fields },
  });
  return reply.status(status).send({
    error: sanitizeDiagnosticText(opts.message ?? errorMessage(error)),
    ...ref,
    ...opts.body,
  });
}
