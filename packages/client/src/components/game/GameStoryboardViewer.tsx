import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  PanelsTopLeft,
  Pause,
  Play,
  RotateCcw,
  TriangleAlert,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { GameTurnStoryboard, GameTurnStoryboardKeyframe } from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import { getChatToolbarButtonClass } from "../chat/ChatToolbarControls";
import { FloatingGamePanel } from "./FloatingGamePanel";
import { GameStoryboardTimings } from "./GameStoryboardTimings";
import {
  isGameTurnStoryboardPreparationFailure,
  isGameTurnStoryboardTerminalFailure,
} from "../../hooks/use-game-storyboards";

const STORYBOARD_VIEWER_CONTROL_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-white/10 text-white/70 transition-colors hover:bg-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-white/10";

const STORYBOARD_KEYFRAME_STATUS_KEYS = {
  planned: "game.storyboard.status.planned",
  rendering_image: "game.storyboard.status.renderingImage",
  image_complete: "game.storyboard.status.imageComplete",
  rendering_video: "game.storyboard.status.renderingVideo",
  complete: "game.storyboard.status.complete",
  failed: "game.storyboard.status.failed",
} as const satisfies Record<GameTurnStoryboardKeyframe["status"], string>;

interface StoryboardPointerHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function GameStoryboardInlineViewer({
  chatId,
  storyboard,
  frame,
  frameSectionLabel,
  generating,
  generationError,
  onRetry,
  width,
  playing,
  muted,
  videoRef,
  onSelectFrame,
  onOpenImage,
  onClose,
  onReplay,
  onTogglePlayback,
  onToggleMute,
  onVideoPlayingChange,
}: {
  chatId?: string;
  storyboard: GameTurnStoryboard | null;
  frame: GameTurnStoryboardKeyframe | null;
  frameSectionLabel: string | null;
  generating: boolean;
  generationError?: string | null;
  onRetry?: () => void;
  position: { x: number; y: number };
  width: number;
  size: "small" | "medium" | "large";
  playing: boolean;
  muted: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  dragHandlers: StoryboardPointerHandlers;
  layoutEditing?: boolean;
  resizeHandlers: StoryboardPointerHandlers;
  onSelectFrame?: (frameId: string) => void;
  onOpenImage?: (frame: GameTurnStoryboardKeyframe) => void;
  onClose: () => void;
  onReplay: () => void;
  onTogglePlayback: () => void;
  onToggleMute: () => void;
  onChangeSize: () => void;
  onResizeByKeyboard: (delta: number) => void;
  onVideoPlayingChange: (videoId: string, playing: boolean) => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  const terminalStoryboardFailure = isGameTurnStoryboardTerminalFailure(storyboard);
  const effectiveGenerating = generating && !terminalStoryboardFailure;
  const framePosition =
    storyboard && frame
      ? Math.max(
          0,
          storyboard.keyframes.findIndex((item) => item.id === frame.id),
        )
      : 0;
  const hasVideo = !!frame?.video;
  const plannedFrameCount = storyboard?.keyframes.length ?? 0;
  const readyFrameCount = storyboard?.keyframes.filter((item) => item.image || item.video).length ?? 0;
  const frameStillGenerating =
    effectiveGenerating &&
    !!frame &&
    !frame.image &&
    !frame.video &&
    (frame.status === "planned" || frame.status === "rendering_image" || frame.status === "rendering_video");

  return (
    <FloatingGamePanel id="storyboard" width={width} side="hud_right" autoGrow overflowVisible>
      <div
        data-game-skip-bg-nav="true"
        className="relative w-full select-none max-lg:max-h-[40%] max-lg:shrink-0 max-lg:overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            className={getChatToolbarButtonClass({
              compact: true,
              sizeClassName: "h-7 w-7",
              className: "absolute -right-2 -top-2 z-20 shadow-lg max-lg:right-2 max-lg:top-2 max-lg:h-11 max-lg:w-11",
            })}
            aria-label={localizeUi("ui.game.gamesurfacecomponent.closeStoryboardViewer")}
            title={localizeUi("ui.game.gamesurfacecomponent.closeStoryboardViewer")}
          >
            <X size={14} />
          </button>
          <div className="overflow-hidden rounded-xl border border-white/15 bg-black/75 shadow-2xl backdrop-blur-md">
            <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2 max-lg:min-h-14 max-lg:pr-16">
              <div className="flex min-w-0 items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-white/75">
                <PanelsTopLeft size={13} className="shrink-0 text-[var(--primary)]" />
                <span className="truncate">{localizeUi("ui.game.gamesurfacecomponent.storyboard")}</span>
              </div>
              <span className="shrink-0 text-[0.625rem] text-white/45">
                {frame
                  ? frameSectionLabel
                  : terminalStoryboardFailure
                    ? localizeUi(
                        isGameTurnStoryboardPreparationFailure(storyboard)
                          ? "game.storyboard.status.unavailable"
                          : STORYBOARD_KEYFRAME_STATUS_KEYS.failed,
                      )
                    : localizeUi("ui.game.gamesurfacecomponent.rendering")}
              </span>
            </div>

            <GameStoryboardTimings chatId={chatId ?? storyboard?.chatId} generating={effectiveGenerating} />
            {generationError && !effectiveGenerating ? (
              <>
                <div
                  role="alert"
                  className="hidden space-y-2 border-b border-amber-200/20 bg-amber-300/12 px-3 py-3 text-xs text-amber-50 lg:block"
                >
                  <p className="font-semibold">
                    {localizeUi("ui.game.gamesurfacecomponent.storyboardGenerationFailed")}
                  </p>
                  <p className="break-words whitespace-pre-wrap">{generationError}</p>
                  {onRetry && (
                    <button
                      type="button"
                      onClick={onRetry}
                      className="rounded-lg border border-white/20 px-3 py-2 text-xs"
                    >
                      {localizeUi("game.storyboard.retryGeneration")}
                    </button>
                  )}
                </div>
                <details
                  className="border-b border-amber-200/20 bg-amber-300/12 px-3 py-2 text-xs text-amber-50 lg:hidden"
                  data-storyboard-viewer-no-drag
                >
                  <summary className="cursor-pointer font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]">
                    {localizeUi("ui.game.gamesurfacecomponent.storyboardGenerationFailed")}
                  </summary>
                  <div role="alert" className="space-y-2 pt-2">
                    <p className="break-words whitespace-pre-wrap">{generationError}</p>
                    {onRetry && (
                      <button
                        type="button"
                        onClick={onRetry}
                        className="min-h-10 rounded-lg border border-white/20 px-3 py-2 text-xs"
                      >
                        {localizeUi("game.storyboard.retryGeneration")}
                      </button>
                    )}
                  </div>
                </details>
              </>
            ) : null}
            {storyboard?.error ? (
              <>
                <div
                  className="hidden items-start gap-2 border-b border-amber-200/20 bg-amber-300/12 px-3 py-2 text-amber-50 lg:flex"
                  role="status"
                >
                  <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-200" />
                  <div className="min-w-0">
                    <p className="text-[0.6875rem] font-semibold">
                      {localizeUi("ui.game.gamesurfacecomponent.storyboardDegradedResult")}
                    </p>
                    <p className="line-clamp-3 text-[0.625rem] leading-4 text-amber-50/75">{storyboard.error}</p>
                  </div>
                </div>
                <details
                  className="border-b border-amber-200/20 bg-amber-300/12 px-3 py-2 text-amber-50 lg:hidden"
                  role="status"
                  data-storyboard-viewer-no-drag
                >
                  <summary className="flex cursor-pointer items-start gap-2 text-[0.6875rem] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]">
                    <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-200" />
                    <span>{localizeUi("ui.game.gamesurfacecomponent.storyboardDegradedResult")}</span>
                  </summary>
                  <p className="break-words pt-2 pl-5 text-[0.625rem] leading-4 text-amber-50/75">{storyboard.error}</p>
                </details>
              </>
            ) : null}

            {frame?.video ? (
              <video
                ref={videoRef}
                key={frame.video.id}
                src={frame.video.url}
                autoPlay={playing}
                controls
                muted={muted}
                playsInline
                onPlay={() => onVideoPlayingChange(frame.video!.id, true)}
                onPause={() => onVideoPlayingChange(frame.video!.id, false)}
                onEnded={() => onVideoPlayingChange(frame.video!.id, false)}
                className="aspect-video w-full cursor-auto touch-auto bg-black object-contain max-lg:max-h-[24dvh]"
                data-storyboard-viewer-no-drag
              />
            ) : frame?.image ? (
              onOpenImage ? (
                <button
                  type="button"
                  onClick={() => onOpenImage(frame)}
                  className="block w-full cursor-zoom-in bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]"
                  aria-label={localizeUi("game.storyboard.openFullscreen")}
                  title={localizeUi("game.storyboard.openFullscreen")}
                  data-storyboard-viewer-no-drag
                >
                  <img
                    src={frame.image.url}
                    alt={
                      frame.title ||
                      localizeUi("game.storyboard.keyframeAlt", {
                        index: frame.index + 1,
                      })
                    }
                    className="aspect-video w-full bg-black object-contain max-lg:max-h-[24dvh]"
                    draggable={false}
                  />
                </button>
              ) : (
                <img
                  src={frame.image.url}
                  alt={
                    frame.title ||
                    localizeUi("game.storyboard.keyframeAlt", {
                      index: frame.index + 1,
                    })
                  }
                  className="aspect-video w-full bg-black object-contain max-lg:max-h-[24dvh]"
                  draggable={false}
                />
              )
            ) : generationError && !effectiveGenerating ? null : (
              <div className="flex min-h-20 w-full items-center justify-center gap-2 bg-black/45 text-xs text-white/55 lg:aspect-video">
                {effectiveGenerating ? <Loader2 size={14} className="animate-spin" /> : null}
                {terminalStoryboardFailure
                  ? localizeUi(
                      isGameTurnStoryboardPreparationFailure(storyboard)
                        ? "game.storyboard.status.unavailable"
                        : STORYBOARD_KEYFRAME_STATUS_KEYS.failed,
                    )
                  : frame
                    ? localizeUi(STORYBOARD_KEYFRAME_STATUS_KEYS[frame.status])
                    : localizeUi("ui.game.gamesurfacecomponent.creatingStoryboard")}
              </div>
            )}

            <div className="space-y-2 px-3 py-2.5">
              {plannedFrameCount > 0 ? (
                <p className="text-[0.625rem] tabular-nums text-white/55" role="status">
                  {localizeUi("game.storyboard.readyCount", { ready: readyFrameCount, total: plannedFrameCount })}
                </p>
              ) : null}
              {frameStillGenerating ? (
                <p className="text-[0.6875rem] text-white/70" role="status">
                  {localizeUi("game.storyboard.frameStillGenerating")}
                </p>
              ) : null}
              {frame?.error && (
                <>
                  <details
                    className="rounded-md bg-[var(--background)] p-2 text-xs text-[var(--foreground)] select-text lg:hidden"
                    role="status"
                    data-storyboard-viewer-no-drag
                  >
                    <summary className="cursor-pointer font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]">
                      {localizeUi("game.storyboard.errorDetails")}
                    </summary>
                    <div className="max-h-36 overflow-y-auto break-words pt-2">
                      <p>{frame.error}</p>
                      {frame.status === "failed" && (
                        <p className="mt-1">{localizeUi("game.storyboard.errorRetryHint")}</p>
                      )}
                    </div>
                  </details>
                  <div
                    role="status"
                    className="hidden max-h-36 overflow-y-auto break-words rounded-md bg-[var(--background)] p-2 text-xs text-[var(--foreground)] select-text lg:block"
                  >
                    <p className="font-semibold">{localizeUi("game.storyboard.errorDetails")}</p>
                    <p>{frame.error}</p>
                    {frame.status === "failed" && (
                      <p className="mt-1">{localizeUi("game.storyboard.errorRetryHint")}</p>
                    )}
                  </div>
                </>
              )}
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 truncate text-xs font-semibold text-white/90">
                  {frame?.title || storyboard?.title || localizeUi("ui.game.gamesurfacecomponent.storyboardTurn")}
                </p>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                  <button
                    type="button"
                    className={`${STORYBOARD_VIEWER_CONTROL_BUTTON} max-lg:h-11 max-lg:w-11`}
                    disabled={!onSelectFrame || framePosition === 0}
                    aria-label={localizeUi("game.storyboard.previousPage")}
                    onClick={() => storyboard && onSelectFrame?.(storyboard.keyframes[framePosition - 1]!.id)}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    type="button"
                    className={`${STORYBOARD_VIEWER_CONTROL_BUTTON} max-lg:h-11 max-lg:w-11`}
                    disabled={!onSelectFrame || !storyboard || framePosition >= storyboard.keyframes.length - 1}
                    aria-label={localizeUi("game.storyboard.nextPage")}
                    onClick={() => storyboard && onSelectFrame?.(storyboard.keyframes[framePosition + 1]!.id)}
                  >
                    <ChevronRight size={14} />
                  </button>
                  {hasVideo ? (
                    <>
                      <button
                        type="button"
                        onClick={onReplay}
                        className={`${STORYBOARD_VIEWER_CONTROL_BUTTON} max-lg:h-11 max-lg:w-11`}
                        title={localizeUi("ui.game.gamesurfacecomponent.replayStoryboardVideo")}
                      >
                        <RotateCcw size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={onTogglePlayback}
                        className={`${STORYBOARD_VIEWER_CONTROL_BUTTON} max-lg:h-11 max-lg:w-11`}
                        title={
                          playing
                            ? localizeUi("ui.game.gamesurfacecomponent.pauseStoryboardVideo")
                            : localizeUi("ui.game.gamesurfacecomponent.playStoryboardVideo")
                        }
                      >
                        {playing ? <Pause size={13} /> : <Play size={13} />}
                      </button>
                      <button
                        type="button"
                        onClick={onToggleMute}
                        className={`${STORYBOARD_VIEWER_CONTROL_BUTTON} max-lg:h-11 max-lg:w-11`}
                        title={
                          muted
                            ? localizeUi("ui.game.gamesurfacecomponent.unmuteStoryboardVideo")
                            : localizeUi("ui.game.gamesurfacecomponent.muteStoryboardVideo")
                        }
                      >
                        {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                      </button>
                    </>
                  ) : null}
                  {storyboard?.keyframes.length ? (
                    <span className="ml-1 text-[0.625rem] text-white/45">
                      {framePosition + 1}/{storyboard.keyframes.length}
                    </span>
                  ) : null}
                </div>
              </div>
              <p className="line-clamp-2 text-[0.6875rem] leading-4 text-white/58">
                {terminalStoryboardFailure
                  ? storyboard?.error || localizeUi(STORYBOARD_KEYFRAME_STATUS_KEYS.failed)
                  : frame?.anchorQuote || frame?.narrationBeat || localizeUi("game.storyboard.generatingKeyframes")}
              </p>
              {storyboard?.keyframes.length ? (
                <div className="flex gap-1">
                  {storyboard.keyframes.map((item) => (
                    <span
                      key={item.id}
                      className={cn(
                        "h-1 flex-1 rounded-full transition-colors",
                        frame?.id === item.id ? "bg-[var(--primary)]" : "bg-white/15",
                      )}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </FloatingGamePanel>
  );
}

export function GameStoryboardBackgroundVisual({
  frame,
  playing,
  muted,
  videoRef,
  onVideoPlayingChange,
}: {
  frame: GameTurnStoryboardKeyframe;
  playing: boolean;
  muted: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  onVideoPlayingChange: (videoId: string, playing: boolean) => void;
}) {
  return (
    <div
      data-game-skip-bg-nav="true"
      className="pointer-events-none absolute inset-0 z-[1] overflow-hidden bg-black"
      aria-hidden="true"
    >
      {frame.video ? (
        <video
          ref={videoRef}
          key={frame.video.id}
          src={frame.video.url}
          poster={frame.image?.url}
          autoPlay={playing}
          muted={muted}
          playsInline
          onPlay={() => onVideoPlayingChange(frame.video!.id, true)}
          onPause={() => onVideoPlayingChange(frame.video!.id, false)}
          onEnded={() => onVideoPlayingChange(frame.video!.id, false)}
          className="h-full w-full bg-black object-contain transition-opacity duration-500"
        />
      ) : frame.image ? (
        <img
          src={frame.image.url}
          alt=""
          className="h-full w-full bg-black object-contain transition-opacity duration-500"
          draggable={false}
        />
      ) : null}
    </div>
  );
}
