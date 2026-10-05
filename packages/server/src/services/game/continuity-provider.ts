import { createHash } from "node:crypto";
import type { DB } from "../../db/connection.js";
import type { apiConnections } from "../../db/schema/index.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createConnectionsStorage } from "../storage/connections.storage.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createLLMProvider } from "../llm/provider-registry.js";
import { isRateLimitError, LLMHttpError } from "../llm/base-provider.js";
import { withConnectionFallbackProvider } from "../llm/connection-fallback-provider.js";
import { resolveBaseUrl } from "../generation/connection-base-url.js";
import { canRefreshLocalContext } from "../llm/local-context-limit.js";
import { fitMessagesToModelAccessContext, resolveModelAccessPolicy } from "../generation/model-access-policy.js";
import { runDiagnosticOperation } from "../../lib/diagnostic-operation.js";
import { createDiagnostic } from "../../lib/diagnostics.js";
import { logger, logDebugOverride } from "../../lib/logger.js";
import { isDebugAgentsEnabled } from "../../config/runtime-config.js";
import {
  normalizeContinuityTelemetryEntry,
  type GameContinuityReceiptWithTelemetry,
  type GameContinuityTelemetryEntry,
  type createGameContinuityStorage,
} from "../storage/game-continuity.storage.js";
import type {
  GameContinuityMetadata,
  GameContinuityMode,
  GameContinuityProviderSnapshot,
  GameContinuityReceipt,
} from "@marinara-engine/shared";

export const CONTINUITY_PROVIDER_LIMITED = "CONTINUITY_PROVIDER_LIMITED";
export const CONTINUITY_PROVIDER_CONFIG_VERSION = "continuity-knowledge-v16";
export type ContinuityStage = "extract" | "review" | "repair";
export const CONTINUITY_STAGES: readonly ContinuityStage[] = ["extract", "review", "repair"];

/**
 * Stable diagnostic codes for every failure thrown out of `completeContinuityStage`. The runtime
 * persists the code on the receipt (`errorCode`); the raw provider text stays in `detail`/`cause`.
 * Codes not listed here (CONTINUITY_CONFIG_CHANGED, CONTINUITY_SOURCE_CHANGED, ...) pass through
 * unchanged because the runtime compares them by exact value.
 */
export const CONTINUITY_ERROR_CODES = {
  /** The stage exceeded its timeout (transient; the runtime retries without spending an attempt). */
  TIMEOUT: "CONTINUITY_TIMEOUT",
  /** HTTP 429/529 or a Retry-After throttle: the whole runtime backs off. */
  PROVIDER_LIMITED: CONTINUITY_PROVIDER_LIMITED,
  /**
   * HTTP 401, or a 403/prose with explicit credential wording. A connection-level fault, not the batch's:
   * the runtime parks that chat's continuity work (without spending attempts) instead of failing every receipt.
   */
  PROVIDER_AUTH: "CONTINUITY_PROVIDER_AUTH",
  /** Refused locally by the global hourly cap on automatic model calls; no request was sent. */
  BACKGROUND_BUDGET: "CONTINUITY_BACKGROUND_BUDGET",
  /** Network failure, undici termination, or a 5xx/408 response. */
  PROVIDER_UNAVAILABLE: "CONTINUITY_PROVIDER_UNAVAILABLE",
  /** The provider answered but not with one complete JSON object. */
  INVALID_JSON: "CONTINUITY_INVALID_JSON",
  /** Schema or source-grounding validation rejected a model result. */
  INVALID: "CONTINUITY_INVALID",
  /** The prompt does not fit the model context (local fit check or provider rejection). */
  CONTEXT_OVERFLOW: "CONTINUITY_CONTEXT_OVERFLOW",
  /** The caller's abort signal fired (runtime stop); not the batch's fault. */
  ABORTED: "CONTINUITY_ABORTED",
  /** Any other failure; the raw message is kept in `detail`. */
  STAGE_FAILED: "CONTINUITY_STAGE_FAILED",
} as const;
export type ContinuityErrorCode = (typeof CONTINUITY_ERROR_CODES)[keyof typeof CONTINUITY_ERROR_CODES] | string;
const CODE_PATTERN = /^CONTINUITY_[A-Z_]+$/u;
/**
 * Stage failures the runtime handles without spending the batch's attempt or that end the batch as
 * stale (provider pauses, runtime stop, a changed configuration or source). They log one warn line
 * without the stack; the runtime writes the batch's own job.state line.
 */
const TRANSIENT_STAGE_CODES: ReadonlySet<string> = new Set([
  "CONTINUITY_TIMEOUT",
  "CONTINUITY_PROVIDER_UNAVAILABLE",
  "CONTINUITY_CONNECTION_UNAVAILABLE",
  "CONTINUITY_PROVIDER_LIMITED",
  "CONTINUITY_ABORTED",
  "CONTINUITY_CONFIG_CHANGED",
  "CONTINUITY_SOURCE_CHANGED",
  "CONTINUITY_CONTEXT_CHANGED",
]);
const TRANSIENT_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set(["ME_TIMEOUT", "ME_NETWORK", "ME_RATE_LIMIT"]);
/** True when a stage failure is an expected, handled provider or runtime condition rather than a defect. */
export function isTransientContinuityStageError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && TRANSIENT_STAGE_CODES.has(code)) return true;
  return TRANSIENT_DIAGNOSTIC_CODES.has(createDiagnostic(error).code);
}
const CODE_PREFIX_PATTERN = /^(CONTINUITY_[A-Z_]+)\s*[:\s]\s*([\s\S]*)$/u;
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/iu,
  /context[_ ]length[_ ]exceeded/iu,
  /maximum context length/iu,
  /exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context/iu,
  /input length and `?max_tokens`? exceed/iu,
  /too many (?:input )?tokens/iu,
  /reduce the length of the messages/iu,
  /context window/iu,
  /request too large/iu,
];
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
const NETWORK_MESSAGE_PATTERN =
  /fetch failed|socket hang up|other side closed|network|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|headers timeout|body timeout|premature close/iu;
const ABORT_MESSAGE_PATTERN = /^terminated$|operation was aborted|aborted/iu;

export class ContinuityError extends Error {
  readonly code: ContinuityErrorCode;
  /** Raw message of the underlying failure when it differs from the code. */
  readonly detail?: string;
  telemetry?: GameContinuityTelemetryEntry;
  constructor(
    code: ContinuityErrorCode,
    options: { detail?: string; cause?: unknown; telemetry?: GameContinuityTelemetryEntry } = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ContinuityError";
    this.code = code;
    if (options.detail && options.detail !== code) this.detail = options.detail;
    if (options.telemetry) this.telemetry = options.telemetry;
  }
}

function errorRecord(error: unknown): Record<string, unknown> {
  return error && typeof error === "object" ? (error as Record<string, unknown>) : {};
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const record = errorRecord(error);
  return typeof record.message === "string" ? record.message : String(error);
}

function* causeChain(error: unknown): Generator<unknown> {
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    yield current;
    current = errorRecord(current).cause;
  }
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function isNetworkFailure(error: unknown): boolean {
  for (const item of causeChain(error)) {
    const record = errorRecord(item);
    const code = typeof record.code === "string" ? record.code : "";
    if (NETWORK_CODES.has(code) || code.startsWith("UND_ERR")) return true;
    if (NETWORK_MESSAGE_PATTERN.test(messageOf(item))) return true;
  }
  return false;
}

function isAbortLike(error: unknown): boolean {
  for (const item of causeChain(error)) {
    const record = errorRecord(item);
    if (record.name === "AbortError" || record.code === "ABORT_ERR") return true;
    if (ABORT_MESSAGE_PATTERN.test(messageOf(item))) return true;
  }
  return false;
}

function isContextOverflow(error: unknown): boolean {
  for (const item of causeChain(error)) {
    if (item instanceof LLMHttpError && item.status === 413) return true;
    if (matchesAny(CONTEXT_OVERFLOW_PATTERNS, messageOf(item))) return true;
  }
  return false;
}

/**
 * Map any failure to a `ContinuityError` whose `message` equals a stable code from
 * `CONTINUITY_ERROR_CODES` (or an existing exact `CONTINUITY_*` code). `hints.timedOut` wins over
 * every other classification because the provider surfaces a stage timeout as a generic abort;
 * `hints.aborted` distinguishes a runtime stop from a provider-side termination.
 */
/**
 * Throttling wording that reaches us as prose rather than a typed HTTP status.
 * Deliberately narrow: "limit" alone would swallow context-length errors, which must not pause.
 */
const RATE_LIMIT_TEXT_PATTERN =
  /\b(rate[ _-]?limit|session limit|usage limit|quota (?:exceeded|exhausted)|too many requests|resets? (?:at|in))\b/iu;

/** Credential rejections that reach us as prose rather than a typed 401. Narrow on purpose. */
// Gemini answers a bad key with HTTP 400 "API key not valid" and reason API_KEY_INVALID.
const AUTH_TEXT_PATTERN =
  /\b(invalid[ _-]?api[ _-]?key|incorrect api key|authentication[_ ]error|permission[_ ]error|invalid[ _-]?x-api-key|api key (?:is )?(?:invalid|revoked|expired|disabled)|api[ _-]?key[ _-]?(?:not[ _-]?valid|invalid)|invalid (?:credentials|token)|unauthori[sz]ed)\b/iu;
/**
 * A 403 that blames the request, not the key: OpenRouter answers 403 when a moderated model flags
 * the input. That is the batch's own fault and must spend attempts like any other 4xx.
 */
const REQUEST_FAULT_TEXT_PATTERN = /\b(moderation|flagged|content[ _-]?(?:policy|filter)|safety)\b/iu;

/**
 * 401 is always a credential rejection. 403 means "forbidden" for many reasons (moderation, region,
 * model access), so it counts as a credential failure only when the text says so.
 */
function isAuthFailure(error: unknown): boolean {
  for (const item of causeChain(error)) {
    const providerCode =
      item instanceof LLMHttpError ? (item as LLMHttpError & { providerCode?: unknown }).providerCode : "";
    const text = [messageOf(item), typeof providerCode === "string" ? providerCode : ""].join(" ");
    if (REQUEST_FAULT_TEXT_PATTERN.test(text)) return false;
    if (item instanceof LLMHttpError && item.status === 401) return true;
    if (AUTH_TEXT_PATTERN.test(text)) return true;
  }
  return false;
}

export function normalizeContinuityError(
  error: unknown,
  hints: { timedOut?: boolean; aborted?: boolean; telemetry?: GameContinuityTelemetryEntry } = {},
): ContinuityError {
  if (error instanceof ContinuityError) {
    if (hints.telemetry && !error.telemetry) error.telemetry = hints.telemetry;
    return error;
  }
  const message = messageOf(error);
  const wrap = (code: ContinuityErrorCode, detail: string = message) =>
    new ContinuityError(code, { detail, cause: error, telemetry: hints.telemetry });
  if (hints.timedOut) return wrap(CONTINUITY_ERROR_CODES.TIMEOUT);
  if (CODE_PATTERN.test(message)) return wrap(message);
  const prefixed = CODE_PREFIX_PATTERN.exec(message);
  if (prefixed) return wrap(prefixed[1]!, message);
  // Subscription providers can answer 200 with a throttling payload, so the typed 429 check alone
  // misses them. A quota refusal must pause the runtime, never spend a batch's attempts: an overnight
  // archive index once burned three attempts on every receipt against an exhausted session limit.
  if (isRateLimitError(error) || RATE_LIMIT_TEXT_PATTERN.test(message))
    return wrap(CONTINUITY_ERROR_CODES.PROVIDER_LIMITED);
  // Checked after the throttle test (some gateways send 403 with quota wording) and before the
  // generic 4xx fallback, which would otherwise spend three paid attempts on every receipt.
  if (isAuthFailure(error)) return wrap(CONTINUITY_ERROR_CODES.PROVIDER_AUTH);
  if (isContextOverflow(error)) return wrap(CONTINUITY_ERROR_CODES.CONTEXT_OVERFLOW);
  if (hints.aborted) return wrap(CONTINUITY_ERROR_CODES.ABORTED);
  if (error instanceof SyntaxError) return wrap(CONTINUITY_ERROR_CODES.INVALID_JSON);
  if (error instanceof LLMHttpError) {
    if (error.status >= 500 || error.status === 408) return wrap(CONTINUITY_ERROR_CODES.PROVIDER_UNAVAILABLE);
    return wrap(CONTINUITY_ERROR_CODES.STAGE_FAILED);
  }
  // An abort nobody asked for (undici "terminated", a dispatcher timeout) is a dropped connection.
  if (isNetworkFailure(error) || isAbortLike(error)) return wrap(CONTINUITY_ERROR_CODES.PROVIDER_UNAVAILABLE);
  return wrap(CONTINUITY_ERROR_CODES.STAGE_FAILED);
}

/** Default per-stage provider timeouts; extraction carries the largest prompt and answer. */
export const DEFAULT_CONTINUITY_STAGE_TIMEOUT_MS: Readonly<Record<ContinuityStage, number>> = {
  extract: 600_000,
  review: 300_000,
  repair: 300_000,
};

/** Node fires any longer timer after 1 ms, so a huge "no timeout" value would abort every call at once. */
const MAX_CONTINUITY_STAGE_TIMEOUT_MS = 2_147_483_647;

function timeoutValue(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value.trim()) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0
    ? Math.min(Math.floor(number), MAX_CONTINUITY_STAGE_TIMEOUT_MS)
    : undefined;
}

/**
 * Timeout precedence (highest first): chat metadata `gameContinuity.stageTimeoutMs.<stage>`,
 * metadata `stageTimeoutMs` as one number, env `CONTINUITY_<STAGE>_TIMEOUT_MS`,
 * env `CONTINUITY_STAGE_TIMEOUT_MS`, then the per-stage default. Invalid values are ignored.
 */
export function resolveContinuityStageTimeoutMs(
  stage: ContinuityStage,
  metadataValue: unknown,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const perStage =
    metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)
      ? timeoutValue((metadataValue as Record<string, unknown>)[stage])
      : undefined;
  return (
    perStage ??
    timeoutValue(metadataValue) ??
    timeoutValue(env[`CONTINUITY_${stage.toUpperCase()}_TIMEOUT_MS`]) ??
    timeoutValue(env.CONTINUITY_STAGE_TIMEOUT_MS) ??
    DEFAULT_CONTINUITY_STAGE_TIMEOUT_MS[stage]
  );
}

function stageTimeouts(metadataValue: unknown): Record<ContinuityStage, number> {
  return {
    extract: resolveContinuityStageTimeoutMs("extract", metadataValue),
    review: resolveContinuityStageTimeoutMs("review", metadataValue),
    repair: resolveContinuityStageTimeoutMs("repair", metadataValue),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mode(value: unknown): GameContinuityMode {
  return value === "active" || value === "shadow" ? value : "off";
}

type ConnectionRow = typeof apiConnections.$inferSelect & { apiKey?: string };

function snapshot(connection: ConnectionRow, fallback: ConnectionRow | null): GameContinuityProviderSnapshot {
  return {
    connectionId: connection.id,
    provider: connection.provider,
    model: connection.model,
    maxContext:
      Number.isInteger(connection.maxContext) && connection.maxContext > 0 ? connection.maxContext : undefined,
    parametersHash: digest({
      primary: {
        defaultParameters: connection.defaultParameters ?? null,
        baseUrl: connection.baseUrl ?? null,
        maxTokensOverride: connection.maxTokensOverride ?? null,
        openrouterProvider: connection.openrouterProvider ?? null,
        claudeFastMode: connection.claudeFastMode ?? null,
        treatAsLocalEndpoint: connection.treatAsLocalEndpoint ?? null,
        enableCaching: connection.enableCaching ?? null,
        anthropicExtendedCacheTtl: connection.anthropicExtendedCacheTtl ?? null,
        cachingAtDepth: connection.cachingAtDepth ?? null,
      },
      fallback: fallback
        ? {
            id: fallback.id,
            provider: fallback.provider,
            model: fallback.model,
            maxContext: fallback.maxContext ?? null,
            defaultParameters: fallback.defaultParameters ?? null,
            baseUrl: fallback.baseUrl ?? null,
            maxTokensOverride: fallback.maxTokensOverride ?? null,
            openrouterProvider: fallback.openrouterProvider ?? null,
            claudeFastMode: fallback.claudeFastMode ?? null,
            treatAsLocalEndpoint: fallback.treatAsLocalEndpoint ?? null,
            enableCaching: fallback.enableCaching ?? null,
            anthropicExtendedCacheTtl: fallback.anthropicExtendedCacheTtl ?? null,
            cachingAtDepth: fallback.cachingAtDepth ?? null,
          }
        : null,
    }),
  };
}

function canonicalConfig(
  extractor: GameContinuityProviderSnapshot,
  verifier: GameContinuityProviderSnapshot,
  metadata: Record<string, unknown>,
  playerCharacter?: { id: string; name: string },
): GameContinuityReceipt["config"] {
  return {
    extractorConnectionId: extractor.connectionId,
    verifierConnectionId: verifier.connectionId,
    extractionInstructions:
      typeof metadata.extractionInstructions === "string" ? metadata.extractionInstructions : undefined,
    verificationInstructions:
      typeof metadata.verificationInstructions === "string" ? metadata.verificationInstructions : undefined,
    extractor,
    verifier,
    ...(playerCharacter ? { playerCharacter } : {}),
  };
}

export async function readContinuityConfig(
  db: DB,
  chatId: string,
  options: { allowHistoricalBackfill?: boolean } = {},
): Promise<{
  mode: GameContinuityMode;
  activationMessageId?: string;
  activationAt?: string;
  frozen: GameContinuityReceipt["config"];
  hash: string;
  /** Effective per-stage timeouts; read live, deliberately outside `frozen` and `hash`. */
  stageTimeoutMs: Record<ContinuityStage, number>;
}> {
  const chats = createChatsStorage(db);
  const connections = createConnectionsStorage(db);
  const characters = createCharactersStorage(db);
  const chat = await chats.getById(chatId);
  if (!chat) throw new Error("CONTINUITY_CHAT_NOT_FOUND");
  const metadata = objectValue(chat.metadata).gameContinuity;
  const config = objectValue(metadata) as GameContinuityMetadata & Record<string, unknown>;
  const selectedMode = mode(config.mode);
  const timeouts = stageTimeouts(config.stageTimeoutMs);
  if (selectedMode === "off" && !options.allowHistoricalBackfill)
    return {
      mode: "off",
      frozen: {},
      hash: digest({ version: CONTINUITY_PROVIDER_CONFIG_VERSION, frozen: {} }),
      stageTimeoutMs: timeouts,
    };
  const extractorId =
    typeof config.extractorConnectionId === "string" && config.extractorConnectionId
      ? config.extractorConnectionId
      : chat.connectionId;
  const verifierId =
    typeof config.verifierConnectionId === "string" && config.verifierConnectionId
      ? config.verifierConnectionId
      : chat.connectionId;
  if (!extractorId || !verifierId) throw new Error("CONTINUITY_CONNECTION_UNAVAILABLE");
  const [extractorConnection, verifierConnection, fallback] = await Promise.all([
    connections.getWithKey(extractorId),
    connections.getWithKey(verifierId),
    connections.getFallbackForAgents(),
  ]);
  if (!extractorConnection?.model || !verifierConnection?.model) throw new Error("CONTINUITY_CONNECTION_UNAVAILABLE");
  const setup = objectValue(objectValue(chat.metadata).gameSetupConfig);
  const playerPersonaId = chat.personaId || (typeof setup.personaId === "string" ? setup.personaId : null);
  const playerPersona = playerPersonaId ? await characters.getPersona(playerPersonaId) : null;
  const playerCharacter =
    playerPersona &&
    typeof playerPersona.id === "string" &&
    typeof playerPersona.name === "string" &&
    playerPersona.name.trim()
      ? { id: playerPersona.id, name: playerPersona.name.trim() }
      : undefined;
  const frozen = canonicalConfig(
    snapshot(extractorConnection, fallback),
    snapshot(verifierConnection, fallback),
    config,
    playerCharacter,
  );
  return {
    mode: mode(config.mode),
    ...(typeof config.activationMessageId === "string" ? { activationMessageId: config.activationMessageId } : {}),
    ...(typeof config.activationAt === "string" ? { activationAt: config.activationAt } : {}),
    frozen,
    hash: digest({ version: CONTINUITY_PROVIDER_CONFIG_VERSION, frozen }),
    stageTimeoutMs: timeouts,
  };
}

/**
 * Providers without a JSON response mode (Claude subscription/API) may wrap the object in a code fence
 * or a sentence. Accept exactly one complete top-level JSON object; never repair malformed JSON, so
 * strict schema validation still sees exactly what the model produced.
 */
export function parseContinuityJson(content: string): unknown {
  const text = content.trim();
  const attempt = (candidate: string): unknown => {
    const parsed: unknown = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  };
  try {
    return attempt(text);
  } catch {
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(text);
    if (fenced) {
      try {
        return attempt(fenced[1]!.trim());
      } catch (error) {
        throw new Error("CONTINUITY_INVALID_JSON", { cause: error });
      }
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start && text.indexOf("{", end) < 0) {
      try {
        return attempt(text.slice(start, end + 1));
      } catch (error) {
        throw new Error("CONTINUITY_INVALID_JSON", { cause: error });
      }
    }
    throw new Error("CONTINUITY_INVALID_JSON");
  }
}

function stageSnapshot(receipt: GameContinuityReceipt, stage: ContinuityStage): GameContinuityProviderSnapshot {
  const key = stage === "extract" || stage === "repair" ? "extractor" : "verifier";
  const snapshot = receipt.config[key];
  if (!snapshot?.connectionId || !snapshot.model || !snapshot.provider)
    throw new Error("CONTINUITY_PROVIDER_SNAPSHOT_MISSING");
  return snapshot;
}

/**
 * Whether a stage's model call books the global hourly cap on automatic calls. The cap exists to stop a
 * storm of paid calls, so a stage whose frozen connection is a local inference server (a local base URL or
 * the connection's "treat as local endpoint" flag) is exempt, unless the agents fallback it can switch to
 * is a remote one. Anything unreadable books the cap, the safe side.
 */
export async function continuityStageBooksBudget(
  db: DB,
  receipt: GameContinuityReceipt,
  stage: ContinuityStage,
): Promise<boolean> {
  try {
    const frozen = stageSnapshot(receipt, stage);
    const connections = createConnectionsStorage(db);
    const primary = frozen.connectionId ? await connections.getById(frozen.connectionId) : null;
    if (!primary) return true;
    const isLocal = (connection: ConnectionRow): boolean =>
      canRefreshLocalContext({
        provider: connection.provider,
        baseUrl: resolveBaseUrl(connection),
        treatAsLocalEndpoint: connection.treatAsLocalEndpoint,
      });
    if (!isLocal(primary)) return true;
    const fallback = await connections.getFallbackForAgents();
    return Boolean(fallback && fallback.id !== primary.id && !isLocal(fallback));
  } catch {
    return true;
  }
}

const STAGE_TELEMETRY = Symbol.for("marinara.continuity.stageTelemetry");

/** Telemetry attached to a stage result returned by `completeContinuityStage`, if any. */
export function readContinuityStageTelemetry(result: unknown): GameContinuityTelemetryEntry | undefined {
  if (!result || typeof result !== "object") return undefined;
  const entry = (result as Record<symbol, unknown>)[STAGE_TELEMETRY];
  return normalizeContinuityTelemetryEntry(entry) ?? undefined;
}

/**
 * Append one telemetry entry to a receipt. Storage keeps the list append-only, so a later
 * checkpoint written from an older in-memory receipt cannot drop it. Published receipts are
 * immutable; recording against one is a no-op that returns false.
 */
export async function recordContinuityTelemetry(
  storage: Pick<ReturnType<typeof createGameContinuityStorage>, "get" | "save">,
  receiptId: string,
  entry: GameContinuityTelemetryEntry | undefined,
): Promise<boolean> {
  const normalized = normalizeContinuityTelemetryEntry(entry);
  if (!normalized) return false;
  const receipt = (await storage.get(receiptId)) as GameContinuityReceiptWithTelemetry | null;
  if (!receipt || receipt.status === "published") return false;
  await storage.save({ ...receipt, telemetry: [...(receipt.telemetry ?? []), normalized] } as GameContinuityReceipt);
  return true;
}

function usageOf(
  usage: { promptTokens?: number; completionTokens?: number; cachedPromptTokens?: number } | undefined,
): GameContinuityTelemetryEntry["usage"] {
  if (!usage) return null;
  return {
    ...(typeof usage.promptTokens === "number" ? { inputTokens: usage.promptTokens } : {}),
    ...(typeof usage.completionTokens === "number" ? { outputTokens: usage.completionTokens } : {}),
    ...(typeof usage.cachedPromptTokens === "number" ? { cacheReadTokens: usage.cachedPromptTokens } : {}),
  };
}

/**
 * Run one provider stage. The parsed JSON object is returned unchanged for existing callers; its
 * telemetry rides along on a symbol key (see `readContinuityStageTelemetry`) and on
 * `ContinuityError.telemetry` when the stage fails.
 */
/**
 * Output budget per stage. The reviewer fills a checklist entry for every proposed record before its findings, so a
 * grouped archive batch of thirty records does not fit the 4,000 tokens that were enough before the checklist.
 */
// Reasoning models spend part of this on thinking; 8000 cut extractions off mid-JSON (CONTINUITY_PROVIDER_FINISH_length,
// 8 of 16 stage failures in one night), wasting the whole paid call.
const CONTINUITY_STAGE_MAX_TOKENS: Record<ContinuityStage, number> = { extract: 16000, review: 20000, repair: 16000 };

export async function completeContinuityStage(
  db: DB,
  receipt: GameContinuityReceipt,
  stage: ContinuityStage,
  prompt: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const detailed = await completeContinuityStageDetailed(db, receipt, stage, prompt, signal);
  Object.defineProperty(detailed.content, STAGE_TELEMETRY, { value: detailed.telemetry, enumerable: false });
  return detailed.content;
}

export async function completeContinuityStageDetailed(
  db: DB,
  receipt: GameContinuityReceipt,
  stage: ContinuityStage,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ content: Record<string, unknown>; telemetry: GameContinuityTelemetryEntry }> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let providerStartedAt: number | undefined;
  let providerMs: number | undefined;
  let usage: GameContinuityTelemetryEntry["usage"];
  let timedOut = false;
  const telemetry = (): GameContinuityTelemetryEntry => ({
    stage,
    startedAt,
    elapsedMs: Date.now() - startedAtMs,
    ...(providerMs === undefined
      ? providerStartedAt === undefined
        ? {}
        : { providerMs: Date.now() - providerStartedAt }
      : { providerMs }),
    ...(usage === undefined ? {} : { usage }),
    attempt: receipt.attempts,
  });
  const abortedError = () => {
    const reason = signal?.reason;
    return reason instanceof Error && CODE_PATTERN.test(reason.message)
      ? normalizeContinuityError(reason, { aborted: true })
      : new ContinuityError(CONTINUITY_ERROR_CODES.ABORTED, {
          detail: reason === undefined ? undefined : messageOf(reason),
          cause: reason,
        });
  };
  return runDiagnosticOperation(
    { operation: "game.continuity", stage, chatId: receipt.chatId, jobId: receipt.id },
    async () => {
      try {
        const content = await runStage();
        return { content, telemetry: telemetry() };
      } catch (error) {
        throw normalizeContinuityError(error, { timedOut, aborted: signal?.aborted === true, telemetry: telemetry() });
      }
    },
    { isTransient: isTransientContinuityStageError },
  );

  async function runStage(): Promise<Record<string, unknown>> {
    const current = await readContinuityConfig(db, receipt.chatId, {
      allowHistoricalBackfill: receipt.config.historicalBackfill !== undefined,
    });
    if (current.hash !== receipt.configHash) throw new Error("CONTINUITY_CONFIG_CHANGED");
    if (signal?.aborted) throw abortedError();
    const frozen = stageSnapshot(receipt, stage);
    if (!frozen.connectionId || !frozen.model || !frozen.provider)
      throw new Error("CONTINUITY_PROVIDER_SNAPSHOT_MISSING");
    const currentSnapshot = current.frozen[stage === "review" ? "verifier" : "extractor"];
    if (
      !currentSnapshot ||
      currentSnapshot.connectionId !== frozen.connectionId ||
      currentSnapshot.model !== frozen.model ||
      currentSnapshot.provider !== frozen.provider ||
      currentSnapshot.parametersHash !== frozen.parametersHash
    ) {
      throw new Error("CONTINUITY_CONFIG_CHANGED");
    }
    const connections = createConnectionsStorage(db);
    const primary = await connections.getWithKey(frozen.connectionId);
    if (!primary || primary.model !== frozen.model || primary.provider !== frozen.provider)
      throw new Error("CONTINUITY_CONFIG_CHANGED");
    const fallback = await connections.getFallbackForAgents();
    const fallbackBaseUrl = fallback ? resolveBaseUrl(fallback) : "";
    const provider = withConnectionFallbackProvider({
      primary: createLLMProvider(
        primary.provider,
        resolveBaseUrl(primary),
        primary.apiKey,
        primary.maxContext,
        primary.openrouterProvider,
        primary.maxTokensOverride,
        primary.claudeFastMode === "true",
        primary.treatAsLocalEndpoint === "true",
        primary.defaultParameters,
        primary.id,
      ),
      primaryConnectionId: primary.id,
      fallbackConnection: fallback,
      fallbackBaseUrl,
      category: "agents",
      // The usual primary pick is routine (debug); only a fallback switch is worth an info line.
      onProviderUsed: (origin) =>
        logger[origin.kind === "fallback" ? "info" : "debug"](
          {
            operation: "game.continuity",
            stage,
            jobId: receipt.id,
            chatId: receipt.chatId,
            connectionId: origin.kind === "fallback" ? fallback?.id : primary.id,
            provider: origin.kind === "fallback" ? origin.provider : primary.provider,
            model: origin.kind === "fallback" ? origin.model : primary.model,
            fallback: origin.kind === "fallback",
          },
          "Continuity provider selected",
        ),
    });
    const policy = resolveModelAccessPolicy({
      provider: primary.provider,
      model: frozen.model,
      maxContext: frozen.maxContext,
    });
    const fit = fitMessagesToModelAccessContext({
      messages: [{ role: "system", content: prompt }],
      policy,
      maxTokens: CONTINUITY_STAGE_MAX_TOKENS[stage],
    });
    if (fit.trimmed) throw new Error("CONTINUITY_CONTEXT_OVERFLOW");
    const chat = await createChatsStorage(db).getById(receipt.chatId);
    const debug =
      objectValue(chat?.metadata).debugMode === true ||
      objectValue(chat?.metadata).debugAgents === true ||
      isDebugAgentsEnabled();
    logDebugOverride(debug, "[debug/game/continuity/%s] prompt:\n%s", stage, prompt);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = current.stageTimeoutMs[stage];
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new ContinuityError(CONTINUITY_ERROR_CODES.TIMEOUT, { detail: `${stage} exceeded ${timeoutMs} ms` }),
      );
    }, timeoutMs);
    // A stage that times out while the connection is rate limited is a provider quota problem, not a
    // slow or broken batch; the runtime backs off instead of spending one of the batch's attempts.
    let rateLimited = false;
    let succeeded = false;
    providerStartedAt = Date.now();
    try {
      const result = await provider
        .chatComplete([{ role: "system", content: prompt }], {
          model: frozen.model,
          maxTokens: CONTINUITY_STAGE_MAX_TOKENS[stage],
          stream: false,
          signal: controller.signal,
          responseFormat: { type: "json_object" },
          debugMode: debug,
          onRateLimitPause: (info) => {
            if (info.reason === "rate_limit") rateLimited = true;
          },
        })
        .catch((error: unknown) => {
          if (isRateLimitError(error) || (rateLimited && !signal?.aborted))
            throw new ContinuityError(CONTINUITY_PROVIDER_LIMITED, { detail: messageOf(error), cause: error });
          if (timedOut)
            throw new ContinuityError(CONTINUITY_ERROR_CODES.TIMEOUT, { detail: messageOf(error), cause: error });
          if (signal?.aborted) throw abortedError();
          throw error;
        })
        .finally(() => {
          providerMs = Date.now() - providerStartedAt!;
        });
      usage = usageOf(result.usage);
      if (signal?.aborted) throw abortedError();
      if (result.finishReason !== "stop")
        throw new Error(`CONTINUITY_PROVIDER_FINISH_${result.finishReason || "UNKNOWN"}`);
      if (!result.content?.trim()) throw new Error("CONTINUITY_EMPTY_RESPONSE");
      const parsed = parseContinuityJson(result.content) as Record<string, unknown>;
      succeeded = true;
      return parsed;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // One line per stage call; a failure's details are logged once by runDiagnosticOperation.
      logger.debug(
        {
          event: "continuity.stage",
          outcome: succeeded ? "ok" : "failed",
          stage,
          chatId: receipt.chatId,
          jobId: receipt.id,
          elapsedMs: Date.now() - startedAtMs,
          providerMs,
          timeoutMs,
          ...(usage === undefined ? {} : { usage }),
        },
        "[game-continuity] stage %s",
        succeeded ? "completed" : "failed",
      );
    }
  }
}
