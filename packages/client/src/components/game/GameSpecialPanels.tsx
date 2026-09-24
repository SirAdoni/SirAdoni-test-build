import { lazy, Suspense } from "react";
import { FloatingGamePanel } from "./FloatingGamePanel";
import { useGameStatusProjection } from "./GameMobileStatus";

const GameStatusWidget = lazy(async () => ({ default: (await import("./GameStatusWidget")).GameStatusWidget }));
const GameContactBookWidget = lazy(async () => ({
  default: (await import("./GameContactBookWidget")).GameContactBookWidget,
}));

export function GameSpecialPanels({
  personaId,
  personaStats,
  playerStats,
  statusVisible,
  inlineStatus = true,
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
  /** False on phones, where the status lives in the widget tray as a tab. */
  inlineStatus?: boolean;
  contactsVisible: boolean;
  chatId: string;
  campaignKey: string;
  refreshKey?: string;
  onCloseContacts: () => void;
  onOpenCharacter: (characterId: string) => void;
}) {
  const projection = useGameStatusProjection(personaId, personaStats, playerStats);
  return (
    <>
      {statusVisible && inlineStatus && (projection.bars.length > 0 || projection.attributes.length > 0) && (
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
