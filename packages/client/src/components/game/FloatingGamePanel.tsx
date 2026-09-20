import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { motion, useDragControls, useMotionValue, useTransform } from "framer-motion";
import { Bookmark, GripHorizontal, MoveDiagonal2, Pin, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PanelLockButton, useDraggablePanel } from "./DraggablePanel";
import {
  GAME_PANEL_HUD_LAYER,
  GAME_PANEL_INTERACTIVE_LAYER,
  GAME_PANEL_STACK_CHANGE_EVENT,
  arrangeRegisteredPanelStack,
  commitRegisteredPanelGroup,
  constrainRegisteredPanelDrag,
  readGamePanelStacks,
  registeredGamePanelOptions,
  registerGamePanel,
  scheduleGamePanelLayout,
  snapPanelDragPosition,
  writeGamePanelStackMembership,
} from "../../lib/game-panel-layout";

export const GamePanelContext = createContext<{
  chatId: string;
  legacyChatId?: string;
  surface: RefObject<HTMLElement | null>;
  layoutEditing?: boolean;
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
}

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
  if (props.hidden) return null;
  if (!context || !desktop) return props.children;
  migratePanelLayoutStorage(context.legacyChatId, context.chatId);
  return <FloatingFrame key={`${context.chatId}:${props.id}`} {...props} {...context} />;
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
  chatId,
  surface,
  layoutEditing = false,
}: Props & {
  chatId: string;
  surface: RefObject<HTMLElement | null>;
  layoutEditing?: boolean;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const intrinsicContent = useRef<HTMLDivElement>(null);
  const controls = useDragControls();
  const sizeKey = `marinara-game-panel:${chatId}:floating:${id}:size-v2`;
  const growthPreferenceKey = `${sizeKey}:growth-explicit`;
  const bottomLockKey = `marinara-game-panel:${chatId}:floating:${id}:bottom-lock`;
  const topCenterLockKey = `marinara-game-panel:${chatId}:floating:${id}:top-center-lock`;
  const tuckKey = `marinara-game-panel:${chatId}:floating:${id}:tucked`;
  const tuckEdgeKey = `${tuckKey}:edge`;
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
  const stackOptions = (surface.current ? registeredGamePanelOptions(surface.current) : [])
    .filter((option) => option.id !== id && option.id.startsWith("widget:"))
    .map((option) => ({ ...option, group: stackGroups[option.id] ?? option.id }));
  if (stackGroup && !stackOptions.some((option) => option.group === stackGroup)) {
    stackOptions.unshift({ id: `current:${stackGroup}`, label: "This widget stack", group: stackGroup });
  }
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
      }, 0);
    },
    [chatId, id, stackGroups, surface],
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
        width: Number.isFinite(stored?.width) ? Math.max(140, stored.width) : width,
        height: Number.isFinite(stored?.height) ? Math.max(64, stored.height) : height,
        manualWidth: stored?.manualWidth === true,
      };
    } catch {
      return { width, height };
    }
  });
  const [available, setAvailable] = useState({ width: window.innerWidth, height: window.innerHeight });
  const tuckRevealGutter =
    tucked && !tuckedClosed && (tuckEdge === "left" || tuckEdge === "right")
      ? Math.min(TUCK_TAB_WIDTH, available.width)
      : 0;
  const expandedPanelWidth = Math.min(size.width + tuckRevealGutter, available.width);
  const [mounted, setMounted] = useState(false);
  const [panelHeight, setPanelHeight] = useState(0);
  const [layoutHeightLimit, setLayoutHeightLimit] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const measure = () => setPanelHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mounted]);
  const { locked, toggleLocked, resetPosition, x, y, handleDragEnd } = useDraggablePanel(chatId, `floating:${id}`, {
    surface,
    panel,
    side,
    slot,
    ready: mounted,
    anchor: tucked ? "top" : growth === "bottom" ? "bottom" : "top",
    // preferredAnchor owns width changes, including the untuck transition.
    skipRightEdgeWidthAdjustment: true,
  });
  const panelLocked = locked || bottomLocked || topCenterPinned;
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
  const preferredPosition = useRef<{ x: number; y: number; relativeX: number; relativeY: number } | null>(null);
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
    return {
      x: saved.relativeX * maxX,
      y: bottomLocked ? Math.max(0, maxY - 16) : saved.relativeY * maxY,
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
        };
      }
    },
    [bottomLocked, handleDragEnd, surface, x, y],
  );
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
      };
    }
    return registerGamePanel(host, {
      id,
      element,
      locked: panelLocked,
      fixed: bottomLocked || topCenterPinned || tucked,
      bottomInset: bottomLocked ? 16 : undefined,
      stackGroup: stackEnabled ? stackGroup : null,
      // The narration surface reserves the primary reading area. Keep it ahead
      // of optional HUD widgets when their saved positions would collide so
      // narration controls remain reachable while editing the layout.
      priority: reserveSpace || bottomLocked || topCenterPinned || tucked ? 0 : id === "map" ? 1 : 2,
      getPosition: () => ({ x: x.get(), y: y.get() }),
      getPreferredPosition: preferredAnchor,
      getSize: () => {
        const naturalHeight = intrinsicContent.current
          ? Math.max(intrinsicContent.current.offsetHeight, intrinsicContent.current.scrollHeight)
          : element.offsetHeight;
        const desiredHeight = collapsed
          ? naturalHeight
          : growsWithContent
            ? naturalHeight
            : (size.height ?? height ?? naturalHeight);
        return {
          width: tuckedClosed ? 36 : element.offsetWidth,
          height: tuckedClosed ? 40 : desiredHeight,
        };
      },
      setHeightLimit: (nextHeight) => {
        const naturalHeight = intrinsicContent.current
          ? Math.max(intrinsicContent.current.offsetHeight, intrinsicContent.current.scrollHeight)
          : element.offsetHeight;
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
        };
      },
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
  useEffect(() => {
    if (!allowTuck || revealOnValueChangeKey == null) return;
    if (previousValueKey.current === revealOnValueChangeKey) return;
    previousValueKey.current = revealOnValueChangeKey;
    if (!tucked) return;
    setTemporaryReveal(true);
    if (tuckEdge !== "top") setTuckRevealAnchorY((current) => current ?? y.get() + TUCK_TAB_HEIGHT / 2);
    let timer = window.setTimeout(closeAfterInteraction, 5000);
    function closeAfterInteraction() {
      if (interactionRevealRef.current || focusedRef.current) {
        timer = window.setTimeout(closeAfterInteraction, 250);
      } else {
        setTemporaryReveal(false);
      }
    }
    return () => window.clearTimeout(timer);
  }, [allowTuck, revealOnValueChangeKey, tuckEdge, tucked, y]);
  // Float the hover tools above the content, but never above the game surface.
  const toolsTop = useTransform(y, (value) => Math.max(-28, -value));
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
  const resize = useRef<{ startX: number; startY: number; width: number; height: number } | null>(null);
  const tuckedDrag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const suppressTuckClick = useRef(false);
  const [resizing, setResizing] = useState(false);
  const dragPosition = useRef<{ x: number; y: number } | null>(null);
  const resizeTo = (nextWidth: number, nextHeight: number) =>
    setSize({
      manualWidth: true,
      width: Math.min(Math.max(140, nextWidth), Math.max(140, available.width - x.get())),
      height: Math.min(Math.max(64, nextHeight), Math.max(64, available.height - y.get())),
    });
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
    const next = constrainRegisteredPanelDrag(
      surface.current,
      id,
      { x: x.get(), y: y.get() },
      {
        x: tuckEdge === "right" ? maxX : tuckEdge === "top" ? clamp(drag.originX + dx, maxX) : 0,
        y: tuckEdge === "top" ? 0 : clamp(drag.originY + dy, maxY),
      },
      { width: panel.current.offsetWidth, height: panel.current.offsetHeight },
    );
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
    }
    tuckedDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    event.stopPropagation();
  };
  if (!mounted || !surface.current) return null;
  const portal = createPortal(
    <motion.div
      ref={panel}
      data-game-floating-panel={id}
      data-game-floating-widget={widgetId}
      data-game-skip-bg-nav="true"
      className="group/floating pointer-events-auto absolute left-0 top-0 z-30 max-w-full rounded-lg"
      style={{
        x,
        y,
        // The reserved narration panel owns the primary reading surface. Keep
        // its controls above same-layer optional widgets during a reflow.
        // Edge bookmarks must remain reachable above neighboring edit controls.
        zIndex: tucked ? Math.max(layer, GAME_PANEL_INTERACTIVE_LAYER) + 1 : reserveSpace ? layer + 1 : layer,
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
      drag={layoutEditing && !panelLocked}
      dragListener={false}
      dragControls={controls}
      dragMomentum={false}
      dragElastic={0}
      dragConstraints={{
        left: 0,
        top: 0,
        right: Math.max(0, available.width - size.width),
        bottom: Math.max(0, available.height - panelHeight),
      }}
      onDragEnd={() => {
        dragPosition.current = null;
        rememberPosition(true);
        if (surface.current) commitRegisteredPanelGroup(surface.current, id);
      }}
      onDragStart={() => {
        dragPosition.current = { x: x.get(), y: y.get() };
      }}
      onDrag={() => {
        const host = surface.current;
        const element = panel.current;
        if (!host || !element) return;
        const current = { x: x.get(), y: y.get() };
        const from = dragPosition.current ?? current;
        const constrained = constrainRegisteredPanelDrag(host, id, from, current, {
          width: element.offsetWidth,
          height: element.offsetHeight,
        });
        if (Math.abs(constrained.x - current.x) > 0.1) x.set(constrained.x);
        if (Math.abs(constrained.y - current.y) > 0.1) y.set(constrained.y);
        dragPosition.current = constrained;
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
        if (allowTuck && event.key === "Escape") {
          event.preventDefault();
          setFocused(false);
          setInteractionReveal(false);
          setTemporaryReveal(false);
        }
      }}
      onBlur={(event) => {
        if (allowTuck && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
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
          style={
            tuckEdge === "left"
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
                : { left: "50%", top: 0, transform: "translateX(-50%)", width: TUCK_TAB_WIDTH, height: TUCK_TAB_HEIGHT }
          }
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
          }}
        >
          {tuckIcon ?? <Bookmark size={14} />}
        </motion.button>
      )}
      {layoutEditing && !tuckedClosed && (
        <motion.div
          data-panel-layout-controls
          style={{ top: toolsTop }}
          className={`absolute right-0 z-20 flex h-7 max-w-full items-center justify-end gap-1 rounded-lg bg-[var(--marinara-chat-chrome-panel-bg)] px-1 text-[var(--marinara-chat-chrome-panel-title)] opacity-0 transition-opacity group-hover/floating:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 ${resizing ? "opacity-100" : ""}`}
        >
          <button
            type="button"
            disabled={panelLocked}
            aria-label={t("ui.game.floatingPanel.move")}
            title={t("ui.game.floatingPanel.move")}
            className="flex h-6 w-6 shrink-0 touch-none items-center justify-start rounded px-1 enabled:cursor-grab focus-visible:outline focus-visible:outline-2 disabled:opacity-40"
            onPointerDown={(event) => {
              if (!panelLocked) controls.start(event);
            }}
            onKeyDown={(event) => {
              if (panelLocked || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault();
              const step = event.shiftKey ? 40 : 10;
              x.set(x.get() + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0));
              y.set(y.get() + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0));
              rememberPosition();
            }}
          >
            <GripHorizontal size={14} />
          </button>
          <select
            aria-label={t("ui.game.floatingPanel.growth")}
            title={t("ui.game.floatingPanel.growth")}
            className="h-6 min-w-0 max-w-32 rounded bg-[var(--marinara-chat-chrome-panel-bg)] text-[0.625rem]"
            value={growth}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => {
              const next = event.target.value as "top" | "bottom" | "fixed";
              if (next === "fixed" && panel.current)
                setSize((current) => ({ ...current, height: panel.current!.offsetHeight }));
              try {
                localStorage.setItem(growthPreferenceKey, "true");
              } catch {
                /* Best effort. */
              }
              setGrowth(next);
            }}
          >
            <option value="top">{t("ui.game.floatingPanel.growthTop")}</option>
            <option value="bottom">{t("ui.game.floatingPanel.growthBottom")}</option>
            <option value="fixed">{t("ui.game.floatingPanel.growthFixed")}</option>
          </select>
          <button
            type="button"
            aria-label={t("ui.game.floatingPanel.reset")}
            title={t("ui.game.floatingPanel.reset")}
            className="flex h-6 w-6 items-center justify-center rounded focus-visible:outline focus-visible:outline-2"
            onClick={() => {
              setSize({ width, height });
              resetPosition();
              rememberPosition();
            }}
          >
            <RotateCcw size={12} />
          </button>
          <PanelLockButton locked={locked} onToggle={toggleLocked} className="h-6 w-6" size={12} />
          {id === "narration" && (
            <button
              type="button"
              aria-label={t(bottomLocked ? "ui.game.floatingPanel.bottomUnlock" : "ui.game.floatingPanel.bottomLock")}
              title={t(bottomLocked ? "ui.game.floatingPanel.bottomUnlock" : "ui.game.floatingPanel.bottomLock")}
              aria-pressed={bottomLocked}
              className={`flex h-6 items-center justify-center gap-1 rounded px-1 text-[0.55rem] focus-visible:outline focus-visible:outline-2 ${bottomLocked ? "text-[var(--primary)]" : ""}`}
              onClick={() => setBottomLocked((current) => !current)}
            >
              <Pin size={12} />
              <span>{t(bottomLocked ? "ui.game.floatingPanel.bottomUnlock" : "ui.game.floatingPanel.bottomLock")}</span>
            </button>
          )}
          {allowTopCenterPin && (
            <button
              type="button"
              aria-label={t(
                topCenterPinned ? "ui.game.floatingPanel.topCenterUnlock" : "ui.game.floatingPanel.topCenterLock",
              )}
              title={t(
                topCenterPinned ? "ui.game.floatingPanel.topCenterUnlock" : "ui.game.floatingPanel.topCenterLock",
              )}
              aria-pressed={topCenterPinned}
              className={`flex h-6 w-6 items-center justify-center rounded focus-visible:outline focus-visible:outline-2 ${topCenterPinned ? "text-[var(--primary)]" : ""}`}
              onClick={() => setTopCenterPinned((current) => !current)}
            >
              <Pin size={12} />
            </button>
          )}
          {allowTuck && (
            <>
              <select
                aria-label={t("ui.game.floatingPanel.tuckEdge")}
                title={t("ui.game.floatingPanel.tuckEdge")}
                value={tuckEdge}
                onChange={(event) => setTuckEdge(event.target.value as "left" | "right" | "top")}
                className="h-6 max-w-20 rounded bg-[var(--marinara-chat-chrome-panel-bg)] text-[0.625rem]"
              >
                <option value="left">{t("ui.game.floatingPanel.tuckLeft")}</option>
                <option value="right">{t("ui.game.floatingPanel.tuckRight")}</option>
                <option value="top">{t("ui.game.floatingPanel.tuckTop")}</option>
              </select>
              <button
                type="button"
                aria-label={t("ui.game.floatingPanel.tuck")}
                title={t("ui.game.floatingPanel.tuck")}
                className="flex h-6 items-center justify-center gap-1 rounded px-1 text-[0.55rem] focus-visible:outline focus-visible:outline-2"
                onClick={collapseToEdge}
              >
                <GripHorizontal size={12} />
                <span>{t("ui.game.floatingPanel.tuck")}</span>
              </button>
            </>
          )}
          {stackEnabled && (
            <select
              aria-label={t("ui.game.floatingPanel.stack")}
              title={t("ui.game.floatingPanel.stack")}
              value={stackGroup ?? ""}
              onChange={(event) => setStack(event.target.value || null)}
              className="h-6 max-w-28 rounded bg-[var(--marinara-chat-chrome-panel-bg)] text-[0.625rem]"
            >
              <option value="">{t("ui.game.floatingPanel.stackNone")}</option>
              {stackOptions.map((option) => (
                <option key={option.id} value={option.group}>
                  {t("ui.game.floatingPanel.stackWith", { name: option.label })}
                </option>
              ))}
            </select>
          )}
          {stackEnabled && (
            <button
              type="button"
              aria-label={t("ui.game.floatingPanel.newStack")}
              title={t("ui.game.floatingPanel.newStack")}
              className="flex h-6 w-6 items-center justify-center rounded focus-visible:outline focus-visible:outline-2"
              onClick={() => setStack(`stack:${id}`)}
            >
              +
            </button>
          )}
        </motion.div>
      )}
      <div
        data-game-panel-content={id}
        className={
          tuckedClosed
            ? "hidden"
            : overflowVisible
              ? "w-full"
              : growsWithContent
                ? `w-full rounded-lg [overflow-wrap:anywhere] ${layoutHeightLimit != null ? "overflow-auto" : "overflow-visible"}`
                : "h-full w-full overflow-auto rounded-lg [overflow-wrap:anywhere]"
        }
        style={{ maxHeight: layoutHeightLimit ?? available.height }}
        ref={content}
      >
        <div ref={intrinsicContent} data-game-panel-intrinsic={id} className="w-full min-h-0">
          {children}
        </div>
      </div>
      {layoutEditing && !panelLocked && (
        <button
          type="button"
          aria-label={t("ui.game.floatingPanel.resize")}
          title={t("ui.game.floatingPanel.resize")}
          className={`absolute bottom-0 right-0 z-20 flex h-6 w-6 touch-none cursor-nwse-resize items-center justify-center rounded bg-[var(--marinara-chat-chrome-panel-bg)] text-[var(--marinara-chat-chrome-panel-title)] opacity-0 transition-opacity group-hover/floating:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:outline focus-visible:outline-2 ${resizing ? "opacity-100" : ""}`}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            const box = panel.current!.getBoundingClientRect();
            resize.current = { startX: event.clientX, startY: event.clientY, width: box.width, height: box.height };
            setResizing(true);
          }}
          onPointerMove={(event) => {
            if (resize.current)
              resizeTo(
                resize.current.width + event.clientX - resize.current.startX,
                resize.current.height + event.clientY - resize.current.startY,
              );
          }}
          onPointerUp={(event) => {
            resize.current = null;
            setResizing(false);
            event.currentTarget.releasePointerCapture(event.pointerId);
            rememberPosition();
          }}
          onPointerCancel={() => {
            resize.current = null;
            setResizing(false);
            rememberPosition();
          }}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"].includes(event.key)) return;
            event.preventDefault();
            const box = panel.current!.getBoundingClientRect();
            const step = event.shiftKey ? 40 : 10;
            resizeTo(
              box.width + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
              box.height + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
            );
          }}
        >
          <MoveDiagonal2 size={14} />
        </button>
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
