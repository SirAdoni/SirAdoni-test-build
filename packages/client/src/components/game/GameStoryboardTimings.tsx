import { useTranslation } from "react-i18next";
import { useStoryboardProgress } from "../../hooks/use-game-storyboards";

export function GameStoryboardTimings({ chatId, generating }: { chatId?: string; generating: boolean }) {
  return chatId ? <StoryboardTimingsContent chatId={chatId} generating={generating} /> : null;
}

function StoryboardTimingsContent({ chatId, generating }: { chatId: string; generating: boolean }) {
  const { t } = useTranslation();
  const { data, isError } = useStoryboardProgress(chatId, generating);
  const seconds = (ms: number) => `${(ms / 1000).toFixed(3)} s`;
  return (
    <details
      className="border-b border-white/10 px-3 py-2 text-xs text-white/70 select-text"
      data-storyboard-viewer-no-drag
    >
      <summary className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] max-lg:flex max-lg:min-h-11 max-lg:items-center">
        {t("game.storyboard.timing.title")}
        {data ? <span className="ml-2 font-mono tabular-nums">{seconds(data.elapsedMs)}</span> : null}
      </summary>
      {isError ? (
        <p role="status">{t("game.storyboard.timing.unavailable")}</p>
      ) : !data ? (
        <p>{t("game.storyboard.timing.waiting")}</p>
      ) : (
        <div className="mt-2 space-y-2">
          <p>{t("game.storyboard.timing.explanation")}</p>
          <p>{t(data.active ? "game.storyboard.timing.running" : "game.storyboard.timing.finished")}</p>
          <ol className="space-y-2">
            {data.steps.map((step, index) => (
              <li key={`${data.startedAt}:${index}`} className="border-t border-white/10 pt-1">
                <div className="break-words">{step.stage}</div>
                <div className="flex flex-wrap justify-between gap-2 font-mono tabular-nums">
                  <span>{t("game.storyboard.timing.start", { seconds: seconds(step.offsetMs) })}</span>
                  <span>
                    {seconds(step.elapsedMs)}
                    {" · "}
                    {t(
                      step.failed
                        ? "game.storyboard.timing.failed"
                        : step.durationMs === undefined
                          ? "game.storyboard.timing.running"
                          : "game.storyboard.timing.finished",
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ol>
          <a
            className="underline"
            href={`/api/game/storyboard/progress/${encodeURIComponent(chatId)}`}
            target="_blank"
            rel="noreferrer"
          >
            {t("game.storyboard.timing.raw")}
          </a>
          <a
            className="block underline"
            href={`/api/game/storyboard/progress/${encodeURIComponent(chatId)}/history`}
            target="_blank"
            rel="noreferrer"
          >
            {t("game.storyboard.timing.history")}
          </a>
        </div>
      )}
    </details>
  );
}
