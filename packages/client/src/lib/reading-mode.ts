// ──────────────────────────────────────────────
// Reading mode: pure logic for the full-screen chat reader
// ──────────────────────────────────────────────
// The reader shows a roleplay chat as a book: active swipes only, hidden turns
// left out, split into pages, with bookmarks as chapter marks. Everything here
// is pure (storage is passed in) so the pagination and saved position can be
// tested without a browser.
import { readMessageBookmark } from "@marinara-engine/shared";
import { parseMessageExtraRecord } from "./chat-message-extra";

export const READING_MODE_MODAL = "reading-mode";

// ── Entries ──

export interface ReaderMessageInput {
  id: string;
  role: string;
  characterId: string | null;
  content: string;
  createdAt?: string | null;
  extra?: unknown;
}

export interface ReaderEntry {
  id: string;
  /** 1-based position of the message in the whole chat, hidden rows included. */
  number: number;
  role: string;
  characterId: string | null;
  speaker: string;
  text: string;
  /** Bookmark label, "" for an unlabeled bookmark, null when the message is not bookmarked. */
  bookmark: string | null;
}

export interface ReaderEntryOptions {
  /** Name for a message; receives the parsed extra record. */
  resolveSpeaker: (message: ReaderMessageInput, extra: Record<string, unknown>) => string;
  /** Keep messages hidden from the AI (they stay visible in the chat, collapsed). Default false. */
  includeHiddenFromAI?: boolean;
}

const THINKING_BLOCK_RE = /<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1>/giu;
const BLOCK_TAG_RE = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|blockquote|section|article|tr)\b[^>]*>/giu;
const STYLE_BLOCK_RE = /<(style|script)\b[^>]*>[\s\S]*?<\/\1>/giu;
const ANY_TAG_RE = /<\/?[a-z][^>]*>/giu;
const ENTITY_MAP: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntity(match: string, name?: string, decimal?: string, hex?: string): string {
  if (name) return ENTITY_MAP[name.toLowerCase()] ?? "";
  const code = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? "", 16);
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
  return String.fromCodePoint(code);
}

/** Chat message text as plain reading text: no HTML, no reasoning blocks, tidy blank lines. */
export function toReaderText(content: string): string {
  return content
    .replace(STYLE_BLOCK_RE, "")
    .replace(THINKING_BLOCK_RE, "")
    .replace(BLOCK_TAG_RE, "\n")
    .replace(ANY_TAG_RE, "")
    .replace(/&(?:(amp|lt|gt|quot|apos|nbsp)|#(\d{1,7})|#x([0-9a-f]{1,6}));/giu, decodeEntity)
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function isReaderMessage(
  message: ReaderMessageInput,
  extra: Record<string, unknown>,
  includeHiddenFromAI = false,
) {
  if (message.role === "system") return false;
  if (typeof message.content !== "string" || !message.content.trim()) return false;
  if (extra.hiddenFromUser === true || extra.commandOnly === true || extra.roleplayPrivateOnly === true) return false;
  if (!includeHiddenFromAI && extra.hiddenFromAI === true) return false;
  return true;
}

/** Readable entries in chat order. The server already returns each message's active swipe as `content`. */
export function buildReaderEntries(
  messages: readonly ReaderMessageInput[],
  options: ReaderEntryOptions,
): ReaderEntry[] {
  const entries: ReaderEntry[] = [];
  messages.forEach((message, index) => {
    const extra = parseMessageExtraRecord(message.extra);
    if (!isReaderMessage(message, extra, options.includeHiddenFromAI === true)) return;
    const text = toReaderText(message.content);
    if (!text) return;
    const bookmark = readMessageBookmark(extra);
    entries.push({
      id: message.id,
      number: index + 1,
      role: message.role,
      characterId: message.characterId,
      speaker: options.resolveSpeaker(message, extra),
      text,
      bookmark: bookmark ? (bookmark.label ?? "") : null,
    });
  });
  return entries;
}

// ── Inline formatting ──

export interface ReaderSpan {
  text: string;
  strong?: boolean;
  em?: boolean;
}

/** Split text into paragraphs of spans, honoring **bold** and *italic* / _italic_ markers. */
export function parseReaderParagraphs(text: string): ReaderSpan[][] {
  return text
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(parseReaderSpans);
}

const INLINE_RE = /\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|(?<![\p{L}\p{N}])_([^_\n]+?)_(?![\p{L}\p{N}])/gu;

export function parseReaderSpans(paragraph: string): ReaderSpan[] {
  const spans: ReaderSpan[] = [];
  let last = 0;
  for (const match of paragraph.matchAll(INLINE_RE)) {
    const start = match.index ?? 0;
    if (start > last) spans.push({ text: paragraph.slice(last, start) });
    if (match[1] !== undefined) spans.push({ text: match[1], strong: true });
    else spans.push({ text: (match[2] ?? match[3]) as string, em: true });
    last = start + match[0].length;
  }
  if (last < paragraph.length) spans.push({ text: paragraph.slice(last) });
  return spans;
}

// ── Pagination ──

export interface ReaderPage {
  /** First entry index (inclusive). */
  start: number;
  /** Last entry index (exclusive). */
  end: number;
}

/** Characters of text on one page at the default settings. */
export const READER_PAGE_CHARS = 6000;
/** Weight of an entry's heading, so pages of many short turns do not run long. */
const ENTRY_OVERHEAD_CHARS = 80;

export function entryWeight(entry: Pick<ReaderEntry, "text">): number {
  return entry.text.length + ENTRY_OVERHEAD_CHARS;
}

/**
 * Greedy pages of whole entries: a page takes entries until the next one would pass
 * `pageChars`. An entry longer than a page gets a page of its own, never split.
 * A bookmark with a label starts a new page, so chapters open at the top.
 */
export function paginateReaderEntries(
  entries: readonly Pick<ReaderEntry, "text" | "bookmark">[],
  pageChars = READER_PAGE_CHARS,
): ReaderPage[] {
  const budget = Math.max(1, Math.floor(pageChars));
  const pages: ReaderPage[] = [];
  let start = 0;
  let used = 0;
  entries.forEach((entry, index) => {
    const weight = entryWeight(entry);
    const chapterBreak = Boolean(entry.bookmark);
    if (index > start && (used + weight > budget || chapterBreak)) {
      pages.push({ start, end: index });
      start = index;
      used = 0;
    }
    used += weight;
  });
  if (entries.length > start) pages.push({ start, end: entries.length });
  return pages;
}

/** Page budget for the chosen font size and line width: bigger text or a narrower column means fewer characters. */
export function pageCharsForSettings(settings: Pick<ReaderSettings, "fontSize" | "lineWidth">): number {
  const scale = (READER_DEFAULTS.fontSize / settings.fontSize) ** 2 * (settings.lineWidth / READER_DEFAULTS.lineWidth);
  return Math.round(Math.min(Math.max(READER_PAGE_CHARS * scale, 1500), 16000));
}

export function pageOfEntry(pages: readonly ReaderPage[], entryIndex: number): number {
  if (pages.length === 0) return 0;
  const found = pages.findIndex((page) => entryIndex >= page.start && entryIndex < page.end);
  if (found >= 0) return found;
  return entryIndex < 0 ? 0 : pages.length - 1;
}

export function clampPage(page: number, pageCount: number): number {
  if (pageCount <= 0 || !Number.isFinite(page)) return 0;
  return Math.min(Math.max(Math.trunc(page), 0), pageCount - 1);
}

// ── Saved position ──

export interface ReaderPosition {
  /** The first message on the page the reader was on. */
  messageId: string | null;
  /** Its 1-based message number, used when the message was deleted or hidden since. */
  number: number | null;
}

/** The page to reopen at: the page with the saved message, else the nearest later readable message, else the start. */
export function resolveReaderPage(
  entries: readonly Pick<ReaderEntry, "id" | "number">[],
  pages: readonly ReaderPage[],
  position: ReaderPosition | null,
): number {
  if (!position || pages.length === 0) return 0;
  if (position.messageId) {
    const index = entries.findIndex((entry) => entry.id === position.messageId);
    if (index >= 0) return pageOfEntry(pages, index);
  }
  if (position.number != null && position.number > 0) {
    const index = entries.findIndex((entry) => entry.number >= (position.number as number));
    return index >= 0 ? pageOfEntry(pages, index) : pages.length - 1;
  }
  return 0;
}

export function positionForPage(
  entries: readonly Pick<ReaderEntry, "id" | "number">[],
  pages: readonly ReaderPage[],
  page: number,
): ReaderPosition | null {
  const range = pages[clampPage(page, pages.length)];
  const entry = range ? entries[range.start] : undefined;
  return entry ? { messageId: entry.id, number: entry.number } : null;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

const POSITION_KEY_PREFIX = "marinara:reading-mode:position:";
export const READER_SETTINGS_KEY = "marinara:reading-mode:settings";

export function readReaderPosition(
  chatId: string,
  storage: StorageLike | null = browserStorage(),
): ReaderPosition | null {
  if (!storage || !chatId) return null;
  try {
    const raw = storage.getItem(POSITION_KEY_PREFIX + chatId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const messageId = typeof parsed.messageId === "string" && parsed.messageId ? parsed.messageId : null;
    const number = typeof parsed.number === "number" && Number.isFinite(parsed.number) ? parsed.number : null;
    return messageId || number ? { messageId, number } : null;
  } catch {
    return null;
  }
}

export function writeReaderPosition(
  chatId: string,
  position: ReaderPosition | null,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage || !chatId || !position) return;
  try {
    storage.setItem(POSITION_KEY_PREFIX + chatId, JSON.stringify(position));
  } catch {
    // Private windows and full storage just lose the bookmark.
  }
}

// ── Typography settings ──

export type ReaderFont = "serif" | "sans";

export interface ReaderSettings {
  /** Base font size in px. */
  fontSize: number;
  /** Column width in `ch`. */
  lineWidth: number;
  lineHeight: number;
  font: ReaderFont;
}

export const READER_DEFAULTS: ReaderSettings = { fontSize: 18, lineWidth: 68, lineHeight: 1.7, font: "serif" };
export const READER_LIMITS = {
  fontSize: { min: 13, max: 30, step: 1 },
  lineWidth: { min: 40, max: 100, step: 4 },
  lineHeight: { min: 1.3, max: 2.2, step: 0.1 },
} as const;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

export function normalizeReaderSettings(raw: unknown): ReaderSettings {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const { fontSize, lineWidth, lineHeight } = READER_LIMITS;
  return {
    fontSize: Math.round(clampNumber(record.fontSize, READER_DEFAULTS.fontSize, fontSize.min, fontSize.max)),
    lineWidth: Math.round(clampNumber(record.lineWidth, READER_DEFAULTS.lineWidth, lineWidth.min, lineWidth.max)),
    lineHeight:
      Math.round(clampNumber(record.lineHeight, READER_DEFAULTS.lineHeight, lineHeight.min, lineHeight.max) * 10) / 10,
    font: record.font === "sans" ? "sans" : "serif",
  };
}

export function stepReaderSetting(
  settings: ReaderSettings,
  key: keyof typeof READER_LIMITS,
  direction: 1 | -1,
): ReaderSettings {
  const limit = READER_LIMITS[key];
  return normalizeReaderSettings({ ...settings, [key]: settings[key] + direction * limit.step });
}

export function readReaderSettings(storage: StorageLike | null = browserStorage()): ReaderSettings {
  if (!storage) return { ...READER_DEFAULTS };
  try {
    const raw = storage.getItem(READER_SETTINGS_KEY);
    return normalizeReaderSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...READER_DEFAULTS };
  }
}

export function writeReaderSettings(settings: ReaderSettings, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(READER_SETTINGS_KEY, JSON.stringify(normalizeReaderSettings(settings)));
  } catch {
    // Settings fall back to the defaults next time.
  }
}

// ── Keyboard ──

export type ReaderKeyAction = "next" | "previous" | "first" | "last" | "bookmarks" | "settings" | "bigger" | "smaller";

/** Reader keys; null lets the key through (typing in a field, scrolling with Space, modifier combos). */
export function readerKeyAction(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  targetIsField?: boolean;
}): ReaderKeyAction | null {
  if (event.targetIsField || event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case "ArrowRight":
    case "PageDown":
    case "j":
    case "n":
      return "next";
    case "ArrowLeft":
    case "PageUp":
    case "k":
    case "p":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "b":
      return "bookmarks";
    case "t":
      return "settings";
    case "+":
    case "=":
      return "bigger";
    case "-":
      return "smaller";
    default:
      return null;
  }
}

/**
 * Arrow keys the chat underneath also listens for on window (swipe with Left and Right,
 * which can regenerate the last reply; edit the last message with Up). While the reader is
 * open they must not reach those listeners, even when the reader itself ignores them.
 */
export function readerKeyIsIsolated(event: { key: string; targetIsField?: boolean }): boolean {
  if (event.targetIsField) return false;
  return (
    event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown"
  );
}
