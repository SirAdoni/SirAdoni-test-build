import { useTranslation } from "react-i18next";
import {
  DEFAULT_STORYBOARD_CONTINUITY,
  normalizeStoryboardContinuity,
  type StoryboardContinuitySettings as ContinuitySettings,
} from "@marinara-engine/shared";

/** Shared by the agent editor and both chat modes; null removes the chat override. */
export function StoryboardContinuitySettings({
  value,
  defaults = DEFAULT_STORYBOARD_CONTINUITY,
  onChange,
  override,
}: {
  value: ContinuitySettings;
  defaults?: ContinuitySettings;
  onChange: (value: ContinuitySettings | null) => void;
  override?: boolean;
}) {
  const { t } = useTranslation();
  const update = (patch: Partial<ContinuitySettings>) => onChange(normalizeStoryboardContinuity(patch, value));
  const inputClass =
    "w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--background)] p-2 text-sm focus-visible:outline-2 focus-visible:outline-[var(--ring)]";
  return (
    <details className="min-w-0 rounded-xl border border-[var(--border)] p-3" data-storyboard-continuity-settings>
      <summary className="cursor-pointer text-sm font-medium">{t("ui.storyboard.continuity.title")}</summary>
      <div className="mt-3 min-w-0 space-y-4">
        <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{t("ui.storyboard.continuity.help")}</p>
        {override !== undefined && (
          <p className="text-xs text-[var(--muted-foreground)]">
            {t(override ? "ui.storyboard.continuity.overridden" : "ui.storyboard.continuity.inherited")}
          </p>
        )}
        {(["enabled", "reviewEnabled"] as const).map((key) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={value[key]} onChange={(event) => update({ [key]: event.target.checked })} />
            {t(`ui.storyboard.continuity.${key}`)}
          </label>
        ))}
        <div className="grid gap-3 sm:grid-cols-2">
          {(["historyCharacters", "repairAttempts"] as const).map((key) => (
            <label key={key} className="min-w-0 space-y-1 text-xs">
              <span>{t(`ui.storyboard.continuity.${key}`)}</span>
              <input
                className={inputClass}
                type="number"
                min={key === "historyCharacters" ? 4000 : 0}
                max={key === "historyCharacters" ? 256000 : 4}
                step={key === "historyCharacters" ? 1000 : 1}
                defaultValue={value[key]}
                key={value[key]}
                onBlur={(event) => {
                  const next = normalizeStoryboardContinuity(
                    event.target.value.trim() && Number.isFinite(event.target.valueAsNumber)
                      ? { [key]: event.target.valueAsNumber }
                      : {},
                    value,
                  );
                  event.target.value = String(next[key]);
                  onChange(next);
                }}
              />
            </label>
          ))}
        </div>
        <p className="text-xs text-[var(--muted-foreground)]">{t("ui.storyboard.continuity.cost")}</p>
        {(["rules", "analystPrompt", "reviewPrompt", "repairPrompt"] as const).map((key) => (
          <details key={key} className="min-w-0">
            <summary className="cursor-pointer text-sm">{t(`ui.storyboard.continuity.${key}`)}</summary>
            <textarea
              aria-label={t(`ui.storyboard.continuity.${key}`)}
              className={inputClass + " mt-2 resize-y font-mono text-xs leading-relaxed"}
              rows={9}
              maxLength={32000}
              value={value[key]}
              onChange={(event) => update({ [key]: event.target.value })}
            />
          </details>
        ))}
        <button
          type="button"
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs hover:bg-[var(--muted)]"
          onClick={() => onChange(override === undefined ? { ...defaults } : null)}
        >
          {t(override === undefined ? "ui.storyboard.continuity.reset" : "ui.storyboard.continuity.inherit")}
        </button>
      </div>
    </details>
  );
}
