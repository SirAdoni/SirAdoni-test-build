// ──────────────────────────────────────────────
// Error Handler Middleware
// ──────────────────────────────────────────────
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { failureLevel } from "../lib/log-context.js";
import { reportDiagnosticError } from "../lib/diagnostic-operation.js";
import { formatDiagnosticError, sanitizeDiagnosticText } from "../lib/diagnostics.js";
import { routeLabel } from "../lib/http-diagnostics.js";

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const zod = error instanceof ZodError;
  const status = zod ? 400 : error.statusCode || 500;
  const route = routeLabel(request);
  // One line per failed request: error for 5xx, warn for client errors (validation, 404, 413).
  const reference = reportDiagnosticError(
    error,
    { requestId: request.id, operation: `${request.method} ${route}`, stage: "http" },
    undefined,
    {
      level: failureLevel(error, status >= 500 ? "error" : "warn"),
      event: "request.error",
      message: `${request.method} ${route} -> ${status}`,
      fields: {
        method: request.method,
        route,
        statusCode: status,
        ...(zod
          ? {
              issueCount: (error as ZodError).errors.length,
              firstIssuePath: (error as ZodError).errors[0]?.path.join("."),
            }
          : {}),
      },
    },
  );
  const safeMessage = formatDiagnosticError(error, reference);
  // Zod validation errors → 400
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: "Validation Error",
      ...reference,
      details: error.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
      })),
    });
  }

  // Known HTTP errors
  if (error.statusCode === 413) {
    // Routes carry their own bodyLimit (64 KB on experience-generation, 256 MB
    // app-wide for profile imports), so the message must not name one number.
    return reply.status(413).send({
      error: "The request body is larger than this endpoint accepts.",
      ...reference,
    });
  }

  if (error.statusCode) {
    return reply.status(error.statusCode).send({
      error: error.message ? sanitizeDiagnosticText(error.message) : safeMessage,
      ...reference,
    });
  }

  // Unknown errors → 500
  return reply.status(500).send({
    error: safeMessage,
    ...reference,
  });
}
