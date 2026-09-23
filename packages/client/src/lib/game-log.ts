// ──────────────────────────────────────────────
// Campaign log: display model, search and filters (DOM-free)
// ──────────────────────────────────────────────
// The campaign log rereads a whole game as a story. Narration turns are split
// with the game's own segment parser (passed in, so this module stays free of
// the Game components) and the session's segment edits and deletions are
// applied the way the Game surface applies them.
import { normalizeGameSegmentEdit, type GameSegmentEdit } from "./game-segment-edits";

export interface CampaignLogMessage {
  id: string;
  /** 1-based position among every stored message of the session chat, as /goto and search count it. */
  number: number;
  role: "user" | "assistant" | "system" | "narrator";
  content: string;
  createdAt: string;
}

export interface CampaignLogSession {
  chatId: string;
  number: number;
  name: string;
  playerName: string | null;
  segmentEdits: Record<string, unknown>;
  segmentDeletes: string[];
  messages: CampaignLogMessage[];
  /** The server left this session's turns out to keep a very long campaign's response bounded. */
  omitted?: boolean;
}

export interface CampaignLogResponse {
  gameId: string;
  gameName: string;
  chatId: string;
  sessions: CampaignLogSession[];
}

/** Where the log should open: a message by id, or by its /goto number in a session chat. */
export interface GameLogTarget {
  chatId: string;
  messageId?: string | null;
  messageNumber?: number | null;
}

/** The fields of the Game narration parser's segments the log reads. */
export interface LogSourceSegment {
  type: "narration" | "dialogue" | "readable" | "system";
  speaker?: string;
  content: string;
  sourceSegmentIndex?: number | null;
  readableType?: "note" | "book";
  readableContent?: string;
}

export type LogSegmentParser = (message: { id: string; role: CampaignLogMessage["role"]; content: string }) =>
  readonly LogSourceSegment[];

export type LogLineKind = "narration" | "dialogue" | "readable" | "system" | "player";

export interface LogLine {
  kind: LogLineKind;
  /** Dialogue speaker or the player's name; null for narration and system lines. */
  speaker: string | null;
  text: string;
  readableType?: "note" | "book";
}

export interface LogEntry {
  /** Unique across the campaign. */
  key: string;
  sessionIndex: number;
  sessionChatId: string;
  messageId: string;
  number: number;
  role: CampaignLogMessage["role"];
  createdAt: string;
  lines: LogLine[];
}

/** Speaker filter value for lines nobody speaks (narration, notes, system lines). */
export const NARRATION_SPEAKER = "\u0000narration";

const PLAYER_ADDRESS_PREFIX = /^\[(?:To the party|To the GM)]\s*/i;

/**
 * Reader text for one line: emphasis markers and inline dice tags become plain prose, so
 * search matches what is on screen.
 */
export function plainLogText(value: string): string {
  return value
    .replace(
      /\[dice:\s*((?:\d+)?d\d+(?:[+-]\d+)?)\s*=\s*(-?\d+)(?:\s*\([^\]]+\))?\]/gi,
      (_match, notation: string, total: string) => `(${notation} = ${total})`,
    )
    .replace(/(\*{1,3})(?=\S)([^*\n]*?\S)\1/g, "$2")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function normalizeSpeaker(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function applyEdit(segment: LogSourceSegment, edit: GameSegmentEdit | null): LogLine | null {
  let text: string;
  let readableType = segment.readableType;
  if (segment.type === "readable") {
    text = edit?.readableContent ?? edit?.content ?? segment.readableContent ?? segment.content;
    readableType = edit?.readableType ?? readableType;
  } else {
    text = edit?.content ?? segment.content;
  }
  text = plainLogText(text);
  if (!text) return null;
  const speaker =
    segment.type === "dialogue" ? normalizeSpeaker(edit?.speaker || segment.speaker) || null : null;
  return {
    kind: segment.type,
    speaker,
    text,
    ...(segment.type === "readable" && readableType ? { readableType } : {}),
  };
}

/** Turn the campaign into readable entries, oldest first, with edits applied and deleted segments left out. */
export function buildGameLogEntries(
  log: Pick<CampaignLogResponse, "sessions">,
  parse: LogSegmentParser,
  labels: { player: string },
): LogEntry[] {
  const entries: LogEntry[] = [];
  log.sessions.forEach((session, sessionIndex) => {
    const deletes = new Set(session.segmentDeletes);
    const player = normalizeSpeaker(session.playerName) || labels.player;
    for (const message of session.messages) {
      const lines: LogLine[] = [];
      if (message.role === "user") {
        const text = plainLogText(message.content.replace(PLAYER_ADDRESS_PREFIX, ""));
        if (text) lines.push({ kind: "player", speaker: player, text });
      } else if (message.role === "system") {
        const text = plainLogText(message.content);
        if (text) lines.push({ kind: "system", speaker: null, text });
      } else {
        let segments: readonly LogSourceSegment[];
        try {
          segments = parse(message);
        } catch {
          segments = [{ type: "narration", content: message.content }];
        }
        segments.forEach((segment, index) => {
          const sourceIndex = segment.sourceSegmentIndex ?? index;
          const key = `${message.id}:${sourceIndex}`;
          if (deletes.has(key)) return;
          const line = applyEdit(segment, normalizeGameSegmentEdit(session.segmentEdits[key]));
          if (line) lines.push(line);
        });
      }
      if (lines.length === 0) continue;
      entries.push({
        key: `${session.chatId}:${message.id}`,
        sessionIndex,
        sessionChatId: session.chatId,
        messageId: message.id,
        number: message.number,
        role: message.role,
        createdAt: message.createdAt,
        lines,
      });
    }
  });
  return entries;
}

export function lineSpeakerKey(line: LogLine): string {
  return line.speaker ? line.speaker.toLocaleLowerCase() : NARRATION_SPEAKER;
}

/** Speakers in the campaign, most lines first; narration is always offered first when present. */
export function listLogSpeakers(entries: readonly LogEntry[]): Array<{ key: string; label: string; count: number }> {
  const byKey = new Map<string, { key: string; label: string; count: number }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const key = lineSpeakerKey(line);
      const current = byKey.get(key);
      if (current) current.count += 1;
      else byKey.set(key, { key, label: line.speaker ?? "", count: 1 });
    }
  }
  const narration = byKey.get(NARRATION_SPEAKER);
  byKey.delete(NARRATION_SPEAKER);
  const named = [...byKey.values()].sort(
    (left, right) => right.count - left.count || left.label.localeCompare(right.label),
  );
  return narration ? [narration, ...named] : named;
}

export interface LogFilters {
  /** Session chat id, or null for every session. */
  sessionChatId: string | null;
  /** A key from listLogSpeakers, or null for anyone. */
  speaker: string | null;
}

/** Entries the filters keep; a speaker filter keeps only that speaker's lines. */
export function filterLogEntries(entries: readonly LogEntry[], filters: LogFilters): LogEntry[] {
  const out: LogEntry[] = [];
  for (const entry of entries) {
    if (filters.sessionChatId && entry.sessionChatId !== filters.sessionChatId) continue;
    if (!filters.speaker) {
      out.push(entry);
      continue;
    }
    const lines = entry.lines.filter((line) => lineSpeakerKey(line) === filters.speaker);
    if (lines.length > 0) out.push(lines.length === entry.lines.length ? entry : { ...entry, lines });
  }
  return out;
}

export interface LogHit {
  entryIndex: number;
  lineIndex: number;
  start: number;
  end: number;
}

export const LOG_SEARCH_MIN_CHARS = 2;
export const LOG_SEARCH_MAX_HITS = 5_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive plain-text hits in reading order, capped at LOG_SEARCH_MAX_HITS. */
export function findLogHits(entries: readonly LogEntry[], query: string): { hits: LogHit[]; capped: boolean } {
  const needle = query.trim();
  if (needle.length < LOG_SEARCH_MIN_CHARS) return { hits: [], capped: false };
  const pattern = new RegExp(escapeRegExp(needle).replace(/\s+/g, "\\s+"), "giu");
  const hits: LogHit[] = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const lines = entries[entryIndex]!.lines;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const text = lines[lineIndex]!.text;
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        if (match[0].length === 0) {
          pattern.lastIndex += 1;
          continue;
        }
        hits.push({ entryIndex, lineIndex, start: match.index, end: match.index + match[0].length });
        if (hits.length >= LOG_SEARCH_MAX_HITS) return { hits, capped: true };
      }
    }
  }
  return { hits, capped: false };
}

/** Split a line into plain and highlighted parts; `current` marks the range that is the active hit. */
export function splitLogHighlights(
  text: string,
  ranges: ReadonlyArray<{ start: number; end: number; current?: boolean }>,
): Array<{ text: string; highlighted: boolean; current: boolean }> {
  const parts: Array<{ text: string; highlighted: boolean; current: boolean }> = [];
  let cursor = 0;
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const start = Math.max(range.start, cursor);
    const end = Math.min(range.end, text.length);
    if (end <= start) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), highlighted: false, current: false });
    parts.push({ text: text.slice(start, end), highlighted: true, current: range.current === true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false, current: false });
  return parts;
}

/** Index of the entry a target points at; a hidden message falls back to the next readable turn of its session. */
export function findLogTarget(
  entries: readonly LogEntry[],
  target: GameLogTarget,
): { index: number; exact: boolean } | null {
  if (target.messageId) {
    const index = entries.findIndex((entry) => entry.messageId === target.messageId);
    if (index >= 0) return { index, exact: true };
  }
  const number = target.messageNumber;
  if (number != null && number > 0) {
    let fallback = -1;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.sessionChatId !== target.chatId) continue;
      if (entry.number === number) return { index, exact: true };
      if (entry.number > number) return { index, exact: false };
      fallback = index;
    }
    if (fallback >= 0) return { index: fallback, exact: false };
  }
  return null;
}

export const LOG_WINDOW_SIZE = 60;

/** The slice of entries to render: `size` entries with `index` in view, clamped to the list. */
export function logWindowAround(index: number, total: number, size = LOG_WINDOW_SIZE): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  const clamped = Math.min(Math.max(index, 0), total - 1);
  const start = Math.max(0, Math.min(clamped - Math.floor(size / 3), total - size));
  return { start, end: Math.min(total, start + size) };
}

/** Most entries rendered at once; paging further drops turns from the far end. */
export const LOG_MAX_RENDERED = LOG_WINDOW_SIZE * 3;

/** Grow the rendered window by one page toward `direction`, trimming the far side past `max`. */
export function extendLogWindow(
  range: { start: number; end: number },
  total: number,
  direction: "earlier" | "later",
  size = LOG_WINDOW_SIZE,
  max = LOG_MAX_RENDERED,
): { start: number; end: number } {
  if (direction === "earlier") {
    const start = Math.max(0, range.start - size);
    return { start, end: Math.min(range.end, start + max) };
  }
  const end = Math.min(total, range.end + size);
  return { start: Math.max(range.start, end - max), end };
}
