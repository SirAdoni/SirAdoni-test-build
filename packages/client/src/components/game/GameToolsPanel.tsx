// ──────────────────────────────────────────────
// Game: Tools tab of the Session panel
// Dice log, the GM prep board, initiative tracker, random tables and oracle, the name generator, the campaign log and the campaign codex export, in one place.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
import { useState, type ReactNode } from "react";
import {
  BookDown,
  BookOpenText,
  ClipboardList,
  Dices,
  FileJson,
  FileText,
  Loader2,
  Maximize2,
  Sparkles,
  Swords,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { GameDiceLog } from "./GameDiceLog";
import { GamePrepBoard } from "./GamePrepBoard";
import { NameGenerator } from "../tools/NameGenerator";
import { RandomTablesTool } from "../tools/RandomTablesTool";
import { InitiativeTracker } from "../tools/InitiativeTracker";
import { downloadCampaignCodex } from "../../hooks/use-game-tools";
import { openNameGenerator } from "../../lib/open-name-generator";
import { openGameLog } from "../../lib/open-game-log";
import { openRandomTables } from "../../lib/open-random-tables";
import { openPrepBoard } from "../../lib/open-prep-board";
import { openInitiativeTracker } from "../../lib/open-initiative-tracker";

function SectionTitle({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        {icon}
        {title}
      </h3>
      {action}
    </div>
  );
}

export function GameToolsPanel({ chatId }: { chatId: string }) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState<"md" | "json" | null>(null);

  const download = async (format: "md" | "json") => {
    setDownloading(format);
    try {
      await downloadCampaignCodex(chatId, format);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("ui.game.tools.codexFailed"));
    } finally {
      setDownloading(null);
    }
  };

  const codexButton = (format: "md" | "json") => (
    <button
      type="button"
      disabled={downloading !== null}
      onClick={() => void download(format)}
      className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-60"
    >
      {downloading === format ? (
        <Loader2 size={13} className="animate-spin" />
      ) : format === "md" ? (
        <FileText size={13} />
      ) : (
        <FileJson size={13} />
      )}
      {t(format === "md" ? "ui.game.tools.codexMarkdown" : "ui.game.tools.codexJson")}
    </button>
  );

  return (
    <div className="space-y-5">
      <GameDiceLog chatId={chatId} />

      <section className="border-t border-border pt-4" aria-label={t("ui.prepBoard.title")}>
        <SectionTitle
          icon={<ClipboardList size={14} className="text-muted-foreground" />}
          title={t("ui.prepBoard.title")}
          action={
            <button
              type="button"
              onClick={() => openPrepBoard(chatId)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              title={t("ui.prepBoard.openWindow")}
              aria-label={t("ui.prepBoard.openWindow")}
            >
              <Maximize2 size={13} />
            </button>
          }
        />
        <GamePrepBoard chatId={chatId} />
      </section>

      <section className="border-t border-border pt-4" aria-label={t("ui.initiative.title")}>
        <SectionTitle
          icon={<Swords size={14} className="text-muted-foreground" />}
          title={t("ui.initiative.title")}
          action={
            <button
              type="button"
              onClick={() => openInitiativeTracker(chatId)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              title={t("ui.initiative.openWindow")}
              aria-label={t("ui.initiative.openWindow")}
            >
              <Maximize2 size={13} />
            </button>
          }
        />
        <InitiativeTracker chatId={chatId} />
      </section>

      <section className="border-t border-border pt-4" aria-label={t("ui.randomTables.title")}>
        <SectionTitle
          icon={<Dices size={14} className="text-muted-foreground" />}
          title={t("ui.randomTables.title")}
          action={
            <button
              type="button"
              onClick={() => openRandomTables(chatId)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              title={t("ui.randomTables.openWindow")}
              aria-label={t("ui.randomTables.openWindow")}
            >
              <Maximize2 size={13} />
            </button>
          }
        />
        <RandomTablesTool chatId={chatId} />
      </section>

      <section className="border-t border-border pt-4" aria-label={t("ui.nameGenerator.title")}>
        <SectionTitle
          icon={<Sparkles size={14} className="text-muted-foreground" />}
          title={t("ui.nameGenerator.title")}
          action={
            <button
              type="button"
              onClick={openNameGenerator}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              title={t("ui.nameGenerator.openWindow")}
              aria-label={t("ui.nameGenerator.openWindow")}
            >
              <Maximize2 size={13} />
            </button>
          }
        />
        <NameGenerator />
      </section>

      <section className="border-t border-border pt-4" aria-label={t("ui.game.tools.logTitle")}>
        <SectionTitle
          icon={<BookOpenText size={14} className="text-muted-foreground" />}
          title={t("ui.game.tools.logTitle")}
        />
        <p className="mb-2 text-xs text-muted-foreground">{t("ui.game.tools.logDescription")}</p>
        <button
          type="button"
          onClick={() => openGameLog({ chatId })}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
        >
          <BookOpenText size={13} />
          {t("ui.game.tools.logOpen")}
        </button>
      </section>

      <section className="border-t border-border pt-4" aria-label={t("ui.game.tools.codexTitle")}>
        <SectionTitle
          icon={<BookDown size={14} className="text-muted-foreground" />}
          title={t("ui.game.tools.codexTitle")}
        />
        <p className="mb-2 text-xs text-muted-foreground">{t("ui.game.tools.codexDescription")}</p>
        <div className="flex gap-1.5">
          {codexButton("md")}
          {codexButton("json")}
        </div>
      </section>
    </div>
  );
}
