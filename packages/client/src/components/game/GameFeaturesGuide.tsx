import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

interface GuideChapter {
  id: string;
  titleKey: string;
  summaryKey: string;
  bodyKey: string;
}

const CHAPTERS: GuideChapter[] = [
  {
    id: "layout",
    titleKey: "gameGuide.chapters.layout.title",
    summaryKey: "gameGuide.chapters.layout.summary",
    bodyKey: "gameGuide.chapters.layout.body",
  },
  {
    id: "map",
    titleKey: "gameGuide.chapters.map.title",
    summaryKey: "gameGuide.chapters.map.summary",
    bodyKey: "gameGuide.chapters.map.body",
  },
  {
    id: "campaign",
    titleKey: "gameGuide.chapters.campaign.title",
    summaryKey: "gameGuide.chapters.campaign.summary",
    bodyKey: "gameGuide.chapters.campaign.body",
  },
  {
    id: "status",
    titleKey: "gameGuide.chapters.status.title",
    summaryKey: "gameGuide.chapters.status.summary",
    bodyKey: "gameGuide.chapters.status.body",
  },
  {
    id: "contacts",
    titleKey: "gameGuide.chapters.contacts.title",
    summaryKey: "gameGuide.chapters.contacts.summary",
    bodyKey: "gameGuide.chapters.contacts.body",
  },
];

export function GameFeaturesGuide({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [chapterIndex, setChapterIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const chapter = CHAPTERS[chapterIndex] ?? CHAPTERS[0];

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), select:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first && last) {
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      } else if (event.key === "ArrowRight") {
        setChapterIndex((index) => Math.min(CHAPTERS.length - 1, index + 1));
      } else if (event.key === "ArrowLeft") {
        setChapterIndex((index) => Math.max(0, index - 1));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-0 z-[10060] flex items-center justify-center bg-black/65 p-3 outline-none backdrop-blur-sm sm:p-6"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[min(44rem,calc(100dvh-1.5rem))] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] shadow-2xl sm:max-h-[calc(100dvh-3rem)] sm:flex-row">
        <aside className="shrink-0 border-b border-[var(--border)] bg-[var(--sidebar)] p-3 sm:w-64 sm:border-b-0 sm:border-r sm:p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <BookOpen size={16} className="text-[var(--primary)]" aria-hidden="true" />
            <span>{t("gameGuide.title")}</span>
          </div>
          <select
            value={chapterIndex}
            onChange={(event) => setChapterIndex(Number(event.target.value))}
            aria-label={t("gameGuide.chapterNavigation")}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-2 text-xs sm:hidden"
          >
            {CHAPTERS.map((item, index) => (
              <option key={item.id} value={index}>
                {t(item.titleKey)}
              </option>
            ))}
          </select>
          <nav aria-label={t("gameGuide.chapterNavigation")} className="hidden gap-1 sm:block">
            {CHAPTERS.map((item, index) => (
              <button
                key={item.id}
                type="button"
                aria-current={index === chapterIndex ? "step" : undefined}
                onClick={() => setChapterIndex(index)}
                className={cn(
                  "w-full rounded-lg px-3 py-2 text-left text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]",
                  index === chapterIndex
                    ? "bg-[var(--accent)] font-semibold text-[var(--accent-foreground)]"
                    : "text-[var(--muted-foreground)] hover:bg-[var(--accent)]/60 hover:text-[var(--foreground)]",
                )}
              >
                <span className="block">{t(item.titleKey)}</span>
                <span className="mt-0.5 block line-clamp-2 text-[0.6875rem] font-normal opacity-80">
                  {t(item.summaryKey)}
                </span>
              </button>
            ))}
          </nav>
        </aside>

        <section className="flex min-h-0 flex-1 flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3 sm:px-6">
            <div className="min-w-0">
              <p className="text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                {t("gameGuide.chapterCount", { current: chapterIndex + 1, total: CHAPTERS.length })}
              </p>
              <h2 id={titleId} className="mt-1 text-lg font-semibold sm:text-xl">
                {t(chapter.titleKey)}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("gameGuide.close")}
              title={t("gameGuide.close")}
              className="shrink-0 rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          <article className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 text-sm leading-6 text-[var(--muted-foreground)] sm:px-6 sm:py-6">
            {t(chapter.bodyKey)
              .split("\n\n")
              .map((paragraph) => (
                <p key={paragraph} className="mb-4 last:mb-0">
                  {paragraph}
                </p>
              ))}
          </article>
          <footer className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3 sm:px-6">
            <button
              type="button"
              disabled={chapterIndex === 0}
              onClick={() => setChapterIndex((index) => Math.max(0, index - 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            >
              <ChevronLeft size={14} aria-hidden="true" />
              {t("gameGuide.previous")}
            </button>
            <span className="text-xs text-[var(--muted-foreground)]" aria-live="polite">
              {chapterIndex + 1} / {CHAPTERS.length}
            </span>
            <button
              type="button"
              disabled={chapterIndex === CHAPTERS.length - 1}
              onClick={() => setChapterIndex((index) => Math.min(CHAPTERS.length - 1, index + 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            >
              {t("gameGuide.next")}
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
