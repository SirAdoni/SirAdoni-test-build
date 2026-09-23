// A small pulsing dot on the top bar's generation jobs button while tracked
// jobs run. Renders nothing while tracking is off or nothing is running.
import { useTranslation } from "react-i18next";
import { isActiveJob } from "../../lib/generation-job-tracking";
import { useGenerationJobTrackingEnabled, useTrackedGenerationJobs } from "../../hooks/use-generation-job-tracking";

export function GenerationJobsActivityDot() {
  const { t } = useTranslation();
  const enabled = useGenerationJobTrackingEnabled();
  const { data } = useTrackedGenerationJobs(enabled);
  const running = enabled ? (data?.filter(isActiveJob).length ?? 0) : 0;
  if (running === 0) return null;
  return (
    <>
      <span
        aria-hidden="true"
        data-testid="generation-jobs-activity"
        className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--primary)] ring-2 ring-[var(--marinara-topbar-surface)] motion-reduce:animate-none"
      />
      <span className="sr-only">{t("generationJobs.tracking.runningCount", { count: running })}</span>
    </>
  );
}
