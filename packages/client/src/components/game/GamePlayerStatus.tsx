import { useGameStateStore } from "../../stores/game-state.store";
import { GameStatusWidget } from "./GameStatusWidget";
import { MobileGameStatusTab, useGameStatusProjection } from "./GameMobileStatus";

/** Mounted only while playerStatus is enabled; hidden status never fetches persona configuration. */
export function GamePlayerStatus({
  chatId,
  personaId,
  mobile = false,
}: {
  chatId: string;
  personaId?: string;
  mobile?: boolean;
}) {
  const state = useGameStateStore((s) => (s.current?.chatId === chatId ? s.current : null));
  const projection = useGameStatusProjection(personaId, state?.personaStats, state?.playerStats);
  return mobile ? <MobileGameStatusTab projection={projection} /> : <GameStatusWidget projection={projection} />;
}
