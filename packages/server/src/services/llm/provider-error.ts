// ──────────────────────────────────────────────
// Provider error helpers shared by every LLM provider
// ──────────────────────────────────────────────
// Turn a failed provider response into one LLMHttpError that carries the
// fields support needs (status, providerCode, providerRequestId, host) and
// nothing it must not have (prompt text, keys, full response bodies).
import { LLMHttpError, parseRetryAfterMs, sanitizeApiError } from "./base-provider.js";
import { sanitizeDiagnosticText } from "../../lib/diagnostics.js";
import { logRepeated } from "../../lib/log-events.js";

/** Provider request id from the usual response headers, for matching a failure with the provider's own logs. */
export function providerRequestIdFrom(headers: Headers): string | undefined {
  for (const name of ["x-request-id", "request-id", "x-goog-request-id", "cf-ray"]) {
    const value = headers.get(name)?.trim();
    if (value) return sanitizeDiagnosticText(value, 200);
  }
  return undefined;
}

/** The host of a URL only (no scheme, path, query or credentials), or undefined when it does not parse. */
export function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function providerCodeOf(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const root = parsed as Record<string, unknown>;
  const error = root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : root;
  const code = error.code ?? error.type ?? error.status;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

/**
 * Reads a failed response body once and builds an LLMHttpError with status,
 * retryAfterMs, providerCode, providerRequestId and host. The message is
 * `${label} (${status}): <sanitized body, 400 chars max>`.
 */
export async function llmHttpErrorFromResponseBody(label: string, response: Response): Promise<LLMHttpError> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  const message = `${label} (${response.status}): ${sanitizeDiagnosticText(sanitizeApiError(text, 400), 400)}`;
  const err = new LLMHttpError(message, {
    status: response.status,
    retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
    providerCode: providerCodeOf(parsed),
  });
  Object.assign(err, { providerRequestId: providerRequestIdFrom(response.headers), host: safeHost(response.url) });
  return err;
}

/**
 * Parses tool-call arguments. Bad JSON returns {} and logs one rate-limited warn
 * `llm.toolcall.invalid_args` with the argument length only, never the text.
 */
export function parseToolArgumentsLogged(value: string, toolName: string, provider: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    logRepeated(
      `toolargs:${provider}:${toolName}`,
      "warn",
      { event: "llm.toolcall.invalid_args", provider, toolName, argsLength: value.length },
      "Tool call arguments were not valid JSON; substituting {}",
    );
    return {};
  }
}

/** Counts stream frames and malformed frames; report() warns once per stream when any frame was malformed. */
export class SseFrameStats {
  total = 0;
  malformed = 0;
  malformedBytes = 0;

  frame(): void {
    this.total++;
  }

  bad(bytes: number): void {
    this.malformed++;
    this.malformedBytes += bytes;
  }

  report(provider: string, model?: string): void {
    if (this.malformed === 0) return;
    logRepeated(
      `stream-malformed:${provider}:${model ?? ""}`,
      "warn",
      {
        event: "llm.stream.malformed",
        provider,
        ...(model ? { model } : {}),
        malformedFrames: this.malformed,
        totalFrames: this.total,
        malformedBytes: this.malformedBytes,
      },
      "Provider stream contained malformed frames; they were skipped",
    );
  }
}
