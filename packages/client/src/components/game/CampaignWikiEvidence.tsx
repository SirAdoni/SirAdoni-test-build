import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, MessageSquareQuote, Quote, RotateCw, X } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { ApiError } from "../../lib/api-client";
import { useCampaignMemorySource } from "../../hooks/use-campaign-memory";
import { cn } from "../../lib/utils";
import { WikiChip, formatCaptureOrder } from "./campaign-wiki-ui";

export interface CampaignWikiEvidenceItem {
  messageId: string;
  quote: string;
  sourceHash?: string;
}

/**
 * The "From the story" disclosure under a record: the quoted line(s) from the transcript, and on request the full
 * source message with the quoted passage highlighted. Evidence may come from an earlier session, so the source lookup
 * uses `sourceChatId` (the record's origin chat) and falls back to the page chat.
 */
export function CampaignWikiEvidence({
  chatId,
  evidence,
  sourceChatId,
  sessionNumber,
  capturedAt,
  defaultOpen = false,
  className,
}: {
  chatId: string;
  evidence: readonly CampaignWikiEvidenceItem[];
  /** Chat that owns the source messages (a projected record's originChatId). Falls back to `chatId`. */
  sourceChatId?: string | null;
  /** Session the record came from, shown as a small chip when known. */
  sessionNumber?: number | null;
  /** `m1|<iso>|<id>` order of the record; shown as a readable date when known. */
  capturedAt?: string | null;
  defaultOpen?: boolean;
  className?: string;
}) {
  const { t, i18n } = useUiTranslation();
  if (evidence.length === 0) return null;
  const lookupChatId = sourceChatId || chatId;
  const date = formatCaptureOrder(capturedAt, i18n.language);
  return (
    <details
      open={defaultOpen || undefined}
      data-component="campaign-wiki-evidence"
      className={cn("group/evidence mt-2", className)}
    >
      <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 [&::-webkit-details-marker]:hidden">
        <MessageSquareQuote size={14} aria-hidden="true" />
        <span>
          {evidence.length > 1
            ? t("ui.game.campaignWiki.evidence.fromStoryCount", {
                count: evidence.length,
                defaultValue: "From the story ({{count}} quotes)",
              })
            : t("ui.game.campaignWiki.evidence.fromStory", { defaultValue: "From the story" })}
        </span>
        <ChevronDown size={13} aria-hidden="true" className="transition-transform group-open/evidence:rotate-180" />
      </summary>
      <div className="mt-1.5 space-y-2">
        {(typeof sessionNumber === "number" || date) && (
          <div className="flex flex-wrap gap-1.5">
            {typeof sessionNumber === "number" && (
              <WikiChip tone="info">
                {t("ui.game.campaignWiki.evidence.session", {
                  number: sessionNumber,
                  defaultValue: "Session {{number}}",
                })}
              </WikiChip>
            )}
            {date && <WikiChip>{date}</WikiChip>}
          </div>
        )}
        {evidence.map((item, index) => (
          <EvidenceItem key={`${item.messageId}-${index}`} chatId={lookupChatId} item={item} />
        ))}
      </div>
    </details>
  );
}

const WRAPPING_QUOTES = /^[\s"'“”‘’«»]+|[\s"'“”‘’«»]+$/gu;

/** Where the quoted passage sits in the full message, tolerant of wrapping quote marks and letter case. */
function locateQuote(content: string, quote: string): [number, number] | null {
  const candidates = [quote.trim(), quote.replace(WRAPPING_QUOTES, "")].filter((value) => value.length >= 3);
  for (const candidate of candidates) {
    const exact = content.indexOf(candidate);
    if (exact >= 0) return [exact, exact + candidate.length];
  }
  const lower = content.toLowerCase();
  for (const candidate of candidates) {
    const loose = lower.indexOf(candidate.toLowerCase());
    if (loose >= 0) return [loose, loose + candidate.length];
  }
  const head = (candidates[candidates.length - 1] ?? "").slice(0, 48).toLowerCase();
  if (head.length >= 12) {
    const partial = lower.indexOf(head);
    if (partial >= 0) return [partial, partial + head.length];
  }
  return null;
}

function EvidenceItem({ chatId, item }: { chatId: string; item: CampaignWikiEvidenceItem }) {
  const { t } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const source = useCampaignMemorySource(chatId, item.messageId, item.sourceHash, { enabled: open });
  const errorStatus = source.error instanceof ApiError ? source.error.status : undefined;
  const content = source.data?.content ?? null;
  const range = useMemo(() => (content ? locateQuote(content, item.quote) : null), [content, item.quote]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const container = scrollRef.current;
    const mark = markRef.current;
    if (!container || !mark) return;
    container.scrollTop = Math.max(0, mark.offsetTop - 32);
  }, [content, range]);

  return (
    <figure className="rounded-lg bg-secondary/35 px-3 py-2.5">
      <blockquote className="flex gap-2">
        <Quote size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-primary/70" />
        <p className="min-w-0 whitespace-pre-wrap break-words text-[0.8125rem] italic leading-6 text-foreground/90">
          {item.quote}
        </p>
      </blockquote>
      {item.sourceHash ? (
        <div className="mt-2">
          {!open ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <ChevronDown size={13} aria-hidden="true" />
              {t("ui.game.campaignWiki.evidence.showFull", { defaultValue: "Show full message" })}
            </button>
          ) : (
            <div className="rounded-lg bg-background/70 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("ui.game.campaignWiki.evidence.fullMessage", { defaultValue: "Full message" })}
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label={t("ui.game.campaignWiki.evidence.hideFull", { defaultValue: "Hide full message" })}
                  title={t("ui.game.campaignWiki.evidence.hideFull", { defaultValue: "Hide full message" })}
                  className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
              {source.isLoading && (
                <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  {t("ui.game.campaignWiki.sourceLoading")}
                </p>
              )}
              {source.isError && (
                <div className="mt-2 space-y-1.5 text-xs text-destructive">
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
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
                  >
                    <RotateCw size={12} aria-hidden="true" />
                    {t("ui.game.campaignWiki.retry")}
                  </button>
                </div>
              )}
              {content !== null && (
                <div
                  ref={scrollRef}
                  className="relative mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[0.8125rem] leading-6 text-foreground/85 [scrollbar-width:thin]"
                >
                  {range ? (
                    <>
                      {content.slice(0, range[0])}
                      <mark
                        ref={markRef}
                        className="rounded bg-primary/25 px-0.5 text-foreground [box-decoration-break:clone]"
                      >
                        {content.slice(range[0], range[1])}
                      </mark>
                      {content.slice(range[1])}
                    </>
                  ) : (
                    content
                  )}
                </div>
              )}
              {content !== null && !range && (
                <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">
                  {t("ui.game.campaignWiki.evidence.quoteNotFound", {
                    defaultValue: "The exact quote could not be matched in this message.",
                  })}
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">
          {t("ui.game.campaignWiki.evidence.noFullMessage", {
            defaultValue: "The full message is not available for this older quote.",
          })}
        </p>
      )}
    </figure>
  );
}
