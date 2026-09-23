// ──────────────────────────────────────────────
// Chapters: mark a message as a chapter start, show dividers and the chapter list
// ──────────────────────────────────────────────
// Title and summary are always written by the user; nothing here calls a model.
import {
  MAX_CHAPTER_SUMMARY_LENGTH,
  MAX_CHAPTER_TITLE_LENGTH,
  readMessageChapter,
  type ChatChapterSummary,
} from "@marinara-engine/shared";
import { BookOpen, Loader2, Pencil } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useChat, useChatChapters } from "../../hooks/use-chats";
import { cn } from "../../lib/utils";

const FIELD_CLASS =
  "w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/25";

export type ChapterDraft = { title: string; summary: string | null };

/** Title and optional summary fields with Save, Remove (when editing) and Cancel. */
export function ChapterFields({
  initial,
  onSave,
  onRemove,
  onCancel,
  busy,
  className,
}: {
  initial: ChapterDraft | null;
  onSave: (draft: ChapterDraft) => void;
  onRemove?: () => void;
  onCancel?: () => void;
  busy?: boolean;
  className?: string;
}) {
  const { t: localizeUi } = useUiTranslation();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const titleId = useId();
  const summaryId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  const trimmedTitle = title.trim();
  const changed = trimmedTitle !== (initial?.title ?? "") || summary.trim() !== (initial?.summary ?? "");
  const save = () => {
    if (!trimmedTitle || busy) return;
    onSave({ title: trimmedTitle, summary: summary.trim() || null });
  };
  return (
    <div className={cn("flex flex-col gap-1.5", className)} onClick={(event) => event.stopPropagation()}>
      <label htmlFor={titleId} className="sr-only">
        {localizeUi("ui.chat.chapters.titleLabel")}
      </label>
      <input
        ref={titleRef}
        id={titleId}
        value={title}
        maxLength={MAX_CHAPTER_TITLE_LENGTH}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            save();
          } else if (event.key === "Escape" && onCancel) {
            event.stopPropagation();
            onCancel();
          }
        }}
        placeholder={localizeUi("ui.chat.chapters.titlePlaceholder")}
        className={cn(FIELD_CLASS, "h-7")}
      />
      <label htmlFor={summaryId} className="sr-only">
        {localizeUi("ui.chat.chapters.summaryLabel")}
      </label>
      <textarea
        id={summaryId}
        value={summary}
        rows={2}
        maxLength={MAX_CHAPTER_SUMMARY_LENGTH}
        onChange={(event) => setSummary(event.target.value)}
        placeholder={localizeUi("ui.chat.chapters.summaryPlaceholder")}
        className={cn(FIELD_CLASS, "resize-y leading-5")}
      />
      <div className="flex flex-wrap justify-end gap-1.5">
        {onRemove && (
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            className="mari-chrome-control mari-chrome-control--small mr-auto px-2 disabled:opacity-50"
          >
            {localizeUi("ui.chat.chapters.remove")}
          </button>
        )}
        {onCancel && (
          <button type="button" onClick={onCancel} className="mari-chrome-control mari-chrome-control--small px-2">
            {localizeUi("ui.chat.chapters.cancel")}
          </button>
        )}
        <button
          type="button"
          disabled={!trimmedTitle || (!!initial && !changed) || busy}
          onClick={save}
          className="mari-chrome-control mari-chrome-control--small px-2 disabled:opacity-50"
        >
          {initial ? localizeUi("ui.chat.chapters.save") : localizeUi("ui.chat.chapters.add")}
        </button>
      </div>
    </div>
  );
}

/** Chapter section of the message marks menu: start, edit or remove a chapter at this message. */
export function ChapterMenuSection({
  extra,
  rowClassName,
  onSave,
}: {
  extra: unknown;
  rowClassName: string;
  onSave: (chapter: ChapterDraft | null) => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  const chapter = readMessageChapter(extra);
  const [editing, setEditing] = useState(false);
  return (
    <div className="mt-1 border-t border-[var(--marinara-chat-chrome-panel-divider)] pt-1">
      <button
        type="button"
        className={rowClassName}
        aria-expanded={editing}
        onClick={() => setEditing((value) => !value)}
      >
        <BookOpen size="0.875rem" className={cn("mt-px shrink-0", chapter && "text-[var(--primary)]")} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">
            {chapter
              ? localizeUi("ui.chat.chapters.editChapter", { title: chapter.title })
              : localizeUi("ui.chat.chapters.startHere")}
          </span>
          {!chapter && (
            <span className="text-[0.6875rem] leading-4 text-[var(--muted-foreground)]">
              {localizeUi("ui.chat.chapters.startHereHint")}
            </span>
          )}
        </span>
      </button>
      {editing && (
        <ChapterFields
          className="px-2 pb-1.5 pt-0.5"
          initial={chapter ? { title: chapter.title, summary: chapter.summary ?? null } : null}
          onSave={(draft) => {
            onSave(draft);
            setEditing(false);
          }}
          onRemove={
            chapter
              ? () => {
                  onSave(null);
                  setEditing(false);
                }
              : undefined
          }
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/** Subtle, theme-aware divider rendered above a message that starts a chapter. */
export function ChapterDivider({ extra, className }: { extra: unknown; className?: string }) {
  const { t: localizeUi } = useUiTranslation();
  const chapter = readMessageChapter(extra);
  if (!chapter) return null;
  return (
    <ChapterHeading
      title={chapter.title}
      summary={chapter.summary ?? null}
      className={className}
      label={localizeUi("ui.chat.chapters.dividerLabel", { title: chapter.title })}
    />
  );
}

/** The divider's visual: rules either side of a small title card. Shared with the campaign log. */
export function ChapterHeading({
  title,
  summary,
  label,
  className,
  action,
}: {
  title: string;
  summary: string | null;
  label: string;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-chapter-divider
      className={cn("flex items-center gap-2 px-3 py-3 sm:gap-3", className)}
    >
      <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--marinara-chat-chrome-panel-border,var(--border))]" />
      <div className="flex min-w-0 max-w-[min(32rem,85%)] items-start gap-1 rounded-xl border border-[var(--marinara-chat-chrome-panel-border,var(--border))] bg-[var(--marinara-chat-chrome-panel-bg,var(--card))] px-3 py-1.5 text-center shadow-sm">
        <div className="min-w-0 flex-1">
          <p className="flex items-center justify-center gap-1.5 text-[0.8125rem] font-semibold leading-5 text-[var(--foreground)]">
            <BookOpen size="0.8125rem" aria-hidden className="shrink-0 text-[var(--primary)]" />
            <span className="min-w-0 break-words">{title}</span>
          </p>
          {summary && (
            <p className="mt-0.5 line-clamp-3 whitespace-pre-line break-words text-[0.6875rem] leading-4 text-[var(--muted-foreground)]">
              {summary}
            </p>
          )}
        </div>
        {action}
      </div>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-[var(--marinara-chat-chrome-panel-border,var(--border))]" />
    </div>
  );
}

/** Small pencil button for a chapter heading (used where the heading itself is editable). */
export function ChapterHeadingEditButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
    >
      <Pencil size="0.75rem" />
    </button>
  );
}

/** The chat's table of contents in the search panel. Clicking a chapter jumps to it. */
export function ChatChaptersList({
  chatId,
  enabled,
  onJump,
}: {
  chatId: string;
  enabled: boolean;
  onJump: (chapter: ChatChapterSummary) => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  const { data: chat } = useChat(chatId);
  const isGame = chat?.mode === "game";
  const { data: chapters, isLoading, isError, refetch } = useChatChapters(chatId, enabled);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-[var(--muted-foreground)]">
        <Loader2 size="0.875rem" className="animate-spin" />
        {localizeUi("ui.chat.chatmessagesearch.loading")}
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 px-3 py-8 text-center text-sm text-[var(--muted-foreground)]">
        <p>{localizeUi("ui.chat.chapters.loadFailed")}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mari-chrome-control mari-chrome-control--small px-3"
        >
          {localizeUi("ui.chat.chatmessagesearch.tryAgain")}
        </button>
      </div>
    );
  }
  if (!chapters || chapters.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-sm text-[var(--muted-foreground)]">
        <BookOpen size="1rem" className="mx-auto mb-2 opacity-60" />
        <p>{localizeUi(isGame ? "ui.chat.chapters.emptyGame" : "ui.chat.chapters.empty")}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {isGame && (
        <p className="border-b border-[var(--border)] px-3 py-2 text-[0.6875rem] leading-4 text-[var(--muted-foreground)]">
          {localizeUi("ui.chat.chapters.gameHint")}
        </p>
      )}
      <ol className="divide-y divide-[var(--border)]">
        {chapters.map((chapter, index) => (
          <li key={chapter.messageId}>
            <button
              type="button"
              onClick={() => onJump(chapter)}
              className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]"
              title={localizeUi("ui.chat.chatmessagesearch.jumpToMessage", { number: chapter.messageNumber })}
            >
              <span className="mt-px w-5 shrink-0 text-right text-xs tabular-nums text-[var(--muted-foreground)]">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 break-words text-sm font-medium leading-5 text-[var(--foreground)]">
                    {chapter.title}
                  </span>
                  <span className="shrink-0 text-[0.6875rem] tabular-nums text-[var(--muted-foreground)]">
                    {localizeUi("ui.chat.chatmessagesearch.messageNumber", { number: chapter.messageNumber })}
                  </span>
                </span>
                {chapter.summary && (
                  <span className="mt-0.5 line-clamp-2 block break-words text-xs leading-4 text-[var(--muted-foreground)]">
                    {chapter.summary}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
