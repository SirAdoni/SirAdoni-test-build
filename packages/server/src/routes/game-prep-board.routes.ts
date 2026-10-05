// ──────────────────────────────────────────────
// Routes: GM prep board
//
// One private board per game, addressed through any of its session chats. The
// client edits the board with the shared pure helpers (prep-board.ts) and saves
// the whole board with the revision it started from; a stale save gets a 409
// and the stored board back. Nothing here, or anywhere in prompt assembly,
// sends the board to a model.
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createDefaultPrepBoard, resolveEffectiveGameId } from "@marinara-engine/shared";
import { eq } from "../db/file-query.js";
import { chats } from "../db/schema/index.js";
import { featureDisabledResponse, isFeatureEnabled } from "../services/features/feature-settings.js";
import { createGamePrepBoardsStorage } from "../services/storage/game-prep-boards.storage.js";

// 2000 items of 4000 characters is the ceiling the shared sanitizer enforces.
const BOARD_BODY_LIMIT = 16 * 1024 * 1024;

const saveSchema = z.object({
  chatId: z.string().min(1).max(200),
  revision: z.number().int().min(0),
  board: z.record(z.string(), z.unknown()),
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

export async function gamePrepBoardRoutes(app: FastifyInstance) {
  const boards = createGamePrepBoardsStorage(app.db);

  app.addHook("preHandler", async (_request, reply) => {
    if (!isFeatureEnabled("gamePrepBoard")) {
      return reply.status(403).send(featureDisabledResponse("gamePrepBoard"));
    }
  });

  /** The campaign and session of a Game Mode chat; null for any other chat. */
  async function gameFor(chatId: string | undefined) {
    if (!chatId) return null;
    const chat = (await app.db.select().from(chats).where(eq(chats.id, chatId)))[0];
    if (!chat || chat.mode !== "game") return null;
    const metadata = parseMetadata(chat.metadata);
    const session = Number(metadata.gameSessionNumber);
    return {
      gameId: resolveEffectiveGameId(metadata.gameId, chat.groupId, chat.id),
      sessionNumber: Number.isInteger(session) && session > 0 ? session : 1,
      chatName: typeof chat.name === "string" ? chat.name : "",
    };
  }

  // ── GET /?chatId= ── the game's board (an unsaved default when it has none yet)
  app.get<{ Querystring: { chatId?: string } }>("/", async (req, reply) => {
    const game = await gameFor(req.query.chatId);
    if (!game) return reply.status(400).send({ error: "The prep board needs a Game Mode chat" });
    const record = await boards.get(game.gameId);
    return {
      gameId: game.gameId,
      sessionNumber: game.sessionNumber,
      chatName: game.chatName,
      board: record?.board ?? createDefaultPrepBoard(game.sessionNumber),
      revision: record?.revision ?? 0,
      updatedAt: record?.updatedAt ?? null,
    };
  });

  // ── PUT / ── save the whole board against the revision it was edited from
  app.put("/", { bodyLimit: BOARD_BODY_LIMIT }, async (req, reply) => {
    const body = saveSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid prep board" });
    const game = await gameFor(body.data.chatId);
    if (!game) return reply.status(400).send({ error: "The prep board needs a Game Mode chat" });
    const result = await boards.save(game.gameId, body.data.board, body.data.revision, () =>
      isFeatureEnabled("gamePrepBoard"),
    );
    if ("disabled" in result) return reply.status(403).send(featureDisabledResponse("gamePrepBoard"));
    if (!result.ok) {
      return reply.status(409).send({
        error: "The prep board changed elsewhere",
        board: result.conflict?.board ?? createDefaultPrepBoard(game.sessionNumber),
        revision: result.conflict?.revision ?? 0,
      });
    }
    return { board: result.record.board, revision: result.record.revision, updatedAt: result.record.updatedAt };
  });

  // ── DELETE /?chatId= ── remove the game's board on purpose
  app.delete<{ Querystring: { chatId?: string } }>("/", async (req, reply) => {
    const game = await gameFor(req.query.chatId);
    if (!game) return reply.status(400).send({ error: "The prep board needs a Game Mode chat" });
    const deleted = await boards.remove(game.gameId, () => isFeatureEnabled("gamePrepBoard"));
    if (deleted === null) return reply.status(403).send(featureDisabledResponse("gamePrepBoard"));
    return { deleted };
  });
}
