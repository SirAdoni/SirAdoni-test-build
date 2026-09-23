import type { DiagnosticReference } from "@marinara-engine/shared";
import type { DiagnosticContext } from "./diagnostics.js";
import {
  createDiagnostic,
  getDiagnosticContext,
  levelFor,
  markDiagnosticReported,
  sanitizeDiagnosticText,
  wasDiagnosticReported,
  withDiagnosticContext,
} from "./diagnostics.js";
import { logger } from "./logger.js";
import { randomUUID } from "node:crypto";

export interface ReportOptions {
  /** Log message. Default: "<operation> failed". */
  message?: string;
  /** Event name. Default: "diagnostic.failure". */
  event?: string;
  /** Level override. Default: levelFor(code), so cancellations are info and validation/auth/rate limits warn. */
  level?: "debug" | "info" | "warn" | "error" | "fatal";
  /** Extra fields for the one line. Never pass prompt text or message content. */
  fields?: Record<string, unknown>;
}

function errorParts(error: unknown): { errName: string; errMessage: string } {
  const name =
    error instanceof Error
      ? error.name
      : error && typeof error === "object"
        ? String((error as { name?: unknown }).name ?? "Error")
        : typeof error;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error === "object"
          ? String((error as { message?: unknown }).message ?? "")
          : String(error);
  return { errName: name, errMessage: sanitizeDiagnosticText(message, 500) };
}

/**
 * Logs a failure exactly once and returns its reference. A second call for the same
 * error object (a rethrow reaching an outer layer) writes only a debug
 * `diagnostic.rethrown` line with the same errorId.
 */
export function reportDiagnosticError(
  error: unknown,
  context?: DiagnosticContext,
  code?: string,
  opts: ReportOptions = {},
): DiagnosticReference {
  const reference = createDiagnostic(error, context, code);
  if (wasDiagnosticReported(error)) {
    logger.debug(
      { event: "diagnostic.rethrown", errorId: reference.errorId, errorCode: reference.code, diagnostic: reference },
      "Diagnostic already reported",
    );
    return reference;
  }
  const level = opts.level ?? levelFor(reference.code);
  const operation = context?.operation ?? getDiagnosticContext().operation ?? "operation";
  logger[level](
    {
      ...getDiagnosticContext(),
      ...context,
      ...reference,
      diagnostic: reference,
      errorCode: code ?? reference.code,
      event: opts.event ?? "diagnostic.failure",
      ...(level === "info" || level === "debug" ? errorParts(error) : { err: error }),
      ...opts.fields,
    },
    opts.message ?? `${operation} failed`,
  );
  markDiagnosticReported(error);
  return reference;
}

export interface OperationOptions {
  /** A success slower than this logs warn `operation.slow`. Default 10 000 ms. */
  slowMs?: number;
  /** Failures this returns true for log one warn line without the stack. */
  isTransient?: (error: unknown) => boolean;
}

export async function runDiagnosticOperation<T>(
  context: DiagnosticContext,
  work: () => Promise<T>,
  opts: OperationOptions = {},
): Promise<T> {
  const started = Date.now();
  const operationId = context.operationId ?? getDiagnosticContext().operationId ?? randomUUID();
  const operation = context.operation ?? getDiagnosticContext().operation ?? "operation";
  return withDiagnosticContext({ ...context, operationId }, async () => {
    logger.debug({ event: "operation.start", operationId }, "%s started", operation);
    try {
      const result = await work();
      const elapsedMs = Date.now() - started;
      if (elapsedMs < (opts.slowMs ?? 10_000)) {
        logger.debug({ event: "operation.end", outcome: "ok", elapsedMs }, "%s finished", operation);
      } else {
        logger.warn({ event: "operation.slow", outcome: "ok", elapsedMs }, "%s was slow", operation);
      }
      return result;
    } catch (error) {
      const elapsedMs = Date.now() - started;
      const reference = createDiagnostic(error, context);
      if (wasDiagnosticReported(error)) {
        logger.debug(
          { event: "operation.end", outcome: "failed", elapsedMs, errorId: reference.errorId },
          "%s failed (already reported)",
          operation,
        );
      } else if (reference.code === "ME_CANCELLED") {
        logger.info(
          {
            event: "operation.end",
            outcome: "cancelled",
            elapsedMs,
            errorId: reference.errorId,
            errorCode: reference.code,
          },
          "%s cancelled",
          operation,
        );
      } else if (opts.isTransient?.(error)) {
        logger.warn(
          {
            event: "operation.end",
            outcome: "failed",
            transient: true,
            elapsedMs,
            errorId: reference.errorId,
            errorCode: reference.code,
          },
          "%s failed (transient)",
          operation,
        );
        markDiagnosticReported(error);
      } else {
        reportDiagnosticError(error, context, undefined, {
          event: "operation.end",
          message: `${operation} failed`,
          fields: { outcome: "failed", elapsedMs },
        });
      }
      throw error;
    }
  });
}
