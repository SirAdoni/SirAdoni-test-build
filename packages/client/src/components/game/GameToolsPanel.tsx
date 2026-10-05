import { NotebookPen, Shuffle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GameDiceLog } from "./GameDiceLog";
import { openPrepBoard } from "../../lib/open-prep-board";
import { openRandomTables } from "../../lib/open-random-tables";
import { useFeatureEnabled } from "../../hooks/use-feature-settings";

export function GameToolsPanel({ chatId }: { chatId: string }) {
  const { t } = useTranslation();
  const prepEnabled = useFeatureEnabled("gamePrepBoard");
  const tablesEnabled = useFeatureEnabled("randomTables");
  const diceEnabled = useFeatureEnabled("diceLog");
  const actions = [
    { enabled: prepEnabled, label: t("ui.prepBoard.title"), icon: NotebookPen, open: () => openPrepBoard(chatId) },
    { enabled: tablesEnabled, label: t("ui.randomTables.title"), icon: Shuffle, open: () => openRandomTables(chatId) },
  ].filter((action) => action.enabled);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-2">
      <div className="grid grid-cols-2 gap-2">
        {actions.map(({ label, icon: Icon, open }) => (
          <button
            key={label}
            type="button"
            onClick={open}
            className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm text-foreground hover:bg-secondary"
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      {diceEnabled && (
        <section className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg border border-border p-2">
          <GameDiceLog chatId={chatId} />
        </section>
      )}
    </div>
  );
}
