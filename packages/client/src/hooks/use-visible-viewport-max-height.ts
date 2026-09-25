import { useLayoutEffect, useState, type RefObject } from "react";

/** Gap kept between a fitted popover and the bottom of the visible viewport, in CSS pixels. */
export const VISIBLE_VIEWPORT_FIT_MARGIN_PX = 12;

/**
 * Height left between `top` (a layout-viewport y coordinate, as getBoundingClientRect reports it) and the
 * bottom of the visible viewport. The visual viewport shrinks for the on-screen keyboard and mobile browser
 * chrome, which 100vh (and even 100dvh while the keyboard is open) does not.
 */
export function visibleViewportSpaceBelow(
  top: number,
  viewport: { height: number; offsetTop: number } | null | undefined,
  layoutHeight: number,
  margin = VISIBLE_VIEWPORT_FIT_MARGIN_PX,
): number {
  const visibleBottom = viewport ? viewport.offsetTop + viewport.height : layoutHeight;
  return Math.max(0, Math.floor(visibleBottom - Math.max(0, top) - margin));
}

/**
 * Keeps an open popover inside the visible viewport: returns the max height (px) the element at `ref` can
 * take from its current top edge down to the visible bottom, tracking resizes and the on-screen keyboard.
 * Pair it with `env(safe-area-inset-bottom)` in CSS so the home indicator never covers the last control.
 */
export function useVisibleViewportMaxHeight(ref: RefObject<HTMLElement | null>, enabled: boolean): number | null {
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!enabled) {
      setMaxHeight(null);
      return undefined;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const element = ref.current;
      if (!element) return;
      const next = visibleViewportSpaceBelow(
        element.getBoundingClientRect().top,
        window.visualViewport,
        window.innerHeight,
      );
      setMaxHeight((current) => (current === next ? current : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [enabled, ref]);

  return maxHeight;
}
