// ──────────────────────────────────────────────
// LLM Provider — Registry & Factory
// ──────────────────────────────────────────────
import { OpenAIProvider } from "./providers/openai.provider.js";
import { OpenAIChatGPTProvider } from "./providers/openai-chatgpt.provider.js";
import { AnthropicProvider } from "./providers/anthropic.provider.js";
import { ClaudeSubscriptionProvider } from "./providers/claude-subscription.provider.js";
import { GrokSubscriptionProvider } from "./providers/grok-subscription.provider.js";
import { GoogleProvider } from "./providers/google.provider.js";
import type { BaseLLMProvider } from "./base-provider.js";
import { withConnectionDefaultParameters } from "./connection-default-provider.js";
import { withConnectionAdmissionProvider } from "../generation/connection-admission.js";
import { withRateLimitAwareProvider } from "./rate-limit-aware-provider.js";
import { withDiagnosticProvider } from "./diagnostic-provider.js";
import { logger } from "../../lib/logger.js";
import { sanitizeDiagnosticText } from "../../lib/diagnostics.js";

const warnedUnknownProviders = new Set<string>();

/** Warns once per unknown provider value; the connection still runs as an OpenAI-compatible custom endpoint. */
function warnUnknownProvider(provider: string, connectionId: string | undefined): void {
  const value = sanitizeDiagnosticText(String(provider), 80);
  if (warnedUnknownProviders.has(value)) return;
  if (warnedUnknownProviders.size >= 100) return;
  warnedUnknownProviders.add(value);
  logger.warn(
    { event: "llm.provider.unknown", provider: value, connectionId },
    "Unknown provider type; treating the connection as an OpenAI-compatible custom endpoint",
  );
}

export function normalizeCohereOpenAIBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const lower = trimmed.toLowerCase();

  if (lower.includes("/compatibility/v1")) return trimmed;
  if (
    lower === "https://api.cohere.com" ||
    lower === "https://api.cohere.ai" ||
    lower === "https://api.cohere.com/v1" ||
    lower === "https://api.cohere.ai/v1" ||
    lower === "https://api.cohere.com/v2" ||
    lower === "https://api.cohere.ai/v2"
  ) {
    return "https://api.cohere.ai/compatibility/v1";
  }

  return trimmed;
}

/**
 * Factory that creates the correct LLM provider for a given provider type.
 */
export function createLLMProvider(
  provider: string,
  baseUrl: string,
  apiKey: string,
  maxContext?: number | null,
  openrouterProvider?: string | null,
  maxTokensOverride?: number | null,
  /** Claude (Subscription) only. When true, asks the Agent SDK to use fast-mode routing. */
  claudeFastMode?: boolean,
  /**
   * Custom endpoints: when false, body.tools is sent to the API even when the model name is
   * not in the OpenAI catalog (suppression bypass). Mirrors the connection's treatAsLocalEndpoint flag.
   */
  treatAsLocalEndpoint?: boolean,
  /** Stored connection defaults. Custom Parameters are bound to every text request made by this provider. */
  defaultParameters?: unknown,
  /** Configured connection ID for direct foreground calls. Fallback wrappers admit their providers separately. */
  connectionId?: string,
  /**
   * When false, `connectionId` only tags diagnostic lines and the caller adds admission and
   * rate-limit wrappers itself (the connection-fallback legs do).
   */
  admitConnection = true,
): BaseLLMProvider {
  const normalizedMaxContext =
    typeof maxContext === "number" && Number.isFinite(maxContext) && maxContext > 0
      ? Math.floor(maxContext)
      : undefined;
  const normalizedMaxTokensOverride =
    typeof maxTokensOverride === "number" && Number.isFinite(maxTokensOverride) && maxTokensOverride > 0
      ? Math.floor(maxTokensOverride)
      : undefined;

  let resolved: BaseLLMProvider;
  switch (provider) {
    case "decision":
      throw new Error("Decision connections cannot generate chat or agent output.");
    case "openai":
    case "openrouter":
    case "nanogpt":
    case "xai":
    case "mistral":
    case "arli":
    case "zai":
      resolved = new OpenAIProvider(
        baseUrl,
        apiKey,
        normalizedMaxContext,
        openrouterProvider,
        normalizedMaxTokensOverride,
        provider,
      );
      break;
    case "custom":
      resolved = new OpenAIProvider(
        baseUrl,
        apiKey,
        normalizedMaxContext,
        openrouterProvider,
        normalizedMaxTokensOverride,
        "custom",
        undefined,
        !(treatAsLocalEndpoint ?? false),
      );
      break;
    case "openai_chatgpt":
      resolved = new OpenAIChatGPTProvider(
        baseUrl,
        apiKey,
        normalizedMaxContext,
        openrouterProvider,
        normalizedMaxTokensOverride,
      );
      break;
    case "cohere":
      resolved = new OpenAIProvider(
        normalizeCohereOpenAIBaseUrl(baseUrl),
        apiKey,
        normalizedMaxContext,
        openrouterProvider,
        normalizedMaxTokensOverride,
        "cohere",
      );
      break;
    case "anthropic":
      resolved = new AnthropicProvider(
        baseUrl,
        apiKey,
        normalizedMaxContext,
        openrouterProvider,
        normalizedMaxTokensOverride,
      );
      break;
    case "claude_subscription":
      resolved = new ClaudeSubscriptionProvider(
        baseUrl,
        apiKey,
        normalizedMaxContext,
        openrouterProvider,
        normalizedMaxTokensOverride,
        claudeFastMode ?? false,
      );
      break;
    case "grok_subscription":
      resolved = new GrokSubscriptionProvider(
        baseUrl,
        apiKey,
        normalizedMaxContext,
        openrouterProvider,
        normalizedMaxTokensOverride,
      );
      break;
    case "google":
      resolved = new GoogleProvider(
        baseUrl,
        apiKey,
        normalizedMaxContext,
        openrouterProvider,
        normalizedMaxTokensOverride,
      );
      break;
    case "google_vertex":
      resolved = new GoogleProvider(
        baseUrl,
        apiKey,
        normalizedMaxContext,
        openrouterProvider,
        normalizedMaxTokensOverride,
        "google_vertex",
      );
      break;
    default:
      warnUnknownProvider(provider, connectionId);
      resolved = new OpenAIProvider(
        baseUrl,
        apiKey,
        normalizedMaxContext,
        openrouterProvider,
        normalizedMaxTokensOverride,
        "custom",
        undefined,
        !(treatAsLocalEndpoint ?? false),
      );
      break;
  }
  const diagnostic = withDiagnosticProvider(resolved, provider, connectionId);
  const configured = withConnectionDefaultParameters(diagnostic, defaultParameters, connectionId);
  if (!connectionId || !admitConnection) return configured;
  // Pace + pause/resume outside the admission (concurrency) gate so a proxy 429 retries the same
  // connection before any fallback decision, and the per-connection throttle applies to everyone.
  return withRateLimitAwareProvider(withConnectionAdmissionProvider(configured, connectionId), connectionId);
}
