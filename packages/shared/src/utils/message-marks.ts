// ──────────────────────────────────────────────
// Per-message user marks: bookmarks, context pins, private notes and chapters
// ──────────────────────────────────────────────
// All of them live in the message's `extra` JSON (message-level, mirrored to every swipe).
// Bookmarks, notes and chapters are reader-only: they never enter prompts. Pins only change
// which history rows survive the chat's context message limit.

/** Most messages one chat may pin into its prompt context. */
export const MAX_PINNED_CONTEXT_MESSAGES = 10;
export const MAX_BOOKMARK_LABEL_LENGTH = 80;
export const MAX_PRIVATE_NOTE_LENGTH = 2000;
export const MAX_CHAPTER_TITLE_LENGTH = 120;
export const MAX_CHAPTER_SUMMARY_LENGTH = 600;
/** Trashed messages older than this are purged automatically. */
export const MESSAGE_TRASH_RETENTION_DAYS = 30;
/** Line prefixed to a pinned message that was restored from outside the context message limit. */
export const PINNED_CONTEXT_MESSAGE_MARKER = "[Pinned message from earlier in the chat]";

export interface MessageBookmark {
  /** Optional short user label shown in the Bookmarks list. */
  label?: string | null;
  createdAt: string;
}

/** A chapter that starts at this message. Title and summary are written by the user, never generated. */
export interface MessageChapter {
  title: string;
  /** Optional short summary shown in the chapter list and exports. */
  summary?: string | null;
  createdAt: string;
}

/** Extra keys that belong to the whole message, not one swipe. */
export const MESSAGE_MARK_EXTRA_KEYS = ["bookmark", "pinnedToContext", "privateNote", "chapter"] as const;

function readExtraRecord(extra: unknown): Record<string, unknown> {
  if (!extra) return {};
  if (typeof extra === "string") {
    try {
      const parsed: unknown = JSON.parse(extra);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof extra === "object" && !Array.isArray(extra) ? (extra as Record<string, unknown>) : {};
}

export function readMessageBookmark(extra: unknown): MessageBookmark | null {
  const value = readExtraRecord(extra).bookmark;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : null;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
  return { label, createdAt };
}

export function isMessagePinnedToContext(extra: unknown): boolean {
  return readExtraRecord(extra).pinnedToContext === true;
}

export function readMessagePrivateNote(extra: unknown): string | null {
  const value = readExtraRecord(extra).privateNote;
  return typeof value === "string" && value.trim() ? value : null;
}

export function readMessageChapter(extra: unknown): MessageChapter | null {
  const value = readExtraRecord(extra).chapter;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) return null;
  const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : null;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
  return { title, summary, createdAt };
}

/** One chapter of a transcript: where it starts (1-based message number, as /goto counts) and its text. */
export interface ChapterListEntry<T> {
  message: T;
  /** 1-based position of the message in the list it was read from. */
  messageNumber: number;
  chapter: MessageChapter;
}

/** A chapter as the chapters endpoint lists it. */
export interface ChatChapterSummary {
  messageId: string;
  /** 1-based position among every stored message of the chat, as /goto and search count it. */
  messageNumber: number;
  title: string;
  summary: string | null;
}

/** Chapters of a transcript in reading order. */
export function listMessageChapters<T extends { extra?: unknown }>(messages: readonly T[]): ChapterListEntry<T>[] {
  const out: ChapterListEntry<T>[] = [];
  messages.forEach((message, index) => {
    const chapter = readMessageChapter(message.extra);
    if (chapter) out.push({ message, messageNumber: index + 1, chapter });
  });
  return out;
}

/**
 * Validate a client patch for the mark keys. Returns the normalized patch, or an
 * error string. Keys other than the mark keys pass through untouched.
 */
export function normalizeMessageMarkPatch(
  partial: Record<string, unknown>,
  now: () => string = () => new Date().toISOString(),
): { patch: Record<string, unknown> } | { error: string } {
  const patch = { ...partial };
  if (Object.prototype.hasOwnProperty.call(patch, "bookmark")) {
    const value = patch.bookmark;
    if (value === null || value === false) {
      patch.bookmark = null;
    } else if (value === true || (value && typeof value === "object" && !Array.isArray(value))) {
      const record = value === true ? {} : (value as Record<string, unknown>);
      if (record.label !== undefined && record.label !== null && typeof record.label !== "string")
        return { error: "bookmark.label must be a string" };
      const label = typeof record.label === "string" ? record.label.trim().slice(0, MAX_BOOKMARK_LABEL_LENGTH) : "";
      patch.bookmark = {
        label: label || null,
        createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : now(),
      } satisfies MessageBookmark;
    } else {
      return { error: "bookmark must be an object or null" };
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "pinnedToContext")) {
    if (typeof patch.pinnedToContext !== "boolean") return { error: "pinnedToContext must be a boolean" };
  }
  if (Object.prototype.hasOwnProperty.call(patch, "privateNote")) {
    const value = patch.privateNote;
    if (value !== null && typeof value !== "string") return { error: "privateNote must be a string or null" };
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length > MAX_PRIVATE_NOTE_LENGTH)
      return { error: `privateNote must be at most ${MAX_PRIVATE_NOTE_LENGTH} characters` };
    patch.privateNote = trimmed || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "chapter")) {
    const value = patch.chapter;
    if (value === null || value === false) {
      patch.chapter = null;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.title !== "string" || !record.title.trim()) return { error: "chapter.title is required" };
      if (record.summary !== undefined && record.summary !== null && typeof record.summary !== "string")
        return { error: "chapter.summary must be a string" };
      const summary = typeof record.summary === "string" ? record.summary.trim() : "";
      if (summary.length > MAX_CHAPTER_SUMMARY_LENGTH)
        return { error: `chapter.summary must be at most ${MAX_CHAPTER_SUMMARY_LENGTH} characters` };
      patch.chapter = {
        title: record.title.trim().replace(/\s+/gu, " ").slice(0, MAX_CHAPTER_TITLE_LENGTH),
        summary: summary || null,
        createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : now(),
      } satisfies MessageChapter;
    } else {
      return { error: "chapter must be an object or null" };
    }
  }
  return { patch };
}

/** Remove the private note from an extra record (exports, copies shared with others). */
export function stripPrivateMessageNote<T extends Record<string, unknown>>(extra: T): T {
  if (!Object.prototype.hasOwnProperty.call(extra, "privateNote")) return extra;
  const { privateNote: _privateNote, ...rest } = extra;
  return rest as T;
}

/**
 * Apply a chat's context message limit while keeping pinned messages.
 *
 * Returns the last `limit` messages, preceded by up to `maxPinned` of the newest pinned
 * messages that the limit would have dropped. Those restored rows are shallow copies with
 * {@link PINNED_CONTEXT_MESSAGE_MARKER} prefixed to their content so the model can tell the
 * history skips ahead after them; everything else is returned by reference. Chronological
 * order is preserved because every restored row predates the kept window.
 */
export function applyContextMessageLimitWithPins<T extends { content?: unknown; extra?: unknown }>(
  messages: readonly T[],
  limit: number | null | undefined,
  maxPinned = MAX_PINNED_CONTEXT_MESSAGES,
): T[] {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return [...messages];
  const normalizedLimit = Math.floor(limit);
  if (normalizedLimit <= 0 || messages.length <= normalizedLimit) return [...messages];
  const cut = messages.length - normalizedLimit;
  const kept = messages.slice(cut);
  if (maxPinned <= 0) return kept;
  const pinned = messages
    .slice(0, cut)
    .filter((message) => isMessagePinnedToContext(message.extra))
    .slice(-maxPinned)
    .map((message) => ({
      ...message,
      content: `${PINNED_CONTEXT_MESSAGE_MARKER}\n${typeof message.content === "string" ? message.content : ""}`,
    }));
  return [...pinned, ...kept];
}

/** A message moved to its chat's trash (list view; the stored snapshot stays server-side). */
export interface MessageTrashEntry {
  id: string;
  chatId: string;
  messageId: string;
  role: "user" | "assistant" | "system" | "narrator";
  characterId: string | null;
  /** Active swipe content at deletion time. */
  content: string;
  swipeCount: number;
  messageCreatedAt: string;
  deletedAt: string;
  /** When the automatic purge removes this entry. */
  expiresAt: string;
}
