// ──────────────────────────────────────────────
// Game: Lock + drag helpers for HUD panels
//
// Each panel (widget cards, map) uses `useDraggablePanel`
// to persist a lock flag and {x,y} offset. State is scoped
// by chatId so positions don't bleed across games.
// `PanelLockButton` renders the lock toggle in headers.
// ──────────────────────────────────────────────
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useMotionValue } from "framer-motion";
import { Lock, Unlock } from "lucide-react";
import { cn } from "../../lib/utils";
import { useTranslation as useUiTranslation } from "react-i18next";

const STORAGE_PREFIX = "marinara-game-panel:";
const MIN_VISIBLE_PANEL_PX = 96;

interface PanelState {
  locked: boolean;
  x: number;
  y: number;
  bottom?: number;
  relativeX?: number;
  relativeY?: number;
  surfaceWidth?: number;
  surfaceHeight?: number;
}

function storageKey(scopeId: string, panelId: string): string {
  return `${STORAGE_PREFIX}${scopeId}:${panelId}`;
}

function readPanelState(key: string): PanelState {
  if (typeof window === "undefined") return { locked: true, x: 0, y: 0 };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { locked: true, x: 0, y: 0 };
    const parsed = JSON.parse(raw) as Partial<PanelState>;
    return {
      locked: parsed.locked !== false,
      x: Number.isFinite(parsed.x) ? (parsed.x as number) : 0,
      y: Number.isFinite(parsed.y) ? (parsed.y as number) : 0,
      bottom: Number.isFinite(parsed.bottom) ? parsed.bottom : undefined,
      relativeX: Number.isFinite(parsed.relativeX) ? Math.max(0, Math.min(1, parsed.relativeX!)) : undefined,
      relativeY: Number.isFinite(parsed.relativeY) ? Math.max(0, Math.min(1, parsed.relativeY!)) : undefined,
      surfaceWidth: parsed.surfaceWidth,
      surfaceHeight: parsed.surfaceHeight,
    };
  } catch {
    return { locked: true, x: 0, y: 0 };
  }
}

function writePanelState(key: string, state: PanelState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // quota / unavailable — best-effort only
  }
}

function clampOffsetToViewport(value: number, axis: "x" | "y") {
  if (typeof window === "undefined") return value;
  const viewportSize = axis === "x" ? window.innerWidth : window.innerHeight;
  const limit = Math.max(0, viewportSize - MIN_VISIBLE_PANEL_PX);
  return Math.max(-limit, Math.min(limit, value));
}

function clampPanelState(state: PanelState): PanelState {
  return {
    ...state,
    x: clampOffsetToViewport(state.x, "x"),
    y: clampOffsetToViewport(state.y, "y"),
  };
}

/**
 * Returns motion values + lock state for a draggable HUD panel, persisted per
 * chat so positions don't bleed across games. Reads from localStorage
 * synchronously on first render to avoid a hydration-flicker where a moved
 * panel paints at origin before snapping back.
 */
export function useDraggablePanel(
  scopeId: string,
  panelId: string,
  bounds?: {
    surface: RefObject<HTMLElement | null>;
    panel: RefObject<HTMLElement | null>;
    side: "hud_left" | "hud_right";
    slot: number;
    ready?: boolean;
    anchor?: "top" | "bottom";
    skipRightEdgeWidthAdjustment?: boolean;
  },
) {
  const key = storageKey(scopeId, panelId);

  // Synchronous first-render hydration via a ref-captured seed.
  const seedRef = useRef<PanelState | null>(null);
  if (seedRef.current === null) {
    seedRef.current = readPanelState(key);
  }
  // Measured panels clamp to their own size; a bookmark can be narrower than 96px.
  const seed = bounds ? seedRef.current : clampPanelState(seedRef.current);

  const [locked, setLocked] = useState(seed.locked);
  const x = useMotionValue(seed.x);
  const y = useMotionValue(seed.y);

  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const initialized = useRef(false);
  const previousHeight = useRef<number | null>(null);
  const previousAnchor = useRef(bounds?.anchor);
  const bottomEdge = useRef<number | null>(null);
  const appliedY = useRef<number | null>(null);
  const surfaceSize = useRef<{ width: number; height: number } | null>(
    seed.surfaceWidth && seed.surfaceHeight ? { width: seed.surfaceWidth, height: seed.surfaceHeight } : null,
  );
  const relative = useRef({ x: seed.relativeX, y: seed.relativeY });
  const placementChanged = useRef(false);
  const previousPanelWidth = useRef<number | null>(null);

  const clampAndPersist = useCallback(() => {
    let next = clampPanelState({ locked, x: x.get(), y: y.get() });
    let shouldPersist = true;
    const bounded = boundsRef.current;
    if (bounded) {
      const surface = bounded.surface.current;
      const panel = bounded.panel.current;
      if (!surface || !panel || !surface.clientWidth || !surface.clientHeight) return;
      const maxX = Math.max(0, surface.clientWidth - panel.offsetWidth);
      const panelWidth = panel.getBoundingClientRect().width;
      const panelHeight = panel.getBoundingClientRect().height;
      const hadSurfaceSize = surfaceSize.current != null;
      const explicitPlacementChange = placementChanged.current;
      shouldPersist = !hadSurfaceSize || explicitPlacementChange;
      const maxY = Math.max(0, surface.clientHeight - panelHeight);
      const surfaceChanged =
        surfaceSize.current != null &&
        (surfaceSize.current.width !== surface.clientWidth || surfaceSize.current.height !== surface.clientHeight);
      if (!placementChanged.current && relative.current.x != null && surfaceChanged) x.set(relative.current.x * maxX);
      else if (
        !placementChanged.current &&
        bounded.side === "hud_right" &&
        !bounded.skipRightEdgeWidthAdjustment &&
        previousPanelWidth.current != null &&
        Math.abs(previousPanelWidth.current - panelWidth) > 0.1
      )
        x.set(x.get() + previousPanelWidth.current - panelWidth);
      previousPanelWidth.current = panelWidth;
      if (surfaceChanged && !placementChanged.current) {
        if (relative.current.y != null) y.set(relative.current.y * maxY);
        bottomEdge.current = y.get() + panelHeight;
        appliedY.current = y.get();
      }
      surfaceSize.current = { width: surface.clientWidth, height: surface.clientHeight };
      if (bounded.anchor === "bottom") {
        if (bottomEdge.current == null || previousAnchor.current !== "bottom")
          bottomEdge.current =
            previousHeight.current == null && seedRef.current?.bottom != null
              ? seedRef.current.bottom
              : y.get() + panelHeight;
        else if (appliedY.current != null && Math.abs(y.get() - appliedY.current) > 0.1)
          bottomEdge.current = y.get() + (previousHeight.current ?? panelHeight);
        bottomEdge.current = Math.min(surface.clientHeight, bottomEdge.current);
        y.set(Math.max(0, bottomEdge.current - panelHeight));
      }
      previousHeight.current = panelHeight;
      previousAnchor.current = bounded.anchor;
      if (!initialized.current) {
        initialized.current = true;
        if (!window.localStorage.getItem(key)) {
          x.set(bounded.side === "hud_right" ? Math.max(0, maxX - 12) : 12);
          y.set(48 + bounded.slot * 44);
        }
      }
      next = { locked, x: Math.max(0, Math.min(maxX, x.get())), y: Math.max(0, Math.min(maxY, y.get())) };
      next.bottom = next.y + panelHeight;
      next.surfaceWidth = surface.clientWidth;
      next.surfaceHeight = surface.clientHeight;
      if (relative.current.x == null || placementChanged.current) relative.current.x = maxX > 0 ? next.x / maxX : 0;
      if (relative.current.y == null || placementChanged.current) relative.current.y = maxY > 0 ? next.y / maxY : 0;
      next.relativeX = relative.current.x;
      next.relativeY = relative.current.y;
      placementChanged.current = false;
      appliedY.current = next.y;
    }
    if (next.x !== x.get()) x.set(next.x);
    if (next.y !== y.get()) y.set(next.y);
    // Automatic resize/collision reflow updates the display position only. Keep the
    // user's saved anchor until an explicit drag/reset changes placement.
    if (shouldPersist) writePanelState(key, next);
  }, [key, locked, x, y]);

  useLayoutEffect(() => {
    if (!boundsRef.current) return;
    clampAndPersist();
    const observer = new ResizeObserver(clampAndPersist);
    for (const element of [boundsRef.current.surface.current, boundsRef.current.panel.current]) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [clampAndPersist, bounds?.ready, bounds?.anchor]);

  useEffect(() => {
    clampAndPersist();
    if (typeof window === "undefined") return;
    window.addEventListener("resize", clampAndPersist);
    return () => window.removeEventListener("resize", clampAndPersist);
  }, [clampAndPersist]);

  const toggleLocked = useCallback(() => {
    setLocked((prev) => {
      const next = !prev;
      // Measured panels keep their saved anchor: x/y may hold a temporary reflow position.
      const stored =
        boundsRef.current && window.localStorage.getItem(key)
          ? readPanelState(key)
          : clampPanelState({
              locked: next,
              x: x.get(),
              y: y.get(),
              relativeX: relative.current.x,
              relativeY: relative.current.y,
            });
      writePanelState(key, { ...stored, locked: next });
      return next;
    });
  }, [key, x, y]);

  /** Set the lock explicitly (Lock all / Unlock all in the layout editor). */
  const setLockedTo = useCallback(
    (next: boolean) => {
      setLocked((prev) => {
        if (prev === next) return prev;
        // Keep the saved anchor untouched: x/y may hold a temporary reflow position.
        const stored = window.localStorage.getItem(key)
          ? readPanelState(key)
          : { locked: next, x: x.get(), y: y.get(), relativeX: relative.current.x, relativeY: relative.current.y };
        writePanelState(key, { ...stored, locked: next });
        return next;
      });
    },
    [key, x, y],
  );

  const handleDragEnd = useCallback(() => {
    placementChanged.current = true;
    clampAndPersist();
  }, [clampAndPersist]);

  const resetPosition = useCallback(() => {
    x.set(0);
    y.set(0);
    writePanelState(key, { locked, x: 0, y: 0 });
  }, [key, locked, x, y]);

  return { locked, toggleLocked, setLockedTo, resetPosition, x, y, handleDragEnd };
}

interface PanelLockButtonProps {
  locked: boolean;
  onToggle: () => void;
  onReset?: () => void;
  /** Icon size in px. Matches the adjacent collapse indicator. */
  size?: number;
  className?: string;
}

/** Small lock toggle styled to match collapse/chevron buttons in HUD panels. */
export function PanelLockButton({ locked, onToggle, onReset, size = 10, className }: PanelLockButtonProps) {
  const { t: localizeUi } = useUiTranslation();
  const title = onReset
    ? locked
      ? "Unlock to move. Double-click or press R to reset position"
      : "Lock in place. Double-click or press R to reset position"
    : locked
      ? "Unlock to move"
      : "Lock in place";

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(event) => {
        if (!onReset) return;
        event.stopPropagation();
        onReset();
      }}
      onKeyDown={(event) => {
        if (!onReset || event.key.toLowerCase() !== "r") return;
        event.preventDefault();
        event.stopPropagation();
        onReset();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      title={title}
      aria-label={
        locked ? localizeUi("ui.game.panellockbutton.unlockPanel") : localizeUi("ui.game.panellockbutton.lockPanel")
      }
      aria-pressed={!locked}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md text-[var(--marinara-chat-chrome-panel-muted)]",
        "transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] hover:text-[var(--marinara-chat-chrome-highlight-text)]",
        className,
      )}
    >
      {locked ? <Lock size={size} /> : <Unlock size={size} />}
    </button>
  );
}
