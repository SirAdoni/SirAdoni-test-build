import { useTranslation } from "react-i18next";
import { SettingsSwitch } from "../../../components/panels/settings/SettingControls";
import { useGameHudListVisible } from "../../../hooks/use-game-hud-lists";
import { cn } from "../../../lib/utils";

/** Game settings switches for the party bar and the Currently present strip, stored per game on this device. */
export function GameHudListsSettings({ scopeId }: { scopeId: string }) {
  const { t } = useTranslation();
  const [partyBarVisible, setPartyBarVisible] = useGameHudListVisible(scopeId, "partyBar");
  const [presenceVisible, setPresenceVisible] = useGameHudListVisible(scopeId, "presence");
  const rowClass = (checked: boolean) =>
    cn(
      "justify-between rounded-md px-3 py-2.5 text-left",
      checked
        ? "bg-[var(--primary)]/10 ring-1 ring-[var(--primary)]/30"
        : "bg-[var(--secondary)] hover:bg-[var(--accent)]",
    );
  return (
    <div data-game-hud-list-settings className="mb-3 space-y-1.5">
      <SettingsSwitch
        label={t("ui.game.hudLists.partyBar")}
        description={t("ui.game.hudLists.partyBarDescription")}
        checked={partyBarVisible}
        onChange={setPartyBarVisible}
        labelPosition="start"
        className={rowClass(partyBarVisible)}
        labelClassName="text-[0.6875rem] font-medium"
      />
      <SettingsSwitch
        label={t("ui.game.hudLists.presence")}
        description={t("ui.game.hudLists.presenceDescription")}
        checked={presenceVisible}
        onChange={setPresenceVisible}
        labelPosition="start"
        className={rowClass(presenceVisible)}
        labelClassName="text-[0.6875rem] font-medium"
      />
    </div>
  );
}
