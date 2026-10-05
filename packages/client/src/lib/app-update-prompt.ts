import { toast } from "sonner";
import { translate } from "../localization/i18n";
import { reloadBrowser } from "./browser-runtime";

const APP_UPDATE_TOAST_ID = "marinara-app-update";
const UPDATE_OPERATION_TIMEOUT_MS = 8_000;
const SERVICE_WORKER_ACTIVATION_DELAY_MS = 1_500;
let latestRefresh: (() => void | Promise<void>) | null = null;
let refreshInFlight: Promise<void> | null = null;

const wait = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export interface AppUpdateRefreshOptions {
  fallback?: () => void;
  operationTimeoutMs?: number;
  activationDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function runAppUpdateRefresh(
  refresh: () => void | Promise<void>,
  options: AppUpdateRefreshOptions = {},
): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  const fallback = options.fallback ?? (() => reloadBrowser("update-fallback"));
  const operationTimeoutMs = options.operationTimeoutMs ?? UPDATE_OPERATION_TIMEOUT_MS;
  const activationDelayMs = options.activationDelayMs ?? SERVICE_WORKER_ACTIVATION_DELAY_MS;
  const waitForActivation = options.wait ?? wait;
  refreshInFlight = (async () => {
    let timeout: number | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(refresh),
        new Promise<void>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error("update-timeout")), operationTimeoutMs);
        }),
      ]);
    } catch {
      // A rejected or timed-out update still gets the bounded full-page fallback.
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
    // Promise.race bounds our wait, not the callback; late callback settlement may still navigate.
    // Give a successfully-installed service worker a brief activation window before forcing navigation.
    try {
      await waitForActivation(activationDelayMs);
    } catch {
      // A failed activation delay must not suppress the full-page fallback.
    }
    try {
      fallback();
    } catch {
      // Leave the update toast available for an explicit retry; never recurse into another reload.
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export function showAppUpdatePrompt(refresh: () => void | Promise<void>) {
  latestRefresh = refresh;
  toast.info(translate("ui.app.update.available"), {
    id: APP_UPDATE_TOAST_ID,
    description: translate("ui.app.update.description"),
    duration: Infinity,
    action: {
      label: translate("ui.app.update.refresh"),
      onClick: (event) => {
        event.preventDefault();
        const refresh = latestRefresh;
        if (!refresh) return;
        void runAppUpdateRefresh(refresh).catch(() => {
          // Keep the visible action retryable; do not start another reload from a failed fallback.
        });
      },
    },
  });
}
