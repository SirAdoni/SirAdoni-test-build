import type { CSSProperties } from "react";
import { Brain } from "lucide-react";
import {
  gameGmReasoningEffortOptions,
  normalizeGameGmReasoningEffort,
  type GameGmReasoningEffort,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useModelParameterCapabilities } from "../../../hooks/use-connections";
import { ChatSettingsSection } from "../ChatSettingsSection";
import { GM_REASONING_EFFORT_LABEL_KEYS } from "../../../lib/gm-reasoning-effort";

/** Stable section id, which also remembers the expanded state. */
export const GM_REASONING_EFFORT_SECTION_ID = "game-gm-reasoning-effort";

interface GmReasoningEffortSectionProps {
  style?: CSSProperties;
  value: unknown;
  connection: { id?: string | null; provider?: string | null; model?: string | null } | null | undefined;
  onChange: (value: GameGmReasoningEffort) => void;
}

export function GmReasoningEffortSection({ style, value, connection, onChange }: GmReasoningEffortSectionProps) {
  const { t: localizeUi } = useUiTranslation();
  const capabilities = useModelParameterCapabilities(connection);
  const selected = normalizeGameGmReasoningEffort(value);
  const options = connection?.provider
    ? gameGmReasoningEffortOptions({
        provider: connection.provider,
        model: connection.model ?? null,
        capabilities,
        selected,
      })
    : gameGmReasoningEffortOptions({ selected });
  // A saved choice the current model cannot use stays visible so switching back does not lose it.
  const shown = options.includes(selected) ? options : [...options, selected];
  return (
    <ChatSettingsSection
      id={GM_REASONING_EFFORT_SECTION_ID}
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
            onChange={(event) => onChange(normalizeGameGmReasoningEffort(event.target.value))}
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
        {!options.includes(selected) && (
          <p className="text-[0.575rem] leading-relaxed text-[var(--muted-foreground)]">
            {localizeUi("ui.chatSettings.gmReasoningEffort.clamped")}
          </p>
        )}
        {options.length === 1 && (
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
