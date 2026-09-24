import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { motion, useMotionValue } from "framer-motion";
import { Bookmark, EyeOff, GripVertical, Lock, LockOpen, Ellipsis, Pin, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDraggablePanel } from "./DraggablePanel";
import {
  GameLayoutPopover,
  LAYOUT_SOLID_BACKGROUND,
  LayoutMenuButton,
  LayoutPopoverSection,
  LayoutSegmented,
} from "./GameLayoutPopover";
import {
  GAME_PANEL_HUD_LAYER,
  GAME_PANEL_INTERACTIVE_LAYER,
  GAME_PANEL_LAYOUT_PASS_EVENT,
  GAME_PANEL_STACK_CHANGE_EVENT,
  arrangeRegisteredPanelStack,
  beginRegisteredPanelDrag,
  beginRegisteredPanelResize,
  commitRegisteredPanelGroup,
  constrainRegisteredPanelDrag,
  gamePanelHasNeighbourAbove,
  readGamePanelStacks,
  registeredGamePanelOptions,
  registerGamePanel,
  scheduleGamePanelLayout,
  setGamePanelLayoutSuspended,
  snapPanelDragPosition,
  subscribeGamePanelRegistry,
  writeGamePanelStackMembership,
  type PanelDragSession,
} from "../../lib/game-panel-layout";
import {
  LAYOUT_GRID,
  constrainResizeRect,
  snapResizeRect,
  type LayoutRect,
  type ResizeEdges,
  type SnapTargets,
} from "../../lib/game-layout-geometry";
import {
  GAME_LAYOUT_LOCK_ALL_EVENT,
  UNHIDEABLE_PANEL_IDS,
  bringPanelToFront,
  isLayoutCollisionsEnabled,
  isLayoutSnapEnabled,
  registerLayoutCatalogEntry,
  requestLayoutRecord,
  setLayoutDragOverlay,
  setPanelHidden,
  togglePanelSelection,
  useIsFrontPanel,
  usePanelHidden,
  usePanelSelected,
} from "../../lib/game-layout-editor-store";

export const GamePanelContext = createContext<{
  chatId: string;
  legacyChatId?: string;
  surface: RefObject<HTMLElement | null>;
  layoutEditing?: boolean;
  /** Bumped when a whole layout is applied (undo, saved layout, reset) so panels remount from storage. */
  layoutRevision?: number;
} | null>(null);

function migratePanelLayoutStorage(legacyChatId: string | undefined, scopeId: string): void {
  if (!legacyChatId || legacyChatId === scopeId || typeof window === "undefined") return;
  try {
    const migrationMarkerKey = `marinara-game-panel-migration:v1:${legacyChatId}:${scopeId}`;
    if (localStorage.getItem(migrationMarkerKey) === "done") return;
    const legacyPrefix = `marinara-game-panel:${legacyChatId}:`;
    const scopePrefix = `marinara-game-panel:${scopeId}:`;
    const stackKey = `marinara-game-panel-stacks:${legacyChatId}`;
    const scopeStackKey = `marinara-game-panel-stacks:${scopeId}`;
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(
      (key): key is string => key !== null,
    );
    for (const key of keys) {
      const targetKey = key.startsWith(legacyPrefix)
        ? `${scopePrefix}${key.slice(legacyPrefix.length)}`
        : key === stackKey
          ? scopeStackKey
          : null;
      if (targetKey && localStorage.getItem(targetKey) === null) {
        const value = localStorage.getItem(key);
        if (value !== null) localStorage.setItem(targetKey, value);
      }
    }
    localStorage.setItem(migrationMarkerKey, "done");
  } catch {
    // Device-local layout migration is best effort; panel defaults remain valid.
  }
}

const TUCK_TAB_WIDTH = 36;
const TUCK_TAB_HEIGHT = 40;
const MIN_PANEL_WIDTH = 140;
const MIN_PANEL_HEIGHT = 64;
const DRAG_THRESHOLD_PX = 3;
const SETTLE_DURATION_MS = 170;
const EDIT_ACCENT = "var(--marinara-chat-chrome-accent, var(--primary))";
const OVERLAP_COLOR = "#ef4444";
/** How far the edit name tag rises above the panel's top border. */
const NAME_TAG_OUTSET = 11;

const KNOWN_PANEL_LABELS: Record<string, string> = {
  narration: "ui.game.layoutEditor.panelNarration",
  toolbar: "ui.game.layoutEditor.panelToolbar",
  map: "ui.game.layoutEditor.panelMap",
  storyboard: "ui.game.layoutEditor.panelStoryboard",
  "scene-presence": "ui.game.layoutEditor.panelScenePresence",
  "game-status": "ui.game.layoutEditor.panelGameStatus",
};

/** Human label for a panel id, used by the edit chip and the Panels menu. */
export function useGamePanelLabel(id: string, tuckLabel?: string): string {
  const { t } = useTranslation();
  if (tuckLabel) return tuckLabel;
  const known = KNOWN_PANEL_LABELS[id];
  if (known) return t(known);
  const bare = id.startsWith("widget:") ? id.slice("widget:".length) : id;
  return bare.replace(/[-_]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

interface Props {
  id: string;
  children: ReactNode;
  width: number;
  side?: "hud_left" | "hud_right";
  slot?: number;
  bottom?: boolean;
  widgetId?: string;
  hidden?: boolean;
  height?: number;
  overflowVisible?: boolean;
  collapsed?: boolean;
  /** Reading/input panels must grow with content even after a manual resize. */
  autoGrow?: boolean;
  /** Keep the panel width synchronized to measured content. */
  autoWidth?: boolean;
  /** Reserve the measured desktop portal height in the source flow. */
  reserveSpace?: boolean;
  /** Raise an interactive panel stack above HUD widgets without competing with dialogs. */
  layer?: number;
  /** Allow the toolbar to be pinned to the responsive top-center anchor. */
  allowTopCenterPin?: boolean;
  /** Allow an edge tab to tuck this panel away. */
  allowTuck?: boolean;
  /** Optional icon rendered in the collapsed edge tab. */
  tuckIcon?: ReactNode;
  /** Optional label appended to the collapsed tab's accessible title. */
  tuckLabel?: string;
  /** Meaningful widget-value signature used for transient reveal after changes. */
  revealOnValueChangeKey?: string;
  /** With a fixed height, stretch the content to fill the panel box (data-game-panel-fill on the content). */
  fillHeight?: boolean;
}

/** Height of content kept visible above a data-game-panel-keep element when a crowded layout shrinks the panel. */
const GAME_PANEL_KEEP_CONTEXT = 272;

/** Desktop overlays share a surface, never a flow-layout stack. Phone layouts stay inline. */
export function FloatingGamePanel(props: Props) {
  const context = useContext(GamePanelContext);
  // Keep compact Game layouts active for portrait landscape phones and small tablets.
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const scopeId = context?.chatId;
  const label = useGamePanelLabel(props.id, props.tuckLabel);
  const userHidden = usePanelHidden(scopeId, props.id);
  const floating = !!context && desktop && !props.hidden;
  // List every panel the game offers (including user-hidden ones) in the Panels menu.
  useEffect(() => {
    if (!floating || !scopeId) return;
    return registerLayoutCatalogEntry(scopeId, {
      id: props.id,
      label,
      hideable: !UNHIDEABLE_PANEL_IDS.has(props.id),
    });
  }, [floating, label, props.id, scopeId]);
  if (props.hidden) return null;
  if (!context || !desktop) return props.children;
  if (userHidden) return null;
  migratePanelLayoutStorage(context.legacyChatId, context.chatId);
  return (
    <FloatingFrame
      key={`${context.chatId}:${props.id}:${context.layoutRevision ?? 0}`}
      {...props}
      {...context}
      label={label}
    />
  );
}

type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const RESIZE_HANDLES: ResizeHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const HANDLE_CURSOR: Record<ResizeHandle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

function edgesFor(handle: ResizeHandle): ResizeEdges {
  return {
    top: handle.includes("n"),
    bottom: handle.includes("s"),
    left: handle.includes("w"),
    right: handle.includes("e"),
  };
}

function handleHitStyle(handle: ResizeHandle): CSSProperties {
  const edge = 10;
  const corner = 16;
  const style: CSSProperties = { position: "absolute", zIndex: 23, cursor: HANDLE_CURSOR[handle], touchAction: "none" };
  if (handle.length === 2) {
    Object.assign(style, { width: corner, height: corner });
    if (handle.includes("n")) style.top = -corner / 2;
    else style.bottom = -corner / 2;
    if (handle.includes("w")) style.left = -corner / 2;
    else style.right = -corner / 2;
    return style;
  }
  if (handle === "n" || handle === "s") {
    Object.assign(style, { left: corner / 2, right: corner / 2, height: edge });
    if (handle === "n") style.top = -edge / 2;
    else style.bottom = -edge / 2;
  } else {
    Object.assign(style, { top: corner / 2, bottom: corner / 2, width: edge });
    if (handle === "w") style.left = -edge / 2;
    else style.right = -edge / 2;
  }
  return style;
}

function tweenPosition(
  from: { x: number; y: number },
  to: { x: number; y: number },
  apply: (x: number, y: number) => void,
  done: () => void,
): void {
  const start = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - start) / SETTLE_DURATION_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    apply(from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased);
    if (progress < 1) requestAnimationFrame(step);
    else done();
  };
  requestAnimationFrame(step);
}

function FloatingFrame({
  id,
  children,
  width,
  side = "hud_left",
  slot = 0,
  bottom,
  widgetId,
  height,
  overflowVisible,
  collapsed,
  autoGrow,
  autoWidth,
  reserveSpace,
  layer = GAME_PANEL_HUD_LAYER,
  allowTopCenterPin = false,
  allowTuck = false,
  tuckIcon,
  tuckLabel,
  revealOnValueChangeKey,
  fillHeight = false,
  chatId,
  surface,
  layoutEditing = false,
  label,
}: Props & {
  chatId: string;
  surface: RefObject<HTMLElement | null>;
  layoutEditing?: boolean;
  label: string;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const intrinsicContent = useRef<HTMLDivElement>(null);
  const sizeKey = `marinara-game-panel:${chatId}:floating:${id}:size-v2`;
  const growthPreferenceKey = `${sizeKey}:growth-explicit`;
  const bottomLockKey = `marinara-game-panel:${chatId}:floating:${id}:bottom-lock`;
  const topCenterLockKey = `marinara-game-panel:${chatId}:floating:${id}:top-center-lock`;
  const tuckKey = `marinara-game-panel:${chatId}:floating:${id}:tucked`;
  const tuckEdgeKey = `${tuckKey}:edge`;
  const frontKey = `${chatId}:${id}`;
  const isFront = useIsFrontPanel(frontKey);
  const selected = usePanelSelected(chatId, id) && layoutEditing;
  const record = useCallback((delay?: number) => requestLayoutRecord(chatId, delay), [chatId]);
  const [stackGroups, setStackGroups] = useState<Record<string, string>>(() => readGamePanelStacks(chatId));
  const stackEnabled = id.startsWith("widget:");
  const stackGroup = stackEnabled ? (stackGroups[id] ?? null) : null;
  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ chatId?: string }>).detail?.chatId === chatId)
        setStackGroups(readGamePanelStacks(chatId));
    };
    window.addEventListener(GAME_PANEL_STACK_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(GAME_PANEL_STACK_CHANGE_EVENT, refresh);
  }, [chatId]);
  const setStack = useCallback(
    (groupId: string | null) => {
      if (groupId) {
        const members = new Set<string>([id]);
        for (const [panelId, panelGroup] of Object.entries(stackGroups)) {
          if (panelGroup === groupId && panelId.startsWith("widget:")) members.add(panelId);
        }
        if (groupId.startsWith("widget:")) members.add(groupId);
        writeGamePanelStackMembership(chatId, [...members], groupId);
      } else {
        writeGamePanelStackMembership(chatId, [], null, id);
      }
      window.setTimeout(() => {
        if (surface.current && groupId) arrangeRegisteredPanelStack(surface.current, groupId);
        if (surface.current) scheduleGamePanelLayout(surface.current);
        record(120);
      }, 0);
    },
    [chatId, id, record, stackGroups, surface],
  );
  const [bottomLocked, setBottomLocked] = useState(() => {
    if (id !== "narration") return false;
    try {
      return localStorage.getItem(bottomLockKey) === "true";
    } catch {
      return false;
    }
  });
  const [topCenterPinned, setTopCenterPinned] = useState(() => {
    if (!allowTopCenterPin) return false;
    try {
      return localStorage.getItem(topCenterLockKey) === "true";
    } catch {
      return false;
    }
  });
  const [tucked, setTucked] = useState(() => {
    if (!allowTuck) return false;
    try {
      return localStorage.getItem(tuckKey) === "true";
    } catch {
      return false;
    }
  });
  const [tuckEdge, setTuckEdge] = useState<"left" | "right" | "top">(() => {
    try {
      const stored = localStorage.getItem(tuckEdgeKey);
      return stored === "left" || stored === "right" || stored === "top"
        ? stored
        : side === "hud_right"
          ? "right"
          : "left";
    } catch {
      return side === "hud_right" ? "right" : "left";
    }
  });
  const [interactionReveal, setInteractionReveal] = useState(false);
  const [temporaryReveal, setTemporaryReveal] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tuckRevealAnchorY, setTuckRevealAnchorY] = useState<number | null>(null);
  const interactionRevealRef = useRef(false);
  const focusedRef = useRef(false);
  const previousValueKey = useRef(revealOnValueChangeKey);
  const tuckedClosed = allowTuck && tucked && !interactionReveal && !temporaryReveal;
  useEffect(() => {
    if (tuckedClosed) setTuckRevealAnchorY(null);
  }, [tuckedClosed]);
  useEffect(() => {
    if (!allowTuck || !tucked) return;
    const closeOnPointerExit = (event: PointerEvent) => {
      if (focusedRef.current || !panel.current) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      if (!hit || !panel.current.contains(hit)) setInteractionReveal(false);
    };
    // Reflow can move a floating panel without producing React's mouseleave.
    // A real pointer exit must still end a hover reveal.
    window.addEventListener("pointermove", closeOnPointerExit);
    return () => window.removeEventListener("pointermove", closeOnPointerExit);
  }, [allowTuck, tucked]);
  const collapseToEdge = useCallback(() => {
    setInteractionReveal(false);
    setFocused(false);
    setTemporaryReveal(false);
    setTuckRevealAnchorY(null);
    setTucked(true);
  }, []);
  useEffect(() => {
    interactionRevealRef.current = interactionReveal;
    focusedRef.current = focused;
  }, [focused, interactionReveal]);
  const [growth, setGrowth] = useState<"top" | "bottom" | "fixed">(() => {
    try {
      const stored = localStorage.getItem(`${sizeKey}:growth`);
      const explicit = localStorage.getItem(growthPreferenceKey) === "true";
      if (stored === "top" || stored === "bottom" || (stored === "fixed" && (!autoGrow || explicit))) return stored;
    } catch {
      /* Device-local preference is optional. */
    }
    return autoGrow ? "bottom" : "fixed";
  });
  const growsWithContent = growth !== "fixed";
  const [size, setSize] = useState<{ width: number; height?: number; manualWidth?: boolean }>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(sizeKey) ?? "null");
      return {
        width: Number.isFinite(stored?.width) ? Math.max(MIN_PANEL_WIDTH, stored.width) : width,
        // A stored height under the minimum is not a real choice (a crushed reflow or a
        // hand-edited value); treat it as unset so the panel sizes to its content.
        height: Number.isFinite(stored?.height) && stored.height >= MIN_PANEL_HEIGHT ? stored.height : height,
        manualWidth: stored?.manualWidth === true,
      };
    } catch {
      return { width, height };
    }
  });
  /** Switch to an explicit fixed height, as picking "Fixed height" does, so growth never undoes a manual size. */
  const fixHeight = useCallback(
    (nextHeight?: number) => {
      try {
        localStorage.setItem(growthPreferenceKey, "true");
      } catch {
        /* Best effort. */
      }
      if (nextHeight != null) setSize((current) => ({ ...current, height: nextHeight }));
      setGrowth("fixed");
    },
    [growthPreferenceKey],
  );
  const [available, setAvailable] = useState({ width: window.innerWidth, height: window.innerHeight });
  const tuckRevealGutter =
    tucked && !tuckedClosed && (tuckEdge === "left" || tuckEdge === "right")
      ? Math.min(TUCK_TAB_WIDTH, available.width)
      : 0;
  const expandedPanelWidth = Math.min(size.width + tuckRevealGutter, available.width);
  const [mounted, setMounted] = useState(false);
  const [panelHeight, setPanelHeight] = useState(0);
  const [layoutHeightLimit, setLayoutHeightLimit] = useState<number | null>(null);
  const layoutHeightLimitRef = useRef<number | null>(null);
  layoutHeightLimitRef.current = layoutHeightLimit;
  /** Content height measured the last time no crowded-layout limit applied. */
  const unlimitedNaturalHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const measure = () => setPanelHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mounted]);
  const { locked, toggleLocked, setLockedTo, resetPosition, x, y, handleDragEnd } = useDraggablePanel(
    chatId,
    `floating:${id}`,
    {
      surface,
      panel,
      side,
      slot,
      ready: mounted,
      anchor: tucked ? "top" : growth === "bottom" ? "bottom" : "top",
      // preferredAnchor owns width changes, including the untuck transition.
      skipRightEdgeWidthAdjustment: true,
    },
  );
  const panelLocked = locked || bottomLocked || topCenterPinned;
  useEffect(() => {
    const onLockAll = (event: Event) => {
      const detail = (event as CustomEvent<{ scopeId?: string; locked?: boolean }>).detail;
      if (detail?.scopeId === chatId && typeof detail.locked === "boolean") setLockedTo(detail.locked);
    };
    window.addEventListener(GAME_LAYOUT_LOCK_ALL_EVENT, onLockAll);
    return () => window.removeEventListener(GAME_LAYOUT_LOCK_ALL_EVENT, onLockAll);
  }, [chatId, setLockedTo]);
  const revealTuck = useCallback(() => {
    if (tucked && tuckEdge !== "top") setTuckRevealAnchorY((current) => current ?? y.get() + TUCK_TAB_HEIGHT / 2);
    setInteractionReveal(true);
  }, [tuckEdge, tucked, y]);
  const tuckTabTop = useMotionValue<string | number>("50%");
  useLayoutEffect(() => {
    const update = (value = y.get()) => {
      tuckTabTop.set(
        !tuckedClosed && tuckRevealAnchorY != null && tuckEdge !== "top" ? tuckRevealAnchorY - value : "50%",
      );
    };
    update();
    return y.on("change", update);
  }, [tuckEdge, tuckRevealAnchorY, tuckedClosed, tuckTabTop, y]);
  // Collision reflow is temporary. Keep a separate anchor so a later resize or
  // observer pass cannot treat the resolver's displacement as a new preference.
  const preferredPosition = useRef<{
    x: number;
    y: number;
    relativeX: number;
    relativeY: number;
    /** Surface size the absolute x/y belong to. */
    surfaceWidth?: number;
    surfaceHeight?: number;
  } | null>(null);
  const untuckAnchorX = useRef<number | null>(null);
  const preferredAnchor = useCallback(() => {
    const host = surface.current;
    const element = panel.current;
    const saved = preferredPosition.current;
    if (!host || !element || !saved) return { x: x.get(), y: y.get() };
    const maxX = Math.max(0, host.clientWidth - element.offsetWidth);
    const maxY = Math.max(0, host.clientHeight - element.offsetHeight);
    if (tucked) {
      const revealY = tuckedClosed ? saved.relativeY * maxY : y.get();
      return {
        x: tuckEdge === "right" ? maxX : tuckEdge === "top" ? Math.max(0, Math.min(saved.relativeX * maxX, maxX)) : 0,
        y: tuckEdge === "top" ? 0 : Math.max(0, Math.min(revealY, maxY)),
      };
    }
    if (topCenterPinned) {
      return { x: Math.max(0, (host.clientWidth - element.offsetWidth) / 2), y: 16 };
    }
    if (untuckAnchorX.current != null) {
      return {
        x: Math.max(0, Math.min(untuckAnchorX.current, maxX)),
        y: bottomLocked ? Math.max(0, maxY - 16) : saved.relativeY * maxY,
      };
    }
    // On an unchanged surface the anchor is absolute. Relative anchors depend on the panel's
    // current height, which a crowded reflow limits, and that feedback flipped the layout
    // between two solutions. After a surface resize, rebase once from the relative anchor.
    if (saved.surfaceWidth !== host.clientWidth || saved.surfaceHeight !== host.clientHeight) {
      preferredPosition.current = {
        ...saved,
        x: saved.relativeX * maxX,
        y: saved.relativeY * maxY,
        surfaceWidth: host.clientWidth,
        surfaceHeight: host.clientHeight,
      };
    }
    const anchor = preferredPosition.current ?? saved;
    return {
      x: Math.max(0, Math.min(anchor.x, maxX)),
      y: bottomLocked ? Math.max(0, maxY - 16) : Math.max(0, Math.min(anchor.y, maxY)),
    };
  }, [bottomLocked, surface, topCenterPinned, tuckEdge, tucked, tuckedClosed, x, y]);
  useLayoutEffect(() => {
    if (!tucked) return;
    const anchor = preferredAnchor();
    x.set(anchor.x);
    y.set(anchor.y);
  }, [preferredAnchor, tucked, tuckedClosed, available.width, available.height, x, y]);
  useLayoutEffect(() => {
    if (tucked || untuckAnchorX.current == null) return;
    const anchor = preferredAnchor();
    const preservedY = preferredPosition.current?.y ?? anchor.y;
    x.set(anchor.x);
    y.set(preservedY);
    const host = surface.current;
    const element = panel.current;
    if (host && element) {
      const maxX = Math.max(0, host.clientWidth - element.offsetWidth);
      const maxY = Math.max(0, host.clientHeight - element.offsetHeight);
      preferredPosition.current = {
        x: anchor.x,
        y: preservedY,
        relativeX: maxX > 0 ? anchor.x / maxX : 0,
        relativeY: maxY > 0 ? preservedY / maxY : 0,
        surfaceWidth: host.clientWidth,
        surfaceHeight: host.clientHeight,
      };
      handleDragEnd();
    }
    untuckAnchorX.current = null;
  }, [preferredAnchor, surface, tucked, available.width, available.height, handleDragEnd, x, y]);
  const rememberPosition = useCallback(
    (snap = false) => {
      const host = surface.current;
      const element = panel.current;
      if (host && element) {
        untuckAnchorX.current = null;
        if (snap && !bottomLocked) {
          x.set(snapPanelDragPosition(x.get(), Math.max(0, host.clientWidth - element.offsetWidth)));
          y.set(snapPanelDragPosition(y.get(), Math.max(0, host.clientHeight - element.offsetHeight)));
        }
        handleDragEnd();
        const maxX = Math.max(0, host.clientWidth - element.offsetWidth);
        const maxY = Math.max(0, host.clientHeight - element.offsetHeight);
        preferredPosition.current = {
          x: x.get(),
          y: y.get(),
          relativeX: maxX > 0 ? Math.max(0, Math.min(1, x.get() / maxX)) : 0,
          relativeY: maxY > 0 ? Math.max(0, Math.min(1, y.get() / maxY)) : 0,
          surfaceWidth: host.clientWidth,
          surfaceHeight: host.clientHeight,
        };
      }
    },
    [bottomLocked, handleDragEnd, surface, x, y],
  );
  const rememberPositionRef = useRef(rememberPosition);
  rememberPositionRef.current = rememberPosition;
  useLayoutEffect(() => {
    const host = surface.current;
    const element = panel.current;
    if (!host || !element) return;
    if (!preferredPosition.current) {
      const maxX = Math.max(0, host.clientWidth - element.offsetWidth);
      const maxY = Math.max(0, host.clientHeight - element.offsetHeight);
      preferredPosition.current = {
        x: x.get(),
        y: y.get(),
        relativeX: maxX > 0 ? Math.max(0, Math.min(1, x.get() / maxX)) : 0,
        relativeY: maxY > 0 ? Math.max(0, Math.min(1, y.get() / maxY)) : 0,
        surfaceWidth: host.clientWidth,
        surfaceHeight: host.clientHeight,
      };
    }
    // Fill panels (the storyboard) shrink their media to the box they are given, so while a
    // crowded-layout limit applies their measured height is not their natural height. Use
    // the last unlimited measurement then, or the limit and the measurement feed back into
    // each other and the whole layout flips between two states every frame.
    const measureNaturalHeight = () => {
      const measured = intrinsicContent.current
        ? Math.max(intrinsicContent.current.offsetHeight, intrinsicContent.current.scrollHeight)
        : element.offsetHeight;
      if (layoutHeightLimitRef.current == null) {
        unlimitedNaturalHeight.current = measured;
        return measured;
      }
      return fillHeight && unlimitedNaturalHeight.current != null
        ? Math.max(measured, unlimitedNaturalHeight.current)
        : measured;
    };
    return registerGamePanel(host, {
      id,
      element,
      locked: panelLocked,
      fixed: bottomLocked || topCenterPinned || tucked,
      bottomInset: bottomLocked ? 16 : undefined,
      stackGroup: stackEnabled ? stackGroup : null,
      firmHeight: !growsWithContent && !collapsed && size.height != null && !tuckedClosed,
      // The narration surface reserves the primary reading area. Keep it ahead
      // of optional HUD widgets when their saved positions would collide so
      // narration controls remain reachable while editing the layout.
      // The wide game toolbar claims its strip before widgets; placed last, it split the
      // screen in two and crowded layouts fell apart around it.
      priority:
        reserveSpace || bottomLocked || topCenterPinned || tucked ? 0 : id === "map" || id === "toolbar" ? 1 : 2,
      getPosition: () => ({ x: x.get(), y: y.get() }),
      getPreferredPosition: preferredAnchor,
      getSize: () => {
        const naturalHeight = measureNaturalHeight();
        const desiredHeight = collapsed
          ? naturalHeight
          : growsWithContent
            ? naturalHeight
            : (size.height ?? height ?? naturalHeight);
        // Content marked data-game-panel-keep (the narration composer) stays in view with some context above it.
        const keep = collapsed || tuckedClosed ? null : element.querySelector<HTMLElement>("[data-game-panel-keep]");
        return {
          width: tuckedClosed ? 36 : element.offsetWidth,
          height: tuckedClosed ? 40 : desiredHeight,
          minHeight: keep ? Math.min(desiredHeight, keep.offsetHeight + GAME_PANEL_KEEP_CONTEXT) : undefined,
        };
      },
      setHeightLimit: (nextHeight) => {
        const naturalHeight = measureNaturalHeight();
        const desiredHeight = collapsed
          ? naturalHeight
          : growsWithContent
            ? naturalHeight
            : (size.height ?? height ?? naturalHeight);
        const constrainedHeight = desiredHeight > nextHeight + 1 ? nextHeight : null;
        setLayoutHeightLimit((current) => (current === constrainedHeight ? current : constrainedHeight));
      },
      setPosition: (nextX, nextY) => {
        x.set(nextX);
        y.set(nextY);
      },
      setPreferredPosition: () => {
        const host = surface.current;
        const element = panel.current;
        if (!host || !element) return;
        const maxX = Math.max(0, host.clientWidth - element.offsetWidth);
        const maxY = Math.max(0, host.clientHeight - element.offsetHeight);
        preferredPosition.current = {
          x: x.get(),
          y: y.get(),
          relativeX: maxX > 0 ? Math.max(0, Math.min(1, x.get() / maxX)) : 0,
          relativeY: maxY > 0 ? Math.max(0, Math.min(1, y.get() / maxY)) : 0,
          surfaceWidth: host.clientWidth,
          surfaceHeight: host.clientHeight,
        };
      },
      commitPosition: () => rememberPositionRef.current(),
    });
  }, [
    id,
    locked,
    panelLocked,
    bottomLocked,
    topCenterPinned,
    tucked,
    tuckedClosed,
    preferredAnchor,
    handleDragEnd,
    surface,
    x,
    y,
    mounted,
    collapsed,
    growsWithContent,
    reserveSpace,
    stackGroup,
    stackEnabled,
    size.height,
    height,
    fillHeight,
    setLayoutHeightLimit,
  ]);
  useEffect(() => {
    if (id !== "narration") return;
    try {
      localStorage.setItem(bottomLockKey, String(bottomLocked));
    } catch {
      /* Best effort. */
    }
    if (bottomLocked && surface.current && panel.current) {
      const maxY = Math.max(0, surface.current.clientHeight - panel.current.offsetHeight);
      y.set(Math.max(0, maxY - 16));
      scheduleGamePanelLayout(surface.current);
    }
  }, [bottomLockKey, bottomLocked, id, surface, y]);
  useEffect(() => {
    if (!allowTopCenterPin) return;
    try {
      localStorage.setItem(topCenterLockKey, String(topCenterPinned));
    } catch {
      /* Best effort. */
    }
    if (topCenterPinned && surface.current && panel.current) {
      x.set(Math.max(0, (surface.current.clientWidth - panel.current.offsetWidth) / 2));
      y.set(16);
      scheduleGamePanelLayout(surface.current);
    }
  }, [allowTopCenterPin, topCenterLockKey, topCenterPinned, surface, x, y]);
  useEffect(() => {
    if (!allowTuck) return;
    try {
      localStorage.setItem(tuckKey, String(tucked));
      localStorage.setItem(tuckEdgeKey, tuckEdge);
    } catch {
      /* Best effort. */
    }
    if (surface.current) scheduleGamePanelLayout(surface.current);
  }, [allowTuck, surface, tuckEdge, tuckEdgeKey, tuckKey, tucked]);
  // Each real value change opens a fresh five-second reveal window.
  const [revealWindow, setRevealWindow] = useState(0);
  useEffect(() => {
    if (!allowTuck || revealOnValueChangeKey == null) return;
    if (previousValueKey.current === revealOnValueChangeKey) return;
    previousValueKey.current = revealOnValueChangeKey;
    if (!tucked) return;
    setTemporaryReveal(true);
    setRevealWindow((current) => current + 1);
    if (tuckEdge !== "top") setTuckRevealAnchorY((current) => current ?? y.get() + TUCK_TAB_HEIGHT / 2);
  }, [allowTuck, revealOnValueChangeKey, tuckEdge, tucked, y]);
  useEffect(() => {
    // The close timer belongs to the reveal, not to the effect that opened it: changing the
    // tuck edge mid-reveal used to clear the timer and leave the widget open for good.
    if (!temporaryReveal) return;
    let timer = window.setTimeout(closeAfterInteraction, 5000);
    function closeAfterInteraction() {
      if (interactionRevealRef.current || focusedRef.current) {
        timer = window.setTimeout(closeAfterInteraction, 250);
      } else {
        setTemporaryReveal(false);
      }
    }
    return () => window.clearTimeout(timer);
  }, [revealWindow, temporaryReveal]);
  // The name tag sits on the top border like a legend, covering only the gap above the
  // panel. At the top of the surface, or when another panel sits right above (tightly
  // stacked panels), it moves inside the panel's top edge instead of covering the neighbour.
  const [tagInside, setTagInside] = useState(false);
  useEffect(() => {
    const host = surface.current;
    if (!layoutEditing || !host) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const element = panel.current;
      if (!element) return;
      const top = y.get();
      setTagInside(
        top < 12 ||
          gamePanelHasNeighbourAbove(host, id, { x: x.get(), y: top, width: element.offsetWidth }, NAME_TAG_OUTSET + 1),
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    const stopX = x.on("change", schedule);
    const stopY = y.on("change", schedule);
    const unsubscribe = subscribeGamePanelRegistry(host, schedule);
    host.addEventListener(GAME_PANEL_LAYOUT_PASS_EVENT, schedule);
    return () => {
      cancelAnimationFrame(frame);
      stopX();
      stopY();
      unsubscribe();
      host.removeEventListener(GAME_PANEL_LAYOUT_PASS_EVENT, schedule);
    };
  }, [id, layoutEditing, surface, x, y]);
  const chipTop = tagInside ? 4 : -NAME_TAG_OUTSET;
  const chipLeft = tagInside ? 6 : 10;
  useLayoutEffect(() => setMounted(true), []);
  useLayoutEffect(() => {
    const host = surface.current;
    if (!host) return;
    const fit = () => setAvailable({ width: host.clientWidth, height: host.clientHeight });
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    observer.observe(panel.current ?? host);
    const schedule = () => scheduleGamePanelLayout(host);
    const panelObserver = new ResizeObserver(schedule);
    panelObserver.observe(host);
    if (panel.current) panelObserver.observe(panel.current);
    if (content.current) panelObserver.observe(content.current);
    if (intrinsicContent.current) panelObserver.observe(intrinsicContent.current);
    return () => {
      observer.disconnect();
      panelObserver.disconnect();
    };
  }, [mounted, surface, width]);
  useEffect(() => {
    if (!autoWidth) return;
    setSize((current) => (current.manualWidth || current.width === width ? current : { ...current, width }));
  }, [autoWidth, width]);
  useEffect(() => {
    try {
      localStorage.setItem(sizeKey, JSON.stringify(size));
    } catch {
      /* Device-local preference is best effort. */
    }
  }, [size, sizeKey]);
  useEffect(() => {
    try {
      localStorage.setItem(`${sizeKey}:growth`, growth);
    } catch {
      /* Best effort. */
    }
  }, [growth, sizeKey]);
  const initiallyPlaced = useRef(false);
  useLayoutEffect(() => {
    if (!mounted || !bottom || initiallyPlaced.current || !panel.current || !surface.current) return;
    initiallyPlaced.current = true;
    try {
      if (
        localStorage.getItem(`${sizeKey}:placed`) ||
        localStorage.getItem(`marinara-game-panel:${chatId}:floating:${id}:scale:placed`)
      )
        return;
      x.set(Math.max(0, (surface.current.clientWidth - panel.current.offsetWidth) / 2));
      y.set(Math.max(0, surface.current.clientHeight - panel.current.offsetHeight - 16));
      rememberPosition();
      localStorage.setItem(`${sizeKey}:placed`, "true");
    } catch {
      /* Storage can be disabled. */
    }
  }, [mounted, bottom, surface, x, y, rememberPosition, sizeKey, chatId, id]);

  // ── Layout editing: drag anywhere, resize from any edge, options popover ──
  const [interaction, setInteraction] = useState<"drag" | "resize" | "settle" | null>(null);
  const [overlapping, setOverlapping] = useState(false);
  const overlappingRef = useRef(false);
  const [sizeBadge, setSizeBadge] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsButton = useRef<HTMLButtonElement>(null);
  const moveHandle = useRef<HTMLButtonElement>(null);
  const dragState = useRef<{
    pointerId: number;
    element: HTMLElement;
    startX: number;
    startY: number;
    moved: boolean;
    session: PanelDragSession;
  } | null>(null);
  const resizeState = useRef<{
    pointerId: number;
    element: HTMLElement;
    handle: ResizeHandle;
    startX: number;
    startY: number;
    origin: LayoutRect;
    sizeBefore: typeof size;
    growthBefore: typeof growth;
    targets: SnapTargets;
    bounds: { width: number; height: number };
    obstacles: LayoutRect[];
    last: LayoutRect;
  } | null>(null);
  /** Abandon a drag or resize in progress: everything returns to where it started. */
  const cancelInteractionRef = useRef<() => void>(() => {});
  cancelInteractionRef.current = () => {
    const drag = dragState.current;
    const resize = resizeState.current;
    if (!drag && !resize) return;
    dragState.current = null;
    resizeState.current = null;
    if (drag) {
      if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
      if (drag.moved) drag.session.cancel();
    }
    if (resize) {
      if (resize.element.hasPointerCapture(resize.pointerId)) resize.element.releasePointerCapture(resize.pointerId);
      x.set(resize.origin.x);
      y.set(resize.origin.y);
      setSize(resize.sizeBefore);
      setGrowth(resize.growthBefore);
    }
    endInteraction();
  };
  useEffect(() => {
    if (layoutEditing) return;
    // Leaving edit mode mid-gesture removes the drag layer that would receive pointerup.
    cancelInteractionRef.current();
    setOptionsOpen(false);
    setInteraction(null);
    setSizeBadge(null);
  }, [layoutEditing]);
  useEffect(() => {
    if (interaction !== "drag" && interaction !== "resize") return;
    // Esc cancels the gesture; it must not also leave edit mode.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelInteractionRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [interaction]);
  useEffect(() => {
    const host = surface.current;
    return () => {
      // Undo, a saved layout or a chat switch can remount the panel mid-gesture: never leave
      // the resolver suspended or the guides drawn.
      if (!dragState.current && !resizeState.current) return;
      dragState.current = null;
      resizeState.current = null;
      setLayoutDragOverlay(null);
      if (host) setGamePanelLayoutSuspended(host, false);
    };
  }, [surface]);
  const setOverlapState = (next: boolean) => {
    if (overlappingRef.current === next) return;
    overlappingRef.current = next;
    setOverlapping(next);
  };
  const endInteraction = () => {
    setLayoutDragOverlay(null);
    setOverlapState(false);
    setSizeBadge(null);
    setInteraction(null);
    if (surface.current) {
      setGamePanelLayoutSuspended(surface.current, false);
      // Neighbours re-check their name tags against the committed position.
      surface.current.dispatchEvent(new Event(GAME_PANEL_LAYOUT_PASS_EVENT));
    }
  };

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!layoutEditing || event.button !== 0) return;
    bringPanelToFront(frontKey);
    if (panelLocked || interaction === "settle") return;
    const host = surface.current;
    if (!host) return;
    const session = beginRegisteredPanelDrag(host, id);
    if (!session) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      session,
    };
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      untuckAnchorX.current = null;
      if (surface.current) setGamePanelLayoutSuspended(surface.current, true);
      setInteraction("drag");
      setOptionsOpen(false);
    }
    event.preventDefault();
    const collide = isLayoutCollisionsEnabled();
    const frame = drag.session.move(dx, dy, isLayoutSnapEnabled() && !event.altKey, collide);
    setOverlapState(frame.overlaps.length > 0);
    setLayoutDragOverlay({ guides: frame.guides, overlaps: frame.overlaps, ghost: frame.ghost });
  };
  const finishDrag = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!drag.moved) return;
    event.preventDefault();
    const host = surface.current;
    const commit = () => {
      rememberPosition();
      if (host) commitRegisteredPanelGroup(host, id);
      endInteraction();
      record();
    };
    if (cancelled) {
      drag.session.cancel();
      endInteraction();
      return;
    }
    const from = drag.session.groupPosition();
    const to = drag.session.settleTarget(isLayoutCollisionsEnabled());
    setLayoutDragOverlay(null);
    if (Math.abs(from.x - to.x) < 0.5 && Math.abs(from.y - to.y) < 0.5) {
      commit();
      return;
    }
    // Settle into the nearest free spot with a short glide, never moving a neighbour.
    setInteraction("settle");
    setOverlapState(false);
    tweenPosition(from, to, (nextX, nextY) => drag.session.setGroupPosition(nextX, nextY), commit);
  };
  const nudge = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (panelLocked || event.ctrlKey || event.altKey || event.metaKey) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 40 : 10;
    const host = surface.current;
    const element = panel.current;
    const maxX = host && element ? Math.max(0, host.clientWidth - element.offsetWidth) : Infinity;
    const maxY = host && element ? Math.max(0, host.clientHeight - element.offsetHeight) : Infinity;
    const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
    x.set(clamp(x.get() + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0), maxX));
    y.set(clamp(y.get() + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0), maxY));
    rememberPosition();
    record(500);
  };

  const resizeTo = (nextWidth: number, nextHeight: number) =>
    setSize({
      manualWidth: true,
      width: Math.min(Math.max(MIN_PANEL_WIDTH, nextWidth), Math.max(MIN_PANEL_WIDTH, available.width - x.get())),
      height: Math.min(Math.max(MIN_PANEL_HEIGHT, nextHeight), Math.max(MIN_PANEL_HEIGHT, available.height - y.get())),
    });
  const startResize = (handle: ResizeHandle) => (event: ReactPointerEvent<HTMLElement>) => {
    if (!layoutEditing || panelLocked || event.button !== 0) return;
    const host = surface.current;
    const element = panel.current;
    if (!host || !element) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    bringPanelToFront(frontKey);
    setOptionsOpen(false);
    const origin = {
      x: x.get(),
      y: y.get(),
      width: element.offsetWidth - tuckRevealGutter,
      height: element.offsetHeight,
    };
    const edges = edgesFor(handle);
    // A height drag is an explicit size: stop content growth from undoing it.
    if ((edges.top || edges.bottom) && (growsWithContent || size.height == null)) fixHeight(origin.height);
    setGamePanelLayoutSuspended(host, true);
    const { targets, bounds, obstacles } = beginRegisteredPanelResize(host, id);
    resizeState.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      sizeBefore: size,
      growthBefore: growth,
      targets,
      bounds,
      obstacles,
      last: origin,
    };
    setInteraction("resize");
    setSizeBadge(`${Math.round(origin.width)} × ${Math.round(origin.height)}`);
  };
  const moveResize = (event: ReactPointerEvent<HTMLElement>) => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const edges = edgesFor(state.handle);
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    const { origin } = state;
    const raw = {
      x: edges.left ? origin.x + dx : origin.x,
      y: edges.top ? origin.y + dy : origin.y,
      width: origin.width + (edges.right ? dx : edges.left ? -dx : 0),
      height: origin.height + (edges.bottom ? dy : edges.top ? -dy : 0),
    };
    const snapOn = isLayoutSnapEnabled() && !event.altKey;
    const snapped = snapResizeRect(raw, edges, snapOn ? state.targets : null, {
      bounds: state.bounds,
      grid: snapOn ? LAYOUT_GRID : 0,
      minWidth: MIN_PANEL_WIDTH,
      minHeight: MIN_PANEL_HEIGHT,
    });
    const constrained = isLayoutCollisionsEnabled()
      ? constrainResizeRect(snapped.rect, origin, edges, state.obstacles, {
          width: MIN_PANEL_WIDTH,
          height: MIN_PANEL_HEIGHT,
        })
      : snapped.rect;
    const next = constrained ?? state.last;
    state.last = next;
    x.set(next.x);
    y.set(next.y);
    setSize((current) => ({
      manualWidth: edges.left || edges.right ? true : current.manualWidth,
      width: edges.left || edges.right ? next.width : current.width,
      height: edges.top || edges.bottom ? next.height : current.height,
    }));
    setSizeBadge(`${Math.round(next.width)} × ${Math.round(next.height)}`);
    const guides = snapped.guides.filter((guide) =>
      guide.axis === "x"
        ? Math.abs(guide.value - next.x) < 0.5 || Math.abs(guide.value - next.x - next.width) < 0.5
        : Math.abs(guide.value - next.y) < 0.5 || Math.abs(guide.value - next.y - next.height) < 0.5,
    );
    setLayoutDragOverlay({ guides, overlaps: [], ghost: null });
  };
  const finishResize = (event: ReactPointerEvent<HTMLElement>) => {
    const state = resizeState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    resizeState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    rememberPosition();
    endInteraction();
    record();
  };
  const resizeWithKeys = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const box = panel.current!.getBoundingClientRect();
    const step = event.shiftKey ? 40 : 10;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && growsWithContent) fixHeight(box.height);
    resizeTo(
      box.width + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
      box.height + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
    );
    record(500);
  };

  const tuckedDrag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const suppressTuckClick = useRef(false);
  const handleTuckPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!layoutEditing || event.button !== 0) return;
    suppressTuckClick.current = false;
    tuckedDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: x.get(),
      originY: y.get(),
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
  };
  const handleTuckPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = tuckedDrag.current;
    if (!drag || drag.pointerId !== event.pointerId || !surface.current || !panel.current) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    event.preventDefault();
    const maxX = Math.max(0, surface.current.clientWidth - panel.current.offsetWidth);
    const maxY = Math.max(0, surface.current.clientHeight - panel.current.offsetHeight);
    const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
    const requested = {
      x: tuckEdge === "right" ? maxX : tuckEdge === "top" ? clamp(drag.originX + dx, maxX) : 0,
      y: tuckEdge === "top" ? 0 : clamp(drag.originY + dy, maxY),
    };
    // Edge tabs slide along their edge. With collisions off they pass other tabs freely.
    const next = isLayoutCollisionsEnabled()
      ? constrainRegisteredPanelDrag(surface.current, id, { x: x.get(), y: y.get() }, requested, {
          width: panel.current.offsetWidth,
          height: panel.current.offsetHeight,
        })
      : requested;
    x.set(next.x);
    y.set(next.y);
    event.stopPropagation();
  };
  const handleTuckPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = tuckedDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      suppressTuckClick.current = true;
      event.preventDefault();
      rememberPosition();
      if (surface.current) commitRegisteredPanelGroup(surface.current, id);
      record();
    }
    tuckedDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    event.stopPropagation();
  };

  if (!mounted || !surface.current) return null;
  const fillBox = fillHeight && !growsWithContent && !collapsed && size.height != null && !tuckedClosed;
  const editChrome = layoutEditing && !tuckedClosed;
  const hideable = !UNHIDEABLE_PANEL_IDS.has(id);
  const outlineColor = overlapping
    ? OVERLAP_COLOR
    : panelLocked
      ? "color-mix(in srgb, var(--marinara-chat-chrome-panel-muted) 70%, transparent)"
      : EDIT_ACCENT;
  const baseZ = tucked ? Math.max(layer, GAME_PANEL_INTERACTIVE_LAYER) + 1 : reserveSpace ? layer + 1 : layer;
  const zIndex = baseZ + (isFront ? 2 : 0) + (interaction ? 6 : 0);
  const portal = createPortal(
    <motion.div
      ref={panel}
      data-game-floating-panel={id}
      data-game-floating-widget={widgetId}
      data-game-skip-bg-nav="true"
      data-layout-editing={editChrome ? "true" : undefined}
      data-layout-locked={editChrome && panelLocked ? "true" : undefined}
      data-layout-overlapping={overlapping ? "true" : undefined}
      data-layout-selected={editChrome && selected ? "true" : undefined}
      className="group/floating pointer-events-auto absolute left-0 top-0 z-30 max-w-full rounded-lg"
      style={{
        x,
        y,
        // The reserved narration panel owns the primary reading surface. Keep
        // its controls above same-layer optional widgets during a reflow.
        // Edge bookmarks must remain reachable above neighboring edit controls.
        zIndex,
        width: tuckedClosed ? 36 : expandedPanelWidth,
        height: tuckedClosed
          ? 40
          : layoutHeightLimit != null
            ? Math.min(layoutHeightLimit, available.height)
            : growsWithContent || collapsed || size.height == null
              ? undefined
              : Math.min(size.height, available.height),
        maxHeight: available.height,
        paddingLeft: tuckEdge === "left" ? tuckRevealGutter : 0,
        paddingRight: tuckEdge === "right" ? tuckRevealGutter : 0,
      }}
      onPointerDownCapture={(event) => {
        // Shift+click while editing toggles multi-select for the toolbar's align tools; no drag starts.
        if (editChrome && event.shiftKey) {
          event.stopPropagation();
          event.preventDefault();
          togglePanelSelection(chatId, id);
          return;
        }
        bringPanelToFront(frontKey);
      }}
      onMouseEnter={() => allowTuck && tucked && !layoutEditing && revealTuck()}
      onMouseLeave={(event) => {
        if (!allowTuck || focused) return;
        // Resizing/reflow can emit a transient leave while the pointer remains
        // over the expanded panel. Only collapse when the leave point is truly
        // outside the panel's current hit box.
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          rect.left <= event.clientX &&
          event.clientX <= rect.right &&
          rect.top <= event.clientY &&
          event.clientY <= rect.bottom
        )
          return;
        const revealTab = event.currentTarget.querySelector<HTMLButtonElement>("[data-game-tuck-tab]");
        const tabRect = revealTab?.getBoundingClientRect();
        if (
          tabRect &&
          tabRect.left <= event.clientX &&
          event.clientX <= tabRect.right &&
          tabRect.top <= event.clientY &&
          event.clientY <= tabRect.bottom
        )
          return;
        window.setTimeout(() => {
          if (
            panel.current?.matches(":hover") ||
            panel.current?.querySelector("[data-game-tuck-tab]")?.matches(":hover")
          )
            return;
          setInteractionReveal(false);
        }, 0);
      }}
      onFocus={() => {
        if (allowTuck && !(layoutEditing && tucked && tuckedDrag.current)) {
          setFocused(true);
          revealTuck();
        }
      }}
      onKeyDown={(event) => {
        // Esc closes a tuck reveal; on an untucked panel it stays free to leave edit mode.
        if (allowTuck && tucked && event.key === "Escape") {
          event.preventDefault();
          setFocused(false);
          setInteractionReveal(false);
          setTemporaryReveal(false);
        }
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as HTMLElement | null;
        // Focus moving into this panel's options popover (a portal) keeps a tuck reveal open.
        if (allowTuck && !event.currentTarget.contains(next) && !next?.closest?.("[data-layout-popover]")) {
          setFocused(false);
          setInteractionReveal(false);
        }
      }}
    >
      {allowTuck && tucked && (
        <motion.button
          type="button"
          aria-label={
            tuckLabel ? t("ui.game.floatingPanel.revealNamed", { name: tuckLabel }) : t("ui.game.floatingPanel.reveal")
          }
          data-game-tuck-tab
          title={
            tuckLabel ? t("ui.game.floatingPanel.revealNamed", { name: tuckLabel }) : t("ui.game.floatingPanel.reveal")
          }
          className="absolute z-30 flex h-10 w-9 touch-none items-center justify-center rounded-lg text-[var(--marinara-chat-chrome-panel-title)] focus-visible:outline focus-visible:outline-2"
          style={{
            ...(tuckEdge === "left"
              ? {
                  left: 0,
                  top: tuckTabTop,
                  transform: "translateY(-50%)",
                  width: TUCK_TAB_WIDTH,
                  height: TUCK_TAB_HEIGHT,
                }
              : tuckEdge === "right"
                ? {
                    right: 0,
                    top: tuckTabTop,
                    transform: "translateY(-50%)",
                    width: TUCK_TAB_WIDTH,
                    height: TUCK_TAB_HEIGHT,
                  }
                : {
                    left: "50%",
                    top: 0,
                    transform: "translateX(-50%)",
                    width: TUCK_TAB_WIDTH,
                    height: TUCK_TAB_HEIGHT,
                  }),
            ...(layoutEditing && tuckedClosed
              ? { outline: `1.5px dashed ${EDIT_ACCENT}`, outlineOffset: 2, cursor: "grab" }
              : null),
          }}
          onPointerDown={handleTuckPointerDown}
          onPointerMove={handleTuckPointerMove}
          onPointerUp={handleTuckPointerUp}
          onPointerCancel={(event) => {
            tuckedDrag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onFocus={() => {
            if (!(layoutEditing && tucked && tuckedDrag.current)) {
              setFocused(true);
              revealTuck();
            }
          }}
          onClick={() => {
            if (suppressTuckClick.current) {
              suppressTuckClick.current = false;
              return;
            }
            if (tuckEdge === "left") untuckAnchorX.current = x.get() + tuckRevealGutter;
            else if (tuckEdge === "right") untuckAnchorX.current = x.get();
            setInteractionReveal(false);
            setFocused(false);
            setTemporaryReveal(false);
            setTuckRevealAnchorY(null);
            setTucked(false);
            if (layoutEditing) record(120);
          }}
        >
          {tuckIcon ?? <Bookmark size={14} />}
        </motion.button>
      )}
      <div
        data-game-panel-content={id}
        data-game-panel-fill={fillBox ? "true" : undefined}
        data-game-panel-limited={layoutHeightLimit != null ? "true" : undefined}
        // Children can style against the box: `group-data-[game-panel-fill=true]/panelbox:` when a
        // fixed-height panel asks its content to fill it, and --game-panel-box-max-height otherwise.
        className={`group/panelbox ${
          tuckedClosed
            ? "hidden"
            : fillBox
              ? "h-full w-full"
              : overflowVisible
                ? "w-full"
                : growsWithContent
                  ? `w-full rounded-lg [overflow-wrap:anywhere] ${layoutHeightLimit != null ? "overflow-auto" : "overflow-visible"}`
                  : "h-full w-full overflow-auto rounded-lg [overflow-wrap:anywhere]"
        }`}
        style={
          {
            maxHeight: layoutHeightLimit ?? available.height,
            "--game-panel-box-max-height": `${layoutHeightLimit ?? available.height}px`,
            ...(fillBox ? { height: "100%" } : null),
          } as CSSProperties
        }
        ref={content}
      >
        <div
          ref={intrinsicContent}
          data-game-panel-intrinsic={id}
          className={fillBox ? "h-full w-full min-h-0" : "w-full min-h-0"}
          style={fillBox ? { height: "100%" } : undefined}
        >
          {children}
        </div>
      </div>
      {editChrome && (
        <>
          {/* Drag layer: the whole panel is a handle, and content cannot be clicked while editing. */}
          <div
            data-panel-drag-layer
            aria-hidden="true"
            className={
              panelLocked
                ? ""
                : "transition-colors hover:bg-[color-mix(in_srgb,var(--marinara-chat-chrome-accent)_7%,transparent)]"
            }
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 20,
              borderRadius: 8,
              touchAction: "none",
              cursor: panelLocked ? "not-allowed" : interaction === "drag" ? "grabbing" : "grab",
              background: overlapping ? `color-mix(in srgb, ${OVERLAP_COLOR} 10%, transparent)` : undefined,
            }}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={(event) => finishDrag(event)}
            onPointerCancel={(event) => finishDrag(event, true)}
            onDoubleClick={() => setOptionsOpen(true)}
          />
          <div
            data-panel-edit-outline
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: -3,
              zIndex: 21,
              pointerEvents: "none",
              borderRadius: 11,
              border: `${selected ? 2 : 1.5}px ${interaction === "drag" || interaction === "resize" || selected ? "solid" : "dashed"} ${outlineColor}`,
              boxShadow:
                interaction === "drag" || interaction === "resize" || selected
                  ? `0 0 0 3px color-mix(in srgb, ${outlineColor} 18%, transparent), 0 14px 32px rgba(0,0,0,0.3)`
                  : undefined,
              transition: "border-color 120ms ease, box-shadow 120ms ease",
            }}
          />
          <motion.div
            data-panel-layout-controls
            className="flex h-[22px] max-w-[calc(100%-20px)] items-center rounded-md border border-[var(--marinara-chat-chrome-panel-border)] text-[0.6875rem] font-medium text-[var(--marinara-chat-chrome-panel-title)] shadow-[0_2px_8px_rgba(0,0,0,0.22)]"
            style={{
              position: "absolute",
              left: chipLeft,
              top: chipTop,
              zIndex: 25,
              background: LAYOUT_SOLID_BACKGROUND,
            }}
          >
            <button
              ref={moveHandle}
              type="button"
              disabled={panelLocked}
              aria-label={t("ui.game.floatingPanel.moveNamed", { name: label })}
              title={panelLocked ? t("ui.game.layoutEditor.lockedHint") : t("ui.game.floatingPanel.moveNamed", { name: label })}
              className="flex h-full min-w-0 touch-none items-center gap-1 rounded-l-md pl-1 pr-1.5 enabled:cursor-grab focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)] disabled:cursor-default"
              onPointerDown={startDrag}
              onPointerMove={moveDrag}
              onPointerUp={(event) => finishDrag(event)}
              onPointerCancel={(event) => finishDrag(event, true)}
              onKeyDown={nudge}
            >
              <GripVertical size={12} aria-hidden="true" className="shrink-0 opacity-60" />
              <span className="min-w-0 truncate">{label}</span>
              {panelLocked && (
                <Lock
                  size={10}
                  aria-hidden="true"
                  data-panel-locked-icon
                  className="shrink-0 text-[var(--marinara-chat-chrome-panel-muted)]"
                />
              )}
            </button>
            <button
              ref={optionsButton}
              type="button"
              aria-label={t("ui.game.layoutEditor.options", { name: label })}
              title={t("ui.game.layoutEditor.options", { name: label })}
              aria-haspopup="dialog"
              aria-expanded={optionsOpen}
              data-panel-options-button
              className={`flex h-full w-6 shrink-0 items-center justify-center rounded-r-md border-l border-[var(--marinara-chat-chrome-panel-divider)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)] ${optionsOpen ? "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-highlight-text)]" : ""}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setOptionsOpen((open) => !open)}
            >
              <Ellipsis size={14} aria-hidden="true" />
            </button>
          </motion.div>
          {!panelLocked &&
            RESIZE_HANDLES.map((handle) => {
              const corner = handle.length === 2;
              const vertical = handle === "e" || handle === "w";
              const visual = (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border border-[var(--marinara-chat-chrome-accent)] bg-[var(--marinara-chat-chrome-panel-bg)] shadow-sm transition-transform group-hover/handle:scale-125"
                  style={{
                    width: corner ? 8 : vertical ? 4 : 18,
                    height: corner ? 8 : vertical ? 18 : 4,
                    borderRadius: corner ? 2 : 999,
                  }}
                />
              );
              const common = {
                "data-panel-resize-handle": handle,
                style: handleHitStyle(handle),
                className: "group/handle",
                onPointerDown: startResize(handle),
                onPointerMove: moveResize,
                onPointerUp: finishResize,
                onPointerCancel: finishResize,
              };
              // The bottom-right corner doubles as the keyboard resize control.
              return handle === "se" ? (
                <button
                  key={handle}
                  type="button"
                  aria-label={t("ui.game.floatingPanel.resizeNamed", { name: label })}
                  title={t("ui.game.floatingPanel.resizeNamed", { name: label })}
                  {...common}
                  className="group/handle rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)]"
                  onKeyDown={resizeWithKeys}
                >
                  {visual}
                </button>
              ) : (
                <div key={handle} aria-hidden="true" {...common}>
                  {visual}
                </div>
              );
            })}
          {sizeBadge && (
            <div
              data-panel-size-badge
              aria-live="polite"
              className="pointer-events-none rounded-md px-1.5 py-0.5 text-[0.625rem] font-semibold tabular-nums text-[var(--primary-foreground)] shadow"
              style={{ position: "absolute", right: 10, bottom: 10, zIndex: 26, background: EDIT_ACCENT }}
            >
              {sizeBadge}
            </div>
          )}
        </>
      )}
      {editChrome && (
        <GamePanelOptions
          anchor={optionsButton}
          open={optionsOpen}
          onClose={() => setOptionsOpen(false)}
          id={id}
          label={label}
          surface={surface}
          locked={locked}
          onToggleLock={() => {
            toggleLocked();
            record(120);
          }}
          onReset={() => {
            setSize({ width, height });
            resetPosition();
            rememberPosition();
            record(120);
          }}
          growth={growth}
          onGrowth={(next) => {
            // A crowded reflow may be showing a temporary window; fix the panel's real height.
            if (next === "fixed")
              fixHeight(
                layoutHeightLimit != null && intrinsicContent.current
                  ? Math.min(available.height, Math.max(MIN_PANEL_HEIGHT, intrinsicContent.current.scrollHeight))
                  : panel.current?.offsetHeight,
              );
            else {
              try {
                localStorage.setItem(growthPreferenceKey, "true");
              } catch {
                /* Best effort. */
              }
              setGrowth(next);
            }
            record(120);
          }}
          allowTuck={allowTuck}
          tuckEdge={tuckEdge}
          onTuckEdge={(next) => {
            setTuckEdge(next);
            record(120);
          }}
          onCollapse={() => {
            setOptionsOpen(false);
            collapseToEdge();
            record(120);
          }}
          stackEnabled={stackEnabled}
          stackGroup={stackGroup}
          stackGroups={stackGroups}
          onStack={setStack}
          bottomLockAvailable={id === "narration"}
          bottomLocked={bottomLocked}
          onBottomLock={() => {
            setBottomLocked((current) => !current);
            record(120);
          }}
          topCenterAvailable={allowTopCenterPin}
          topCenterPinned={topCenterPinned}
          onTopCenter={() => {
            setTopCenterPinned((current) => !current);
            record(120);
          }}
          hideable={hideable}
          onHide={() => {
            setOptionsOpen(false);
            setPanelHidden(chatId, id, true);
          }}
        />
      )}
    </motion.div>,
    surface.current,
  );
  if (!reserveSpace) return portal;
  return (
    <>
      <div aria-hidden="true" className="shrink-0" style={{ height: panelHeight }} />
      {portal}
    </>
  );
}

interface OptionsProps {
  anchor: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onClose: () => void;
  id: string;
  label: string;
  surface: RefObject<HTMLElement | null>;
  locked: boolean;
  onToggleLock: () => void;
  onReset: () => void;
  growth: "top" | "bottom" | "fixed";
  onGrowth: (growth: "top" | "bottom" | "fixed") => void;
  allowTuck: boolean;
  tuckEdge: "left" | "right" | "top";
  onTuckEdge: (edge: "left" | "right" | "top") => void;
  onCollapse: () => void;
  stackEnabled: boolean;
  stackGroup: string | null;
  stackGroups: Record<string, string>;
  onStack: (groupId: string | null) => void;
  bottomLockAvailable: boolean;
  bottomLocked: boolean;
  onBottomLock: () => void;
  topCenterAvailable: boolean;
  topCenterPinned: boolean;
  onTopCenter: () => void;
  hideable: boolean;
  onHide: () => void;
}

/** Per-panel options, opened from the chip's "more" button. */
function GamePanelOptions(props: OptionsProps) {
  const { t } = useTranslation();
  const { id, stackGroups, stackGroup, surface } = props;
  // Stack candidates query the DOM, so build them only while the popover is open.
  const stackOptions =
    props.open && props.stackEnabled
      ? (() => {
          const options = (surface.current ? registeredGamePanelOptions(surface.current) : [])
            .filter((option) => option.id !== id && option.id.startsWith("widget:"))
            .map((option) => ({ ...option, group: stackGroups[option.id] ?? option.id }));
          if (stackGroup && !options.some((option) => option.group === stackGroup))
            options.unshift({
              id: `current:${stackGroup}`,
              label: t("ui.game.layoutEditor.thisWidgetStack"),
              group: stackGroup,
            });
          return options;
        })()
      : [];
  return (
    <GameLayoutPopover
      anchor={props.anchor}
      open={props.open}
      onClose={props.onClose}
      label={t("ui.game.layoutEditor.options", { name: props.label })}
      name="panel-options"
      width={272}
    >
      <div className="flex items-center gap-2 px-1 pb-2 pt-0.5">
        <span className="min-w-0 flex-1 break-words text-[0.8125rem] font-semibold text-[var(--marinara-chat-chrome-panel-title)]">
          {props.label}
        </span>
        <button
          type="button"
          aria-pressed={!props.locked}
          aria-label={props.locked ? t("ui.game.panellockbutton.unlockPanel") : t("ui.game.panellockbutton.lockPanel")}
          title={props.locked ? t("ui.game.panellockbutton.unlockPanel") : t("ui.game.panellockbutton.lockPanel")}
          data-panel-option="lock"
          onClick={props.onToggleLock}
          className={`flex h-6 items-center gap-1 rounded-md px-2 text-[0.6875rem] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)] ${
            props.locked
              ? "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-muted)]"
              : "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-highlight-text)]"
          }`}
        >
          {props.locked ? <Lock size={11} aria-hidden="true" /> : <LockOpen size={11} aria-hidden="true" />}
          {props.locked ? t("ui.game.layoutEditor.lockedState") : t("ui.game.layoutEditor.unlockedState")}
        </button>
      </div>
      <LayoutPopoverSection title={t("ui.game.floatingPanel.growth")}>
        <LayoutSegmented
          label={t("ui.game.floatingPanel.growth")}
          value={props.growth}
          onChange={props.onGrowth}
          options={[
            {
              value: "top",
              label: t("ui.game.layoutEditor.growthTopShort"),
              ariaLabel: t("ui.game.floatingPanel.growthTop"),
            },
            {
              value: "bottom",
              label: t("ui.game.layoutEditor.growthBottomShort"),
              ariaLabel: t("ui.game.floatingPanel.growthBottom"),
            },
            {
              value: "fixed",
              label: t("ui.game.layoutEditor.growthFixedShort"),
              ariaLabel: t("ui.game.floatingPanel.growthFixed"),
            },
          ]}
        />
      </LayoutPopoverSection>
      {props.allowTuck && (
        <LayoutPopoverSection title={t("ui.game.floatingPanel.tuckEdge")}>
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <LayoutSegmented
                label={t("ui.game.floatingPanel.tuckEdge")}
                value={props.tuckEdge}
                onChange={props.onTuckEdge}
                options={[
                  {
                    value: "left",
                    label: t("ui.game.layoutEditor.edgeLeftShort"),
                    ariaLabel: t("ui.game.floatingPanel.tuckLeft"),
                  },
                  {
                    value: "right",
                    label: t("ui.game.layoutEditor.edgeRightShort"),
                    ariaLabel: t("ui.game.floatingPanel.tuckRight"),
                  },
                  {
                    value: "top",
                    label: t("ui.game.layoutEditor.edgeTopShort"),
                    ariaLabel: t("ui.game.floatingPanel.tuckTop"),
                  },
                ]}
              />
            </div>
            <button
              type="button"
              aria-label={t("ui.game.floatingPanel.tuck")}
              title={t("ui.game.floatingPanel.tuck")}
              onClick={props.onCollapse}
              className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-[var(--marinara-chat-chrome-panel-border)] px-2 text-[0.6875rem] font-medium hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)]"
            >
              <Bookmark size={11} aria-hidden="true" />
              {t("ui.game.layoutEditor.collapse")}
            </button>
          </div>
        </LayoutPopoverSection>
      )}
      {props.stackEnabled && (
        <LayoutPopoverSection title={t("ui.game.floatingPanel.stack")}>
          <div className="flex items-center gap-1.5">
            <select
              aria-label={t("ui.game.floatingPanel.stack")}
              title={t("ui.game.floatingPanel.stack")}
              value={stackGroup ?? ""}
              onChange={(event) => props.onStack(event.target.value || null)}
              className="h-7 min-w-0 flex-1 rounded-md border border-[var(--marinara-chat-chrome-input-border,var(--marinara-chat-chrome-panel-border))] bg-[var(--marinara-chat-chrome-input-bg,var(--marinara-chat-chrome-panel-bg))] px-1.5 text-[0.6875rem] text-[var(--marinara-chat-chrome-panel-text)]"
            >
              <option value="">{t("ui.game.floatingPanel.stackNone")}</option>
              {stackOptions.map((option) => (
                <option key={option.id} value={option.group}>
                  {t("ui.game.floatingPanel.stackWith", { name: option.label })}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={t("ui.game.floatingPanel.newStack")}
              title={t("ui.game.floatingPanel.newStack")}
              onClick={() => props.onStack(`stack:${id}`)}
              className="flex h-7 shrink-0 items-center rounded-md border border-[var(--marinara-chat-chrome-panel-border)] px-2 text-[0.6875rem] font-medium hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)]"
            >
              {t("ui.game.layoutEditor.newStackShort")}
            </button>
          </div>
        </LayoutPopoverSection>
      )}
      <LayoutPopoverSection>
        {props.bottomLockAvailable && (
          <LayoutMenuButton
            icon={<Pin size={12} />}
            pressed={props.bottomLocked}
            ariaLabel={t(
              props.bottomLocked ? "ui.game.floatingPanel.bottomUnlock" : "ui.game.floatingPanel.bottomLock",
            )}
            onClick={props.onBottomLock}
          >
            {t(props.bottomLocked ? "ui.game.floatingPanel.bottomUnlock" : "ui.game.floatingPanel.bottomLock")}
          </LayoutMenuButton>
        )}
        {props.topCenterAvailable && (
          <LayoutMenuButton
            icon={<Pin size={12} />}
            pressed={props.topCenterPinned}
            ariaLabel={t(
              props.topCenterPinned ? "ui.game.floatingPanel.topCenterUnlock" : "ui.game.floatingPanel.topCenterLock",
            )}
            onClick={props.onTopCenter}
          >
            {t(props.topCenterPinned ? "ui.game.floatingPanel.topCenterUnlock" : "ui.game.floatingPanel.topCenterLock")}
          </LayoutMenuButton>
        )}
        <LayoutMenuButton
          icon={<RotateCcw size={12} />}
          ariaLabel={t("ui.game.floatingPanel.reset")}
          onClick={props.onReset}
        >
          {t("ui.game.floatingPanel.reset")}
        </LayoutMenuButton>
        {props.hideable && (
          <LayoutMenuButton
            icon={<EyeOff size={12} />}
            ariaLabel={t("ui.game.layoutEditor.hide")}
            onClick={props.onHide}
          >
            {t("ui.game.layoutEditor.hide")}
          </LayoutMenuButton>
        )}
      </LayoutPopoverSection>
    </GameLayoutPopover>
  );
}
