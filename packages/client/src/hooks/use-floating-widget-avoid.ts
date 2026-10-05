import { useEffect, useLayoutEffect, useState } from "react";
import { FLOATING_WIDGET_AVOID_SELECTOR, type FloatingWidgetRect } from "../lib/floating-widget-avoid";

export interface FloatingWidgetAvoidState {
  viewportLeft: number;
  viewportTop: number;
  viewportWidth: number;
  viewportHeight: number;
  obstacles: FloatingWidgetRect[];
}

/** Measure the rendered collapsed bubble so rem-scaled controls are placed using their real size. */
export function useMeasuredFloatingWidgetSize(enabled: boolean, fallback: number) {
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState(fallback);

  useLayoutEffect(() => {
    if (!enabled || !element) return;

    const measure = () => {
      const rect = element.getBoundingClientRect();
      const measured = Math.max(rect.width, rect.height);
      if (measured > 0 && Number.isFinite(measured))
        setSize((previous) => (Math.abs(previous - measured) < 0.25 ? previous : measured));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, element]);

  return [ref, size] as const;
}

function readState(): FloatingWidgetAvoidState {
  const viewport = window.visualViewport;
  const obstacles: FloatingWidgetRect[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(FLOATING_WIDGET_AVOID_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    obstacles.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  }
  return {
    viewportLeft: viewport?.offsetLeft ?? 0,
    viewportTop: viewport?.offsetTop ?? 0,
    viewportWidth: viewport?.width ?? window.innerWidth,
    viewportHeight: viewport?.height ?? window.innerHeight,
    obstacles,
  };
}

function sameState(a: FloatingWidgetAvoidState, b: FloatingWidgetAvoidState): boolean {
  if (
    a.viewportLeft !== b.viewportLeft ||
    a.viewportTop !== b.viewportTop ||
    a.viewportWidth !== b.viewportWidth ||
    a.viewportHeight !== b.viewportHeight
  ) {
    return false;
  }
  if (a.obstacles.length !== b.obstacles.length) return false;
  return a.obstacles.every((rect, index) => {
    const other = b.obstacles[index]!;
    return (
      Math.round(rect.left) === Math.round(other.left) &&
      Math.round(rect.top) === Math.round(other.top) &&
      Math.round(rect.right) === Math.round(other.right) &&
      Math.round(rect.bottom) === Math.round(other.bottom)
    );
  });
}

const EMPTY_STATE: FloatingWidgetAvoidState = {
  viewportLeft: 0,
  viewportTop: 0,
  viewportWidth: 0,
  viewportHeight: 0,
  obstacles: [],
};

/**
 * Visual-viewport bounds in fixed-layer CSS coordinates plus the rects of every
 * `[data-floating-widget-avoid]` element. Resize, pan, on-screen keyboard and DOM changes are
 * coalesced into one animation frame and only re-render when something actually moved.
 */
export function useFloatingWidgetAvoid(enabled = true): FloatingWidgetAvoidState {
  const [state, setState] = useState<FloatingWidgetAvoidState>(() =>
    typeof window === "undefined" || !enabled ? EMPTY_STATE : readState(),
  );

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = readState();
      setState((previous) => (sameState(previous, next) ? previous : next));
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };
    // Avoid targets often re-lay out a render or two after the viewport changes, so a
    // resize measures now and once more when that settles.
    let settleTimer = 0;
    const onViewportChange = () => {
      schedule();
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(schedule, 250);
    };
    schedule();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    window.visualViewport?.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("scroll", onViewportChange);
    // Avoid targets can mount, unmount or toggle their attribute at any time (game HUD, panels).
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-floating-widget-avoid", "hidden"],
    });
    // Layout can also shift without a DOM mutation (fonts, transitions); a slow poll catches it.
    const interval = window.setInterval(schedule, 1500);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
      window.visualViewport?.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("scroll", onViewportChange);
      observer.disconnect();
      window.clearInterval(interval);
    };
  }, [enabled]);

  return state;
}
