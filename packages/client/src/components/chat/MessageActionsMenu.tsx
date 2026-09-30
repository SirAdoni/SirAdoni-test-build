// ──────────────────────────────────────────────
// Message actions on touch screens: inline row or one ⋯ menu
// ──────────────────────────────────────────────
// Both presentations render the SAME action children (the buttons the inline row
// already builds), so visibility rules and handlers stay in one place. In menu mode
// each MessageActionButton reads MessageActionPresentationContext and renders as a
// full-size labelled menu item instead of an icon button.
import { MoreHorizontal, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { normalizeTouchMessageActionsMode, useUIStore } from "../../stores/ui.store";

export type MessageActionPresentation = { mode: "row" } | { mode: "menu"; close: () => void };

export const MessageActionPresentationContext = createContext<MessageActionPresentation>({ mode: "row" });

export function useMessageActionPresentation(): MessageActionPresentation {
  return useContext(MessageActionPresentationContext);
}

const COARSE_POINTER_QUERY = "(pointer: coarse)";

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(COARSE_POINTER_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(COARSE_POINTER_QUERY);
    const update = () => setCoarse(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return coarse;
}

/** True when the user chose the ⋯ menu and this is a touch screen; mouse screens always keep the row. */
export function useTouchMessageActionsMenu(): boolean {
  const mode = useUIStore((state) => normalizeTouchMessageActionsMode(state.touchMessageActionsMode));
  const coarse = useCoarsePointer();
  return mode === "menu" && coarse;
}

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not(:disabled)';
const SHEET_BREAKPOINT_PX = 768;

/**
 * Chooses the presentation for one message's actions. Row mode renders the existing
 * row element unchanged; menu mode renders a zero-height anchor with a ⋯ button.
 */
export function MessageActionsSurface({
  rowProps,
  revealed,
  menuDisabled = false,
  children,
}: {
  /** Props of the inline row element, used unchanged in row mode. */
  rowProps: HTMLAttributes<HTMLDivElement> & { "data-component"?: string };
  /** Whether the message's actions are currently shown (tap, hover or edit). */
  revealed: boolean;
  /** Keep the inline row even in menu mode (for example the streaming thinking-only row). */
  menuDisabled?: boolean;
  children: ReactNode;
}) {
  const menuMode = useTouchMessageActionsMenu();
  if (!menuMode || menuDisabled) return <div {...rowProps}>{children}</div>;
  return <MessageActionsMenu revealed={revealed}>{children}</MessageActionsMenu>;
}

function MessageActionsMenu({ revealed, children }: { revealed: boolean; children: ReactNode }) {
  const { t: localizeUi } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [asSheet, setAsSheet] = useState(true);
  const label = localizeUi("ui.chat.messageactionsmenu.messageActions");

  const close = useCallback(() => {
    setOpen(false);
    // Return focus to the ⋯ button so keyboard and screen-reader users keep their place.
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const sheet = window.innerWidth < SHEET_BREAKPOINT_PX;
      setAsSheet(sheet);
      if (sheet) {
        setPanelStyle({});
        return;
      }
      const trigger = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const margin = 8;
      const below = trigger.bottom + 6;
      const top = below + height <= window.innerHeight - margin ? below : Math.max(margin, trigger.top - height - 6);
      const left = Math.max(margin, Math.min(trigger.right - width, window.innerWidth - width - margin));
      setPanelStyle({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [asSheet, open]);

  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR);
    first?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A marks or reaction popover opened from the menu closes first.
      if (document.querySelector(".marinara-chat-popover")) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? []);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = index <= 0 ? items.length - 1 : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className="relative h-0 w-full" data-message-actions-menu="">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          // Decide sheet vs popover before the first paint so the popover is measured at its own width.
          setAsSheet(window.innerWidth < SHEET_BREAKPOINT_PX);
          setOpen((value) => !value);
        }}
        className={cn(
          "absolute bottom-1 right-1 z-[5] flex h-9 w-9 items-center justify-center rounded-full border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-panel-bg)] text-[var(--marinara-chat-message-action-text-hover)] shadow-md backdrop-blur-md transition-opacity [-webkit-tap-highlight-color:transparent] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]",
          revealed || open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <MoreHorizontal size="1.125rem" />
      </button>
      {open &&
        createPortal(
          <MessageActionPresentationContext.Provider value={{ mode: "menu", close }}>
            <div
              className={cn("fixed inset-0 z-[70]", asSheet && "bg-black/45")}
              onClick={(event) => {
                event.stopPropagation();
                close();
              }}
              aria-hidden="true"
              data-message-actions-backdrop=""
            />
            <div
              ref={panelRef}
              role="menu"
              aria-label={label}
              onKeyDown={onMenuKeyDown}
              onClick={(event) => event.stopPropagation()}
              style={panelStyle}
              data-message-actions-sheet={asSheet ? "sheet" : "popover"}
              className={cn(
                // The chrome panel colour can be translucent; layer it over the opaque app background.
                "marinara-chat-message-actions-menu fixed z-[71] flex flex-col overflow-hidden border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--background)] bg-[image:linear-gradient(var(--marinara-chat-chrome-panel-bg),var(--marinara-chat-chrome-panel-bg))] text-[var(--foreground)] shadow-2xl",
                asSheet
                  ? "inset-x-0 bottom-0 max-h-[75dvh] rounded-t-2xl pb-[var(--mari-safe-area-inset-bottom,env(safe-area-inset-bottom))]"
                  : "w-72 max-h-[min(32rem,70vh)] rounded-xl",
              )}
            >
              <div className="flex shrink-0 items-center justify-between border-b border-[var(--marinara-chat-chrome-panel-border)] py-1 pl-4 pr-1">
                <span className="text-sm font-semibold">{label}</span>
                <button
                  type="button"
                  onClick={close}
                  aria-label={localizeUi("navigation.common.close")}
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]"
                >
                  <X size="1.125rem" />
                </button>
              </div>
              <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain p-1.5">{children}</div>
            </div>
          </MessageActionPresentationContext.Provider>,
          document.body,
        )}
    </div>
  );
}
