// ──────────────────────────────────────────────
// Lorebook entry "fired in" badge: the activation count on an entry row. Clicking
// it lists the chats the entry fired in (newest first, at most 20) with links.
// ──────────────────────────────────────────────
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation as useUiTranslation } from "react-i18next";
import { MessageSquare } from "lucide-react";
import { cn } from "../../lib/utils";
import { openChatAtMessage } from "../../lib/chat-insights";
import type { LorebookEntryRecentChat } from "../../hooks/use-lorebooks";

const POPOVER_WIDTH = 256;
const MAX_RECENT_CHATS = 20;

interface Props {
  stat: { count: number; lastActivatedAt: string | null; recentChats?: LorebookEntryRecentChat[] };
}

export function LorebookEntryFiredIn({ stat }: Props) {
  const { t: localizeUi } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: POPOVER_WIDTH });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const chats = stat.recentChats ?? [];
  const title = localizeUi("lorebook.editor.stats.firedTitle", {
    count: stat.count,
    date: stat.lastActivatedAt ? new Date(stat.lastActivatedAt).toLocaleString() : "",
  });

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      setPosition({ top: rect.bottom + 4, left, width });
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cn(
          "shrink-0 rounded px-1 text-[0.625rem] pointer-coarse:text-[0.6875rem] tabular-nums text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]",
          open && "bg-[var(--accent)] text-[var(--foreground)]",
        )}
        title={title}
        aria-label={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {localizeUi("lorebook.editor.stats.firedShort", { count: stat.count })}
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={localizeUi("lorebook.editor.backlinks.title")}
            className="fixed z-[120] rounded-lg border border-[var(--border)] bg-[var(--popover)] p-1 text-[var(--popover-foreground)] shadow-xl ring-1 ring-[var(--border)]"
            style={{ top: position.top, left: position.left, width: position.width }}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="px-1.5 pb-1 pt-0.5 text-[0.6875rem] font-semibold">
              {localizeUi("lorebook.editor.backlinks.title")}
            </p>
            {chats.length === 0 ? (
              <p className="px-1.5 pb-1 text-[0.625rem] pointer-coarse:text-[0.6875rem] text-[var(--muted-foreground)]">
                {localizeUi("lorebook.editor.backlinks.empty")}
              </p>
            ) : (
              <ul className="max-h-64 overflow-y-auto">
                {chats.map((chat) => (
                  <li key={chat.chatId}>
                    {chat.chatName === null ? (
                      <div className="flex items-center gap-1.5 px-1.5 py-1 text-[0.6875rem] italic text-[var(--muted-foreground)]">
                        <MessageSquare size="0.625rem" className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {localizeUi("lorebook.editor.backlinks.deletedChat")}
                        </span>
                        {chat.count > 0 && (
                          <span className="shrink-0 tabular-nums">
                            {localizeUi("lorebook.editor.stats.firedShort", { count: chat.count })}
                          </span>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[0.6875rem] transition-colors hover:bg-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                        title={
                          chat.lastActivatedAt
                            ? localizeUi("lorebook.editor.backlinks.lastFired", {
                                date: new Date(chat.lastActivatedAt).toLocaleString(),
                              })
                            : undefined
                        }
                        onClick={() => {
                          setOpen(false);
                          openChatAtMessage(chat.chatId);
                        }}
                      >
                        <MessageSquare size="0.625rem" className="shrink-0 text-[var(--muted-foreground)]" />
                        <span className="min-w-0 flex-1 truncate">{chat.chatName}</span>
                        {chat.count > 0 && (
                          <span className="shrink-0 tabular-nums text-[var(--muted-foreground)]">
                            {localizeUi("lorebook.editor.stats.firedShort", { count: chat.count })}
                          </span>
                        )}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {chats.length >= MAX_RECENT_CHATS && (
              <p className="px-1.5 pb-0.5 pt-1 text-[0.625rem] pointer-coarse:text-[0.6875rem] text-[var(--muted-foreground)]">
                {localizeUi("lorebook.editor.backlinks.capped", { count: MAX_RECENT_CHATS })}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
