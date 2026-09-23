import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../lib/logger.js";
import { DATA_DIR } from "../../utils/data-dir.js";

/**
 * Pre-send cache check.
 *
 * Before a chat's main request goes to the model, the fully built prompt is compared with the last prompt that was
 * actually sent for that chat. The provider can only reuse its cache up to the first message that differs, and not at
 * all once the cache has expired. When the predicted share falls under the chat's threshold the request stops before
 * any model call and the player is asked whether to send anyway.
 *
 * The estimate is by characters, not tokens, and ignores provider breakpoints, so it is a close guide rather than the
 * provider's own number. It never blocks a request the player has acknowledged.
 */

export interface PromptFingerprint {
  at: number;
  scope: CacheGuardScope;
  /** One entry per message: hash of role and content, and content length. */
  entries: Array<{ h: string; n: number }>;
  /** Short readable label per message, used to say what changed. */
  labels: string[];
}

export type CacheGuardRequestKind = "narrator" | "tool-planner" | "tool-round" | "isolated-planner";
export type CacheGuardMode = "anthropic-ttl" | "openai-prefix";
export interface CacheGuardScope {
  provider: string;
  model: string;
  connectionId: string;
  requestKind: CacheGuardRequestKind;
}

export interface CacheGuardSettings {
  enabled: boolean;
  /** Warn when the predicted cached share is below this percentage. */
  thresholdPercent: number;
  /** A prompt older than this is treated as expired at the provider. */
  ttlMinutes: number;
}

export interface CacheHitPrediction {
  mode: CacheGuardMode;
  requestKind: CacheGuardRequestKind;
  percent: number;
  reason: "expired" | "changed";
  /** Characters the provider is expected to write to cache again. */
  uncachedChars: number;
  totalChars: number;
  minutesSinceLastSend: number;
  /** Where the prompt first differs from the last one sent, when it does. */
  firstChange: { index: number; label: string } | null;
}

export const DEFAULT_CACHE_GUARD: CacheGuardSettings = { enabled: true, thresholdPercent: 80, ttlMinutes: 60 };

/** Providers whose prompt caching this check understands. */
const CACHING_PROVIDERS = new Set(["claude_subscription", "anthropic"]);

type PromptMessage = { role: string; content?: unknown; providerMetadata?: Record<string, unknown> };

function contentText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

function labelFor(message: PromptMessage): string {
  const text = contentText(message.content);
  const tag = /<([a-z_]+)[\s>]/u.exec(text.slice(0, 400))?.[1];
  const preview = text.replace(/\s+/gu, " ").trim().slice(0, 80);
  return `${message.role}${tag ? ` <${tag}>` : ""}: ${preview}`;
}

export function fingerprintPrompt(
  messages: readonly PromptMessage[],
  at: number,
  scope: CacheGuardScope,
): PromptFingerprint {
  return {
    at,
    scope,
    entries: messages.map((message) => {
      const text = contentText(message.content);
      return { h: createHash("sha1").update(`${message.role}\0${text}`).digest("hex"), n: text.length };
    }),
    labels: messages.map(labelFor),
  };
}

export function readCacheGuardSettings(chatMetadata: Record<string, unknown>): CacheGuardSettings {
  const raw = chatMetadata.cacheSendGuard;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const number = (input: unknown, fallback: number, min: number, max: number) =>
    typeof input === "number" && Number.isFinite(input) ? Math.min(max, Math.max(min, input)) : fallback;
  return {
    enabled: value.enabled !== false,
    thresholdPercent: number(value.thresholdPercent, DEFAULT_CACHE_GUARD.thresholdPercent, 0, 100),
    ttlMinutes: number(value.ttlMinutes, DEFAULT_CACHE_GUARD.ttlMinutes, 1, 24 * 60),
  };
}

export function cacheGuardApplies(provider: string | null | undefined, messages?: readonly PromptMessage[]): boolean {
  const normalized = String(provider ?? "");
  if (CACHING_PROVIDERS.has(normalized)) return true;
  return (
    normalized === "openai_chatgpt" &&
    messages?.some((message) => message.providerMetadata?.marinaraFullLoreContext === true) === true
  );
}

export function cacheGuardMode(provider: string): CacheGuardMode {
  return provider === "openai_chatgpt" ? "openai-prefix" : "anthropic-ttl";
}

/** Predict the cached share of `current` given the last prompt sent. Null when there is nothing to compare with. */
export function predictCacheHit(
  previous: PromptFingerprint | null,
  current: PromptFingerprint,
  settings: CacheGuardSettings,
  now = Date.now(),
  mode: CacheGuardMode = cacheGuardMode(current.scope.provider),
): CacheHitPrediction | null {
  if (!previous || !previous.entries.length || !sameScope(previous.scope, current.scope)) return null;
  const totalChars = current.entries.reduce((sum, entry) => sum + entry.n, 0);
  if (totalChars === 0) return null;
  const minutesSinceLastSend = Math.max(0, Math.round((now - previous.at) / 60_000));
  if (mode === "anthropic-ttl" && now - previous.at > settings.ttlMinutes * 60_000) {
    return {
      mode,
      requestKind: current.scope.requestKind,
      percent: 0,
      reason: "expired",
      uncachedChars: totalChars,
      totalChars,
      minutesSinceLastSend,
      firstChange: null,
    };
  }
  let index = 0;
  let cachedChars = 0;
  while (
    index < previous.entries.length &&
    index < current.entries.length &&
    previous.entries[index]!.h === current.entries[index]!.h
  ) {
    cachedChars += current.entries[index]!.n;
    index += 1;
  }
  const percent = Math.floor((cachedChars / totalChars) * 100);
  return {
    mode,
    requestKind: current.scope.requestKind,
    percent,
    reason: "changed",
    uncachedChars: totalChars - cachedChars,
    totalChars,
    minutesSinceLastSend,
    firstChange: index < current.entries.length ? { index, label: current.labels[index] ?? "" } : null,
  };
}

const lastSent = new Map<string, PromptFingerprint>();
/** In-memory entries kept at most; evicted ones reload from DATA_DIR/cache-guard on the next read. */
const LAST_SENT_MAX = 200;

function rememberInMemory(key: string, fingerprint: PromptFingerprint): void {
  // Re-insert so Map order stays least-recently-used first.
  lastSent.delete(key);
  lastSent.set(key, fingerprint);
  while (lastSent.size > LAST_SENT_MAX) {
    const oldest = lastSent.keys().next().value;
    if (oldest === undefined) break;
    lastSent.delete(oldest);
  }
}

function sameScope(left: unknown, right: CacheGuardScope): boolean {
  if (!left || typeof left !== "object") return false;
  const candidate = left as Partial<CacheGuardScope>;
  return (
    candidate.provider === right.provider &&
    candidate.model === right.model &&
    candidate.connectionId === right.connectionId &&
    candidate.requestKind === right.requestKind
  );
}

function isCacheGuardScope(value: unknown): value is CacheGuardScope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CacheGuardScope>;
  return (
    typeof candidate.provider === "string" &&
    typeof candidate.model === "string" &&
    typeof candidate.connectionId === "string" &&
    (candidate.requestKind === "narrator" ||
      candidate.requestKind === "tool-planner" ||
      candidate.requestKind === "tool-round" ||
      candidate.requestKind === "isolated-planner")
  );
}

function isStoredFingerprint(value: unknown): value is PromptFingerprint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PromptFingerprint>;
  return (
    typeof candidate.at === "number" &&
    Number.isFinite(candidate.at) &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as { h?: unknown }).h === "string" &&
        typeof (entry as { n?: unknown }).n === "number" &&
        Number.isFinite((entry as { n: number }).n) &&
        (entry as { n: number }).n >= 0,
    ) &&
    Array.isArray(candidate.labels) &&
    isCacheGuardScope(candidate.scope)
  );
}

function scopeKey(scope: CacheGuardScope): string {
  return `${scope.provider}\0${scope.model}\0${scope.connectionId}\0${scope.requestKind}`;
}

function fingerprintPath(chatId: string, scope: CacheGuardScope): string {
  const suffix = createHash("sha256").update(scopeKey(scope)).digest("hex").slice(0, 20);
  return join(DATA_DIR, "cache-guard", `${encodeURIComponent(chatId)}-${suffix}.json`);
}

export async function readLastSentPrompt(chatId: string, scope: CacheGuardScope): Promise<PromptFingerprint | null> {
  const key = `${chatId}\0${scopeKey(scope)}`;
  const cached = lastSent.get(key);
  if (cached && sameScope(cached.scope, scope)) {
    rememberInMemory(key, cached);
    return cached;
  }
  try {
    const parsed = JSON.parse(await readFile(fingerprintPath(chatId, scope), "utf8")) as PromptFingerprint;
    if (isStoredFingerprint(parsed) && sameScope(parsed.scope, scope)) {
      rememberInMemory(key, parsed);
      return parsed;
    }
  } catch {
    /* no earlier send recorded */
  }
  return null;
}

/** Remember the prompt that was just sent, in memory and on disk so a restart inside the cache lifetime still knows. */
export async function recordSentPrompt(chatId: string, fingerprint: PromptFingerprint): Promise<void> {
  const key = `${chatId}\0${scopeKey(fingerprint.scope)}`;
  rememberInMemory(key, fingerprint);
  try {
    await mkdir(join(DATA_DIR, "cache-guard"), { recursive: true });
    const path = fingerprintPath(chatId, fingerprint.scope);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(fingerprint), "utf8");
    await rename(temporary, path);
  } catch (error) {
    logger.warn({ err: error, chatId }, "[cache-guard] could not save the sent prompt fingerprint");
  }
}

/** Thrown before the model call when the player has to confirm a low cache hit; the route turns it into an event. */
export class CacheGuardHold extends Error {
  constructor(readonly prediction: CacheHitPrediction & { thresholdPercent: number }) {
    super("CACHE_GUARD_HOLD");
    this.name = "CacheGuardHold";
  }
}
