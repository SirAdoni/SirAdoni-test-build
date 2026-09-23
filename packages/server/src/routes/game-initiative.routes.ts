// ──────────────────────────────────────────────
// Routes: Initiative and encounter tracker
//
// Saved encounters for the Tools tab's initiative tracker, one list per game,
// and the initiative roll itself. Rolls happen here so each roll and its
// dice-log row come from the same throw; the turn-order rules live in the pure
// shared module (initiative-tracker.ts) and run on the client. Nothing here
// writes to a chat.
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MAX_INITIATIVE_COMBATANTS,
  clampParsedDiceToLimits,
  normalizeInitiativeDice,
  parseDiceNotation,
  resolveEffectiveGameId,
  rollParsedDice,
} from "@marinara-engine/shared";
import { eq } from "../db/file-query.js";
import { chats } from "../db/schema/index.js";
import {
  MAX_INITIATIVE_ENCOUNTERS,
  createInitiativeEncountersStorage,
} from "../services/storage/game-initiative-encounters.storage.js";
import { recordGameDiceRollsSafely } from "../services/storage/game-dice-rolls.storage.js";
import type { DiceRollLogEntry } from "../services/game/dice-roll-log.js";

const ENCOUNTER_BODY_LIMIT = 1024 * 1024;

const nameField = z.string().min(1).max(200);

const createSchema = z.object({ chatId: z.string().min(1).max(200), name: nameField, state: z.unknown() });
const updateSchema = z.object({ name: nameField.optional(), state: z.unknown().optional() });
const rollSchema = z.object({
  chatId: z.string().min(1).max(200),
  combatants: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().max(200).default(""),
        dice: z.string().max(40).default(""),
      }),
    )
    .min(1)
    .max(MAX_INITIATIVE_COMBATANTS),
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

/** `maxEncounters` is the per-game cap; only tests pass a smaller one. */
export async function gameInitiativeRoutes(app: FastifyInstance, options: { maxEncounters?: number } = {}) {
  const maxEncounters = options.maxEncounters ?? MAX_INITIATIVE_ENCOUNTERS;
  const encounters = createInitiativeEncountersStorage(app.db);

  /** The campaign a Game Mode chat belongs to; null for any other chat or none. */
  async function gameIdFor(chatId: string | undefined): Promise<string | null> {
    if (!chatId) return null;
    const chat = (await app.db.select().from(chats).where(eq(chats.id, chatId)))[0];
    if (!chat || chat.mode !== "game") return null;
    return resolveEffectiveGameId(parseMetadata(chat.metadata).gameId, chat.groupId, chat.id);
  }

  // ── GET / ── the saved encounters of a game chat's campaign
  app.get<{ Querystring: { chatId?: string } }>("/", async (req, reply) => {
    const gameId = await gameIdFor(req.query.chatId);
    if (gameId === null) return reply.status(400).send({ error: "Encounters need a Game Mode chat" });
    return { gameId, encounters: await encounters.listForGame(gameId) };
  });

  // ── POST / ── save a new encounter
  app.post("/", { bodyLimit: ENCOUNTER_BODY_LIMIT }, async (req, reply) => {
    const body = createSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid encounter" });
    const gameId = await gameIdFor(body.data.chatId);
    if (gameId === null) return reply.status(400).send({ error: "Encounters need a Game Mode chat" });
    if ((await encounters.countForGame(gameId)) >= maxEncounters) {
      return reply.status(409).send({ error: "Too many encounters" });
    }
    const created = await encounters.create(gameId, body.data.name, body.data.state);
    if (!created) return reply.status(400).send({ error: "Invalid encounter" });
    return created;
  });

  // ── PUT /:id ── replace an encounter's state and optionally rename it
  app.put<{ Params: { id: string } }>("/:id", { bodyLimit: ENCOUNTER_BODY_LIMIT }, async (req, reply) => {
    const body = updateSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid encounter" });
    const updated = await encounters.update(req.params.id, body.data);
    if (!updated) return reply.status(404).send({ error: "Encounter not found" });
    return updated;
  });

  // ── DELETE /:id ──
  app.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    if (!(await encounters.remove(req.params.id))) return reply.status(404).send({ error: "Encounter not found" });
    return { deleted: true };
  });

  // ── POST /roll ── roll initiative for some combatants and log each roll to the game's dice log
  app.post("/roll", async (req, reply) => {
    const body = rollSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid initiative roll" });
    const results: Array<{ id: string; notation: string; rolls: number[]; modifier: number; total: number }> = [];
    const entries: DiceRollLogEntry[] = [];
    for (const combatant of body.data.combatants) {
      const dice = normalizeInitiativeDice(combatant.dice);
      const parsed = dice ? parseDiceNotation(dice) : null;
      if (!parsed) return reply.status(400).send({ error: `Invalid initiative dice: ${combatant.dice}` });
      const roll = rollParsedDice(clampParsedDiceToLimits(parsed));
      results.push({ id: combatant.id, ...roll });
      const single20 = parsed.sides === 20 && roll.rolls.length === 1;
      entries.push({
        source: "initiative",
        actor: combatant.name.replace(/\s+/g, " ").trim() || null,
        label: "Initiative",
        notation: roll.notation,
        rolls: roll.rolls,
        modifier: roll.modifier,
        total: roll.total,
        critical: single20 && roll.rolls[0] === 20,
        fumble: single20 && roll.rolls[0] === 1,
      });
    }
    const logged =
      (await gameIdFor(body.data.chatId)) === null
        ? 0
        : await recordGameDiceRollsSafely(app.db, body.data.chatId, entries);
    const totals = Object.fromEntries(results.map((result) => [result.id, result.total]));
    return { results, totals, logged };
  });
}
