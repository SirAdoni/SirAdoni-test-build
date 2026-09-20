/**
 * Data for the pre-send prompt cache warning. The server stops a send before any model call when the prompt it built
 * would mostly have to be cached again; the player decides whether to send anyway.
 */
import { translate } from "../localization/i18n";

type CacheGuardWarningRequestKind = "narrator" | "tool-planner" | "tool-round" | "isolated-planner";

export interface CacheGuardWarning {
  mode?: "anthropic-ttl" | "openai-prefix";
  requestKind?: CacheGuardWarningRequestKind;
  percent: number;
  reason: "expired" | "changed";
  uncachedChars: number;
  totalChars: number;
  minutesSinceLastSend: number;
  firstChange: { index: number; label: string } | null;
  thresholdPercent: number;
}

export function isCacheGuardWarning(value: unknown): value is CacheGuardWarning {
  if (!value || typeof value !== "object") return false;
  const warning = value as Record<string, unknown>;
  return typeof warning.percent === "number" && (warning.reason === "expired" || warning.reason === "changed");
}

/** Rough token count from characters, matching the usual four characters per token for English prose. */
function approximateTokens(chars: number): string {
  const tokens = Math.round(chars / 4);
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

export function cacheGuardWarningMessage(warning: CacheGuardWarning): string {
  const prefixEstimate = warning.mode === "openai-prefix";
  const planner = warning.requestKind === "isolated-planner";
  const lines = [
    prefixEstimate
      ? translate(planner ? "ui.cacheGuardWarning.prefixPlannerSummary" : "ui.cacheGuardWarning.prefixSummary", {
          percent: warning.percent,
          threshold: warning.thresholdPercent,
          defaultValue: planner
            ? "Only about {{percent}}% of this planner prompt is an estimated reusable prompt prefix, not a measured cache hit (warning below {{threshold}}%)."
            : "Only about {{percent}}% of this prompt is an estimated reusable prompt prefix, not a measured cache hit (warning below {{threshold}}%).",
        })
      : translate("ui.cacheGuardWarning.anthropicSummary", {
          percent: warning.percent,
          threshold: warning.thresholdPercent,
          defaultValue:
            "Only about {{percent}}% of this prompt is expected to be cached (warning below {{threshold}}%).",
        }),
  ];
  if (warning.reason === "expired" && !prefixEstimate) {
    lines.push(
      translate("ui.cacheGuardWarning.anthropicExpired", {
        minutes: warning.minutesSinceLastSend,
        tokens: approximateTokens(warning.uncachedChars),
        defaultValue:
          "The last message was sent {{minutes}} minutes ago, so the provider cache has likely expired and about {{tokens}} tokens will be cached again.",
      }),
    );
  } else {
    lines.push(
      prefixEstimate
        ? translate("ui.cacheGuardWarning.prefixChanged", {
            tokens: approximateTokens(warning.uncachedChars),
            defaultValue: "About {{tokens}} tokens are estimated to fall outside the reusable prompt prefix.",
          })
        : translate("ui.cacheGuardWarning.anthropicChanged", {
            tokens: approximateTokens(warning.uncachedChars),
            defaultValue: "About {{tokens}} tokens will be written to cache again.",
          }),
    );
    if (warning.firstChange?.label)
      lines.push(
        translate("ui.cacheGuardWarning.firstChange", {
          label: warning.firstChange.label,
          defaultValue: "The prompt first changes at: {{label}}",
        }),
      );
  }
  lines.push(
    translate("ui.cacheGuardWarning.savedMessage", {
      defaultValue: "Your message is saved. Send it now, or cancel and send later.",
    }),
  );
  return lines.join("\n\n");
}
