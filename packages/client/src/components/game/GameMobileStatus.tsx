// Game mode on phones: the status stats collapse to one tab in the widget tray instead of an inline panel.
import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Activity } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { usePersona } from "../../hooks/use-characters";
import { Modal } from "../ui/Modal";
import type { GameStatusProjection } from "./game-status-widget";

const GameStatusWidget = lazy(async () => ({ default: (await import("./GameStatusWidget")).GameStatusWidget }));

const EMPTY_PROJECTION: GameStatusProjection = { bars: [], attributes: [] };

export function hasGameStatus(projection: GameStatusProjection) {
  return projection.bars.length > 0 || projection.attributes.length > 0;
}

/** Projects the persona and RPG stats into the bars and attributes the status widget shows. */
export function useGameStatusProjection(personaId?: string, personaStats?: unknown, playerStats?: unknown) {
  const selectedPersonaQuery = usePersona(personaId ?? null);
  const [projection, setProjection] = useState<GameStatusProjection>(EMPTY_PROJECTION);
  useEffect(() => {
    let current = true;
    void import("./game-status-widget").then(({ projectGameStatusStats }) => {
      if (current)
        setProjection(
          projectGameStatusStats({
            personaStats,
            rpgStats: playerStats,
            config: selectedPersonaQuery.data?.personaStats,
          }),
        );
    });
    return () => {
      current = false;
    };
  }, [personaStats, playerStats, selectedPersonaQuery.data?.personaStats]);
  return projection;
}

/** Live media query match, false during server rendering. */
export function useMediaMatch(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** A tray tab that opens the stats in a sheet, so they never take the narration's height on a phone. */
export function MobileGameStatusTab({ projection }: { projection: GameStatusProjection }) {
  const { t: localizeUi } = useUiTranslation();
  const [open, setOpen] = useState(false);
  if (!hasGameStatus(projection)) return null;
  const label = localizeUi("ui.game.statusWidget.title");
  return (
    <>
      <button
        type="button"
        data-mobile-status-tab
        onClick={() => setOpen(true)}
        className="marinara-chat-toolbar-button flex h-11 w-11 shrink-0 snap-start items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-button-bg)] text-[var(--marinara-chat-chrome-button-text)] backdrop-blur-md transition-all hover:border-[var(--marinara-chat-chrome-button-border-hover)] hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] hover:text-[var(--marinara-chat-chrome-button-text-hover)] active:scale-95"
        aria-haspopup="dialog"
        aria-label={label}
        title={label}
      >
        <Activity size={16} aria-hidden="true" />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={label} width="max-w-sm">
        <div className="max-h-[min(70dvh,32rem)] overflow-y-auto">
          <Suspense fallback={null}>
            <GameStatusWidget projection={projection} />
          </Suspense>
        </div>
      </Modal>
    </>
  );
}
