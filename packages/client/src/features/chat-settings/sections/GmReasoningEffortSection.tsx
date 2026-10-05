import type { CSSProperties } from "react";
import { Brain } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getCachedFeatureEnabled, useFeatureEnabled } from "../../../hooks/use-feature-settings";
import {
  gameGmReasoningEffortOptions,
  normalizeGameGmReasoningEffort,
  resolveGameGmReasoningEffort,
  type GameGmReasoningEffort,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { ChatSettingsSection } from "../ChatSettingsSection";
import { GM_REASONING_EFFORT_LABEL_KEYS } from "../../../lib/gm-reasoning-effort";

interface GmReasoningEffortSectionProps {
  style?: CSSProperties;
  value: unknown;
  connection: { id?: string | null; provider?: string | null; model?: string | null } | null | undefined;
  onChange: (value: GameGmReasoningEffort) => void;
}

export function GmReasoningEffortSection({ style, value, connection, onChange }: GmReasoningEffortSectionProps) {
  const { t: localizeUi } = useUiTranslation();
  const enabled = useFeatureEnabled("gmNarrationReasoning");
  const queryClient = useQueryClient();
  const selected = normalizeGameGmReasoningEffort(value);
  const options = connection?.provider
    ? gameGmReasoningEffortOptions({
        provider: connection.provider,
        model: connection.model ?? null,
        selected,
      })
    : gameGmReasoningEffortOptions({ selected });
  // Preserve the saved choice even when the static provider/model mapping sends a lower level.
  const shown = options.includes(selected) ? options : [...options, selected];
  const resolved = resolveGameGmReasoningEffort({
    provider: connection?.provider,
    model: connection?.model,
    setting: selected,
  });
  const isMapped = selected !== "default" && resolved !== undefined && resolved !== null && resolved !== selected;
  const hasNoEffortControl = options.length === 1 && selected !== "default";

  if (!enabled) return null;
  return (
    <ChatSettingsSection
      id="game-gm-reasoning-effort"
      style={style}
      label={localizeUi("ui.chatSettings.gmReasoningEffort.title")}
      icon={<Brain size="0.875rem" />}
      help={localizeUi("ui.chatSettings.gmReasoningEffort.help")}
    >
      <div className="space-y-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
            {localizeUi("ui.chatSettings.gmReasoningEffort.label")}
          </span>
          <select
            value={selected}
            onChange={(event) => {
              if (getCachedFeatureEnabled(queryClient, "gmNarrationReasoning")) {
                onChange(normalizeGameGmReasoningEffort(event.target.value));
              }
            }}
            data-gm-reasoning-effort-select="true"
            className="mari-preset-native-select min-h-11 w-full truncate rounded-lg bg-[var(--secondary)] px-3 py-2 pr-8 text-xs text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] transition-shadow focus:ring-[var(--primary)]/40 sm:min-h-0"
          >
            {shown.map((option) => (
              <option key={option} value={option}>
                {localizeUi(GM_REASONING_EFFORT_LABEL_KEYS[option])}
              </option>
            ))}
          </select>
        </label>
        {isMapped && (
          <p className="text-[0.575rem] leading-relaxed text-[var(--muted-foreground)]">
            {localizeUi("ui.chatSettings.gmReasoningEffort.clamped", {
              effort: localizeUi(GM_REASONING_EFFORT_LABEL_KEYS[resolved ?? "default"]),
            })}
          </p>
        )}
        {hasNoEffortControl && (
          <p className="text-[0.575rem] leading-relaxed text-[var(--muted-foreground)]">
            {localizeUi("ui.chatSettings.gmReasoningEffort.unsupported")}
          </p>
        )}
        <p className="text-[0.575rem] leading-relaxed text-[var(--muted-foreground)]">
          {localizeUi("ui.chatSettings.gmReasoningEffort.scope")}
        </p>
      </div>
    </ChatSettingsSection>
  );
}
