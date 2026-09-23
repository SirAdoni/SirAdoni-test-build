// ──────────────────────────────────────────────
// Keyboard handling for the docked shell panels (chat sidebar, right panel).
//
// - Opened from its top-bar toggle, a panel takes focus, so Tab continues inside
//   it instead of walking the whole Home page first (the panels come after the
//   center content in DOM order).
// - Escape inside a panel closes it and returns focus to the toggle that opened
//   it, unless something inside the panel owns that Escape: a text field that
//   still has text, an open menu/listbox/popover, or any dialog above the shell.
// ──────────────────────────────────────────────
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { isModalOverlayOpen } from "../../lib/modal-overlay-registry";

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

function ownsEscape(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[aria-expanded="true"], [role="menu"], [role="listbox"], [role="dialog"]')) return true;
  if (target instanceof HTMLTextAreaElement) return target.value.length > 0;
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) return target.value.length > 0;
  return target.isContentEditable;
}

export function usePanelKeyboardFocus({
  open,
  panelKey,
  containerRef,
  toggleSelector,
  onClose,
}: {
  open: boolean;
  /** Changes when the same container switches content (e.g. right panel tabs). */
  panelKey?: string;
  containerRef: RefObject<HTMLElement | null>;
  /** Selector for the toggle that opens this panel, used to restore focus. */
  toggleSelector: string;
  onClose: () => void;
}) {
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    // Only follow a deliberate top-bar activation. Panels opened programmatically
    // (the tour, deep links, Professor Mari) must not steal focus from the composer.
    if (!(active instanceof HTMLElement) || !active.closest('[data-component="TopBar"]')) return;
    openerRef.current = active;
    // The shell panels slide in; an element that is still invisible cannot take
    // focus, so retry briefly until the enter animation has made it focusable.
    let attempts = 0;
    let timer = 0;
    const tryFocus = () => {
      const container = containerRef.current;
      if (!container) return;
      container.focus({ preventScroll: true });
      if (document.activeElement !== container && !container.contains(document.activeElement) && attempts++ < 8) {
        timer = window.setTimeout(tryFocus, 60);
      }
    };
    const frame = window.requestAnimationFrame(tryFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [open, panelKey, containerRef]);

  // Closed by any route (its X, the toggle, Escape): if focus was left inside the
  // now-hidden panel or dropped to <body>, hand it back to the opener.
  useEffect(() => {
    if (open) return;
    const opener = openerRef.current;
    if (!opener) return;
    const active = document.activeElement;
    const container = containerRef.current;
    if (active === document.body || (container && active && container.contains(active))) {
      if (document.contains(opener)) opener.focus({ preventScroll: true });
    }
    openerRef.current = null;
  }, [open, containerRef]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (isModalOverlayOpen() || ownsEscape(event.target)) return;
    event.preventDefault();
    onClose();
    const opener =
      openerRef.current && document.contains(openerRef.current)
        ? openerRef.current
        : document.querySelector<HTMLElement>(toggleSelector);
    window.requestAnimationFrame(() => opener?.focus({ preventScroll: true }));
  };

  return { onKeyDown };
}
