// ──────────────────────────────────────────────
// Routes: Game Dice Log
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DiceRollResult, SkillCheckResult } from "@marinara-engine/shared";
import { eq } from "../db/file-query.js";
import { chats } from "../db/schema/index.js";
import { featureDisabledResponse, isFeatureEnabled } from "../services/features/feature-settings.js";
import { createGameDiceRollsStorage, recordGameDiceRollsSafely } from "../services/storage/game-dice-rolls.storage.js";
import { diceResultLogEntry, skillCheckLogEntry, summarizeDiceRolls } from "../services/game/dice-roll-log.js";

const MAX_RECENT = 500;
const querySchema = z.object({
  chatId: z.string().min(1).max(200),
  scope: z.enum(["session", "game"]).default("session"),
  limit: z.coerce.number().int().min(1).max(MAX_RECENT).default(60),
});
const rollNumbers = z.array(z.number().finite()).min(1).max(1000);
const writeSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("player"),
    chatId: z.string().min(1).max(200),
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
    chatId: z.string().min(1).max(200),
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

export async function gameToolsRoutes(app: FastifyInstance) {
  const diceRolls = createGameDiceRollsStorage(app.db);
  app.addHook("preHandler", async (_request, reply) => {
    if (!isFeatureEnabled("diceLog")) return reply.status(403).send(featureDisabledResponse("diceLog"));
  });

  async function isGameChat(chatId: string) {
    const chat = (await app.db.select().from(chats).where(eq(chats.id, chatId)))[0];
    return chat?.mode === "game";
  }

  app.get("/dice-log", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "Invalid dice log query" });
    const { chatId, scope, limit } = parsed.data;
    if (!(await isGameChat(chatId))) return reply.status(404).send({ error: "Game chat not found" });
    const gameId = await diceRolls.gameIdForChat(chatId);
    if (gameId === null) return reply.status(404).send({ error: "Chat not found" });
    const records = await diceRolls.list(scope === "game" ? { gameId } : { chatId });
    if (!isFeatureEnabled("diceLog")) return reply.status(403).send(featureDisabledResponse("diceLog"));
    return {
      scope,
      gameId,
      total: records.length,
      stats: summarizeDiceRolls(records),
      recent: records.slice(0, limit),
    };
  });

  app.post("/dice-log", async (req, reply) => {
    const parsed = writeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "Invalid dice log entry" });
    const input = parsed.data;
    if (!(await isGameChat(input.chatId))) return reply.status(404).send({ error: "Game chat not found" });
    const entry =
      input.source === "player"
        ? diceResultLogEntry(input.result as DiceRollResult, "player", input.context)
        : skillCheckLogEntry(input.result as unknown as SkillCheckResult);
    const recorded = await recordGameDiceRollsSafely(app.db, input.chatId, [entry], {
      messageId: input.source === "skill_check" ? (input.messageId ?? null) : null,
    });
    return { recorded };
  });
}
