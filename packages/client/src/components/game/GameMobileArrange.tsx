// Game mode: per-device arrangement of the inline widget row on phones and small tablets.
import { useCallback, useContext, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff, ListOrdered } from "lucide-react";
import type { HudWidget } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import {
  mobileArrangementKey,
  moveMobileItem,
  orderMobileIds,
  parseMobileArrangement,
  setMobileItemHidden,
  visibleMobileIds,
  type MobilePanelArrangement,
} from "../../lib/game-mobile-panel-arrangement";
import { cn } from "../../lib/utils";
import { Modal } from "../ui/Modal";
import { GamePanelContext } from "./FloatingGamePanel";
import { widgetIcon } from "./GameWidgetSetupEditor";

const ARRANGEMENT_EVENT = "marinara-game-panel-mobile-arrangement";

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
export function useMobileWidgetArrangement(chatId: string) {
  const scopeId = useContext(GamePanelContext)?.chatId || chatId;
  const key = mobileArrangementKey(scopeId);
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null,
  );
  const arrangement = useMemo(() => parseMobileArrangement(raw), [raw]);
  const update = useCallback(
    (next: MobilePanelArrangement) => {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage unavailable: arrangement stays for this render only */
      }
      window.dispatchEvent(new Event(ARRANGEMENT_EVENT));
    },
    [key],
  );
  return { arrangement, update };
}

/** Orders a rail's widgets and drops the hidden ones. */
export function arrangeMobileWidgets(widgets: HudWidget[], arrangement: MobilePanelArrangement) {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  return visibleMobileIds([...byId.keys()], arrangement).map((id) => byId.get(id)!);
}

const SHEET_BUTTON =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--marinara-chat-chrome-button-text)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] disabled:opacity-30";

export function MobileWidgetArrangeButton({ widgets, chatId }: { widgets: HudWidget[]; chatId: string }) {
  const { t: localizeUi } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const { arrangement, update } = useMobileWidgetArrangement(chatId);
  const label = localizeUi("ui.game.mobilewidgetarrange.arrangeWidgets");
  const hidden = new Set(arrangement.hidden);
  const sections = (["hud_left", "hud_right"] as const)
    .map((position) => {
      const rail = widgets.filter((widget) => widget.position === position);
      const byId = new Map(rail.map((widget) => [widget.id, widget]));
      const ids = [...byId.keys()];
      return { position, ids, items: orderMobileIds(ids, arrangement).map((id) => byId.get(id)!) };
    })
    .filter((section) => section.items.length > 0);

  return (
    <>
      <button
        type="button"
        data-mobile-arrange-button
        onClick={() => setOpen(true)}
        className="marinara-chat-toolbar-button flex h-11 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--marinara-chat-chrome-button-text)] opacity-70 transition-opacity hover:opacity-100"
        aria-haspopup="dialog"
        aria-label={label}
        title={label}
      >
        <ListOrdered size={16} />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={label} width="max-w-sm">
        <div className="space-y-3" data-mobile-arrange-sheet>
          {sections.map((section) => (
            <section key={section.position}>
              <h3 className="mb-1 text-[0.6875rem] font-semibold text-[var(--marinara-chat-chrome-panel-title)]">
                {localizeUi(
                  section.position === "hud_left"
                    ? "ui.game.mobilewidgetarrange.firstGroup"
                    : "ui.game.mobilewidgetarrange.secondGroup",
                )}
              </h3>
              <ul className="space-y-1">
                {section.items.map((widget, index) => {
                  const isHidden = hidden.has(widget.id);
                  return (
                    <li
                      key={widget.id}
                      data-mobile-arrange-item={widget.id}
                      className="flex items-center gap-1 rounded-lg border border-[var(--marinara-chat-chrome-panel-divider)] pl-2"
                    >
                      <span className="w-6 shrink-0 text-center text-sm">{widgetIcon(widget)}</span>
                      <span className={cn("min-w-0 flex-1 truncate text-xs", isHidden && "opacity-50 line-through")}>
                        {widget.label}
                      </span>
                      <button
                        type="button"
                        className={SHEET_BUTTON}
                        disabled={index === 0}
                        onClick={() => update(moveMobileItem(section.ids, arrangement, widget.id, -1))}
                        aria-label={localizeUi("ui.game.mobilewidgetarrange.moveUpValue1", { value1: widget.label })}
                      >
                        <ChevronUp size={16} />
                      </button>
                      <button
                        type="button"
                        className={SHEET_BUTTON}
                        disabled={index === section.items.length - 1}
                        onClick={() => update(moveMobileItem(section.ids, arrangement, widget.id, 1))}
                        aria-label={localizeUi("ui.game.mobilewidgetarrange.moveDownValue1", { value1: widget.label })}
                      >
                        <ChevronDown size={16} />
                      </button>
                      <button
                        type="button"
                        className={SHEET_BUTTON}
                        aria-pressed={!isHidden}
                        onClick={() => update(setMobileItemHidden(arrangement, widget.id, !isHidden))}
                        aria-label={localizeUi(
                          isHidden ? "ui.game.mobilewidgetarrange.showValue1" : "ui.game.mobilewidgetarrange.hideValue1",
                          { value1: widget.label },
                        )}
                      >
                        {isHidden ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </Modal>
    </>
  );
}
