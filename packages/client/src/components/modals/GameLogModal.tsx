// ──────────────────────────────────────────────
// Campaign log: reread a whole Game campaign as a story
// ──────────────────────────────────────────────
// The Game screen shows one narration beat at a time. This reader lays every
// session out in order, with the game's own segment parsing, edits and
// deletions, a campaign-wide search with next/previous, filters by session
// and speaker, and a chapter list. Game mode has no per-message anchors on its
// main screen, so chapters are marked here. Long campaigns render a window of
// turns at a time.
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BookOpen, ChevronDown, ChevronUp, Loader2, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Modal } from "../ui/Modal";
import { cn } from "../../lib/utils";
import { campaignLogKeys, useCampaignLog } from "../../hooks/use-game-tools";
import { chatKeys } from "../../hooks/use-chats";
import { api } from "../../lib/api-client";
import { ChapterFields, ChapterHeading, ChapterHeadingEditButton, type ChapterDraft } from "../chat/MessageChapters";
import { parseNarrationSegments } from "../game/GameNarration";
import {
  LOG_SEARCH_MIN_CHARS,
  NARRATION_SPEAKER,
  buildGameLogEntries,
  extendLogWindow,
  filterLogEntries,
  findLogHits,
  findLogTarget,
  listLogChapters,
  listLogSpeakers,
  logWindowAround,
  splitLogHighlights,
  type LogEntry,
  type LogHit,
  type LogLine,
  type LogSegmentParser,
} from "../../lib/game-log";

const FIELD_CLASS =
  "h-9 w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 text-xs text-[var(--foreground)] outline-none transition-colors focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/25";
const ICON_BUTTON_CLASS =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40 disabled:hover:bg-transparent";
const EMPTY_SPEAKER_COLORS = new Map<string, string>();
const TARGET_FLASH_MS = 2_600;

const parseLogMessage: LogSegmentParser = (message) =>
  parseNarrationSegments(
    {
      id: message.id,
      chatId: "",
      role: message.role,
      content: message.content,
      characterId: null,
      extra: {},
      activeSwipeIndex: 0,
    } as unknown as Parameters<typeof parseNarrationSegments>[0],
    EMPTY_SPEAKER_COLORS,
  );

type HitRange = { start: number; end: number; current?: boolean };

function HighlightedText({ text, ranges }: { text: string; ranges: HitRange[] | undefined }) {
  if (!ranges?.length) return <>{text}</>;
  return (
    <>
      {splitLogHighlights(text, ranges).map((part, index) =>
        part.highlighted ? (
          <mark
            key={index}
            data-log-current-hit={part.current ? "true" : undefined}
            className={cn(
              "rounded-sm px-0.5 text-[var(--foreground)]",
              part.current ? "bg-[var(--primary)]/55 ring-1 ring-[var(--primary)]" : "bg-[var(--primary)]/20",
            )}
          >
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function LogLineView({ line, ranges }: { line: LogLine; ranges: HitRange[] | undefined }) {
  const { t } = useTranslation();
  const body = <HighlightedText text={line.text} ranges={ranges} />;
  if (line.kind === "player") {
    return (
      <p className="border-l-2 border-[var(--primary)]/60 pl-3 text-[var(--foreground)]">
        <span className="font-semibold text-[var(--primary)]">{line.speaker}</span>
        <span className="text-[var(--muted-foreground)]">: </span>
        {body}
      </p>
    );
  }
  if (line.kind === "dialogue") {
    return (
      <p>
        <span className="font-semibold text-[var(--foreground)]">{line.speaker ?? t("ui.game.log.narration")}</span>
        <span className="text-[var(--muted-foreground)]">: </span>
        {body}
      </p>
    );
  }
  if (line.kind === "readable") {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 px-3 py-2 italic">
        <div className="mb-1 text-[0.625rem] font-semibold not-italic uppercase tracking-wide text-[var(--muted-foreground)]">
          {t(line.readableType === "book" ? "ui.game.log.book" : "ui.game.log.note")}
        </div>
        {body}
      </div>
    );
  }
  if (line.kind === "system") {
    return <p className="text-xs text-[var(--muted-foreground)]">{body}</p>;
  }
  return <p className="text-[var(--foreground)]/90">{body}</p>;
}

export function GameLogModal({
  open,
  onClose,
  chatId,
  messageId = null,
  messageNumber = null,
  focusChapters = false,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string;
  messageId?: string | null;
  messageNumber?: number | null;
  /** Open with the chapter list focused (the palette's "Go to chapter"). */
  focusChapters?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const chapterSelectRef = useRef<HTMLSelectElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef<{ key: string; hit: boolean } | null>(null);
  // An entry that must stay where it is on screen while turns are added or dropped around it.
  const anchorRef = useRef<{ key: string; top: number } | null>(null);
  const log = useCampaignLog(chatId, open);

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sessionChatId, setSessionChatId] = useState<string | null>(null);
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [currentHit, setCurrentHit] = useState(0);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [targetNotice, setTargetNotice] = useState(false);

  const entries = useMemo(
    () => (log.data ? buildGameLogEntries(log.data, parseLogMessage, { player: t("ui.game.log.you") }) : []),
    [log.data, t],
  );
  const speakers = useMemo(() => listLogSpeakers(entries), [entries]);
  const chapters = useMemo(() => listLogChapters(entries), [entries]);
  const [editingChapterKey, setEditingChapterKey] = useState<string | null>(null);
  const [savingChapterKey, setSavingChapterKey] = useState<string | null>(null);
  // A chapter picked while filters hide it: filters clear first, then the reader jumps.
  const pendingChapterJumpRef = useRef<string | null>(null);
  const view = useMemo(() => filterLogEntries(entries, { sessionChatId, speaker }), [entries, sessionChatId, speaker]);
  const search = useMemo(() => findLogHits(view, deferredQuery), [view, deferredQuery]);
  const searching = deferredQuery.trim().length >= LOG_SEARCH_MIN_CHARS;

  const hitsByLine = useMemo(() => {
    const map = new Map<string, HitRange[]>();
    search.hits.forEach((hit, index) => {
      const key = `${hit.entryIndex}:${hit.lineIndex}`;
      const list = map.get(key) ?? [];
      list.push({ start: hit.start, end: hit.end, current: index === currentHit });
      map.set(key, list);
    });
    return map;
  }, [currentHit, search.hits]);

  const showEntry = useCallback(
    (index: number, options: { hit?: boolean; flash?: boolean } = {}) => {
      const entry = view[index];
      if (!entry) return;
      setRange((current) =>
        current && index >= current.start && index < current.end ? current : logWindowAround(index, view.length),
      );
      pendingScrollRef.current = { key: entry.key, hit: options.hit === true };
      if (options.flash) setFlashKey(entry.key);
    },
    [view],
  );

  // First load: open at the requested message, else at the start of the session the log was opened from.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current || entries.length === 0) return;
    openedRef.current = true;
    const target = findLogTarget(entries, { chatId, messageId, messageNumber });
    if (target) {
      setTargetNotice(!target.exact);
      showEntry(target.index, { flash: true });
      return;
    }
    // The requested turn is not in the readable log (hidden, or its session was left out).
    if (messageId || (messageNumber != null && messageNumber > 0)) setTargetNotice(true);
    const sessionStart = entries.findIndex((entry) => entry.sessionChatId === chatId);
    if (sessionStart >= 0) showEntry(sessionStart);
    else setRange(logWindowAround(0, entries.length));
  }, [chatId, entries, messageId, messageNumber, showEntry]);

  // Filters change the list the window indexes into; start again from its top.
  const filterKey = `${sessionChatId ?? ""}\u0000${speaker ?? ""}`;
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    setRange(logWindowAround(0, view.length));
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filterKey, view.length]);

  // A new search starts at its first hit.
  useEffect(() => {
    setCurrentHit(0);
    const first = search.hits[0];
    if (first) showEntry(first.entryIndex, { hit: true });
    // Only a new result set moves the reader, not a window change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.hits]);

  useEffect(() => {
    const key = pendingChapterJumpRef.current;
    if (!key) return;
    const index = view.findIndex((entry) => entry.key === key);
    if (index < 0) return;
    pendingChapterJumpRef.current = null;
    showEntry(index, { flash: true });
  }, [showEntry, view]);

  // The palette's "Go to chapter" lands on the chapter list once the log has loaded.
  const chapterFocusDoneRef = useRef(false);
  useEffect(() => {
    if (!focusChapters || chapterFocusDoneRef.current || chapters.length === 0) return;
    chapterFocusDoneRef.current = true;
    chapterSelectRef.current?.focus();
  }, [chapters.length, focusChapters]);

  const jumpToChapter = (key: string) => {
    const index = view.findIndex((entry) => entry.key === key);
    if (index >= 0) {
      showEntry(index, { flash: true });
      return;
    }
    pendingChapterJumpRef.current = key;
    setSessionChatId(null);
    setSpeaker(null);
  };

  const saveChapter = async (entry: LogEntry, draft: ChapterDraft | null) => {
    // An existing chapter may live on a hidden turn just before this one.
    const targetId = entry.chapter?.messageId ?? entry.messageId;
    setSavingChapterKey(entry.key);
    try {
      await api.patch(
        `/chats/${encodeURIComponent(entry.sessionChatId)}/messages/${encodeURIComponent(targetId)}/extra`,
        { chapter: draft },
      );
      setEditingChapterKey(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: campaignLogKeys.detail(chatId) }),
        queryClient.invalidateQueries({ queryKey: chatKeys.chapters(entry.sessionChatId) }),
        queryClient.invalidateQueries({ queryKey: chatKeys.messages(entry.sessionChatId) }),
      ]);
    } catch {
      toast.error(t("ui.chat.messagemarks.saveFailed"));
    } finally {
      setSavingChapterKey(null);
    }
  };

  const goToHit = (index: number) => {
    const total = search.hits.length;
    if (total === 0) return;
    const next = ((index % total) + total) % total;
    setCurrentHit(next);
    showEntry((search.hits[next] as LogHit).entryIndex, { hit: true });
  };

  useLayoutEffect(() => {
    const container = scrollRef.current;
    const anchor = anchorRef.current;
    if (anchor && container) {
      anchorRef.current = null;
      const anchorEl = container.querySelector<HTMLElement>(`[data-log-entry="${CSS.escape(anchor.key)}"]`);
      if (anchorEl) container.scrollTop += anchorEl.getBoundingClientRect().top - anchor.top;
    }
    const pending = pendingScrollRef.current;
    if (!pending || !container) return;
    const entryEl = container.querySelector<HTMLElement>(`[data-log-entry="${CSS.escape(pending.key)}"]`);
    if (!entryEl) return;
    pendingScrollRef.current = null;
    const target = (pending.hit && entryEl.querySelector<HTMLElement>("[data-log-current-hit]")) || entryEl;
    target.scrollIntoView({ block: pending.hit ? "center" : "start" });
  });

  useEffect(() => {
    if (!flashKey) return;
    const timer = window.setTimeout(() => setFlashKey(null), TARGET_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashKey]);

  const window_ = range ?? logWindowAround(0, view.length);
  const visible = view.slice(window_.start, window_.end);
  const sessions = log.data?.sessions ?? [];
  const omittedSessions = sessions.filter((session) => session.omitted).map((session) => session.number);
  const sessionLabel = (index: number) => {
    const session = sessions[index];
    return session ? t("ui.game.log.sessionLabel", { number: session.number }) : "";
  };

  // Paging keeps the entry the reader is on in place: the first one in view when turns appear
  // above, the last one in view when turns appear below and the oldest rendered ones drop out.
  const extendWindow = (direction: "earlier" | "later") => {
    const container = scrollRef.current;
    if (container) {
      const box = container.getBoundingClientRect();
      const inView = Array.from(container.querySelectorAll<HTMLElement>("[data-log-entry]")).filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom;
      });
      const anchorEl = direction === "earlier" ? inView[0] : inView[inView.length - 1];
      if (anchorEl?.dataset.logEntry) {
        anchorRef.current = { key: anchorEl.dataset.logEntry, top: anchorEl.getBoundingClientRect().top };
      }
    }
    setRange(extendLogWindow(window_, view.length, direction));
  };
  const showEarlier = () => extendWindow("earlier");
  const showLater = () => extendWindow("later");

  const hitLabel = !searching
    ? ""
    : search.hits.length === 0
      ? t("ui.game.log.noHits")
      : t(search.capped ? "ui.game.log.hitCountCapped" : "ui.game.log.hitCount", {
          current: (currentHit + 1).toLocaleString(),
          total: search.hits.length.toLocaleString(),
        });

  const title = log.data?.gameName
    ? t("ui.game.log.titleWithGame", { game: log.data.gameName })
    : t("ui.game.log.title");

  let body: ReactNode;
  if (log.isLoading) {
    body = (
      <p className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--muted-foreground)]">
        <Loader2 size="1rem" className="animate-spin" />
        {t("ui.game.log.loading")}
      </p>
    );
  } else if (log.isError) {
    body = <p className="py-16 text-center text-sm text-[var(--muted-foreground)]">{t("ui.game.log.failed")}</p>;
  } else if (view.length === 0) {
    body = (
      <p className="py-16 text-center text-sm text-[var(--muted-foreground)]">
        {t(entries.length === 0 ? "ui.game.log.empty" : "ui.game.log.noFilterMatches")}
      </p>
    );
  } else {
    body = (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-10">
        {window_.start > 0 && (
          <button
            type="button"
            onClick={showEarlier}
            className="mari-chrome-control mari-chrome-control--small mx-auto px-4 text-xs"
          >
            <ChevronUp size="0.875rem" />
            {t("ui.game.log.showEarlier")}
          </button>
        )}
        {visible.map((entry: LogEntry, offset) => {
          const index = window_.start + offset;
          const previous = offset === 0 ? null : visible[offset - 1]!;
          const sessionChanged = !previous || previous.sessionIndex !== entry.sessionIndex;
          // Later sessions are named after the game plus a session suffix; only a name of its own is shown.
          const ownName = sessions[entry.sessionIndex]?.name.replace(/\s+\u2014\s+Session \d+$/u, "").trim();
          const sessionName = ownName && ownName !== log.data?.gameName ? ownName : null;
          const editingChapter = editingChapterKey === entry.key;
          const chapterLabel = t("ui.game.log.chapterAction");
          return (
            <div key={entry.key} className="flex flex-col gap-4">
              {sessionChanged && (
                <div className="flex items-center gap-3 pt-2" role="separator">
                  <span className="h-px flex-1 bg-[var(--border)]" />
                  <span className="max-w-[80%] truncate text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                    {sessionLabel(entry.sessionIndex)}
                    {sessionName ? <span className="font-normal normal-case tracking-normal">{t("ui.game.log.sessionNameSuffix", { name: sessionName })}</span> : null}
                  </span>
                  <span className="h-px flex-1 bg-[var(--border)]" />
                </div>
              )}
              {editingChapter ? (
                <div className="mx-auto w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--secondary)]/40 p-2.5">
                  <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-[var(--foreground)]">
                    <BookOpen size="0.8125rem" className="shrink-0 text-[var(--primary)]" />
                    {entry.chapter ? t("ui.game.log.editChapter") : t("ui.game.log.newChapter")}
                  </p>
                  <ChapterFields
                    initial={entry.chapter ? { title: entry.chapter.title, summary: entry.chapter.summary } : null}
                    busy={savingChapterKey === entry.key}
                    onSave={(draft) => void saveChapter(entry, draft)}
                    onRemove={entry.chapter ? () => void saveChapter(entry, null) : undefined}
                    onCancel={() => setEditingChapterKey(null)}
                  />
                </div>
              ) : entry.chapter ? (
                <ChapterHeading
                  title={entry.chapter.title}
                  summary={entry.chapter.summary}
                  label={t("ui.chat.chapters.dividerLabel", { title: entry.chapter.title })}
                  className="px-0 py-1"
                  action={
                    <ChapterHeadingEditButton
                      title={t("ui.game.log.editChapter")}
                      onClick={() => setEditingChapterKey(entry.key)}
                    />
                  }
                />
              ) : null}
              <article
                data-log-entry={entry.key}
                title={t("ui.game.log.turnMeta", {
                  session: sessions[entry.sessionIndex]?.number ?? entry.sessionIndex + 1,
                  number: entry.number,
                })}
                className={cn(
                  "group relative flex flex-col gap-2 rounded-lg py-1 pl-2 pr-8 text-sm leading-6 transition-colors duration-700",
                  flashKey === entry.key && "bg-[var(--primary)]/12 ring-1 ring-[var(--primary)]/40",
                  // Keep the chapter heading above in view when the reader jumps here.
                  entry.chapter && "scroll-mt-24",
                )}
              >
                {!entry.chapter && !editingChapter && (
                  <button
                    type="button"
                    onClick={() => setEditingChapterKey(entry.key)}
                    title={chapterLabel}
                    aria-label={chapterLabel}
                    className="absolute right-0.5 top-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] opacity-0 transition-opacity hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] group-hover:opacity-100 [@media(pointer:coarse)]:opacity-50"
                  >
                    <BookOpen size="0.8125rem" />
                  </button>
                )}
                {entry.lines.map((line, lineIndex) => (
                  <LogLineView key={lineIndex} line={line} ranges={hitsByLine.get(`${index}:${lineIndex}`)} />
                ))}
              </article>
            </div>
          );
        })}
        {window_.end < view.length && (
          <button
            type="button"
            onClick={showLater}
            className="mari-chrome-control mari-chrome-control--small mx-auto px-4 text-xs"
          >
            <ChevronDown size="0.875rem" />
            {t("ui.game.log.showLater")}
          </button>
        )}
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-none"
      fullScreen
      initialFocusRef={inputRef}
      contentClassName="flex min-h-0 flex-col !overflow-hidden !p-0"
    >
      <div className="shrink-0 border-b border-[var(--border)] px-3 py-2.5 sm:px-5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <Search
                size="0.875rem"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
              />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  goToHit(currentHit + (event.shiftKey ? -1 : 1));
                }}
                placeholder={t("ui.game.log.searchPlaceholder")}
                aria-label={t("ui.game.log.searchLabel")}
                className={cn(FIELD_CLASS, "pl-9 text-sm", searching && "pr-24")}
              />
              {searching && (
                <span
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[0.6875rem] tabular-nums text-[var(--muted-foreground)]"
                  role="status"
                  aria-live="polite"
                >
                  {hitLabel}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => goToHit(currentHit - 1)}
              disabled={search.hits.length === 0}
              className={ICON_BUTTON_CLASS}
              title={t("ui.game.log.previousHit")}
              aria-label={t("ui.game.log.previousHit")}
            >
              <ChevronUp size="0.875rem" />
            </button>
            <button
              type="button"
              onClick={() => goToHit(currentHit + 1)}
              disabled={search.hits.length === 0}
              className={ICON_BUTTON_CLASS}
              title={t("ui.game.log.nextHit")}
              aria-label={t("ui.game.log.nextHit")}
            >
              <ChevronDown size="0.875rem" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            <select
              value={sessionChatId ?? ""}
              onChange={(event) => setSessionChatId(event.target.value || null)}
              className={FIELD_CLASS}
              aria-label={t("ui.game.log.sessionFilter")}
              title={t("ui.game.log.sessionFilter")}
            >
              <option value="">{t("ui.game.log.allSessions")}</option>
              {sessions.map((session) => (
                <option key={session.chatId} value={session.chatId}>
                  {t("ui.game.log.sessionLabel", { number: session.number })}
                </option>
              ))}
            </select>
            <select
              value={speaker ?? ""}
              onChange={(event) => setSpeaker(event.target.value || null)}
              className={FIELD_CLASS}
              aria-label={t("ui.game.log.speakerFilter")}
              title={t("ui.game.log.speakerFilter")}
            >
              <option value="">{t("ui.game.log.anySpeaker")}</option>
              {speakers.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.key === NARRATION_SPEAKER ? t("ui.game.log.narration") : item.label}
                </option>
              ))}
            </select>
            <select
              ref={chapterSelectRef}
              value=""
              onChange={(event) => {
                if (event.target.value) jumpToChapter(event.target.value);
              }}
              disabled={chapters.length === 0}
              className={cn(FIELD_CLASS, "col-span-2 sm:col-span-1 disabled:opacity-60")}
              aria-label={t("ui.game.log.chapters")}
              title={chapters.length === 0 ? t("ui.game.log.noChaptersHint") : t("ui.game.log.chapters")}
            >
              <option value="">
                {chapters.length === 0
                  ? t("ui.game.log.noChapters")
                  : t("ui.game.log.chapterCount", { count: chapters.length })}
              </option>
              {chapters.map((item, index) => (
                <option key={item.entry.key} value={item.entry.key}>
                  {t("ui.game.log.chapterOption", { number: index + 1, title: item.chapter.title })}
                </option>
              ))}
            </select>
          </div>
          {targetNotice && (
            <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{t("ui.game.log.targetHidden")}</p>
          )}
          {omittedSessions.length > 0 && (
            <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
              {t("ui.game.log.sessionsOmitted", { sessions: omittedSessions.join(", ") })}
            </p>
          )}
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-5">
        {body}
      </div>
      {view.length > 0 && (
        <div className="shrink-0 border-t border-[var(--border)] px-3 py-1.5 text-center text-[0.6875rem] tabular-nums text-[var(--muted-foreground)]">
          {t("ui.game.log.position", {
            from: (window_.start + 1).toLocaleString(),
            to: window_.end.toLocaleString(),
            total: view.length.toLocaleString(),
          })}
        </div>
      )}
    </Modal>
  );
}
