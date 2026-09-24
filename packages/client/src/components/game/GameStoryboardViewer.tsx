import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
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

/** Same breakpoint as FloatingGamePanel: below it Game panels render inline in the phone column. */
const STORYBOARD_DESKTOP_QUERY = "(min-width: 1024px)";
/** Clearance kept between the phone storyboard sheet and the composer or the column edges. */
const STORYBOARD_SHEET_GAP = 8;
/** Below this height the space above the composer is too small to be useful for the sheet. */
const STORYBOARD_SHEET_MIN_USEFUL_HEIGHT = 160;

interface StoryboardPointerHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

function useStoryboardCompactLayout() {
  const [compact, setCompact] = useState(() => !window.matchMedia(STORYBOARD_DESKTOP_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(STORYBOARD_DESKTOP_QUERY);
    const update = () => setCompact(!query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

/** Above the Game HUD layers (widget strips, Currently Present), below app dialogs and toasts. */
const STORYBOARD_SHEET_Z_INDEX = 45;

interface StoryboardSheetPlacement {
  left: number;
  width: number;
  bottom: number;
  maxHeight: number;
}

/** The visible composer (the player's text box) inside the Game column, if any. */
function findGameComposer(column: HTMLElement): HTMLElement | null {
  const textarea = [...column.querySelectorAll("textarea")].find((item) => item.getClientRects().length > 0);
  if (!textarea) return null;
  return (textarea.closest(".mari-chat-input-box") as HTMLElement | null) ?? textarea;
}

/**
 * Place the phone storyboard sheet in the largest free band of the Game column that does not
 * include the composer, so the text box and its send button always stay on top and usable.
 * The visual viewport bottom is honoured so an on-screen keyboard cannot push the band under it.
 */
export function computeStoryboardSheetPlacement(input: {
  host: { top: number; bottom: number };
  column: { top: number; bottom: number; left: number; width: number };
  viewportBottom: number;
  composer: { top: number; bottom: number } | null;
}): StoryboardSheetPlacement {
  const top = Math.max(input.column.top, 0) + STORYBOARD_SHEET_GAP;
  const bottom = Math.min(input.column.bottom, input.viewportBottom) - STORYBOARD_SHEET_GAP;
  let regionTop = top;
  let regionBottom = bottom;
  if (input.composer) {
    const composerTop = Math.max(input.composer.top, top);
    const composerBottom = Math.min(input.composer.bottom, bottom);
    if (composerBottom > composerTop) {
      const above = composerTop - STORYBOARD_SHEET_GAP - top;
      const below = bottom - (composerBottom + STORYBOARD_SHEET_GAP);
      if (above >= STORYBOARD_SHEET_MIN_USEFUL_HEIGHT || above >= below)
        regionBottom = composerTop - STORYBOARD_SHEET_GAP;
      else regionTop = composerBottom + STORYBOARD_SHEET_GAP;
    } else if (input.composer.bottom <= top) {
      regionTop = Math.max(regionTop, input.composer.bottom + STORYBOARD_SHEET_GAP);
    } else if (input.composer.top >= bottom) {
      regionBottom = Math.min(regionBottom, input.composer.top - STORYBOARD_SHEET_GAP);
    }
  }
  return {
    left: Math.round(input.column.left + STORYBOARD_SHEET_GAP),
    width: Math.max(0, Math.round(input.column.width - STORYBOARD_SHEET_GAP * 2)),
    bottom: Math.round(input.host.bottom - regionBottom),
    maxHeight: Math.max(0, Math.round(regionBottom - regionTop)),
  };
}

/**
 * True while the player types in the Game composer with an on-screen keyboard up. Focus alone is not
 * enough: hiding the tab on every focus shifted the column by its height on each focus and send, even
 * where no keyboard takes the room (hardware keyboards, tablets). The keyboard shows as a visual
 * viewport noticeably shorter than the layout viewport.
 */
function useGameComposerFocused() {
  const [composerFocused, setFocused] = useState(false);
  const [keyboardUp, setKeyboardUp] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setKeyboardUp(viewport.height < window.innerHeight * 0.8);
    update();
    viewport.addEventListener("resize", update);
    return () => viewport.removeEventListener("resize", update);
  }, []);
  useEffect(() => {
    const isComposer = (target: EventTarget | null) =>
      target instanceof HTMLTextAreaElement && !!target.closest(".mari-chat-input-box");
    const onFocusIn = (event: FocusEvent) => setFocused(isComposer(event.target));
    const onFocusOut = (event: FocusEvent) => {
      if (isComposer(event.target) && !isComposer(event.relatedTarget)) setFocused(false);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  return composerFocused && keyboardUp;
}

function useStoryboardSheetPlacement(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  sheetRef: RefObject<HTMLElement | null>,
) {
  const [placement, setPlacement] = useState<StoryboardSheetPlacement | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const anchor = anchorRef.current;
      const sheet = sheetRef.current;
      const column = anchor?.parentElement;
      if (!anchor || !sheet || !column) return;
      // The sheet is fixed to the layout viewport (portalled above the HUD layers).
      const hostRect = { top: 0, bottom: document.documentElement.clientHeight || window.innerHeight };
      const columnRect = column.getBoundingClientRect();
      const viewport = window.visualViewport;
      const composer = findGameComposer(column)?.getBoundingClientRect() ?? null;
      const next = computeStoryboardSheetPlacement({
        host: hostRect,
        column: columnRect,
        viewportBottom: viewport ? viewport.offsetTop + viewport.height : window.innerHeight,
        composer,
      });
      setPlacement((current) =>
        current &&
        current.left === next.left &&
        current.width === next.width &&
        current.bottom === next.bottom &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    const column = anchorRef.current?.parentElement;
    if (column) observer.observe(column);
    if (column) {
      const composer = findGameComposer(column);
      if (composer) observer.observe(composer);
    }
    // Narration reflows (streaming text, choices) move the composer without resizing the column.
    const interval = window.setInterval(schedule, 400);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.clearInterval(interval);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [anchorRef, open, sheetRef]);
  return placement;
}

export function GameStoryboardInlineViewer(props: {
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
  const compact = useStoryboardCompactLayout();
  if (compact) return <GameStoryboardPhoneViewer {...props} />;
  return (
    <FloatingGamePanel id="storyboard" width={props.width} side="hud_right" autoGrow overflowVisible fillHeight>
      <div
        data-game-skip-bg-nav="true"
        className="relative w-full select-none group-data-[game-panel-fill=true]/panelbox:flex group-data-[game-panel-fill=true]/panelbox:h-full group-data-[game-panel-fill=true]/panelbox:flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative group-data-[game-panel-fill=true]/panelbox:flex group-data-[game-panel-fill=true]/panelbox:min-h-0 group-data-[game-panel-fill=true]/panelbox:flex-1 group-data-[game-panel-fill=true]/panelbox:flex-col">
          <StoryboardCloseButton onClose={props.onClose} className="absolute -right-2 -top-2 z-20 shadow-lg" />
          <GameStoryboardViewerCard {...props} />
        </div>
      </div>
    </FloatingGamePanel>
  );
}

function StoryboardCloseButton({
  onClose,
  className,
  label,
}: {
  onClose: () => void;
  className: string;
  label?: string;
}) {
  const { t: localizeUi } = useUiTranslation();
  const text = label ?? localizeUi("ui.game.gamesurfacecomponent.closeStoryboardViewer");
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className={getChatToolbarButtonClass({ compact: true, sizeClassName: "h-7 w-7", className })}
      aria-label={text}
      title={text}
    >
      <X size={14} />
    </button>
  );
}

/**
 * Phones never float the storyboard over the column. It stays a slim tab below the narration and
 * opens on demand as a sheet placed clear of the composer, with an obvious close button.
 */
function GameStoryboardPhoneViewer(props: Parameters<typeof GameStoryboardInlineViewer>[0]) {
  const { t: localizeUi } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const placement = useStoryboardSheetPlacement(open, anchorRef, sheetRef);
  const status = useStoryboardStatus(props);
  // While typing, give the keyboard-shortened column back to the composer: the tab steps aside.
  const composerFocused = useGameComposerFocused();
  const sheetId = "game-storyboard-phone-sheet";
  return (
    <div
      ref={anchorRef}
      data-game-skip-bg-nav="true"
      data-storyboard-phone
      className={cn(
        "pointer-events-auto shrink-0 px-3 pb-[max(0.5rem,var(--mari-safe-area-inset-bottom,env(safe-area-inset-bottom)))]",
        // Landscape phones: the tab becomes one icon in the Game top row, left of the actions menu.
        "max-lg:[@media(max-height:32rem)]:absolute max-lg:[@media(max-height:32rem)]:right-[3.75rem] max-lg:[@media(max-height:32rem)]:top-3 max-lg:[@media(max-height:32rem)]:z-30 max-lg:[@media(max-height:32rem)]:p-0",
        composerFocused && "hidden",
      )}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="mx-auto flex w-full max-w-4xl items-center gap-1 rounded-xl border border-white/15 bg-black/70 pr-1 shadow-lg backdrop-blur-md max-lg:[@media(max-height:32rem)]:w-auto max-lg:[@media(max-height:32rem)]:pr-0">
        <button
          type="button"
          data-storyboard-phone-tab
          data-floating-widget-avoid
          aria-expanded={open}
          aria-controls={sheetId}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-xl px-3 text-left text-[0.6875rem] font-semibold uppercase tracking-wide text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)] max-lg:[@media(max-height:32rem)]:h-11 max-lg:[@media(max-height:32rem)]:w-11 max-lg:[@media(max-height:32rem)]:flex-none max-lg:[@media(max-height:32rem)]:justify-center max-lg:[@media(max-height:32rem)]:relative max-lg:[@media(max-height:32rem)]:px-0 max-lg:[@media(max-height:32rem)]:[&>svg:last-child]:hidden"
        >
          <PanelsTopLeft size={13} className="shrink-0 text-[var(--primary)]" />
          <span className="shrink-0 max-lg:[@media(max-height:32rem)]:sr-only">
            {localizeUi("ui.game.gamesurfacecomponent.storyboard")}
          </span>
          <span className="flex min-w-0 items-center gap-1 truncate text-[0.625rem] font-normal normal-case tracking-normal text-white/50 max-lg:[@media(max-height:32rem)]:absolute max-lg:[@media(max-height:32rem)]:right-1 max-lg:[@media(max-height:32rem)]:top-1">
            {status.busy ? <Loader2 size={11} className="shrink-0 animate-spin" /> : null}
            {status.problem ? <TriangleAlert size={11} className="shrink-0 text-amber-200" /> : null}
            <span className="truncate max-lg:[@media(max-height:32rem)]:sr-only">{status.shortLabel}</span>
          </span>
          <ChevronUp
            size={14}
            className={cn("ml-auto shrink-0 text-white/60 transition-transform", open ? "" : "rotate-180")}
          />
        </button>
        <StoryboardCloseButton
          onClose={props.onClose}
          className="h-8 w-8 shrink-0 max-lg:[@media(max-height:32rem)]:hidden"
        />
      </div>
      {open
        ? createPortal(
            <div
              ref={sheetRef}
              id={sheetId}
              data-storyboard-phone-sheet
              data-floating-widget-avoid
              role="region"
              aria-label={localizeUi("ui.game.gamesurfacecomponent.storyboard")}
              data-game-skip-bg-nav="true"
              className="fixed flex flex-col overflow-y-auto overscroll-contain rounded-xl"
              style={{
                zIndex: STORYBOARD_SHEET_Z_INDEX,
                ...(placement ?? { left: 0, width: 0, bottom: 0, maxHeight: 0, visibility: "hidden" as const }),
              }}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
            >
              <div className="relative">
                <StoryboardCloseButton
                  onClose={() => setOpen(false)}
                  label={localizeUi("game.storyboard.hideViewer")}
                  className="absolute right-2 top-2 z-20 h-9 w-9 shadow-lg"
                />
                <GameStoryboardViewerCard {...props} phone />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function useStoryboardStatus({
  storyboard,
  frame,
  frameSectionLabel,
  generating,
  generationError,
}: Pick<
  Parameters<typeof GameStoryboardInlineViewer>[0],
  "storyboard" | "frame" | "frameSectionLabel" | "generating" | "generationError"
>) {
  const { t: localizeUi } = useUiTranslation();
  const terminalFailure = isGameTurnStoryboardTerminalFailure(storyboard);
  const busy = generating && !terminalFailure;
  const failed = terminalFailure || (!!generationError && !busy);
  const problem = failed || !!storyboard?.error || frame?.status === "failed";
  const shortLabel = failed
    ? localizeUi(
        isGameTurnStoryboardPreparationFailure(storyboard)
          ? "game.storyboard.status.unavailable"
          : "game.storyboard.friendlyFailure",
      )
    : frame
      ? (frameSectionLabel ?? localizeUi(STORYBOARD_KEYFRAME_STATUS_KEYS[frame.status]))
      : localizeUi("ui.game.gamesurfacecomponent.rendering");
  return { terminalFailure, busy, failed, problem, shortLabel };
}

function StoryboardDebugDetails({ children }: { children: ReactNode }) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <details
      data-storyboard-debug
      data-storyboard-viewer-no-drag
      className="group/sbdebug border-t border-white/10 px-3 py-1.5 text-xs text-white/60 select-text"
    >
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1 text-[0.625rem] text-white/45 hover:text-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] max-lg:min-h-9 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={11} className="shrink-0 transition-transform group-open/sbdebug:rotate-90" />
        {localizeUi("game.storyboard.details")}
      </summary>
      <div className="space-y-2 pt-1.5">{children}</div>
    </details>
  );
}

function GameStoryboardViewerCard({
  chatId,
  storyboard,
  frame,
  frameSectionLabel,
  generating,
  generationError,
  onRetry,
  playing,
  muted,
  videoRef,
  onSelectFrame,
  onOpenImage,
  onReplay,
  onTogglePlayback,
  onToggleMute,
  onVideoPlayingChange,
  phone = false,
}: Parameters<typeof GameStoryboardInlineViewer>[0] & { phone?: boolean }) {
  const { t: localizeUi } = useUiTranslation();
  const { busy: effectiveGenerating, failed } = useStoryboardStatus({
    storyboard,
    frame,
    frameSectionLabel,
    generating,
    generationError,
  });
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
  const degraded = !failed && !!storyboard?.error;
  const phoneMediaClass = phone ? "max-h-[min(40dvh,24rem)]" : "max-lg:max-h-[24dvh]";

  return (
    <div className="overflow-hidden rounded-xl border border-white/15 bg-black/75 shadow-2xl backdrop-blur-md group-data-[game-panel-fill=true]/panelbox:flex group-data-[game-panel-fill=true]/panelbox:min-h-0 group-data-[game-panel-fill=true]/panelbox:flex-1 group-data-[game-panel-fill=true]/panelbox:flex-col group-data-[game-panel-fill=true]/panelbox:[&>*]:shrink-0">
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2",
          phone && "min-h-12 pr-14",
        )}
      >
        <div className="flex min-w-0 items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-white/75">
          <PanelsTopLeft size={13} className="shrink-0 text-[var(--primary)]" />
          <span className="truncate">{localizeUi("ui.game.gamesurfacecomponent.storyboard")}</span>
        </div>
        <span className="shrink-0 text-[0.625rem] text-white/45">
          {frame ? frameSectionLabel : failed ? null : localizeUi("ui.game.gamesurfacecomponent.rendering")}
        </span>
      </div>

      {failed || degraded ? (
        <div
          role="status"
          data-storyboard-friendly-status
          className="flex items-center gap-2 border-b border-amber-200/20 bg-amber-300/12 px-3 py-1.5 text-[0.6875rem] text-amber-50"
        >
          <TriangleAlert size={13} className="shrink-0 text-amber-200" />
          <span className="min-w-0 flex-1">
            {localizeUi(
              !failed
                ? "game.storyboard.friendlyDegraded"
                : isGameTurnStoryboardPreparationFailure(storyboard)
                  ? "game.storyboard.status.unavailable"
                  : "game.storyboard.friendlyFailure",
            )}
          </span>
          {failed && onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 rounded-md border border-white/20 px-2 py-1 text-[0.6875rem] max-lg:min-h-9"
            >
              {localizeUi("game.storyboard.retryGeneration")}
            </button>
          ) : null}
        </div>
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
          className={cn(
            "aspect-video w-full cursor-auto touch-auto bg-black object-contain lg:max-h-[calc(var(--game-panel-box-max-height,100dvh)-192px)] group-data-[game-panel-fill=true]/panelbox:aspect-auto group-data-[game-panel-fill=true]/panelbox:min-h-0 group-data-[game-panel-fill=true]/panelbox:flex-1! group-data-[game-panel-fill=true]/panelbox:lg:max-h-none",
            phoneMediaClass,
          )}
          data-storyboard-viewer-no-drag
        />
      ) : frame?.image ? (
        onOpenImage ? (
          <button
            type="button"
            onClick={() => onOpenImage(frame)}
            className="block w-full cursor-zoom-in bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)] group-data-[game-panel-fill=true]/panelbox:min-h-0 group-data-[game-panel-fill=true]/panelbox:flex-1!"
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
              className={cn(
                "aspect-video w-full bg-black object-contain lg:max-h-[calc(var(--game-panel-box-max-height,100dvh)-192px)] group-data-[game-panel-fill=true]/panelbox:aspect-auto group-data-[game-panel-fill=true]/panelbox:h-full group-data-[game-panel-fill=true]/panelbox:min-h-0 group-data-[game-panel-fill=true]/panelbox:flex-1! group-data-[game-panel-fill=true]/panelbox:lg:max-h-none",
                phoneMediaClass,
              )}
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
            className={cn(
              "aspect-video w-full bg-black object-contain lg:max-h-[calc(var(--game-panel-box-max-height,100dvh)-192px)] group-data-[game-panel-fill=true]/panelbox:aspect-auto group-data-[game-panel-fill=true]/panelbox:h-full group-data-[game-panel-fill=true]/panelbox:min-h-0 group-data-[game-panel-fill=true]/panelbox:flex-1! group-data-[game-panel-fill=true]/panelbox:lg:max-h-none",
              phoneMediaClass,
            )}
            draggable={false}
          />
        )
      ) : failed ? null : (
        <div className="flex min-h-20 w-full items-center justify-center gap-2 bg-black/45 text-xs text-white/55 lg:aspect-video group-data-[game-panel-fill=true]/panelbox:aspect-auto group-data-[game-panel-fill=true]/panelbox:min-h-0 group-data-[game-panel-fill=true]/panelbox:flex-1! group-data-[game-panel-fill=true]/panelbox:lg:aspect-auto">
          {effectiveGenerating ? <Loader2 size={14} className="animate-spin" /> : null}
          {frame
            ? localizeUi(
                frame.status === "failed"
                  ? "game.storyboard.friendlyFailure"
                  : STORYBOARD_KEYFRAME_STATUS_KEYS[frame.status],
              )
            : localizeUi("ui.game.gamesurfacecomponent.creatingStoryboard")}
        </div>
      )}

      <div className="space-y-2 px-3 py-2.5">
        {frameStillGenerating ? (
          <p className="text-[0.6875rem] text-white/70" role="status">
            {localizeUi("game.storyboard.frameStillGenerating")}
          </p>
        ) : null}
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
                  aria-label={localizeUi("ui.game.gamesurfacecomponent.replayStoryboardVideo")}
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
                  aria-label={
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
                  aria-label={
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
        {failed ? null : (
          <p className="line-clamp-2 text-[0.6875rem] leading-4 text-white/58">
            {frame?.anchorQuote || frame?.narrationBeat || localizeUi("game.storyboard.generatingKeyframes")}
          </p>
        )}
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

      <StoryboardDebugDetails>
        {plannedFrameCount > 0 ? (
          <p className="text-[0.625rem] tabular-nums" role="status">
            {localizeUi("game.storyboard.readyCount", { ready: readyFrameCount, total: plannedFrameCount })}
          </p>
        ) : null}
        {generationError && !effectiveGenerating ? (
          <div role="alert" className="space-y-1">
            <p className="font-semibold">{localizeUi("ui.game.gamesurfacecomponent.storyboardGenerationFailed")}</p>
            <p className="break-words whitespace-pre-wrap">{generationError}</p>
          </div>
        ) : null}
        {storyboard?.error ? (
          <div className="space-y-1">
            <p className="font-semibold">{localizeUi("ui.game.gamesurfacecomponent.storyboardDegradedResult")}</p>
            <p className="break-words text-[0.625rem] leading-4">{storyboard.error}</p>
          </div>
        ) : null}
        {frame?.error ? (
          <div className="max-h-36 space-y-1 overflow-y-auto break-words" data-storyboard-frame-error>
            <p className="font-semibold">{localizeUi("game.storyboard.errorDetails")}</p>
            <p>{frame.error}</p>
            {frame.status === "failed" ? <p>{localizeUi("game.storyboard.errorRetryHint")}</p> : null}
          </div>
        ) : null}
        <div className="-mx-3 -mb-1.5">
          <GameStoryboardTimings chatId={chatId ?? storyboard?.chatId} generating={effectiveGenerating} />
        </div>
      </StoryboardDebugDetails>
    </div>
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
