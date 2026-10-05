import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { HudWidget } from "@marinara-engine/shared";
import {
  mobileArrangementKey,
  resolveMobileArrangement,
  visibleMobileIds,
  type MobilePanelArrangement,
} from "../lib/game-mobile-panel-arrangement";

const ARRANGEMENT_EVENT = "marinara-game-panel-mobile-arrangement";
const noSubscribe = () => () => undefined;

function readRaw(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(ARRANGEMENT_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(ARRANGEMENT_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Shared by every inline widget panel so the left and right rails and the Arrange sheet stay in sync. */
export function useMobileWidgetArrangement(scopeId: string, enabled: boolean, canWrite: () => boolean) {
  const key = mobileArrangementKey(scopeId);
  const raw = useSyncExternalStore(
    enabled ? subscribe : noSubscribe,
    enabled ? () => readRaw(key) : () => null,
    () => null,
  );
  const arrangement = useMemo(() => resolveMobileArrangement(raw, enabled), [enabled, raw]);
  const update = useCallback(
    (next: MobilePanelArrangement) => {
      if (!enabled || !canWrite()) return;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage unavailable: arrangement stays for this render only */
      }
      window.dispatchEvent(new Event(ARRANGEMENT_EVENT));
    },
    [canWrite, enabled, key],
  );
  return { arrangement, update };
}

/** Orders a rail's widgets and drops the hidden ones. */
export function arrangeMobileWidgets(widgets: HudWidget[], arrangement: MobilePanelArrangement) {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  return visibleMobileIds([...byId.keys()], arrangement).map((id) => byId.get(id)!);
}
