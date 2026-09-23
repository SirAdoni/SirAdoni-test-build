// ──────────────────────────────────────────────
// Routes: Game tools (dice log, campaign codex, campaign log)
//
// Small read-mostly helpers for Game Mode that sit beside the main game routes:
// the dice roll history, the campaign codex export and the campaign log reader.
// Writes here are limited to appending dice log rows; campaign memory and
// messages are only ever read.
// ──────────────────────────────────────────────
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { z } from "zod";
import { createGameDiceRollsStorage, recordGameDiceRollsSafely } from "../services/storage/game-dice-rolls.storage.js";
import { diceResultLogEntry, skillCheckLogEntry, summarizeDiceRolls } from "../services/game/dice-roll-log.js";
import {
  campaignCodexFileBase,
  loadCampaignCodex,
  renderCampaignCodexMarkdown,
} from "../services/game/campaign-codex.js";
import { loadCampaignLog } from "../services/game/campaign-log.js";
import type { DiceRollResult, SkillCheckResult } from "@marinara-engine/shared";

const gzipAsync = promisify(gzip);
/** Log and codex responses past this size are gzipped when the client accepts it; prose shrinks several times over. */
const GZIP_MIN_BYTES = 64 * 1024;

/** Send a text body, gzipped when it is large and the client accepts gzip. */
async function sendText(req: FastifyRequest, reply: FastifyReply, body: string) {
  reply.header("Vary", "Accept-Encoding");
  if (body.length < GZIP_MIN_BYTES || !/\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""))) {
    return reply.send(body);
  }
  return reply.header("Content-Encoding", "gzip").send(await gzipAsync(body));
}

const DEFAULT_RECENT = 60;
const MAX_RECENT = 500;

const diceLogQuerySchema = z.object({
  chatId: z.string().min(1),
  scope: z.enum(["session", "game"]).default("session"),
  limit: z.coerce.number().int().min(1).max(MAX_RECENT).default(DEFAULT_RECENT),
});

const rollNumbers = z.array(z.number().finite()).min(1).max(1000);

const diceLogWriteSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("player"),
    chatId: z.string().min(1),
    context: z.string().max(500).optional(),
    result: z.object({
      notation: z.string().min(1).max(100),
      rolls: rollNumbers,
      modifier: z.number().finite().default(0),
      total: z.number().finite(),
    }),
  }),
  z.object({
    source: z.literal("skill_check"),
    chatId: z.string().min(1),
    messageId: z.string().min(1).max(200).optional(),
    result: z
      .object({
        skill: z.string().max(200),
        dc: z.number().finite(),
        rolls: rollNumbers,
        modifier: z.number().finite().default(0),
        total: z.number().finite(),
        criticalSuccess: z.boolean().default(false),
        criticalFailure: z.boolean().default(false),
        dice: z.string().max(100).optional(),
        who: z.string().max(200).optional(),
      })
      .passthrough(),
  }),
]);

const codexQuerySchema = z.object({
  format: z.enum(["md", "json"]).default("md"),
});

function attachmentHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function gameToolsRoutes(app: FastifyInstance) {
  const diceRolls = createGameDiceRollsStorage(app.db);

  // ── GET /dice-log ── recent rolls and stats for one session or the whole game
  app.get("/dice-log", async (req, reply) => {
    const query = diceLogQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return reply.status(400).send({ error: "Invalid dice log query" });
    const { chatId, scope, limit } = query.data;
    const gameId = await diceRolls.gameIdForChat(chatId);
    if (gameId === null) return reply.status(404).send({ error: "Chat not found" });
    const records = await diceRolls.list(scope === "game" ? { gameId } : { chatId });
    return {
      scope,
      gameId,
      total: records.length,
      stats: summarizeDiceRolls(records),
      recent: records.slice(0, limit),
    };
  });

  // ── POST /dice-log ── a roll the client made through /game/dice/roll or /game/skill-check
  app.post("/dice-log", async (req, reply) => {
    const body = diceLogWriteSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid dice log entry" });
    const input = body.data;
    const entry =
      input.source === "player"
        ? diceResultLogEntry(input.result as DiceRollResult, "player", input.context)
        : skillCheckLogEntry(input.result as unknown as SkillCheckResult);
    const recorded = await recordGameDiceRollsSafely(app.db, input.chatId, [entry], {
      messageId: input.source === "skill_check" ? (input.messageId ?? null) : null,
    });
    return { recorded };
  });

  // ── GET /log/:chatId ── every readable turn of the campaign, session by session
  app.get<{ Params: { chatId: string } }>("/log/:chatId", async (req, reply) => {
    const log = await loadCampaignLog(app.db, req.params.chatId);
    if (!log) return reply.status(404).send({ error: "Game chat not found" });
    reply.header("Content-Type", "application/json; charset=utf-8");
    return sendText(req, reply, JSON.stringify(log));
  });

  // ── GET /codex/:chatId ── the game's campaign memory as a Markdown or JSON download
  app.get<{ Params: { chatId: string } }>("/codex/:chatId", async (req, reply) => {
    const query = codexQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return reply.status(400).send({ error: "Invalid codex format" });
    const codex = await loadCampaignCodex(app.db, req.params.chatId);
    if (!codex) return reply.status(404).send({ error: "Chat not found" });
    const base = campaignCodexFileBase(codex.gameName);
    if (query.data.format === "json") {
      reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Content-Disposition", attachmentHeader(`${base}.json`));
      return sendText(req, reply, JSON.stringify(codex, null, 2));
    }
    reply
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", attachmentHeader(`${base}.md`));
    return sendText(req, reply, renderCampaignCodexMarkdown(codex));
  });
}
