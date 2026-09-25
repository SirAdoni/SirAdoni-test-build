import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getPrivilegedActionErrorMessage } from "../../../lib/api-client";
import {
  useGenerationJobTrackingSettings,
  useSetGenerationJobTracking,
} from "../../../hooks/use-generation-job-tracking";
import { useUIStore } from "../../../stores/ui.store";
import { ToggleSetting } from "./SettingControls";

export const GENERATION_JOB_TRACKING_CONTROL_ID = "generation-job-tracking";

/**
 * Opt-in job tracking, shown as a row of Settings > Advanced > Features. Unlike the other switches there
 * it starts off and keeps its own app setting (generationJobTracking): saved job status, a log trail per
 * job, and reconnect recovery.
 */
export function GenerationJobTrackingSettings({ anchorId }: { anchorId?: string }) {
  const { t } = useTranslation();
  const settings = useGenerationJobTrackingSettings();
  const save = useSetGenerationJobTracking();
  const enabled = settings.data?.enabled === true;

  return (
    <div className="flex flex-col gap-1">
      <ToggleSetting
        anchorId={anchorId}
        label={t("settings.generationJobTracking.toggle")}
        checked={enabled}
        disabled={!settings.data || save.isPending}
        onChange={(value) =>
          save.mutate(value, {
            onError: (error) =>
              toast.error(getPrivilegedActionErrorMessage(error, t("settings.generationJobTracking.saveFailed"))),
          })
        }
        help={t("settings.generationJobTracking.help")}
      />
      <p className="px-1.5 text-[0.625rem] leading-relaxed text-[var(--marinara-chat-chrome-panel-muted)]">
        {t("settings.generationJobTracking.startsOff")}{" "}
        {settings.isError
          ? t("settings.generationJobTracking.loadFailed")
          : t("settings.generationJobTracking.retention", {
              days: settings.data?.retentionDays ?? 7,
              limit: settings.data?.maxRecords ?? 300,
            })}
      </p>
      {enabled ? (
        <button
          type="button"
          onClick={() => useUIStore.getState().openModal("generation-jobs")}
          className="mari-chrome-control w-full justify-center px-3 text-xs"
        >
          {t("settings.generationJobTracking.open")}
        </button>
      ) : null}
    </div>
  );
}
