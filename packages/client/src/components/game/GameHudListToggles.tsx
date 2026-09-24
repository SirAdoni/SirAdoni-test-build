import { Theater, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGameHudListVisible } from "../../hooks/use-game-hud-lists";

/** Toolbar and actions-menu toggles for the party bar and the "Currently present" strip. */
export function GameHudListToggles({
  scopeId,
  buttonClass,
}: {
  scopeId: string;
  buttonClass: (options: { open?: boolean }) => string;
}) {
  const { t } = useTranslation();
  const [partyBarVisible, setPartyBarVisible] = useGameHudListVisible(scopeId, "partyBar");
  const [presenceVisible, setPresenceVisible] = useGameHudListVisible(scopeId, "presence");
  const partyLabel = t(partyBarVisible ? "ui.game.hudLists.hidePartyBar" : "ui.game.hudLists.showPartyBar");
  const presenceLabel = t(presenceVisible ? "ui.game.hudLists.hidePresence" : "ui.game.hudLists.showPresence");
  return (
    <>
      <button
        type="button"
        data-game-hud-list-toggle="partyBar"
        aria-pressed={partyBarVisible}
        onClick={() => setPartyBarVisible(!partyBarVisible)}
        className={buttonClass({ open: partyBarVisible })}
        title={partyLabel}
        aria-label={partyLabel}
      >
        <UsersRound size={14} />
      </button>
      <button
        type="button"
        data-game-hud-list-toggle="presence"
        aria-pressed={presenceVisible}
        onClick={() => setPresenceVisible(!presenceVisible)}
        className={buttonClass({ open: presenceVisible })}
        title={presenceLabel}
        aria-label={presenceLabel}
      >
        <Theater size={14} />
      </button>
    </>
  );
}
