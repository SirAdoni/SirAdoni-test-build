import { useTranslation } from "react-i18next";
import { useSceneTimeline } from "../../hooks/use-scene-timeline";

export function GameSceneTimeline({ chatId }: { chatId: string }) {
  const { t } = useTranslation();
  const { data, isPending, error, sync } = useSceneTimeline(chatId);
  return (
    <section className="mb-5 space-y-3" aria-label={t("sceneTimeline.title")}>
      <h3 className="text-sm font-semibold text-text-primary">{t("sceneTimeline.title")}</h3>
      {(isPending || data?.pending) && (
        <p role="status" className="text-xs text-text-secondary">
          {t("sceneTimeline.updating")}
        </p>
      )}
      {Boolean(error || sync.error || data?.error || (data?.remaining && !data.pending)) && (
        <div role="status" className="space-y-2 text-xs text-text-secondary">
          <p>
            {t(data?.error && data.remaining === 0 ? "sceneTimeline.reviewIncomplete" : "sceneTimeline.incomplete")}
          </p>
          {Boolean(data?.remaining) && <p>{t("sceneTimeline.remaining", { count: data?.remaining })}</p>}
          {(error || sync.error || data?.error) && (
            <details>
              <summary className="cursor-pointer">{t("sceneTimeline.errorDetails")}</summary>
              <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                {error?.message || sync.error?.message || data?.error}
              </p>
            </details>
          )}
          <button
            type="button"
            className="mt-2 rounded-md border border-border px-3 py-1"
            disabled={sync.isPending || data?.pending}
            onClick={() => sync.mutate()}
          >
            {t("sceneTimeline.retry")}
          </button>
        </div>
      )}
      {data?.scenes.map((scene, index) => (
        <article key={scene.id} className="rounded-lg border border-border bg-bg-secondary p-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium text-text-primary">
              {index + 1}. {scene.location}
            </h4>
            {!scene.closed && <span className="text-xs text-accent">{t("sceneTimeline.current")}</span>}
          </div>
          <p className="mt-2 text-xs text-text-secondary">
            {t("sceneTimeline.participants")}: {scene.participants.join(", ")}
          </p>
          {!scene.closed && (
            <p className="mt-1 text-xs text-text-secondary">
              {t("sceneTimeline.present")}: {scene.present.join(", ")}
            </p>
          )}
          {scene.closed && (
            <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-text-primary">
              {!scene.reviewed ? t("sceneTimeline.reviewing") : scene.summary || t("sceneTimeline.noEvents")}
            </p>
          )}
        </article>
      ))}
      {!isPending &&
        !data?.pending &&
        !data?.scenes.length &&
        !data?.remaining &&
        !data?.error &&
        !error &&
        !sync.error && <p className="text-xs text-text-secondary">{t("sceneTimeline.empty")}</p>}
    </section>
  );
}
