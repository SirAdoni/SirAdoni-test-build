import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Keeps the Game composer's footprint at its one-line height. The input bar sits absolutely at the
 * bottom of `slot`, so when the textarea auto-grows for a long turn it rises over the narration
 * instead of pushing the narration panel, the floating panels and the narration scroll around on
 * every keystroke. The slot height is written straight to the DOM (no React state), so the
 * measurement can never feed a render or resize loop.
 */
export function useComposerOverlayGrowth(
  slot: RefObject<HTMLElement | null>,
  bar: RefObject<HTMLElement | null>,
  textarea: RefObject<HTMLTextAreaElement | null>,
) {
  useLayoutEffect(() => {
    const slotElement = slot.current;
    const barElement = bar.current;
    if (!slotElement || !barElement) return;
    const reserve = () => {
      const input = textarea.current;
      const grown = input ? input.offsetHeight - (Number.parseFloat(getComputedStyle(input).minHeight) || 0) : 0;
      const next = `${Math.max(0, barElement.offsetHeight - Math.max(0, grown))}px`;
      if (slotElement.style.height !== next) slotElement.style.height = next;
    };
    reserve();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reserve);
    observer.observe(barElement);
    return () => observer.disconnect();
  }, [slot, bar, textarea]);
}

/**
 * The composer dock's last height, held after the dock unmounts. Sending a turn swaps the dock for
 * the generation status line; reserving the dock's height there keeps the narration panel (and the
 * crowded-layout reflow that follows its height) still at the moment of sending. The height is kept
 * current while the dock is mounted, so the swap renders at full height in the same commit and the
 * narration scroll position is never clamped by a momentarily shorter panel.
 */
export function useComposerDockReserve() {
  const observer = useRef<ResizeObserver | null>(null);
  const [reserved, setReserved] = useState(0);
  const dockRef = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    const record = () => {
      // The dock's height changes only with its rows (dice, attachments), never per keystroke.
      if (element.isConnected) setReserved(element.offsetHeight);
    };
    record();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(record);
    observer.current.observe(element);
  }, []);
  return { dockRef, reserved };
}
