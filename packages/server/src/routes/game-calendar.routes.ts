// ──────────────────────────────────────────────
// Routes: In-world calendar (Tools tab)
//
// The calendar's months, weekdays, era, moons and dated events live in chat
// metadata under `gameCalendar`, beside the Game Mode clock (`gameTime`). There
// is no second "today": the calendar maps the clock's day number to a date, and
// advancing or setting the date moves `gameTime.day`, the same value the Day
// editor and /game/time/advance write. Every write goes through the queued
// patchMetadata path so a concurrent metadata write is never reverted.
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  GAME_CALENDAR_LIMITS,
  GAME_CALENDAR_METADATA_KEY,
  advanceClockDays,
  applyTrackerFieldLocksToGameStatePatch,
  readGameClock,
  sanitizeGameCalendarDate,
  sanitizeGameCalendarState,
  setClockToCalendarDate,
  type GameCalendarState,
  type GameClockTime,
} from "@marinara-engine/shared";
import { createChatsStorage } from "../services/storage/chats.storage.js";
import { createGameStateStorage } from "../services/storage/game-state.storage.js";
import { createInitialTime, formatGameTime } from "../services/game/time.service.js";
import { parseGameStateRow } from "./generate/generate-route-utils.js";

const CALENDAR_BODY_LIMIT = 1024 * 1024;

const saveSchema = z.object({ calendar: z.unknown() });
const advanceSchema = z.object({
  days: z
    .number()
    .int()
    .min(-GAME_CALENDAR_LIMITS.advanceDays)
    .max(GAME_CALENDAR_LIMITS.advanceDays)
    .refine((days) => days !== 0),
});
const dateSchema = z.object({ date: z.object({ year: z.number(), month: z.number(), day: z.number() }) });

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function calendarView(metadata: Record<string, unknown>) {
  const calendar = sanitizeGameCalendarState(metadata[GAME_CALENDAR_METADATA_KEY]);
  const clock = readGameClock(metadata.gameTime);
  return { calendar, clock, formattedTime: clock ? formatGameTime(clock) : null };
}

export async function gameCalendarRoutes(app: FastifyInstance) {
  const chats = createChatsStorage(app.db);
  const gameStates = createGameStateStorage(app.db);

  const loadGameChat = async (chatId: string) => {
    const chat = await chats.getById(chatId);
    return chat && chat.mode === "game" ? chat : null;
  };

  /** Mirror a clock move into the latest game-state snapshot, as /game/time/advance does, honoring tracker locks. */
  const syncSnapshotTime = async (chatId: string, clock: GameClockTime) => {
    const latest = await gameStates.getLatest(chatId);
    if (!latest) return;
    const patch = applyTrackerFieldLocksToGameStatePatch(
      { time: formatGameTime(clock) },
      parseGameStateRow(latest as Record<string, unknown>),
    );
    if (Object.keys(patch).length > 0) await gameStates.updateLatest(chatId, patch as never);
  };

  // ── GET /:chatId ── the calendar (a default, switched off, when the game has none) and the clock
  app.get<{ Params: { chatId: string } }>("/:chatId", async (req, reply) => {
    const chat = await loadGameChat(req.params.chatId);
    if (!chat) return reply.status(404).send({ error: "Game chat not found" });
    return calendarView(parseMetadata(chat.metadata));
  });

  // ── PUT /:chatId ── replace the calendar definition and events; the clock is untouched
  app.put<{ Params: { chatId: string } }>("/:chatId", { bodyLimit: CALENDAR_BODY_LIMIT }, async (req, reply) => {
    const body = saveSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid calendar" });
    if (!(await loadGameChat(req.params.chatId))) return reply.status(404).send({ error: "Game chat not found" });
    const calendar = sanitizeGameCalendarState(body.data.calendar);
    const updated = await chats.patchMetadata(req.params.chatId, { [GAME_CALENDAR_METADATA_KEY]: calendar });
    if (!updated) return reply.status(404).send({ error: "Game chat not found" });
    return calendarView(parseMetadata(updated.metadata));
  });

  // ── POST /:chatId/advance ── move the game clock by whole days (negative goes back, never before Day 1)
  app.post<{ Params: { chatId: string } }>("/:chatId/advance", async (req, reply) => {
    const body = advanceSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid number of days" });
    const chatId = req.params.chatId;
    if (!(await loadGameChat(chatId))) return reply.status(404).send({ error: "Game chat not found" });
    let clock: GameClockTime | undefined;
    const updated = await chats.patchMetadata(chatId, (fresh) => {
      clock = advanceClockDays(readGameClock(fresh.gameTime) ?? createInitialTime(), body.data.days);
      return { gameTime: clock };
    });
    if (!updated || !clock) return reply.status(404).send({ error: "Game chat not found" });
    await syncSnapshotTime(chatId, clock);
    return calendarView(parseMetadata(updated.metadata));
  });

  // ── POST /:chatId/date ── set today to a calendar date by moving the clock (or the calendar's start)
  app.post<{ Params: { chatId: string } }>("/:chatId/date", async (req, reply) => {
    const body = dateSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid date" });
    const chatId = req.params.chatId;
    if (!(await loadGameChat(chatId))) return reply.status(404).send({ error: "Game chat not found" });
    let clock: GameClockTime | undefined;
    const updated = await chats.patchMetadata(chatId, (fresh) => {
      const calendar: GameCalendarState = sanitizeGameCalendarState(fresh[GAME_CALENDAR_METADATA_KEY]);
      const target = sanitizeGameCalendarDate(calendar.config, body.data.date);
      if (!target) return {};
      const moved = setClockToCalendarDate(
        calendar.config,
        readGameClock(fresh.gameTime) ?? createInitialTime(),
        target,
      );
      clock = moved.clock;
      return {
        gameTime: moved.clock,
        ...(moved.config === calendar.config
          ? {}
          : { [GAME_CALENDAR_METADATA_KEY]: { ...calendar, config: moved.config } }),
      };
    });
    if (!updated) return reply.status(404).send({ error: "Game chat not found" });
    if (clock) await syncSnapshotTime(chatId, clock);
    return calendarView(parseMetadata(updated.metadata));
  });
}
