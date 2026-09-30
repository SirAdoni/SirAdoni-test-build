import { useUpdateSpatialAutoTravelNow } from "../../../hooks/use-spatial-context";
import { useSpatialMapTranslation } from "../localization";

interface SpatialAutoTravelNowSwitchProps {
  chatId: string;
  enabled: boolean;
  enabledForChat: boolean;
  mapAvailable: boolean;
}

export function SpatialAutoTravelNowSwitch({
  chatId,
  enabled,
  enabledForChat,
  mapAvailable,
}: SpatialAutoTravelNowSwitchProps) {
  const { t } = useSpatialMapTranslation();
  const updatePreference = useUpdateSpatialAutoTravelNow();
  const disabled = !enabledForChat || !mapAvailable || updatePreference.isPending;

  return (
    <div className="space-y-2">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-busy={updatePreference.isPending}
        disabled={disabled}
        onClick={() => updatePreference.mutate({ chatId, enabled: !enabled })}
        className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-60 ${
          enabled
            ? "bg-[var(--primary)]/10 ring-[var(--primary)]/30"
            : "bg-[var(--secondary)] ring-[var(--border)] hover:bg-[var(--accent)]"
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-[var(--foreground)]">
            {t("ui.worldMaps.autoTravel.label")}
          </span>
          <span className="mt-0.5 block text-[0.625rem] leading-relaxed text-[var(--marinara-chat-chrome-accent)]">
            {t(enabled ? "ui.worldMaps.autoTravel.enabledHelp" : "ui.worldMaps.autoTravel.disabledHelp")}
          </span>
        </span>
        <span
          aria-hidden="true"
          data-settings-switch-track
          className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
            enabled ? "bg-[var(--primary)]/70 mari-accent-animated" : "bg-[var(--border)]"
          }`}
        >
          <span
            data-settings-switch-thumb
            className={`pointer-events-none block h-4 w-4 shrink-0 rounded-full bg-[var(--background)] shadow-sm ring-1 ring-[var(--border)] transition-transform ${
              enabled ? "translate-x-4" : ""
            }`}
          />
        </span>
      </button>
      {updatePreference.isPending && (
        <p role="status" aria-live="polite" className="px-1 text-[0.625rem] text-[var(--marinara-chat-chrome-accent)]">
          {t("ui.worldMaps.autoTravel.saving")}
        </p>
      )}
      {updatePreference.isError && (
        <p
          role="alert"
          className="rounded-lg bg-[var(--destructive)]/10 px-3 py-2 text-[0.6875rem] text-[var(--destructive)]"
        >
          {t("ui.worldMaps.autoTravel.saveError")}
        </p>
      )}
    </div>
  );
}
