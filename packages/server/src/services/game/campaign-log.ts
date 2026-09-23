// ──────────────────────────────────────────────
// Game: campaign log
//
// Every readable turn of a campaign, session by session, for the campaign log
// reader. A Game session shows one narration beat at a time, so rereading a long
// campaign needs the whole line in one place. The payload stays compact: only
// what the reader renders (role, text, time, the message number the chat uses
// for /goto) plus each session's segment edits and deletions, so the client
// shows the story the way the game shows it.
//
// The session list is the codex's: the canonical line, or the branch the log was
// opened from standing in for the chain it forked from. Read-only.
// ──────────────────────────────────────────────
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { messages, personas } from "../../db/schema/index.js";
import { isReaderVisibleMessage } from "../chat-insights/chat-insights.service.js";
import { resolveCampaignSessionChats } from "./campaign-codex.js";

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
  /** Session number as the game counts it; falls back to the position in the list. */
  number: number;
  name: string;
  /** The player's persona name in that session, when one is set. */
  playerName: string | null;
  /** Segment edits keyed `<messageId>:<segmentIndex>`, as stored in chat metadata. */
  segmentEdits: Record<string, unknown>;
  /** Deleted segments, `<messageId>:<segmentIndex>`. */
  segmentDeletes: string[];
  messages: CampaignLogMessage[];
  /** The session's turns were left out to keep the response within CAMPAIGN_LOG_MAX_CHARS. */
  omitted?: boolean;
}

export interface CampaignLog {
  gameId: string;
  gameName: string;
  /** The chat the log was opened from. */
  chatId: string;
  sessions: CampaignLogSession[];
}

/**
 * Text budget of one log response. A campaign past it drops its oldest sessions' turns
 * (never the session the log was opened from) and marks them omitted, so one request can
 * not grow without bound.
 */
export const CAMPAIGN_LOG_MAX_CHARS = 12_000_000;

const SYNTHETIC_GAME_START_RE = /^\s*\[start(?:\s+the)?\s+game\]\s*$/i;
const LOG_ROLES = new Set(["user", "assistant", "system", "narrator"]);

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Segment edits and deletions a session's metadata carries (`segmentEdit:<id>:<n>`, `segmentDelete:<id>:<n>`). */
export function readSegmentOverrides(metadata: unknown): Pick<CampaignLogSession, "segmentEdits" | "segmentDeletes"> {
  const segmentEdits: Record<string, unknown> = {};
  const segmentDeletes: string[] = [];
  for (const [key, value] of Object.entries(parseRecord(metadata))) {
    if (key.startsWith("segmentEdit:")) {
      if (value !== null && value !== undefined) segmentEdits[key.slice("segmentEdit:".length)] = value;
    } else if (key.startsWith("segmentDelete:") && (value === true || value === "true")) {
      segmentDeletes.push(key.slice("segmentDelete:".length));
    }
  }
  return { segmentEdits, segmentDeletes };
}

/** Whether a stored message is a turn the player can read in the game. */
export function isCampaignLogMessage(row: { role: unknown; content?: unknown; extra?: unknown }): boolean {
  if (!LOG_ROLES.has(row.role as string)) return false;
  if (!isReaderVisibleMessage(row)) return false;
  return !(row.role === "user" && SYNTHETIC_GAME_START_RE.test(String(row.content ?? "")));
}

/** Empty the oldest sessions, never `keepChatId`, until the turns fit in `maxChars`. */
export function capCampaignLogSessions(sessions: CampaignLogSession[], keepChatId: string, maxChars: number): void {
  const size = (session: CampaignLogSession) =>
    session.messages.reduce((sum, message) => sum + message.content.length, 0);
  let total = sessions.reduce((sum, session) => sum + size(session), 0);
  for (const session of sessions) {
    if (total <= maxChars) return;
    if (session.chatId === keepChatId || session.messages.length === 0) continue;
    total -= size(session);
    session.messages = [];
    session.omitted = true;
  }
}

/** Read every readable turn of the chat's campaign. Null for an unknown chat or one that is not a game. */
export async function loadCampaignLog(
  db: DB,
  chatId: string,
  maxChars = CAMPAIGN_LOG_MAX_CHARS,
): Promise<CampaignLog | null> {
  const resolved = await resolveCampaignSessionChats(db, chatId);
  if (!resolved || resolved.chat.mode !== "game") return null;
  const personaNames = new Map<string, string | null>();
  const personaName = async (id: string | null | undefined) => {
    if (!id) return null;
    if (!personaNames.has(id)) {
      const row = (await db.select().from(personas).where(eq(personas.id, id)))[0] as { name?: unknown } | undefined;
      personaNames.set(id, typeof row?.name === "string" && row.name.trim() ? row.name.trim() : null);
    }
    return personaNames.get(id) ?? null;
  };

  const sessions: CampaignLogSession[] = [];
  for (const [index, row] of resolved.sessions.entries()) {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.chatId, row.id))
      .orderBy(messages.createdAt, messages.id);
    const readable: CampaignLogMessage[] = [];
    rows.forEach((message, position) => {
      if (!isCampaignLogMessage(message)) return;
      readable.push({
        id: message.id,
        number: position + 1,
        role: message.role as CampaignLogMessage["role"],
        content: message.content,
        createdAt: message.createdAt,
      });
    });
    sessions.push({
      chatId: row.id,
      number: resolved.sessionNumber(row) ?? index + 1,
      name: typeof row.name === "string" ? row.name.trim() : "",
      playerName: await personaName(row.personaId),
      ...readSegmentOverrides(row.metadata),
      messages: readable,
    });
  }
  capCampaignLogSessions(sessions, chatId, maxChars);
  return { gameId: resolved.gameId, gameName: resolved.gameName, chatId, sessions };
}
