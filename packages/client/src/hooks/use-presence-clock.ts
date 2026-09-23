import { useEffect, useState } from "react";

/**
 * Returns a `Date` that refreshes on a fixed cadence so components which derive
 * conversation presence from schedules or expiring overrides re-render when time
 * alone changes the effective status — without needing navigation, a new message,
 * or an unrelated render. Mirrors the presence pill's 60s server refetch.
 *
 * Pass the returned value straight into the presence computation (and any memo
 * dependency array) — its identity changes each tick. One interval per consumer
 * (place it at a list root, not per row). The timer is paused while the tab is
 * hidden and refreshes immediately when the tab becomes visible again, matching
 * the pill query's `document.hidden` gating.
 */
export function usePresenceClock(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Guard non-DOM environments (tests / any non-browser runtime); the client
    // normally runs in a browser or Tauri webview where `document` exists.
    if (typeof document === "undefined") return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer == null) timer = setInterval(() => setNow(new Date()), intervalMs);
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const handleVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        setNow(new Date()); // catch up immediately on re-show
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [intervalMs]);

  return now;
}
