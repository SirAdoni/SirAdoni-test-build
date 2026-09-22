// ──────────────────────────────────────────────
// Game: Tools tab of the Session panel
// Dice log, the name generator and the campaign codex export, in one place.
// ──────────────────────────────────────────────
import { useState, type ReactNode } from "react";
import { BookDown, FileJson, FileText, Loader2, Maximize2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { GameDiceLog } from "./GameDiceLog";
import { NameGenerator } from "../tools/NameGenerator";
import { downloadCampaignCodex } from "../../hooks/use-game-tools";
import { openNameGenerator } from "../../lib/open-name-generator";

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
