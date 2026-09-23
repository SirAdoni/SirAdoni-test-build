// Small anchored popover used by the Game layout editor (panel options, Panels
// and Layouts menus). Portal to <body>, keyboard accessible, closes on outside
// pointer down or Esc, and returns focus to its anchor.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { markLayoutPopoverOpen } from "../../lib/game-layout-editor-store";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  label: string;
  width?: number;
  align?: "start" | "center" | "end";
  children: ReactNode;
  /** Test and styling hook. */
  name?: string;
}

export const LAYOUT_POPOVER_Z_INDEX = 1200;
/** The chrome panel colour laid over the app background, so layout chrome is always opaque. */
export const LAYOUT_SOLID_BACKGROUND =
  "linear-gradient(var(--marinara-chat-chrome-panel-bg), var(--marinara-chat-chrome-panel-bg)), var(--background, #16161a)";

export function GameLayoutPopover({
  anchor,
  open,
  onClose,
  label,
  width = 264,
  align = "start",
  children,
  name,
}: Props) {
  const popover = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const place = useCallback(() => {
    const target = anchor.current;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const height = popover.current?.scrollHeight ?? 0;
    const margin = 8;
    const preferredLeft =
      align === "end" ? rect.right - width : align === "center" ? rect.left + rect.width / 2 - width / 2 : rect.left;
    const left = Math.max(margin, Math.min(preferredLeft, window.innerWidth - width - margin));
    const below = rect.bottom + 6;
    const spaceBelow = window.innerHeight - below - margin;
    const spaceAbove = rect.top - 6 - margin;
    const openAbove = height > spaceBelow && spaceAbove > spaceBelow;
    const maxHeight = Math.max(160, openAbove ? spaceAbove : spaceBelow);
    const top = openAbove
      ? Math.max(margin, rect.top - 6 - Math.min(height, maxHeight))
      : Math.max(margin, Math.min(below, window.innerHeight - margin - Math.min(height, maxHeight)));
    setPosition((current) =>
      current && current.left === left && current.top === top && current.maxHeight === maxHeight
        ? current
        : { left, top, maxHeight },
    );
  }, [align, anchor, width]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
    // Measure again once the content has laid out, then follow the anchor.
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer = new ResizeObserver(place);
    if (popover.current) observer.observe(popover.current);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer.disconnect();
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const release = markLayoutPopoverOpen();
    const focusFrame = requestAnimationFrame(() => {
      const first = popover.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus({ preventScroll: true });
    });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popover.current?.contains(target) || anchor.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Inline editors (for example a rename field) cancel themselves first.
      if ((event.target as HTMLElement | null)?.closest?.("[data-layout-escape-local]")) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      anchor.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      release();
    };
  }, [anchor, open]);

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !popover.current) return;
    const items = [...popover.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => element.offsetParent !== null,
    );
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;
  return createPortal(
    <div
      ref={popover}
      role="dialog"
      aria-label={label}
      data-layout-popover={name ?? ""}
      data-game-skip-bg-nav="true"
      onKeyDown={(event) => {
        trapTab(event);
        event.stopPropagation();
      }}
      // React portals bubble synthetic events to the owning panel. Keep popover
      // clicks and focus from starting drags or tuck reveals underneath.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onFocus={(event) => event.stopPropagation()}
      onBlur={(event) => event.stopPropagation()}
      className="overflow-y-auto rounded-xl border border-[var(--marinara-chat-chrome-panel-border)] p-2 text-xs text-[var(--marinara-chat-chrome-panel-text)] shadow-[0_12px_32px_rgba(0,0,0,0.28)]"
      style={{
        position: "fixed",
        // Chrome panel colours can be translucent; menus sit on a solid base so nothing shows through.
        background: LAYOUT_SOLID_BACKGROUND,
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        width,
        maxHeight: position?.maxHeight,
        zIndex: LAYOUT_POPOVER_Z_INDEX,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Section inside a layout popover, with an optional small heading. */
export function LayoutPopoverSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="border-t border-[var(--marinara-chat-chrome-panel-divider)] px-1 py-2 first:border-t-0 first:pt-1 last:pb-1">
      {title && (
        <div className="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--marinara-chat-chrome-panel-muted)]">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Accessible name; defaults to the visible label. */
  ariaLabel?: string;
}

/** Compact segmented radio group with arrow-key navigation. */
export function LayoutSegmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<SegmentOption<T>>;
  onChange: (value: T) => void;
  label: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      className="flex rounded-lg bg-[var(--marinara-chat-chrome-highlight-bg)] p-0.5"
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const index = options.findIndex((option) => option.value === value);
        const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const next = options[(index + step + options.length) % options.length]!;
        onChange(next.value);
        requestAnimationFrame(() =>
          group.current?.querySelector<HTMLElement>(`[data-segment-value="${next.value}"]`)?.focus(),
        );
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel ?? option.label}
            title={option.ariaLabel ?? option.label}
            tabIndex={selected ? 0 : -1}
            data-segment-value={option.value}
            onClick={() => onChange(option.value)}
            className={`h-6 min-w-0 flex-1 truncate rounded-md px-2 text-[0.6875rem] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)] ${
              selected
                ? "bg-[var(--marinara-chat-chrome-panel-bg)] text-[var(--marinara-chat-chrome-highlight-text)] shadow-sm"
                : "text-[var(--marinara-chat-chrome-panel-muted)] hover:text-[var(--marinara-chat-chrome-panel-title)]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A full-width row button for menus: icon, label and optional trailing content. */
export function LayoutMenuButton({
  icon,
  children,
  onClick,
  pressed,
  disabled,
  danger,
  ariaLabel,
  trailing,
  title,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  danger?: boolean;
  ariaLabel?: string;
  trailing?: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--marinara-chat-chrome-accent)] disabled:cursor-not-allowed disabled:opacity-45 ${
        danger
          ? "text-[var(--destructive)] hover:bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)]"
          : pressed
            ? "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-highlight-text)]"
            : "text-[var(--marinara-chat-chrome-panel-text)] hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)]"
      }`}
    >
      {icon && <span className="flex w-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}
