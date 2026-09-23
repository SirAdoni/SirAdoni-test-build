import { lazy, Suspense, useEffect, useState } from "react";
import { FloatingGamePanel } from "./FloatingGamePanel";
import { usePersona } from "../../hooks/use-characters";
import type { GameStatusProjection } from "./game-status-widget";

const GameStatusWidget = lazy(async () => ({ default: (await import("./GameStatusWidget")).GameStatusWidget }));
const GameContactBookWidget = lazy(async () => ({
  default: (await import("./GameContactBookWidget")).GameContactBookWidget,
}));

export function GameSpecialPanels({
  personaId,
  personaStats,
  playerStats,
  statusVisible,
  contactsVisible,
  chatId,
  campaignKey,
  refreshKey,
  onCloseContacts,
  onOpenCharacter,
}: {
  personaId?: string;
  personaStats?: unknown;
  playerStats?: unknown;
  statusVisible: boolean;
  contactsVisible: boolean;
  chatId: string;
  campaignKey: string;
  refreshKey?: string;
  onCloseContacts: () => void;
  onOpenCharacter: (characterId: string) => void;
}) {
  const selectedPersonaQuery = usePersona(personaId ?? null);
  const [projection, setProjection] = useState<GameStatusProjection>({ bars: [], attributes: [] });
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
  return (
    <>
      {statusVisible && (projection.bars.length > 0 || projection.attributes.length > 0) && (
        <FloatingGamePanel
          id="game-status"
          width={248}
          side="hud_left"
          slot={1}
          autoGrow
          autoWidth
          allowTuck
          revealOnValueChangeKey={JSON.stringify(projection)}
        >
          <div className="rounded-xl border border-white/10 bg-black/80 text-white/90 shadow-xl backdrop-blur-md">
            <Suspense fallback={null}>
              <GameStatusWidget projection={projection} />
            </Suspense>
          </div>
        </FloatingGamePanel>
      )}
      {contactsVisible && (
        <Suspense fallback={null}>
          <GameContactBookWidget
            chatId={chatId}
            campaignKey={campaignKey}
            refreshKey={refreshKey}
            open
            onClose={onCloseContacts}
            onOpenCharacter={onOpenCharacter}
          />
        </Suspense>
      )}
    </>
  );
}
