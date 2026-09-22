// ──────────────────────────────────────────────
// Message marks: bookmark, pin to context, private note
// ──────────────────────────────────────────────
import {
  MAX_BOOKMARK_LABEL_LENGTH,
  MAX_PINNED_CONTEXT_MESSAGES,
  MAX_PRIVATE_NOTE_LENGTH,
  isMessagePinnedToContext,
  readMessageBookmark,
  readMessagePrivateNote,
} from "@marinara-engine/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Bookmark, Pin, StickyNote } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation as useUiTranslation } from "react-i18next";
import { toast } from "sonner";
import { useUpdateMessageExtra } from "../../hooks/use-chats";
import { ApiError } from "../../lib/api-client";
import { cn } from "../../lib/utils";
import { MESSAGE_ACTION_ICON_SIZE, MessageActionButton, useMessageActionMenu } from "./MessageActionButton";

type MarkableMessage = { id: string; chatId: string; extra?: unknown };

const POPOVER_CLASS =
  "marinara-chat-popover fixed z-[9999] w-[min(18rem,calc(100vw-1rem))] rounded-xl border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-panel-bg)] p-2 text-[var(--foreground)] shadow-xl";
const MENU_ROW_CLASS =
  "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)] disabled:pointer-events-none disabled:opacity-50";
const FIELD_CLASS =
  "w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/25";
const ACTIVE_ICON_CLASS =
  "text-[var(--marinara-chat-chrome-button-text-active)] hover:text-[var(--marinara-chat-chrome-button-text-hover)]";

export function readMessageMarks(message: { extra?: unknown }) {
  const bookmark = readMessageBookmark(message.extra);
  const pinned = isMessagePinnedToContext(message.extra);
  const note = readMessagePrivateNote(message.extra);
  return { bookmark, pinned, note, any: !!bookmark || pinned || !!note };
}

function useSaveMessageMarks(message: MarkableMessage) {
  const qc = useQueryClient();
  const updateExtra = useUpdateMessageExtra(message.chatId);
  const { t: localizeUi } = useUiTranslation();
  return (extra: Record<string, unknown>) =>
    updateExtra.mutate(
      { messageId: message.id, extra },
      {
        onSuccess: () => qc.invalidateQueries({ queryKey: ["chat-message-search", message.chatId] }),
        onError: (error) =>
          toast.error(
            error instanceof ApiError && error.status === 409
              ? localizeUi("ui.chat.messagemarks.pinLimitReached", { count: MAX_PINNED_CONTEXT_MESSAGES })
              : localizeUi("ui.chat.messagemarks.saveFailed"),
          ),
      },
    );
}

/** One message action that opens the bookmark / pin / note menu. */
export function MessageMarksAction({
  message,
  align = "left",
  stopPropagation,
}: {
  message: MarkableMessage;
  align?: "left" | "right";
  stopPropagation?: boolean;
}) {
  const { t: localizeUi } = useUiTranslation();
  const { open, setOpen, buttonRef, menuRef, position } = useMessageActionMenu(align);
  const marks = readMessageMarks(message);
  const save = useSaveMessageMarks(message);
  const [label, setLabel] = useState(marks.bookmark?.label ?? "");
  const [note, setNote] = useState(marks.note ?? "");
  const labelId = useId();
  const noteId = useId();

  useEffect(() => {
    if (!open) return;
    setLabel(marks.bookmark?.label ?? "");
    setNote(marks.note ?? "");
    // Only reseed the fields when the menu opens; typing must not be overwritten by refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const saveLabel = () => {
    if (!marks.bookmark || label.trim() === (marks.bookmark.label ?? "")) return;
    save({ bookmark: { label: label.trim(), createdAt: marks.bookmark.createdAt } });
  };
  const noteChanged = note.trim() !== (marks.note ?? "");

  return (
    <>
      <MessageActionButton
        buttonRef={buttonRef}
        icon={<Bookmark size={MESSAGE_ACTION_ICON_SIZE} fill={marks.bookmark ? "currentColor" : "none"} />}
        onClick={() => setOpen((value) => !value)}
        title={localizeUi("ui.chat.messagemarks.menuTitle")}
        className={cn(marks.any && ACTIVE_ICON_CLASS)}
        ariaPressed={open}
        stopPropagation={stopPropagation}
      />
      {open &&
        createPortal(
          <div
            ref={menuRef}
            style={position}
            role="dialog"
            aria-label={localizeUi("ui.chat.messagemarks.menuTitle")}
            className={POPOVER_CLASS}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className={MENU_ROW_CLASS}
              aria-pressed={!!marks.bookmark}
              onClick={() => save({ bookmark: marks.bookmark ? null : { label: label.trim() || null } })}
            >
              <Bookmark
                size="0.875rem"
                className={cn("mt-px shrink-0", marks.bookmark && "text-[var(--primary)]")}
                fill={marks.bookmark ? "currentColor" : "none"}
              />
              <span>
                {marks.bookmark
                  ? localizeUi("ui.chat.messagemarks.removeBookmark")
                  : localizeUi("ui.chat.messagemarks.addBookmark")}
              </span>
            </button>
            {marks.bookmark && (
              <div className="px-2 pb-1.5">
                <label htmlFor={labelId} className="sr-only">
                  {localizeUi("ui.chat.messagemarks.bookmarkLabel")}
                </label>
                <input
                  id={labelId}
                  value={label}
                  maxLength={MAX_BOOKMARK_LABEL_LENGTH}
                  onChange={(event) => setLabel(event.target.value)}
                  onBlur={saveLabel}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveLabel();
                    }
                  }}
                  placeholder={localizeUi("ui.chat.messagemarks.bookmarkLabelPlaceholder")}
                  className={cn(FIELD_CLASS, "h-7")}
                />
              </div>
            )}

            <button
              type="button"
              className={MENU_ROW_CLASS}
              aria-pressed={marks.pinned}
              onClick={() => save({ pinnedToContext: !marks.pinned })}
            >
              <Pin size="0.875rem" className={cn("mt-px shrink-0", marks.pinned && "text-[var(--primary)]")} />
              <span className="flex min-w-0 flex-col">
                <span>
                  {marks.pinned
                    ? localizeUi("ui.chat.messagemarks.unpinFromContext")
                    : localizeUi("ui.chat.messagemarks.pinToContext")}
                </span>
                <span className="text-[0.6875rem] leading-4 text-[var(--muted-foreground)]">
                  {localizeUi("ui.chat.messagemarks.pinHint", { count: MAX_PINNED_CONTEXT_MESSAGES })}
                </span>
              </span>
            </button>

            <div className="mt-1 border-t border-[var(--marinara-chat-chrome-panel-divider)] px-2 pt-2">
              <label htmlFor={noteId} className="mb-1 flex items-center gap-1.5 text-xs">
                <StickyNote size="0.875rem" className={cn("shrink-0", marks.note && "text-[var(--primary)]")} />
                {localizeUi("ui.chat.messagemarks.privateNote")}
              </label>
              <textarea
                id={noteId}
                value={note}
                rows={3}
                maxLength={MAX_PRIVATE_NOTE_LENGTH}
                onChange={(event) => setNote(event.target.value)}
                placeholder={localizeUi("ui.chat.messagemarks.privateNotePlaceholder")}
                className={cn(FIELD_CLASS, "resize-y leading-5")}
              />
              <div className="mt-1.5 flex justify-end gap-1.5">
                {marks.note && (
                  <button
                    type="button"
                    onClick={() => {
                      setNote("");
                      save({ privateNote: null });
                    }}
                    className="mari-chrome-control mari-chrome-control--small px-2"
                  >
                    {localizeUi("ui.chat.messagemarks.removeNote")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={!noteChanged}
                  onClick={() => save({ privateNote: note.trim() || null })}
                  className="mari-chrome-control mari-chrome-control--small px-2 disabled:opacity-50"
                >
                  {localizeUi("ui.chat.messagemarks.saveNote")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Small always-visible markers for a message's bookmark, pin and private note. */
export function MessageMarkIndicators({ message, className }: { message: MarkableMessage; className?: string }) {
  const { t: localizeUi } = useUiTranslation();
  const marks = readMessageMarks(message);
  const { open, setOpen, buttonRef, menuRef, position } = useMessageActionMenu("left");
  if (!marks.any) return null;
  const iconClass = "shrink-0 text-[var(--marinara-chat-chrome-highlight-text)]";
  const bookmarkTitle = marks.bookmark?.label
    ? localizeUi("ui.chat.messagemarks.bookmarkedAs", { label: marks.bookmark.label })
    : localizeUi("ui.chat.messagemarks.bookmarked");
  return (
    <span className={cn("inline-flex items-center gap-1 align-middle", className)}>
      {marks.bookmark && (
        <span title={bookmarkTitle} aria-label={bookmarkTitle} role="img">
          <Bookmark size="0.7rem" className={iconClass} fill="currentColor" />
        </span>
      )}
      {marks.pinned && (
        <span
          title={localizeUi("ui.chat.messagemarks.pinnedToContext")}
          aria-label={localizeUi("ui.chat.messagemarks.pinnedToContext")}
          role="img"
        >
          <Pin size="0.7rem" className={iconClass} />
        </span>
      )}
      {marks.note && (
        <>
          <button
            ref={buttonRef}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen((value) => !value);
            }}
            aria-expanded={open}
            title={localizeUi("ui.chat.messagemarks.showPrivateNote")}
            aria-label={localizeUi("ui.chat.messagemarks.showPrivateNote")}
            className="inline-flex items-center rounded p-0.5 transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]"
          >
            <StickyNote size="0.7rem" className={iconClass} />
          </button>
          {open &&
            createPortal(
              <div
                ref={menuRef}
                style={position}
                role="note"
                className={POPOVER_CLASS}
                onClick={(event) => event.stopPropagation()}
              >
                <p className="mb-1 flex items-center gap-1.5 text-[0.6875rem] font-semibold text-[var(--muted-foreground)]">
                  <StickyNote size="0.75rem" className="shrink-0" />
                  {localizeUi("ui.chat.messagemarks.privateNote")}
                </p>
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5">
                  {marks.note}
                </p>
              </div>,
              document.body,
            )}
        </>
      )}
    </span>
  );
}
