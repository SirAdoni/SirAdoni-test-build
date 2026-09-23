// Global Layout toolbar for Game mode "Edit layout": Done, undo/redo, snap and
// collision toggles, lock/unlock all, the Panels menu (show/hide) and saved
// Layouts. Also draws the edit grid and the live snap guides on the HUD surface.
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  Copy,
  Eye,
  EyeOff,
  Layers2,
  LayoutTemplate,
  Lock,
  LockOpen,
  Magnet,
  PanelsTopLeft,
  Pencil,
  Redo2,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { GamePanelContext } from "./FloatingGamePanel";
import {
  GameLayoutPopover,
  LAYOUT_SOLID_BACKGROUND,
  LayoutMenuButton,
  LayoutPopoverSection,
} from "./GameLayoutPopover";
import {
  registeredGamePanelStates,
  scheduleGamePanelLayout,
  subscribeGamePanelRegistry,
} from "../../lib/game-panel-layout";
import {
  addSavedLayout,
  deleteSavedLayout,
  exportLayoutJson,
  parseLayoutJson,
  renameSavedLayout,
  type SavedLayout,
} from "../../lib/game-layout-snapshots";
import {
  applyLayoutAsStep,
  beginLayoutEditSession,
  captureCurrentLayout,
  dispatchLayoutLockAll,
  endLayoutEditSession,
  isLayoutPopoverOpen,
  isPanelHidden,
  readSavedLayouts,
  redoLayout,
  setLayoutCollisionsEnabled,
  setLayoutSnapEnabled,
  setLayoutToolbarDock,
  setPanelHidden,
  undoLayout,
  useHiddenPanelsVersion,
  useLayoutCatalog,
  useLayoutCollisionsEnabled,
  useLayoutDragOverlay,
  useLayoutHistoryState,
  useLayoutSnapEnabled,
  useLayoutToolbarDock,
  useSavedLayouts,
  writeSavedLayouts,
} from "../../lib/game-layout-editor-store";

interface Props {
  editing: boolean;
  onDone: () => void;
  /** Called after a whole layout was written to storage; the owner bumps the layout revision. */
  onLayoutApplied: () => void;
}

const TOOLBAR_Z_INDEX = 60;
const GUIDE_Z_INDEX = 58;
const ACCENT = "var(--marinara-chat-chrome-accent, var(--primary))";

function useDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return desktop;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.isContentEditable ||
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  );
}

function newLayoutId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

const TOOLBAR_HEIGHT = 36;

/**
 * Where the fixed toolbar sits. When the app chrome leaves a strip above the HUD
 * surface, the toolbar lives there and covers no panel; otherwise it sits just
 * inside the surface edge.
 */
function useToolbarPlacement(surface: HTMLElement): { centerX: number; top: number; bottom: number } {
  const measure = useCallback(() => {
    const rect = surface.getBoundingClientRect();
    const roomAbove = rect.top >= TOOLBAR_HEIGHT + 12;
    const roomBelow = window.innerHeight - rect.bottom >= TOOLBAR_HEIGHT + 12;
    return {
      centerX: rect.left + rect.width / 2,
      top: roomAbove ? rect.top - TOOLBAR_HEIGHT - 8 : rect.top + 10,
      bottom: roomBelow ? window.innerHeight - rect.bottom - TOOLBAR_HEIGHT - 8 : window.innerHeight - rect.bottom + 10,
    };
  }, [surface]);
  const [placement, setPlacement] = useState(measure);
  useLayoutEffect(() => {
    const update = () =>
      setPlacement((current) => {
        const next = measure();
        return current.centerX === next.centerX && current.top === next.top && current.bottom === next.bottom
          ? current
          : next;
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [measure, surface]);
  return placement;
}

/** Pick the free end of the surface for the toolbar when the user has not chosen one. */
function autoDock(surface: HTMLElement): "top" | "bottom" {
  const host = surface.getBoundingClientRect();
  if (host.top >= TOOLBAR_HEIGHT + 12) return "top";
  const band = (top: number) => ({
    left: host.left + host.width / 2 - 320,
    right: host.left + host.width / 2 + 320,
    top,
    bottom: top + 64,
  });
  const occupied = (area: { left: number; right: number; top: number; bottom: number }) =>
    [...surface.querySelectorAll<HTMLElement>("[data-game-floating-panel]")].some((panel) => {
      const rect = panel.getBoundingClientRect();
      return rect.left < area.right && rect.right > area.left && rect.top < area.bottom && rect.bottom > area.top;
    });
  return occupied(band(host.top)) && !occupied(band(host.bottom - 64)) ? "bottom" : "top";
}

export function GameLayoutEditToolbar({ editing, onDone, onLayoutApplied }: Props) {
  const context = useContext(GamePanelContext);
  const desktop = useDesktop();
  const scopeId = context?.chatId ?? "";
  const surface = context?.surface;
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(surface?.current ?? null);
  }, [editing, surface]);
  useEffect(() => {
    if (!scopeId || !editing) return;
    beginLayoutEditSession(scopeId);
    // Ending on cleanup covers a chat switch while editing too: the old scope's session
    // must end, or returning to it later keeps a stale undo baseline.
    return () => endLayoutEditSession(scopeId);
  }, [editing, scopeId]);
  useEffect(() => {
    // Below the desktop width panels are inline and there is nothing to edit.
    if (editing && !desktop) onDone();
  }, [desktop, editing, onDone]);
  if (!context || !editing || !desktop || !host || !scopeId) return null;
  return (
    <>
      {createPortal(<LayoutEditOverlay />, host)}
      {createPortal(
        <LayoutToolbar scopeId={scopeId} surface={host} onDone={onDone} onLayoutApplied={onLayoutApplied} />,
        document.body,
      )}
    </>
  );
}

/** Edit grid plus live guides, overlap areas and the settle preview. */
function LayoutEditOverlay() {
  const overlay = useLayoutDragOverlay();
  const line = `color-mix(in srgb, ${ACCENT} 9%, transparent)`;
  const major = `color-mix(in srgb, ${ACCENT} 16%, transparent)`;
  return (
    <>
      <div
        aria-hidden="true"
        data-layout-grid
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 25,
          pointerEvents: "none",
          backgroundColor: "rgba(0, 0, 0, 0.1)",
          backgroundImage: [
            `linear-gradient(to right, ${major} 1px, transparent 1px)`,
            `linear-gradient(to bottom, ${major} 1px, transparent 1px)`,
            `linear-gradient(to right, ${line} 1px, transparent 1px)`,
            `linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
          ].join(", "),
          backgroundSize: "64px 64px, 64px 64px, 16px 16px, 16px 16px",
        }}
      />
      {overlay && (
        <div
          aria-hidden="true"
          data-layout-guides
          style={{ position: "absolute", inset: 0, zIndex: GUIDE_Z_INDEX, pointerEvents: "none" }}
        >
          {overlay.ghost && (
            <div
              data-layout-settle-preview
              style={{
                position: "absolute",
                left: overlay.ghost.x,
                top: overlay.ghost.y,
                width: overlay.ghost.width,
                height: overlay.ghost.height,
                borderRadius: 10,
                border: `1.5px dashed ${ACCENT}`,
                background: `color-mix(in srgb, ${ACCENT} 8%, transparent)`,
              }}
            />
          )}
          {overlay.overlaps.map((area, index) => (
            <div
              key={`overlap-${index}`}
              data-layout-overlap
              style={{
                position: "absolute",
                left: area.x,
                top: area.y,
                width: area.width,
                height: area.height,
                background:
                  "repeating-linear-gradient(135deg, rgba(239, 68, 68, 0.34) 0 6px, rgba(239, 68, 68, 0.12) 6px 12px)",
                outline: "1px solid rgba(239, 68, 68, 0.85)",
                borderRadius: 4,
              }}
            />
          ))}
          {overlay.guides.map((guide, index) => (
            <div
              key={`guide-${index}`}
              data-layout-guide={guide.axis}
              style={{
                position: "absolute",
                background: ACCENT,
                boxShadow: "0 0 0 0.5px rgba(255,255,255,0.35)",
                ...(guide.axis === "x"
                  ? {
                      left: guide.value - 0.5,
                      top: guide.start,
                      width: 1,
                      height: Math.max(1, guide.end - guide.start),
                    }
                  : {
                      top: guide.value - 0.5,
                      left: guide.start,
                      height: 1,
                      width: Math.max(1, guide.end - guide.start),
                    }),
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ToolbarButton({
  label,
  onClick,
  children,
  pressed,
  disabled,
  buttonRef,
  expanded,
  name,
  wide,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  expanded?: boolean;
  name?: string;
  wide?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      data-layout-tool={name}
      disabled={disabled}
      onClick={onClick}
      className={`relative flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg text-[0.75rem] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)] disabled:cursor-not-allowed disabled:opacity-35 ${
        wide ? "px-2" : "w-7"
      } ${
        pressed || expanded
          ? "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-highlight-text)]"
          : "text-[var(--marinara-chat-chrome-panel-text)] enabled:hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] enabled:hover:text-[var(--marinara-chat-chrome-highlight-text)]"
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return (
    <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-[var(--marinara-chat-chrome-panel-divider)]" />
  );
}

function LayoutToolbar({
  scopeId,
  surface,
  onDone,
  onLayoutApplied,
}: {
  scopeId: string;
  surface: HTMLElement;
  onDone: () => void;
  onLayoutApplied: () => void;
}) {
  const { t } = useTranslation();
  const { canUndo, canRedo } = useLayoutHistoryState(scopeId);
  const snapEnabled = useLayoutSnapEnabled();
  const collisionsEnabled = useLayoutCollisionsEnabled();
  const preferredDock = useLayoutToolbarDock();
  const [autoDockSide] = useState(() => autoDock(surface));
  const dock = preferredDock ?? autoDockSide;
  const placement = useToolbarPlacement(surface);
  const catalog = useLayoutCatalog(scopeId);
  useHiddenPanelsVersion();
  const hiddenCount = catalog.filter((entry) => isPanelHidden(scopeId, entry.id)).length;
  const [menu, setMenu] = useState<"panels" | "layouts" | null>(null);
  const panelsButton = useRef<HTMLButtonElement>(null);
  const layoutsButton = useRef<HTMLButtonElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const undo = useCallback(() => {
    if (undoLayout(scopeId)) onLayoutApplied();
  }, [onLayoutApplied, scopeId]);
  const redo = useCallback(() => {
    if (redoLayout(scopeId)) onLayoutApplied();
  }, [onLayoutApplied, scopeId]);

  // All-locked hint: shown on entry when nothing can move yet.
  const [hint, setHint] = useState<"pending" | "shown" | "dismissed">("pending");
  const [allLocked, setAllLocked] = useState(false);
  useEffect(() => {
    const measure = () => {
      const states = registeredGamePanelStates(surface);
      setAllLocked(states.length > 0 && states.every((state) => state.locked));
    };
    const frame = requestAnimationFrame(measure);
    const unsubscribe = subscribeGamePanelRegistry(surface, measure);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [surface]);
  useEffect(() => {
    // The hint sits over the top of the surface; let it step aside on its own after a while.
    if (hint !== "shown") return;
    const timer = window.setTimeout(() => setHint("dismissed"), 12000);
    return () => window.clearTimeout(timer);
  }, [hint]);
  useEffect(() => {
    if (hint !== "pending") return;
    const timer = window.setTimeout(() => setHint(allLocked ? "shown" : "dismissed"), 160);
    return () => window.clearTimeout(timer);
  }, [allLocked, hint]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const key = event.key.toLowerCase();
      if (key === "escape") {
        if (isLayoutPopoverOpen() || menu) return;
        // Leave other dialogs (for example a settings modal) their own Esc.
        if ((event.target as HTMLElement | null)?.closest?.('[role="dialog"]:not([data-layout-popover])')) return;
        event.preventDefault();
        doneRef.current();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || isEditableTarget(event.target)) return;
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menu, redo, undo]);

  const lockAll = (locked: boolean) => {
    dispatchLayoutLockAll(scopeId, locked);
    if (!locked) setHint("dismissed");
  };

  return (
    <div
      data-layout-toolbar
      data-layout-dock={dock}
      data-game-skip-bg-nav="true"
      className={`pointer-events-auto flex items-center gap-1.5 ${dock === "top" ? "flex-col" : "flex-col-reverse"}`}
      style={{
        position: "fixed",
        left: placement.centerX,
        transform: "translateX(-50%)",
        zIndex: TOOLBAR_Z_INDEX,
        display: "flex",
        flexDirection: dock === "top" ? "column" : "column-reverse",
        alignItems: "center",
        gap: 6,
        ...(dock === "top" ? { top: placement.top } : { bottom: placement.bottom }),
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        role="toolbar"
        aria-label={t("ui.game.layoutEditor.toolbarLabel")}
        className="flex h-9 items-center gap-0.5 whitespace-nowrap rounded-xl border border-[var(--marinara-chat-chrome-panel-border)] px-1 text-[var(--marinara-chat-chrome-panel-text)] shadow-[0_10px_30px_rgba(0,0,0,0.3)]"
        style={{ display: "flex", alignItems: "center", background: LAYOUT_SOLID_BACKGROUND }}
      >
        <span className="flex items-center gap-1.5 pl-1.5 pr-1 text-[0.75rem] font-semibold text-[var(--marinara-chat-chrome-panel-title)]">
          <LayoutTemplate size={14} aria-hidden="true" className="text-[var(--marinara-chat-chrome-accent)]" />
          {t("ui.game.layoutEditor.title")}
        </span>
        <Divider />
        <ToolbarButton label={t("ui.game.layoutEditor.undo")} onClick={undo} disabled={!canUndo} name="undo">
          <Undo2 size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label={t("ui.game.layoutEditor.redo")} onClick={redo} disabled={!canRedo} name="redo">
          <Redo2 size={14} aria-hidden="true" />
        </ToolbarButton>
        <Divider />
        <ToolbarButton
          label={t(snapEnabled ? "ui.game.layoutEditor.snapOn" : "ui.game.layoutEditor.snapOff")}
          pressed={snapEnabled}
          onClick={() => setLayoutSnapEnabled(!snapEnabled)}
          name="snap"
        >
          <Magnet size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label={t(collisionsEnabled ? "ui.game.layoutEditor.collisionsOn" : "ui.game.layoutEditor.collisionsOff")}
          pressed={collisionsEnabled}
          onClick={() => {
            setLayoutCollisionsEnabled(!collisionsEnabled);
            scheduleGamePanelLayout(surface);
          }}
          name="collisions"
        >
          <Layers2 size={14} aria-hidden="true" />
        </ToolbarButton>
        <Divider />
        <ToolbarButton label={t("ui.game.layoutEditor.lockAll")} onClick={() => lockAll(true)} name="lock-all">
          <Lock size={14} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label={t("ui.game.layoutEditor.unlockAll")} onClick={() => lockAll(false)} name="unlock-all">
          <LockOpen size={14} aria-hidden="true" />
        </ToolbarButton>
        <Divider />
        <ToolbarButton
          label={t("ui.game.layoutEditor.panels")}
          buttonRef={panelsButton}
          expanded={menu === "panels"}
          onClick={() => setMenu((current) => (current === "panels" ? null : "panels"))}
          name="panels"
          wide
        >
          <PanelsTopLeft size={14} aria-hidden="true" />
          <span>{t("ui.game.layoutEditor.panels")}</span>
          {hiddenCount > 0 && (
            <span
              data-layout-hidden-count
              className="rounded-full bg-[var(--marinara-chat-chrome-accent)] px-1.5 text-[0.625rem] font-semibold leading-4 text-white"
            >
              {hiddenCount}
            </span>
          )}
        </ToolbarButton>
        <ToolbarButton
          label={t("ui.game.layoutEditor.layouts")}
          buttonRef={layoutsButton}
          expanded={menu === "layouts"}
          onClick={() => setMenu((current) => (current === "layouts" ? null : "layouts"))}
          name="layouts"
          wide
        >
          <Save size={14} aria-hidden="true" />
          <span>{t("ui.game.layoutEditor.layouts")}</span>
        </ToolbarButton>
        <Divider />
        <ToolbarButton
          label={t(dock === "top" ? "ui.game.layoutEditor.dockBottom" : "ui.game.layoutEditor.dockTop")}
          onClick={() => setLayoutToolbarDock(dock === "top" ? "bottom" : "top")}
          name="dock"
        >
          {dock === "top" ? (
            <ArrowDownToLine size={14} aria-hidden="true" />
          ) : (
            <ArrowUpToLine size={14} aria-hidden="true" />
          )}
        </ToolbarButton>
        <button
          type="button"
          data-layout-tool="done"
          onClick={onDone}
          title={t("ui.game.layoutEditor.doneHint")}
          className="ml-0.5 flex h-7 items-center gap-1 rounded-lg bg-[var(--marinara-chat-chrome-accent)] px-2.5 text-[0.75rem] font-semibold text-white shadow-sm transition-[filter] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)]"
        >
          <Check size={14} aria-hidden="true" />
          {t("ui.game.layoutEditor.done")}
        </button>
      </div>
      {hint === "shown" && allLocked && (
        <div
          role="status"
          data-layout-locked-hint
          style={{ background: LAYOUT_SOLID_BACKGROUND }}
          className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] py-1 pl-2.5 pr-1 text-[0.75rem] text-[var(--marinara-chat-chrome-panel-text)] shadow-[0_6px_18px_rgba(0,0,0,0.22)]"
        >
          <Lock size={12} aria-hidden="true" className="text-[var(--marinara-chat-chrome-panel-muted)]" />
          <span>{t("ui.game.layoutEditor.allLockedHint")}</span>
          <button
            type="button"
            onClick={() => lockAll(false)}
            className="h-6 rounded-md bg-[var(--marinara-chat-chrome-highlight-bg)] px-2 font-semibold text-[var(--marinara-chat-chrome-highlight-text)] hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)]"
          >
            {t("ui.game.layoutEditor.unlockAll")}
          </button>
          <button
            type="button"
            aria-label={t("ui.game.layoutEditor.dismiss")}
            title={t("ui.game.layoutEditor.dismiss")}
            onClick={() => setHint("dismissed")}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--marinara-chat-chrome-panel-muted)] hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)]"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      <GameLayoutPopover
        anchor={panelsButton}
        open={menu === "panels"}
        onClose={() => setMenu(null)}
        label={t("ui.game.layoutEditor.panels")}
        name="panels"
        width={248}
        align="center"
      >
        <PanelsMenu scopeId={scopeId} />
      </GameLayoutPopover>
      <GameLayoutPopover
        anchor={layoutsButton}
        open={menu === "layouts"}
        onClose={() => setMenu(null)}
        label={t("ui.game.layoutEditor.layouts")}
        name="layouts"
        width={300}
        align="center"
      >
        <LayoutsMenu
          scopeId={scopeId}
          onApplied={() => {
            setMenu(null);
            onLayoutApplied();
          }}
        />
      </GameLayoutPopover>
    </div>
  );
}

function PanelsMenu({ scopeId }: { scopeId: string }) {
  const { t } = useTranslation();
  const catalog = useLayoutCatalog(scopeId);
  useHiddenPanelsVersion();
  const hidden = catalog.filter((entry) => isPanelHidden(scopeId, entry.id));
  return (
    <>
      <LayoutPopoverSection title={t("ui.game.layoutEditor.panelsHeading")}>
        <div data-layout-panels-list className="flex max-h-[min(60vh,420px)] flex-col gap-0.5 overflow-y-auto">
          {catalog.map((entry) => {
            const isHidden = isPanelHidden(scopeId, entry.id);
            return (
              <div
                key={entry.id}
                data-layout-panel-row={entry.id}
                className="flex h-7 shrink-0 items-center gap-2 rounded-md px-1.5 hover:bg-[var(--marinara-chat-chrome-highlight-bg)]"
              >
                <span
                  className={`min-w-0 flex-1 truncate text-xs ${isHidden ? "text-[var(--marinara-chat-chrome-panel-muted)] line-through decoration-1" : ""}`}
                >
                  {entry.label}
                </span>
                {entry.hideable ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!isHidden}
                    aria-label={
                      isHidden
                        ? t("ui.game.layoutEditor.showPanel", { name: entry.label })
                        : t("ui.game.layoutEditor.hidePanel", { name: entry.label })
                    }
                    title={
                      isHidden
                        ? t("ui.game.layoutEditor.showPanel", { name: entry.label })
                        : t("ui.game.layoutEditor.hidePanel", { name: entry.label })
                    }
                    onClick={() => setPanelHidden(scopeId, entry.id, !isHidden)}
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)] ${
                      isHidden
                        ? "text-[var(--marinara-chat-chrome-panel-muted)]"
                        : "text-[var(--marinara-chat-chrome-highlight-text)]"
                    }`}
                  >
                    {isHidden ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
                  </button>
                ) : (
                  <span
                    className="shrink-0 text-[0.625rem] text-[var(--marinara-chat-chrome-panel-muted)]"
                    title={t("ui.game.layoutEditor.cannotHide")}
                  >
                    {t("ui.game.layoutEditor.alwaysVisible")}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </LayoutPopoverSection>
      {hidden.length > 0 && (
        <LayoutPopoverSection>
          <LayoutMenuButton
            icon={<Eye size={12} />}
            onClick={() => {
              for (const entry of hidden) setPanelHidden(scopeId, entry.id, false);
            }}
          >
            {t("ui.game.layoutEditor.showAll", { count: hidden.length })}
          </LayoutMenuButton>
        </LayoutPopoverSection>
      )}
    </>
  );
}

function LayoutsMenu({ scopeId, onApplied }: { scopeId: string; onApplied: () => void }) {
  const { t } = useTranslation();
  const layouts = useSavedLayouts();
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [exportText, setExportText] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState(false);

  const save = () => {
    const next = addSavedLayout(
      readSavedLayouts(),
      name || t("ui.game.layoutEditor.defaultLayoutName", { number: layouts.length + 1 }),
      captureCurrentLayout(scopeId),
      Date.now(),
      newLayoutId(),
    );
    writeSavedLayouts(next);
    setName("");
  };
  const apply = (layout: SavedLayout) => {
    applyLayoutAsStep(scopeId, layout.snapshot);
    onApplied();
  };
  const copy = async (key: string, json: string) => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(key);
      setExportText(null);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1600);
    } catch {
      // Clipboard can be unavailable (permissions, insecure origin): show the JSON to copy by hand.
      setExportText(json);
    }
  };
  const runImport = () => {
    const parsed = parseLayoutJson(importText);
    if (!parsed) {
      setImportError(true);
      return;
    }
    let next = readSavedLayouts();
    for (const item of parsed) next = addSavedLayout(next, item.name, item.snapshot, Date.now(), newLayoutId());
    writeSavedLayouts(next);
    setImportText("");
    setImportError(false);
    setImportOpen(false);
  };
  const commitRename = () => {
    if (!renaming) return;
    writeSavedLayouts(renameSavedLayout(readSavedLayouts(), renaming.id, renaming.value, Date.now()));
    setRenaming(null);
  };
  const iconButton =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--marinara-chat-chrome-panel-muted)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] hover:text-[var(--marinara-chat-chrome-highlight-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)]";
  const input =
    "h-7 min-w-0 flex-1 rounded-md border border-[var(--marinara-chat-chrome-input-border,var(--marinara-chat-chrome-panel-border))] bg-[var(--marinara-chat-chrome-input-bg,transparent)] px-2 text-xs text-[var(--marinara-chat-chrome-panel-text)] outline-none placeholder:text-[var(--marinara-chat-chrome-panel-muted)] focus:border-[var(--marinara-chat-chrome-accent)]";

  return (
    <>
      <LayoutPopoverSection title={t("ui.game.layoutEditor.saveHeading")}>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            aria-label={t("ui.game.layoutEditor.layoutName")}
            placeholder={t("ui.game.layoutEditor.layoutNamePlaceholder")}
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            className={input}
          />
          <button
            type="submit"
            data-layout-save
            className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-[var(--marinara-chat-chrome-accent)] px-2.5 text-xs font-semibold text-white hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--marinara-chat-chrome-accent)]"
          >
            <Save size={12} aria-hidden="true" />
            {t("ui.game.layoutEditor.saveLayout")}
          </button>
        </form>
      </LayoutPopoverSection>
      <LayoutPopoverSection title={t("ui.game.layoutEditor.savedHeading")}>
        {layouts.length === 0 ? (
          <p className="px-1 text-[0.6875rem] leading-snug text-[var(--marinara-chat-chrome-panel-muted)]">
            {t("ui.game.layoutEditor.noLayouts")}
          </p>
        ) : (
          <ul data-layout-saved-list className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
            {layouts.map((layout) => (
              <li
                key={layout.id}
                data-layout-saved={layout.name}
                className="flex h-7 shrink-0 items-center gap-0.5 rounded-md pl-1 hover:bg-[var(--marinara-chat-chrome-highlight-bg)]"
              >
                {renaming?.id === layout.id ? (
                  <input
                    autoFocus
                    data-layout-escape-local
                    aria-label={t("ui.game.layoutEditor.renameLayout", { name: layout.name })}
                    value={renaming.value}
                    maxLength={60}
                    onChange={(event) => setRenaming({ id: layout.id, value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRename();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                    onBlur={commitRename}
                    className={input}
                  />
                ) : (
                  <button
                    type="button"
                    aria-label={t("ui.game.layoutEditor.applyLayout", { name: layout.name })}
                    title={t("ui.game.layoutEditor.applyLayout", { name: layout.name })}
                    onClick={() => apply(layout)}
                    className="min-w-0 flex-1 truncate rounded px-1 text-left text-xs text-[var(--marinara-chat-chrome-panel-text)] hover:text-[var(--marinara-chat-chrome-highlight-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)]"
                  >
                    {layout.name}
                  </button>
                )}
                <button
                  type="button"
                  className={iconButton}
                  aria-label={t("ui.game.layoutEditor.renameLayout", { name: layout.name })}
                  title={t("ui.game.layoutEditor.renameLayout", { name: layout.name })}
                  onClick={() => setRenaming({ id: layout.id, value: layout.name })}
                >
                  <Pencil size={11} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={iconButton}
                  aria-label={t("ui.game.layoutEditor.exportLayout", { name: layout.name })}
                  title={
                    copied === layout.id
                      ? t("ui.game.layoutEditor.copied")
                      : t("ui.game.layoutEditor.exportLayout", { name: layout.name })
                  }
                  onClick={() => void copy(layout.id, exportLayoutJson(layout.name, layout.snapshot))}
                >
                  {copied === layout.id ? (
                    <Check size={11} aria-hidden="true" />
                  ) : (
                    <Copy size={11} aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  className={
                    confirmDelete === layout.id
                      ? "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[0.625rem] font-semibold text-[var(--destructive)] hover:bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)]"
                      : iconButton
                  }
                  aria-label={
                    confirmDelete === layout.id
                      ? t("ui.game.layoutEditor.confirmDelete")
                      : t("ui.game.layoutEditor.deleteLayout", { name: layout.name })
                  }
                  title={
                    confirmDelete === layout.id
                      ? t("ui.game.layoutEditor.confirmDelete")
                      : t("ui.game.layoutEditor.deleteLayout", { name: layout.name })
                  }
                  onBlur={() => setConfirmDelete((current) => (current === layout.id ? null : current))}
                  onClick={() => {
                    if (confirmDelete !== layout.id) {
                      setConfirmDelete(layout.id);
                      return;
                    }
                    writeSavedLayouts(deleteSavedLayout(readSavedLayouts(), layout.id));
                    setConfirmDelete(null);
                  }}
                >
                  <Trash2 size={11} aria-hidden="true" />
                  {confirmDelete === layout.id && <span>{t("ui.game.layoutEditor.deleteShort")}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </LayoutPopoverSection>
      <LayoutPopoverSection title={t("ui.game.layoutEditor.transferHeading")}>
        <LayoutMenuButton
          icon={copied === "current" ? <Check size={12} /> : <Copy size={12} />}
          onClick={() =>
            void copy(
              "current",
              exportLayoutJson(t("ui.game.layoutEditor.currentLayoutName"), captureCurrentLayout(scopeId)),
            )
          }
        >
          {copied === "current" ? t("ui.game.layoutEditor.copied") : t("ui.game.layoutEditor.exportCurrent")}
        </LayoutMenuButton>
        {exportText !== null && (
          <textarea
            readOnly
            aria-label={t("ui.game.layoutEditor.exportFallback")}
            value={exportText}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 h-24 w-full resize-none rounded-md border border-[var(--marinara-chat-chrome-panel-border)] bg-transparent p-1.5 font-mono text-[0.625rem] text-[var(--marinara-chat-chrome-panel-text)]"
          />
        )}
        <LayoutMenuButton
          icon={<Upload size={12} />}
          pressed={importOpen}
          onClick={() => setImportOpen((open) => !open)}
        >
          {t("ui.game.layoutEditor.import")}
        </LayoutMenuButton>
        {importOpen && (
          <div className="mt-1 flex flex-col gap-1.5">
            <textarea
              aria-label={t("ui.game.layoutEditor.importPlaceholder")}
              placeholder={t("ui.game.layoutEditor.importPlaceholder")}
              value={importText}
              onChange={(event) => {
                setImportText(event.target.value);
                setImportError(false);
              }}
              className="h-24 w-full resize-none rounded-md border border-[var(--marinara-chat-chrome-input-border,var(--marinara-chat-chrome-panel-border))] bg-transparent p-1.5 font-mono text-[0.625rem] text-[var(--marinara-chat-chrome-panel-text)] outline-none focus:border-[var(--marinara-chat-chrome-accent)]"
            />
            {importError && (
              <p role="alert" className="text-[0.6875rem] text-[var(--destructive)]">
                {t("ui.game.layoutEditor.importError")}
              </p>
            )}
            <button
              type="button"
              disabled={!importText.trim()}
              onClick={runImport}
              className="h-7 self-end rounded-md bg-[var(--marinara-chat-chrome-highlight-bg)] px-2.5 text-xs font-semibold text-[var(--marinara-chat-chrome-highlight-text)] hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)]"
            >
              {t("ui.game.layoutEditor.importAction")}
            </button>
          </div>
        )}
      </LayoutPopoverSection>
      <LayoutPopoverSection>
        <LayoutMenuButton
          icon={<RotateCcw size={12} />}
          danger
          onClick={() => {
            if (!confirmReset) {
              setConfirmReset(true);
              return;
            }
            setConfirmReset(false);
            applyLayoutAsStep(scopeId, { entries: {} });
            onApplied();
          }}
        >
          {confirmReset ? t("ui.game.layoutEditor.resetAllConfirm") : t("ui.game.layoutEditor.resetAll")}
        </LayoutMenuButton>
      </LayoutPopoverSection>
    </>
  );
}
