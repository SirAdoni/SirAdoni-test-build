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
  daysInMonth,
  readGameClock,
  sanitizeGameCalendarDate,
  sanitizeGameCalendarState,
  setClockToCalendarDate,
  type GameCalendarState,
  type GameClockTime,
} from "@marinara-engine/shared";
import { createChatsStorage, withChatMetadataPatchQueue } from "../services/storage/chats.storage.js";
import { createGameStateStorage } from "../services/storage/game-state.storage.js";
import { createInitialTime, formatGameTime } from "../services/game/time.service.js";
import { parseGameStateRow } from "./generate/generate-route-utils.js";
import {
  rejectCampaignSurfaceWhenDisabled,
  requireCampaignSurface,
  sendCampaignSurfaceDisabled,
} from "../services/features/campaign-surface-opt-in.js";

const CALENDAR_BODY_LIMIT = 1024 * 1024;

const saveSchema = z.object({
  calendar: z
    .object({
      enabled: z.boolean(),
      config: z.object({}).passthrough(),
      events: z.array(z.unknown()),
    })
    .passthrough(),
});
const advanceSchema = z.object({
  days: z
    .number()
    .int()
    .min(-GAME_CALENDAR_LIMITS.advanceDays)
    .max(GAME_CALENDAR_LIMITS.advanceDays)
    .refine((days) => days !== 0),
});
const dateSchema = z.object({
  date: z.object({
    year: z.number().int().min(-GAME_CALENDAR_LIMITS.year).max(GAME_CALENDAR_LIMITS.year),
    month: z
      .number()
      .int()
      .min(0)
      .max(GAME_CALENDAR_LIMITS.months - 1),
    day: z
      .number()
      .int()
      .min(1)
      .max(GAME_CALENDAR_LIMITS.monthDays * 2),
  }),
});

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
    if (rejectCampaignSurfaceWhenDisabled(reply, "gameCalendar")) return;
    const chat = await loadGameChat(req.params.chatId);
    if (!chat) return reply.status(404).send({ error: "Game chat not found" });
    return calendarView(parseMetadata(chat.metadata));
  });

  // ── PUT /:chatId ── replace the calendar definition and events; the clock is untouched
  app.put<{ Params: { chatId: string } }>("/:chatId", { bodyLimit: CALENDAR_BODY_LIMIT }, async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "gameCalendar")) return;
    const body = saveSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid calendar" });
    if (!(await loadGameChat(req.params.chatId))) return reply.status(404).send({ error: "Game chat not found" });
    const calendar = sanitizeGameCalendarState(body.data.calendar);
    const disabled = Symbol("calendar-disabled");
    const updated = await chats
      .patchMetadata(req.params.chatId, () => {
        requireCampaignSurface("gameCalendar");
        return { [GAME_CALENDAR_METADATA_KEY]: calendar };
      })
      .catch((error: unknown) => {
        if (sendCampaignSurfaceDisabled(reply, error)) return disabled;
        throw error;
      });
    if (typeof updated === "symbol") return;
    if (!updated) return reply.status(404).send({ error: "Game chat not found" });
    return calendarView(parseMetadata(updated.metadata));
  });

  // ── POST /:chatId/advance ── move the game clock by whole days (negative goes back, never before Day 1)
  app.post<{ Params: { chatId: string } }>("/:chatId/advance", async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "gameCalendar")) return;
    const body = advanceSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid number of days" });
    const chatId = req.params.chatId;
    if (!(await loadGameChat(chatId))) return reply.status(404).send({ error: "Game chat not found" });
    let clock: GameClockTime | undefined;
    const disabled = Symbol("calendar-disabled");
    const updated = await chats
      .patchMetadata(chatId, (fresh) => {
        requireCampaignSurface("gameCalendar");
        clock = advanceClockDays(readGameClock(fresh.gameTime) ?? createInitialTime(), body.data.days);
        return { gameTime: clock };
      })
      .catch((error: unknown) => {
        if (sendCampaignSurfaceDisabled(reply, error)) return disabled;
        throw error;
      });
    if (typeof updated === "symbol") return;
    if (!updated || !clock) return reply.status(404).send({ error: "Game chat not found" });
    await syncSnapshotTime(chatId, clock);
    return calendarView(parseMetadata(updated.metadata));
  });

  // ── POST /:chatId/date ── set today to a calendar date by moving the clock (or the calendar's start)
  app.post<{ Params: { chatId: string } }>("/:chatId/date", async (req, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "gameCalendar")) return;
    const body = dateSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid date" });
    const chatId = req.params.chatId;
    if (!(await loadGameChat(chatId))) return reply.status(404).send({ error: "Game chat not found" });
    const disabled = Symbol("calendar-disabled");
    const result = await withChatMetadataPatchQueue(chatId, async () => {
      const chat = await chats.getById(chatId);
      if (!chat || chat.mode !== "game") return { kind: "not-found" as const };
      requireCampaignSurface("gameCalendar");

      const fresh = parseMetadata(chat.metadata);
      const calendar: GameCalendarState = sanitizeGameCalendarState(fresh[GAME_CALENDAR_METADATA_KEY]);
      const date = body.data.date;
      if (
        date.month >= calendar.config.months.length ||
        date.day > daysInMonth(calendar.config, date.year, date.month)
      ) {
        return { kind: "invalid-date" as const };
      }
      const target = sanitizeGameCalendarDate(calendar.config, date);
      if (!target) return { kind: "invalid-date" as const };
      const moved = setClockToCalendarDate(
        calendar.config,
        readGameClock(fresh.gameTime) ?? createInitialTime(),
        target,
      );
      const updated = await chats.patchMetadata(
        chatId,
        {
          gameTime: moved.clock,
          ...(moved.config === calendar.config
            ? {}
            : { [GAME_CALENDAR_METADATA_KEY]: { ...calendar, config: moved.config } }),
        },
        { metadataQueueHeld: true },
      );
      return updated ? { kind: "updated" as const, updated, clock: moved.clock } : { kind: "not-found" as const };
    }).catch((error: unknown) => {
      if (sendCampaignSurfaceDisabled(reply, error)) return disabled;
      throw error;
    });
    if (typeof result === "symbol") return;
    if (result.kind === "not-found") return reply.status(404).send({ error: "Game chat not found" });
    if (result.kind === "invalid-date") return reply.status(400).send({ error: "Invalid date" });
    await syncSnapshotTime(chatId, result.clock);
    return calendarView(parseMetadata(result.updated.metadata));
  });
}
