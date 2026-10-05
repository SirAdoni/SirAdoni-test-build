// ──────────────────────────────────────────────
// Error Handler Middleware
// ──────────────────────────────────────────────
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { failureLevel } from "../lib/log-context.js";
import { sendCampaignFeatureDisabled } from "../services/features/campaign-opt-in.js";
import { LLMHttpError } from "../services/llm/base-provider.js";
import { isFeatureEnabled } from "../services/features/feature-settings.js";

export function errorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  if (sendCampaignFeatureDisabled(reply, error)) return;

  // Zod validation errors → 400
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: "Validation Error",
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
    });
  }

  if (error instanceof LLMHttpError) {
    if (error.diagnostic && isFeatureEnabled("providerDiagnostics")) {
      // The provider failure was already logged with bounded HTTP metadata. Do
      // not serialize its message or response body into this routine log line.
      return reply.status(500).send({
        error: "Internal Server Error",
        diagnosticRef: error.diagnostic.diagnosticRef,
      });
    }

    // Keep typed failure evidence safe when optional provider diagnostics are off,
    // including errors created while the switch was on and handled after it turns off.
    reply.log.error(
      {
        providerStatus: error.status,
        ...(typeof error.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {}),
      },
      "LLM provider request failed",
    );
    return reply.status(500).send({ error: "Internal Server Error" });
  }

  if (error.statusCode) {
    return reply.status(error.statusCode).send({
      error: error.message,
    });
  }

  // Unknown errors → 500. This is the only line for the failure (a client
  // that went away is logged at info); Fastify's request-completed line only
  // records the status.
  reply.log[failureLevel(error)](error);
  return reply.status(500).send({
    error: "Internal Server Error",
  });
}
