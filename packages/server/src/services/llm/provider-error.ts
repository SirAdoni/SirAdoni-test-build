import { randomUUID } from "node:crypto";
import { getLogContext } from "../../lib/log-context.js";
import { logger } from "../../lib/logger.js";
import { isFeatureEnabled } from "../features/feature-settings.js";

export interface ProviderHttpDiagnostic {
  diagnosticRef: string;
  requestId?: string;
  providerStatus: number;
  retryAfterMs?: number;
  providerRequestId?: string;
  providerCode?: string;
  providerHost?: string;
}

const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const safeRequestId = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|req_[A-Za-z0-9]{8,120})$/iu;
const safeProviderCode = /^[A-Z][A-Z0-9_]{0,63}$/u;

function safeHeader(response: Response, names: string[], allowed: RegExp): string | undefined {
  for (const name of names) {
    const value = response.headers.get(name)?.trim();
    if (value && allowed.test(value)) return value;
  }
  return undefined;
}

/** Log only bounded HTTP metadata; never inspect a provider response body or error message. */
export function recordProviderHttpFailure(
  response: Response,
  retryAfterMs?: number,
): ProviderHttpDiagnostic | undefined {
  if (!isFeatureEnabled("providerDiagnostics")) return undefined;

  const context = getLogContext();
  let providerHost: string | undefined;
  try {
    const host = new URL(response.url).hostname.toLowerCase();
    if (host && /^[a-z0-9.-]{1,253}$/u.test(host)) providerHost = host;
  } catch {
    // Synthetic responses and custom transports may not expose a URL.
  }

  const providerRequestId = safeHeader(
    response,
    ["x-request-id", "request-id", "anthropic-request-id", "x-goog-request-id"],
    safeRequestId,
  );
  const providerCode = safeHeader(
    response,
    ["x-provider-error-code", "x-error-code", "anthropic-error-type"],
    safeProviderCode,
  );

  const diagnostic: ProviderHttpDiagnostic = {
    diagnosticRef: randomUUID(),
    ...(context?.requestId && safeToken.test(context.requestId) ? { requestId: context.requestId } : {}),
    providerStatus: response.status,
    ...(typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(providerHost ? { providerHost } : {}),
  };

  logger.error(
    { ...diagnostic, operation: "llm.provider_request", stage: "http_response" },
    "LLM provider request failed",
  );
  return diagnostic;
}
