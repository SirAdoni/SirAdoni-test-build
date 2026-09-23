// ──────────────────────────────────────────────
// Keep-Alive: Prevent Chrome/Edge tab sleeping
// ──────────────────────────────────────────────
// Chrome and Edge aggressively throttle/freeze background tabs
// ("Sleeping Tabs" / Tab Discarding). This kills timers, stales
// React Query data, and makes the app feel laggy when returning.
//
// Mechanisms:
// 1. Web Locks API — holding a lock signals the browser that the
//    tab has important work; Chrome won't discard it.
// 2. Periodic BroadcastChannel ping — lightweight activity that
//    prevents the "idle" heuristic from triggering.
// 3. On Android localhost only, a visible-page health request keeps the
//    Termux-hosted server responsive on devices that freeze an otherwise idle
//    background host. Hidden pages and remote clients remain quiet.
// ──────────────────────────────────────────────

import { api } from "./api-client";

export const ANDROID_HOST_HEARTBEAT_INTERVAL_MS = 10_000;
const IPV4_LOOPBACK_HOSTNAME_RE = /^127(?:\.(?:0|[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5])){3}$/u;

let started = false;

export function shouldRunAndroidHostHeartbeat(input: {
  isAndroid: boolean;
  isHostDevice: boolean;
  pageVisible: boolean;
  requestPending: boolean;
}): boolean {
  return input.isAndroid && input.isHostDevice && input.pageVisible && !input.requestPending;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    IPV4_LOOPBACK_HOSTNAME_RE.test(normalized) ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function createAndroidHostHeartbeat(input: {
  isAndroid: boolean;
  isHostDevice: boolean;
  isPageVisible: () => boolean;
  request: () => Promise<unknown>;
}): () => void {
  let requestPending = false;
  return () => {
    if (
      !shouldRunAndroidHostHeartbeat({
        isAndroid: input.isAndroid,
        isHostDevice: input.isHostDevice,
        pageVisible: input.isPageVisible(),
        requestPending,
      })
    ) {
      return;
    }
    requestPending = true;
    void input
      .request()
      .catch(() => {})
      .finally(() => {
        requestPending = false;
      });
  };
}

export function startKeepAlive() {
  if (started) return;
  started = true;
  const isAndroid = /Android/u.test(navigator.userAgent);
  const isHostDevice = isLoopbackHostname(window.location.hostname);
  if (isAndroid && isHostDevice) {
    const heartbeat = createAndroidHostHeartbeat({
      isAndroid,
      isHostDevice,
      isPageVisible: () => document.visibilityState === "visible",
      request: () => api.get("/health", { signal: AbortSignal.timeout(5_000) }),
    });
    heartbeat();
    setInterval(heartbeat, ANDROID_HOST_HEARTBEAT_INTERVAL_MS);
    document.addEventListener("visibilitychange", heartbeat);
    return;
  }

  // Mobile browsers need to suspend idle pages to protect battery and thermal
  // headroom. Only the loopback Android host path above gets a heartbeat.
  if (window.matchMedia("(hover: none) and (pointer: coarse)").matches) {
    return;
  }
  // ── Web Lock (primary defense) ──
  // navigator.locks.request() holds a lock for as long as the returned
  // promise is pending. We never resolve it → lock held forever → tab
  // won't be discarded while the page is open.
  if (navigator.locks) {
    navigator.locks.request("marinara-engine-keep-alive", () => new Promise(() => {}));
  }

  // ── Periodic activity (fallback for older Edge) ──
  // A tiny BroadcastChannel message every 20s counts as "tab activity"
  // and resets the idle timer that triggers tab sleeping.
  try {
    const channel = new BroadcastChannel("marinara-heartbeat");
    setInterval(() => {
      channel.postMessage(0);
    }, 20_000);
  } catch {
    // BroadcastChannel not available — that's fine
  }
}
