// ──────────────────────────────────────────────
// Reading mode: a distraction-free, paged reader for a roleplay chat
// ──────────────────────────────────────────────
// Shows the chat as a book (active swipes, hidden turns left out) with
// typography settings, keyboard paging, bookmarks as chapters, and a saved
// position per chat. Pagination and storage live in lib/reading-mode.ts.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  Minus,
  Plus,
  Type,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Message } from "@marinara-engine/shared";
import { Modal } from "../ui/Modal";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api-client";
import { useChat } from "../../hooks/use-chats";
import { useCharacterSummaries } from "../../hooks/use-characters";
import { getChatDisplayName } from "../../lib/chat-display";
import {
  READER_LIMITS,
  buildReaderEntries,
  clampPage,
  pageCharsForSettings,
  pageOfEntry,
  paginateReaderEntries,
  parseReaderParagraphs,
  positionForPage,
  readReaderPosition,
  readReaderSettings,
  readerKeyAction,
  readerKeyIsIsolated,
  resolveReaderPage,
  stepReaderSetting,
  writeReaderPosition,
  writeReaderSettings,
  type ReaderEntry,
  type ReaderPosition,
  type ReaderSettings,
} from "../../lib/reading-mode";

const ICON_BUTTON_CLASS =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40 disabled:hover:bg-transparent";
const TOGGLE_ON_CLASS = "border-[var(--primary)]/60 bg-[var(--primary)]/10 text-[var(--foreground)]";
const SERIF_STACK = "Georgia, Cambria, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif";
const SANS_STACK = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const FLASH_MS = 2_400;

type Panel = "settings" | "bookmarks" | null;

function EntryView({ entry, flash }: { entry: ReaderEntry; flash: boolean }) {
  const paragraphs = useMemo(() => parseReaderParagraphs(entry.text), [entry.text]);
  const isUser = entry.role === "user";
  return (
    <section data-reader-entry={entry.id} className="scroll-mt-4">
      {entry.bookmark ? (
        <h2 className="mb-5 mt-2 text-center text-[1.15em] font-semibold tracking-wide text-[var(--foreground)]">
          {entry.bookmark}
        </h2>
      ) : null}
      <div
        className={cn(
          "rounded-lg transition-colors duration-700",
          isUser && "border-l-2 border-[var(--primary)]/50 pl-[0.9em]",
          flash && "bg-[var(--primary)]/10 ring-1 ring-[var(--primary)]/35",
        )}
      >
        <div
          className={cn(
            "mb-[0.35em] text-[0.7em] font-semibold uppercase tracking-[0.08em]",
            isUser ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]",
          )}
        >
          {entry.speaker}
          {entry.bookmark !== null ? (
            <Bookmark size="0.85em" className="ml-1.5 inline-block -translate-y-px fill-current align-middle" />
          ) : null}
        </div>
        {paragraphs.map((spans, index) => (
          <p key={index} className="mb-[0.8em] whitespace-pre-line text-[var(--foreground)] last:mb-0">
            {spans.map((span, spanIndex) =>
              span.strong ? (
                <strong key={spanIndex}>{span.text}</strong>
              ) : span.em ? (
                <em key={spanIndex}>{span.text}</em>
              ) : (
                <span key={spanIndex}>{span.text}</span>
              ),
            )}
          </p>
        ))}
      </div>
    </section>
  );
}

function Stepper({
  label,
  value,
  onStep,
  canDecrease,
  canIncrease,
}: {
  label: string;
  value: string;
  onStep: (direction: 1 | -1) => void;
  canDecrease: boolean;
  canIncrease: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-[var(--border)] px-2 py-1">
      <span className="truncate text-xs text-[var(--muted-foreground)]">{label}</span>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onStep(-1)}
          disabled={!canDecrease}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40"
          aria-label={t("readingMode.decrease", { setting: label })}
        >
          <Minus size="0.8rem" />
        </button>
        <span className="w-10 text-center text-xs tabular-nums text-[var(--foreground)]">{value}</span>
        <button
          type="button"
          onClick={() => onStep(1)}
          disabled={!canIncrease}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40"
          aria-label={t("readingMode.increase", { setting: label })}
        >
          <Plus size="0.8rem" />
        </button>
      </div>
    </div>
  );
}

export function ReadingModeModal({ open, onClose, chatId }: { open: boolean; onClose: () => void; chatId: string }) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data: chat } = useChat(chatId || null);
  const messagesQuery = useQuery({
    queryKey: ["reading-mode", chatId],
    queryFn: ({ signal }) => api.get<Message[]>(`/chats/${encodeURIComponent(chatId)}/messages`, { signal }),
    enabled: open && !!chatId,
    staleTime: 0,
  });
  const messages = messagesQuery.data;
  const characterIds = useMemo(
    () => (messages ?? []).map((message) => message.characterId).filter((id): id is string => !!id),
    [messages],
  );
  const { data: summaries } = useCharacterSummaries(characterIds, open);

  const [settings, setSettings] = useState<ReaderSettings>(() => readReaderSettings());
  const [position, setPosition] = useState<ReaderPosition | null>(() => readReaderPosition(chatId));
  const [panel, setPanel] = useState<Panel>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const pendingScrollRef = useRef<{ id: string | null } | null>({ id: null });

  const entries = useMemo(() => {
    if (!messages) return [];
    const names = new Map((summaries ?? []).map((summary) => [summary.id, summary.name]));
    return buildReaderEntries(messages, {
      resolveSpeaker: (message, extra) => {
        if (message.role === "user") {
          const snapshot = extra.personaSnapshot as { name?: unknown } | null | undefined;
          return typeof snapshot?.name === "string" && snapshot.name.trim() ? snapshot.name : t("readingMode.you");
        }
        if (message.role === "narrator") return t("readingMode.narrator");
        return (message.characterId && names.get(message.characterId)) || t("readingMode.narrator");
      },
    });
  }, [messages, summaries, t]);

  const pageChars = pageCharsForSettings(settings);
  const pages = useMemo(() => paginateReaderEntries(entries, pageChars), [entries, pageChars]);
  const page = clampPage(resolveReaderPage(entries, pages, position), pages.length);
  const range = pages[page];
  const visible = range ? entries.slice(range.start, range.end) : [];
  const bookmarks = useMemo(
    () => entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.bookmark !== null),
    [entries],
  );

  useEffect(() => writeReaderSettings(settings), [settings]);
  useEffect(() => {
    if (entries.length > 0 && position) writeReaderPosition(chatId, position);
  }, [chatId, entries.length, position]);

  const goToPage = (next: number) => {
    const target = clampPage(next, pages.length);
    if (target === page) return;
    setPosition(positionForPage(entries, pages, target));
    pendingScrollRef.current = { id: null };
  };

  const jumpToEntry = (entry: ReaderEntry) => {
    setPosition({ messageId: entry.id, number: entry.number });
    pendingScrollRef.current = { id: entry.id };
    setFlashId(entry.id);
    setPanel(null);
  };

  // New page: back to its top, or to the bookmarked entry that was jumped to.
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const container = scrollRef.current;
    if (!pending || !container || visible.length === 0) return;
    pendingScrollRef.current = null;
    const target = pending.id
      ? container.querySelector<HTMLElement>(`[data-reader-entry="${CSS.escape(pending.id)}"]`)
      : null;
    if (target) target.scrollIntoView({ block: "start" });
    else container.scrollTo({ top: 0 });
  });

  useEffect(() => {
    if (!flashId) return;
    const timer = window.setTimeout(() => setFlashId(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyHandlerRef.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const targetIsField =
      !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    const action = readerKeyAction({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      targetIsField,
    });
    // Keep arrows away from the chat's own window listeners (swipe, regenerate, edit last).
    if (action || readerKeyIsIsolated({ key: event.key, targetIsField })) event.stopPropagation();
    if (!action) return;
    event.preventDefault();
    if (action === "next") goToPage(page + 1);
    else if (action === "previous") goToPage(page - 1);
    else if (action === "first") goToPage(0);
    else if (action === "last") goToPage(pages.length - 1);
    else if (action === "bookmarks") setPanel((current) => (current === "bookmarks" ? null : "bookmarks"));
    else if (action === "settings") setPanel((current) => (current === "settings" ? null : "settings"));
    else setSettings((current) => stepReaderSetting(current, "fontSize", action === "bigger" ? 1 : -1));
  };
  useEffect(() => {
    if (!open) return;
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    // Capture phase, so the reader sees keys before the chat's bubble-phase window listeners.
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [open]);

  const chatName = getChatDisplayName(chat);
  const title = chatName ? t("readingMode.titleWithChat", { chat: chatName }) : t("readingMode.title");
  const columnStyle: CSSProperties = {
    maxWidth: settings.lineWidth + "ch",
    fontSize: settings.fontSize + "px",
    lineHeight: settings.lineHeight,
    fontFamily: settings.font === "serif" ? SERIF_STACK : SANS_STACK,
  };
  const step = (key: keyof typeof READER_LIMITS) => (direction: 1 | -1) =>
    setSettings((current) => stepReaderSetting(current, key, direction));
  const pageLabel =
    pages.length > 0
      ? t("readingMode.pageOf", { page: (page + 1).toLocaleString(), total: pages.length.toLocaleString() })
      : "";
  const progress = pages.length > 1 ? (page / (pages.length - 1)) * 100 : 100;

  let body;
  if (messagesQuery.isLoading) {
    body = (
      <p className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--muted-foreground)]">
        <Loader2 size="1rem" className="animate-spin" />
        {t("readingMode.loading")}
      </p>
    );
  } else if (messagesQuery.isError) {
    body = <p className="py-16 text-center text-sm text-[var(--muted-foreground)]">{t("readingMode.failed")}</p>;
  } else if (entries.length === 0) {
    body = <p className="py-16 text-center text-sm text-[var(--muted-foreground)]">{t("readingMode.empty")}</p>;
  } else {
    body = (
      <article className="mx-auto flex w-full flex-col gap-[1.6em] pb-12 pt-2" style={columnStyle}>
        {visible.map((entry) => (
          <EntryView key={entry.id} entry={entry} flash={flashId === entry.id} />
        ))}
        {page < pages.length - 1 ? (
          <button
            type="button"
            onClick={() => goToPage(page + 1)}
            className="mari-chrome-control mari-chrome-control--small mx-auto px-4 font-sans text-xs"
          >
            {t("readingMode.nextPage")}
            <ChevronRight size="0.875rem" />
          </button>
        ) : (
          <p className="text-center font-sans text-xs text-[var(--muted-foreground)]">{t("readingMode.end")}</p>
        )}
      </article>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-none"
      fullScreen
      contentClassName="flex min-h-0 flex-col !overflow-hidden !p-0"
    >
      <div className="shrink-0 border-b border-[var(--border)] px-3 py-2 sm:px-5">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPanel((current) => (current === "bookmarks" ? null : "bookmarks"))}
            className={cn(ICON_BUTTON_CLASS, panel === "bookmarks" && TOGGLE_ON_CLASS)}
            title={t("readingMode.bookmarks")}
            aria-label={t("readingMode.bookmarks")}
            aria-expanded={panel === "bookmarks"}
          >
            <Bookmark size="0.9rem" />
          </button>
          <button
            type="button"
            onClick={() => setPanel((current) => (current === "settings" ? null : "settings"))}
            className={cn(ICON_BUTTON_CLASS, panel === "settings" && TOGGLE_ON_CLASS)}
            title={t("readingMode.typography")}
            aria-label={t("readingMode.typography")}
            aria-expanded={panel === "settings"}
          >
            <Type size="0.9rem" />
          </button>
          <span
            className="min-w-0 flex-1 truncate text-center text-xs tabular-nums text-[var(--muted-foreground)]"
            role="status"
            aria-live="polite"
          >
            {pageLabel}
          </span>
          <button
            type="button"
            onClick={() => goToPage(0)}
            disabled={page <= 0}
            className={cn(ICON_BUTTON_CLASS, "hidden sm:flex")}
            title={t("readingMode.firstPage")}
            aria-label={t("readingMode.firstPage")}
          >
            <ChevronsLeft size="0.9rem" />
          </button>
          <button
            type="button"
            onClick={() => goToPage(page - 1)}
            disabled={page <= 0}
            className={ICON_BUTTON_CLASS}
            title={t("readingMode.previousPage")}
            aria-label={t("readingMode.previousPage")}
          >
            <ChevronLeft size="0.9rem" />
          </button>
          <button
            type="button"
            onClick={() => goToPage(page + 1)}
            disabled={page >= pages.length - 1}
            className={ICON_BUTTON_CLASS}
            title={t("readingMode.nextPage")}
            aria-label={t("readingMode.nextPage")}
          >
            <ChevronRight size="0.9rem" />
          </button>
          <button
            type="button"
            onClick={() => goToPage(pages.length - 1)}
            disabled={page >= pages.length - 1}
            className={cn(ICON_BUTTON_CLASS, "hidden sm:flex")}
            title={t("readingMode.lastPage")}
            aria-label={t("readingMode.lastPage")}
          >
            <ChevronsRight size="0.9rem" />
          </button>
        </div>

        {panel === "settings" ? (
          <div className="mx-auto mt-2 grid w-full max-w-3xl grid-cols-1 gap-1.5 sm:grid-cols-2">
            <Stepper
              label={t("readingMode.fontSize")}
              value={String(settings.fontSize)}
              onStep={step("fontSize")}
              canDecrease={settings.fontSize > READER_LIMITS.fontSize.min}
              canIncrease={settings.fontSize < READER_LIMITS.fontSize.max}
            />
            <Stepper
              label={t("readingMode.lineWidth")}
              value={String(settings.lineWidth)}
              onStep={step("lineWidth")}
              canDecrease={settings.lineWidth > READER_LIMITS.lineWidth.min}
              canIncrease={settings.lineWidth < READER_LIMITS.lineWidth.max}
            />
            <Stepper
              label={t("readingMode.lineHeight")}
              value={settings.lineHeight.toFixed(1)}
              onStep={step("lineHeight")}
              canDecrease={settings.lineHeight > READER_LIMITS.lineHeight.min}
              canIncrease={settings.lineHeight < READER_LIMITS.lineHeight.max}
            />
            <div
              className="grid grid-cols-2 gap-1 rounded-lg border border-[var(--border)] p-1"
              role="radiogroup"
              aria-label={t("readingMode.font")}
            >
              {(["serif", "sans"] as const).map((font) => (
                <button
                  key={font}
                  type="button"
                  role="radio"
                  aria-checked={settings.font === font}
                  onClick={() => setSettings((current) => ({ ...current, font }))}
                  className={cn(
                    "h-7 rounded-md text-xs transition-colors",
                    settings.font === font
                      ? "bg-[var(--primary)]/15 text-[var(--foreground)]"
                      : "text-[var(--muted-foreground)] hover:bg-[var(--accent)]",
                  )}
                  style={{ fontFamily: font === "serif" ? SERIF_STACK : SANS_STACK }}
                >
                  {t(font === "serif" ? "readingMode.serif" : "readingMode.sans")}
                </button>
              ))}
            </div>
            <p className="text-[0.6875rem] text-[var(--muted-foreground)] sm:col-span-2">{t("readingMode.keysHint")}</p>
          </div>
        ) : null}

        {panel === "bookmarks" ? (
          <div className="mx-auto mt-2 w-full max-w-3xl">
            {bookmarks.length === 0 ? (
              <p className="py-2 text-xs text-[var(--muted-foreground)]">{t("readingMode.noBookmarks")}</p>
            ) : (
              <ul className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto overscroll-contain">
                {bookmarks.map(({ entry, index }) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => jumpToEntry(entry)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--accent)]"
                    >
                      <Bookmark size="0.75rem" className="shrink-0 fill-current text-[var(--primary)]" />
                      <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">
                        {entry.bookmark || entry.text.slice(0, 120)}
                      </span>
                      <span className="shrink-0 tabular-nums text-[var(--muted-foreground)]">
                        {t("readingMode.pageShort", { page: (pageOfEntry(pages, index) + 1).toLocaleString() })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-8">
        {body}
      </div>

      {pages.length > 1 ? (
        <div className="h-0.5 shrink-0 bg-[var(--border)]" aria-hidden="true">
          <div className="h-full bg-[var(--primary)]/70 transition-[width]" style={{ width: progress + "%" }} />
        </div>
      ) : null}
    </Modal>
  );
}
