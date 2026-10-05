// Game mode: per-device arrangement of the inline widget row on phones and small tablets.
import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Eye, EyeOff, ListOrdered } from "lucide-react";
import { isExtendedHudWidgetType, type HudWidget } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useExtendedWidgetsEnabled } from "../../hooks/use-extended-widgets";
import {
  moveMobileItem,
  orderMobileIds,
  setMobileItemExpanded,
  setMobileItemHidden,
} from "../../lib/game-mobile-panel-arrangement";
import { useMobileWidgetArrangement } from "../../hooks/use-mobile-widget-arrangement";
import { cn } from "../../lib/utils";
import { Modal } from "../ui/Modal";
import { widgetIcon } from "./GameWidgetSetupEditor";

type TrayFit = { width: number | null; before: number; after: number };

const FADE = "0.625rem";

/**
 * The inline widget row on phones. Tabs scroll sideways without a scrollbar, the visible window is
 * trimmed to whole tabs so none is cut mid-button, the edges fade where more tabs wait, and one small
 * chevron pages through them. `trailing` (the Arrange button) sits outside the scroller, always reachable.
 */
export function MobileWidgetTray({
  children,
  trailing,
  className,
  ...rest
}: { children: ReactNode; trailing?: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  const { t: localizeUi } = useUiTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<TrayFit>({ width: null, before: 0, after: 0 });

  useLayoutEffect(() => {
    const host = hostRef.current;
    const scroller = scrollerRef.current;
    if (!host || !scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const tabs = [...scroller.querySelectorAll<HTMLElement>("button")];
      const gap = Number.parseFloat(getComputedStyle(scroller).columnGap) || 0;
      const tab = tabs[0]?.offsetWidth ?? 0;
      const step = tab + gap;
      const full = tabs.length * step - gap;
      const trailing = trailingRef.current?.offsetWidth ?? 0;
      const available = host.clientWidth - (trailing > 0 ? trailing + gap : 0);
      let width: number | null = null;
      if (step > 0 && full > available + 0.5) {
        // Reserve the chevron, then show as many whole tabs as fit.
        const pagerWidth = 2.25 * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
        const room = available - pagerWidth - gap;
        const count = Math.max(1, Math.floor((room + gap) / step));
        width = count * step - gap;
      }
      const shown = width ?? full;
      const before = step > 0 ? Math.round(scroller.scrollLeft / step) : 0;
      const after = step > 0 ? Math.max(0, Math.round((full - shown - scroller.scrollLeft) / step)) : 0;
      setFit((previous) =>
        previous.width === width && previous.before === before && previous.after === after
          ? previous
          : { width, before, after },
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(host);
    if (trailingRef.current) resize.observe(trailingRef.current);
    const mutations = new MutationObserver(schedule);
    mutations.observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      scroller.removeEventListener("scroll", schedule);
    };
  }, []);

  const overflowing = fit.width !== null;
  const atEnd = fit.after === 0;
  const mask =
    fit.before > 0 || fit.after > 0
      ? `linear-gradient(to right, ${fit.before > 0 ? "transparent" : "#000"}, #000 ${FADE}, #000 calc(100% - ${FADE}), ${fit.after > 0 ? "transparent" : "#000"})`
      : undefined;
  const pageLabel = localizeUi(
    atEnd ? "ui.game.mobilewidgetarrange.showFirstWidgets" : "ui.game.mobilewidgetarrange.showMoreWidgets",
  );

  return (
    <div {...rest} ref={hostRef} className={cn("pointer-events-auto flex min-w-0 items-center gap-1.5", className)}>
      <div
        ref={scrollerRef}
        data-mobile-tray-scroller
        className="scrollbar-hide flex min-w-0 touch-pan-x snap-x snap-mandatory items-center gap-1.5 overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]"
        style={{
          width: fit.width ?? undefined,
          flex: "none",
          maxWidth: "100%",
          maskImage: mask,
          WebkitMaskImage: mask,
        }}
      >
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          data-mobile-tray-scroll
          onClick={() => {
            const scroller = scrollerRef.current;
            if (!scroller) return;
            // One page is the visible tabs plus the gap before the next one, so a page lands on a tab edge.
            const gap = Number.parseFloat(getComputedStyle(scroller).columnGap) || 0;
            scroller.scrollTo({
              left: atEnd ? 0 : scroller.scrollLeft + scroller.clientWidth + gap,
              behavior: "smooth",
            });
          }}
          className="marinara-chat-toolbar-button relative flex h-11 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-button-bg)] text-[var(--marinara-chat-chrome-button-text)] backdrop-blur-md transition-colors hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] hover:text-[var(--marinara-chat-chrome-button-text-hover)]"
          aria-label={pageLabel}
          title={pageLabel}
        >
          {atEnd ? <ChevronLeft size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          {!atEnd && (
            <span className="absolute bottom-0.5 text-[0.5625rem] font-semibold leading-none tabular-nums">
              +{fit.after}
            </span>
          )}
        </button>
      )}
      {trailing && (
        <div ref={trailingRef} className="flex shrink-0">
          {trailing}
        </div>
      )}
    </div>
  );
}

const SHEET_BUTTON =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--marinara-chat-chrome-button-text)] transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] disabled:opacity-30";

export function MobileWidgetArrangeButton({
  widgets,
  chatId,
  scopeId,
  enabled,
  canWrite,
}: {
  widgets: HudWidget[];
  chatId: string;
  scopeId: string;
  enabled: boolean;
  canWrite: () => boolean;
}) {
  const { t: localizeUi } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const allowExtended = useExtendedWidgetsEnabled(chatId);
  const { arrangement, update } = useMobileWidgetArrangement(scopeId, enabled, canWrite);
  widgets = widgets.filter((widget) => allowExtended || !isExtendedHudWidgetType(widget.type));
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
                      <span
                        className={cn("min-w-0 flex-1 break-words py-1 text-xs", isHidden && "opacity-50 line-through")}
                      >
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
                        aria-pressed={arrangement.expanded.includes(widget.id)}
                        onClick={() =>
                          update(
                            setMobileItemExpanded(arrangement, widget.id, !arrangement.expanded.includes(widget.id)),
                          )
                        }
                        aria-label={localizeUi(
                          arrangement.expanded.includes(widget.id)
                            ? "ui.game.mobilewidgetarrange.collapseValue1"
                            : "ui.game.mobilewidgetarrange.expandValue1",
                          { value1: widget.label },
                        )}
                      >
                        {arrangement.expanded.includes(widget.id) ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </button>
                      <button
                        type="button"
                        className={SHEET_BUTTON}
                        aria-pressed={!isHidden}
                        onClick={() => update(setMobileItemHidden(arrangement, widget.id, !isHidden))}
                        aria-label={localizeUi(
                          isHidden
                            ? "ui.game.mobilewidgetarrange.showValue1"
                            : "ui.game.mobilewidgetarrange.hideValue1",
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
