import { createHash } from "node:crypto";
import { generationParametersSchema } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";

import type { ChatCompletionResult, ChatMessage, ChatOptions, LLMUsage } from "./base-provider.js";
import { BaseLLMProvider } from "./base-provider.js";

const warnedInvalidConfigs = new Set<string>();

/**
 * Warns once per connection and stored value when connection defaults do not parse or fail the
 * schema. Only field names and issue paths are logged, never the stored values.
 */
function warnInvalidConfig(
  raw: unknown,
  field: string,
  issues: Array<{ path: ReadonlyArray<PropertyKey> }>,
  connectionId: string | undefined,
): void {
  let text: string;
  try {
    text = typeof raw === "string" ? raw : (JSON.stringify(raw) ?? "");
  } catch {
    text = "";
  }
  const key = createHash("sha256")
    .update(`${connectionId ?? ""}\u0000${field}\u0000${text}`)
    .digest("hex")
    .slice(0, 24);
  if (warnedInvalidConfigs.has(key)) return;
  if (warnedInvalidConfigs.size >= 500) warnedInvalidConfigs.clear();
  warnedInvalidConfigs.add(key);
  logger.warn(
    {
      event: "llm.config.invalid",
      connectionId,
      field,
      issues: issues.slice(0, 10).map((issue) => issue.path.map(String).join(".") || "(root)"),
    },
    "Connection default parameters are invalid and were ignored",
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUnsafeCustomParameterKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function cloneCustomParameterValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneCustomParameterValue);
  if (isPlainRecord(value)) return mergeCustomParameters({}, value);
  return value;
}

function mergeCustomParameters(
  base: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    if (!isUnsafeCustomParameterKey(key) && value !== undefined) merged[key] = cloneCustomParameterValue(value);
  }
  for (const [key, value] of Object.entries(next ?? {})) {
    if (isUnsafeCustomParameterKey(key) || value === undefined) continue;
    const current = merged[key];
    merged[key] =
      isPlainRecord(current) && isPlainRecord(value)
        ? mergeCustomParameters(current, value)
        : cloneCustomParameterValue(value);
  }
  return merged;
}

export function parseConnectionCustomParameters(
  defaultParameters: unknown,
  connectionId?: string,
): Record<string, unknown> {
  let parsed = defaultParameters;
  if (typeof parsed === "string") {
    if (!parsed.trim()) return {};
    try {
      parsed = JSON.parse(parsed);
    } catch {
      warnInvalidConfig(defaultParameters, "defaultParameters", [{ path: [] }], connectionId);
      return {};
    }
  }
  if (!isPlainRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, "customParameters")) return {};
  const result = generationParametersSchema.shape.customParameters.safeParse(parsed.customParameters);
  if (!result.success) {
    warnInvalidConfig(defaultParameters, "customParameters", result.error.issues, connectionId);
    return {};
  }
  return mergeCustomParameters({}, result.data);
}

class ConnectionDefaultProvider extends BaseLLMProvider {
  constructor(
    private readonly provider: BaseLLMProvider,
    private readonly defaultCustomParameters: Record<string, unknown>,
  ) {
    // This facade delegates all I/O; keep connection credentials confined to the wrapped provider.
    super("", "", provider.maxContextValue ?? undefined, null, provider.maxTokensOverrideValue);
  }

  private withDefaults(options: ChatOptions): ChatOptions {
    return {
      ...options,
      customParameters: mergeCustomParameters(this.defaultCustomParameters, options.customParameters),
    };
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
    return yield* this.provider.chat(messages, this.withDefaults(options));
  }

  override chatComplete(messages: ChatMessage[], options: ChatOptions): Promise<ChatCompletionResult> {
    return this.provider.chatComplete(messages, this.withDefaults(options));
  }

  override embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
    return this.provider.embed(texts, model, signal);
  }
}

/** Bind connection-scoped Custom Parameters to every text generation made through this provider. */
export function withConnectionDefaultParameters(
  provider: BaseLLMProvider,
  defaultParameters: unknown,
  connectionId?: string,
): BaseLLMProvider {
  let parsed = defaultParameters;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // parseConnectionCustomParameters below warns about the unparseable value once.
      parsed = null;
    }
  }
  const headers = generationParametersSchema.shape.customHeaders.safeParse(
    isPlainRecord(parsed) ? parsed.customHeaders : undefined,
  );
  if (!headers.success) warnInvalidConfig(defaultParameters, "customHeaders", headers.error.issues, connectionId);
  provider.setCustomRequestHeaders(headers.success ? (headers.data ?? {}) : {});
  const customParameters = parseConnectionCustomParameters(defaultParameters, connectionId);
  return Object.keys(customParameters).length > 0
    ? new ConnectionDefaultProvider(provider, customParameters)
    : provider;
}
