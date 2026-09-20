import { useState } from "react";
import { Loader2, RotateCw, X } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { ApiError } from "../../lib/api-client";
import { useCampaignMemorySource } from "../../hooks/use-campaign-memory";

export interface CampaignWikiEvidenceItem {
  messageId: string;
  quote: string;
  sourceHash?: string;
}

export function CampaignWikiEvidence({
  chatId,
  evidence,
}: {
  chatId: string;
  evidence: readonly CampaignWikiEvidenceItem[];
}) {
  const { t } = useUiTranslation();
  if (evidence.length === 0) return null;
  return (
    <details className="mt-2 rounded-md border border-[var(--border)] px-2 py-1.5">
      <summary className="cursor-pointer text-[0.625rem] text-[var(--muted-foreground)]">
        {t("ui.game.campaignWiki.evidence")}
      </summary>
      <div className="mt-2 space-y-3 text-[0.625rem] text-[var(--muted-foreground)]">
        {evidence.map((item, index) => (
          <EvidenceItem key={`${item.messageId}-${index}`} chatId={chatId} item={item} />
        ))}
      </div>
    </details>
  );
}

function EvidenceItem({ chatId, item }: { chatId: string; item: CampaignWikiEvidenceItem }) {
  const { t } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const source = useCampaignMemorySource(chatId, item.messageId, item.sourceHash, { enabled: open });
  const errorStatus = source.error instanceof ApiError ? source.error.status : undefined;
  return (
    <blockquote className="border-l border-[var(--border)] pl-2">
      <p className="whitespace-pre-wrap break-words">{item.quote}</p>
      <span className="opacity-60">({item.messageId})</span>
      {item.sourceHash ? (
        <div className="mt-1">
          {!open ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="inline-flex min-h-8 items-center gap-1 rounded border border-[var(--border)] px-2 text-[0.625rem] hover:bg-[var(--secondary)]"
            >
              {t("ui.game.campaignWiki.readSource")}
            </button>
          ) : (
            <div className="rounded border border-[var(--border)] bg-[var(--background)] p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[0.625rem] font-medium">{t("ui.game.campaignWiki.sourceText")}</span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label={t("ui.game.campaignWiki.closeSource")}
                  className="inline-flex min-h-7 min-w-7 items-center justify-center rounded hover:bg-[var(--secondary)]"
                >
                  <X size={12} />
                </button>
              </div>
              {source.isLoading && (
                <p className="mt-2 inline-flex items-center gap-1">
                  <Loader2 size={12} className="animate-spin" />
                  {t("ui.game.campaignWiki.sourceLoading")}
                </p>
              )}
              {source.isError && (
                <div className="mt-2 space-y-1 text-[var(--destructive)]">
                  <p>
                    {errorStatus === 409
                      ? t("ui.game.campaignWiki.sourceStale")
                      : errorStatus === 404
                        ? t("ui.game.campaignWiki.sourceUnavailable")
                        : t("ui.game.campaignWiki.sourceError")}
                  </p>
                  <button
                    type="button"
                    onClick={() => void source.refetch()}
                    className="inline-flex min-h-7 items-center gap-1 rounded border border-[var(--border)] px-2 text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"
                  >
                    <RotateCw size={11} />
                    {t("ui.game.campaignWiki.retry")}
                  </button>
                </div>
              )}
              {source.data && (
                <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[var(--foreground)]">
                  {source.data.content}
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-1 text-[0.625rem] italic">{t("ui.game.campaignWiki.sourceLegacy")}</p>
      )}
    </blockquote>
  );
}
