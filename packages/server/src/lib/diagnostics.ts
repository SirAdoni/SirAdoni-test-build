import type { DiagnosticReference } from "@marinara-engine/shared";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface DiagnosticContext {
  requestId?: string;
  operationId?: string;
  operation?: string;
  stage?: string;
  chatId?: string;
  messageId?: string;
  jobId?: string;
  provider?: string;
  model?: string;
  connectionId?: string;
  attempt?: number;
}

const contexts = new AsyncLocalStorage<DiagnosticContext>();
const references = new WeakMap<object, DiagnosticReference>();
const reported = new WeakSet<object>();
const MAX_CAUSE_LINKS = 8;
const MAX_TEXT = 2_000;
const SECRET_KEYS =
  /(?:authorization|cookie|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential|jwt|bearer|token)/i;
const SECRET_QUERY = /([?&](?:token|key|secret|password|passwd|authorization|api[_-]?key|access[_-]?token)=)[^&#\s]*/gi;

export function getDiagnosticContext(): DiagnosticContext {
  return { ...(contexts.getStore() ?? {}) };
}

export function withDiagnosticContext<T>(context: DiagnosticContext, work: () => T): T {
  return contexts.run({ ...getDiagnosticContext(), ...context }, work);
}

/**
 * Starts a fresh context store that does not inherit the caller's. Use it for
 * requests, timers, workers and package ticks, so they never carry a stale
 * requestId or stage from whatever happened to schedule them.
 */
export function runWithRootDiagnosticContext<T>(context: DiagnosticContext, work: () => T): T {
  return contexts.run({ ...context }, work);
}

/** Binds a callback to the context active now, for callbacks run later by an emitter or pool. */
export function bindCurrentDiagnosticContext<F extends (...args: any[]) => any>(fn: F): F {
  return AsyncResource.bind(fn) as F;
}

export type DiagnosticLevel = "info" | "warn" | "error";

/** Default log level for a failure of the given ME_* code. */
export function levelFor(code: string): DiagnosticLevel {
  if (code === "ME_CANCELLED") return "info";
  if (code === "ME_VALIDATION" || code === "ME_AUTH" || code === "ME_RATE_LIMIT") return "warn";
  return "error";
}

/** Records that this error object already has its one full log line, so later layers only log a debug pointer. */
export function markDiagnosticReported(error: unknown): void {
  if (error && (typeof error === "object" || typeof error === "function")) reported.add(error as object);
}

export function wasDiagnosticReported(error: unknown): boolean {
  return !!error && (typeof error === "object" || typeof error === "function") && reported.has(error as object);
}

/** True for environment variable names whose values must never be logged. */
export function isSecretEnvKey(key: string): boolean {
  return SECRET_KEYS.test(key) || /PASS|SECRET|KEY|TOKEN|CREDENTIAL|PRIVATE/i.test(key);
}

function errorName(error: unknown) {
  return error instanceof Error
    ? error.name
    : typeof error === "object" && error
      ? String((error as any).name ?? "")
      : "";
}
function statusOf(error: unknown) {
  const s = (error as any)?.statusCode ?? (error as any)?.status;
  return Number.isInteger(s) ? s : undefined;
}
function causeOf(error: unknown): unknown {
  return error && typeof error === "object" ? (error as any).cause : undefined;
}

function classify(error: unknown, explicit?: string, depth = 0): string {
  if (explicit) return explicit;
  const name = errorName(error).toLowerCase();
  const code = String((error as any)?.code ?? "").toUpperCase();
  const status = statusOf(error) ?? statusOf(causeOf(error));
  if (name.includes("abort") || name.includes("cancel") || code === "ABORT_ERR") return "ME_CANCELLED";
  if (name.includes("timeout") || code.includes("TIMEOUT") || code === "ETIMEDOUT") return "ME_TIMEOUT";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND" || name.includes("network"))
    return "ME_NETWORK";
  if (status === 401 || status === 403) return "ME_AUTH";
  if (status === 429 || code.includes("RATE")) return "ME_RATE_LIMIT";
  if (name.includes("provider") || name.includes("llmhttp")) return "ME_PROVIDER_ERROR";
  if (status !== undefined) return "ME_HTTP_ERROR";
  if (name.includes("validation") || name === "zoderror") return "ME_VALIDATION";
  if (name.includes("session") && name.includes("review")) return "ME_SESSION_REVIEW";
  if (name === "storagewriterleaseerror") return "ME_STORAGE_LEASE";
  if (
    name.includes("storage") ||
    code.startsWith("SQLITE") ||
    ["EACCES", "ENOENT", "ENOSPC", "EROFS", "EIO", "EPERM"].includes(code)
  )
    return "ME_STORAGE";
  if (name.includes("provider") || ((error as any)?.provider && !status)) return "ME_PROVIDER_ERROR";
  if (depth < 4 && causeOf(error) && causeOf(error) !== error) return classify(causeOf(error), undefined, depth + 1);
  return "ME_INTERNAL";
}

export function sanitizeDiagnosticText(text: string, limit = MAX_TEXT): string {
  let value = String(text).replace(SECRET_QUERY, "$1[REDACTED]");
  value = value.replace(/([?&][^=\s]+)=([^&#\s]*)/g, (all, key) =>
    /token|secret|key|password|auth|credential/i.test(key) ? `${key}=[REDACTED]` : all,
  );
  value = value.replace(/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, "$1[REDACTED]:[REDACTED]@");
  value = value.replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]");
  value = value.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]");
  value = value.replace(
    /(["'](?:token|secret|apiKey|api_key|accessKey|password|authorization)["']\s*:\s*["'])[^"']+(["'])/gi,
    "$1[REDACTED]$2",
  );
  value = value.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTED]");
  value = value.replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  value = value.replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=]+/gi, "[REDACTED_MEDIA]");
  value = value.replace(
    /(["']?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|cookie|set-cookie|x-admin-secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi,
    "$1[REDACTED]",
  );
  return value.length > limit ? `${value.slice(0, limit)}…[TRUNCATED]` : value;
}

const EXTRA_ERROR_KEYS = [
  "code",
  "status",
  "statusCode",
  "providerCode",
  "retryAfterMs",
  "errno",
  "syscall",
  "signal",
  "killed",
  "exitCode",
  "errorCode",
  "packageId",
  "stage",
  "operation",
  "providerRequestId",
  "host",
  "retryAttempts",
  "primaryErrorId",
  "timeoutMs",
  "attempt",
  "httpStatus",
] as const;
const PAYLOAD_KEYS =
  /^(headers?|body|query|cookies?|media|response|rawJson|images?|files?|raw|rawText|responsePreview|preview|reasoning|imagePrompt|fullResponse)$/i;

export function sanitizeDiagnosticValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  debug = false,
): unknown {
  return sanitizeInner(value, depth, seen, debug, 0);
}

function sanitizeInner(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  debug: boolean,
  causeLinks: number,
): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (typeof value === "string") return sanitizeDiagnosticText(value, debug ? 128_000 : 8_000);
  if (value === null || typeof value !== "object") return typeof value === "bigint" ? String(value) : value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (value instanceof Error) {
    const result: Record<string, unknown> = { name: value.name, message: sanitizeDiagnosticText(value.message) };
    for (const key of EXTRA_ERROR_KEYS) {
      const item = (value as any)[key];
      if (item !== undefined && (typeof item === "string" || typeof item === "number" || typeof item === "boolean"))
        result[key] = typeof item === "string" ? sanitizeDiagnosticText(item) : item;
    }
    if (value.stack) result.stack = sanitizeDiagnosticText(value.stack, 8_000);
    const aggregate = (value as AggregateError).errors;
    if (Array.isArray(aggregate))
      result.errors = aggregate.slice(0, 8).map((item) => sanitizeInner(item, depth + 1, seen, debug, 0));
    // The cause chain has its own link budget instead of the nesting depth, so
    // a wrapper of a wrapper still shows the root cause.
    if (value.cause !== undefined && value.cause !== null) {
      if (causeLinks < MAX_CAUSE_LINKS) result.cause = sanitizeInner(value.cause, 0, seen, debug, causeLinks + 1);
      else result.causeTruncated = true;
    }
    return result;
  }
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeInner(item, depth + 1, seen, debug, 0));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    // An already-serialized error (the file writer sanitizes a second time) keeps
    // the same cause-link budget as a live Error instead of the nesting depth.
    if (key === "cause" && item !== null && typeof item === "object") {
      if (causeLinks < MAX_CAUSE_LINKS) result[key] = sanitizeInner(item, 0, seen, debug, causeLinks + 1);
      else result.causeTruncated = true;
      continue;
    }
    const numericCount = /(?:tokens|tokenCount)$/i.test(key) && typeof item === "number";
    const payload = PAYLOAD_KEYS.test(key) || (!debug && /^(prompt|messages|content)$/i.test(key));
    result[key] =
      (!numericCount && SECRET_KEYS.test(key)) || payload
        ? "[REDACTED]"
        : sanitizeInner(
            typeof item === "string" && /^(url|originalUrl)$/i.test(key) ? item.split(/[?#]/, 1)[0] : item,
            depth + 1,
            seen,
            debug,
            0,
          );
  }
  return result;
}

function isObjectLike(value: unknown): value is object {
  return !!value && (typeof value === "object" || typeof value === "function");
}

/** Finds a reference already minted for a cause or an aggregated error, so one incident keeps one errorId. */
function linkedReference(error: unknown): DiagnosticReference | undefined {
  let current: unknown = error;
  for (let link = 0; link < MAX_CAUSE_LINKS; link++) {
    const next = isObjectLike(current) ? (current as any).cause : undefined;
    if (!isObjectLike(next) || next === current) break;
    const found = references.get(next);
    if (found) return found;
    current = next;
  }
  const aggregate = isObjectLike(error) ? (error as AggregateError).errors : undefined;
  if (Array.isArray(aggregate)) {
    for (const item of aggregate.slice(0, 8)) {
      if (!isObjectLike(item)) continue;
      const found = references.get(item);
      if (found) return found;
    }
  }
  return undefined;
}

export function createDiagnostic(error: unknown, context?: DiagnosticContext, code?: string): DiagnosticReference {
  const supplied = { ...getDiagnosticContext(), ...(context ?? {}) };
  if (error && (typeof error === "object" || typeof error === "function")) {
    const previous = references.get(error);
    if (previous) return previous;
  }
  const linked = linkedReference(error);
  const reference: DiagnosticReference = {
    code: classify(error, code),
    errorId: linked?.errorId ?? randomUUID(),
    ...(supplied.requestId ? { requestId: supplied.requestId } : {}),
    ...(supplied.operation ? { operation: supplied.operation } : {}),
    ...(supplied.stage ? { stage: supplied.stage } : {}),
  };
  if (error && (typeof error === "object" || typeof error === "function")) references.set(error, reference);
  return reference;
}

export function formatDiagnosticError(error: unknown, reference: DiagnosticReference): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unexpected error";
  return `${sanitizeDiagnosticText(message)} (code=${reference.code}, reference=${reference.errorId})`;
}

export function diagnosticDetails(error: unknown): unknown {
  return sanitizeDiagnosticValue(error);
}
