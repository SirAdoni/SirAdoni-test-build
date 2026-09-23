// ──────────────────────────────────────────────
// Routes: Character usage (where a card is used, and which cards are unused)
//
// Read-only. The index is built from chat rows and kept for the life of the
// process; see services/characters/character-usage.ts for how it stays current.
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { eq } from "../db/file-query.js";
import { characters } from "../db/schema/index.js";
import { createCharacterUsageIndex, listUnusedCharacters } from "../services/characters/character-usage.js";

export async function characterUsageRoutes(app: FastifyInstance) {
  const index = createCharacterUsageIndex();

  // ── GET /summary ── chat and game counts per character id (ids with no use are absent)
  app.get("/summary", async () => ({ characters: await index.summary(app.db) }));

  // ── GET /unused ── library cards that no chat or game names
  app.get("/unused", async () => {
    const summary = await index.summary(app.db);
    const unused = await listUnusedCharacters(app.db, summary);
    return { total: unused.length, characters: unused };
  });

  // ── GET /:characterId ── every chat and game a character is in; ?counts=1 adds message counts
  app.get<{ Params: { characterId: string }; Querystring: { counts?: string } }>(
    "/:characterId",
    async (req, reply) => {
      const characterId = req.params.characterId;
      const exists = (await app.db.select().from(characters).where(eq(characters.id, characterId))).length > 0;
      if (!exists) return reply.status(404).send({ error: "Character not found" });
      const usage = await index.forCharacter(app.db, characterId);
      const wantCounts = req.query.counts === "1" || req.query.counts === "true";
      const counted = wantCounts ? await index.countMessages(app.db, usage.chats) : null;
      return {
        characterId,
        chats: usage.chats,
        games: usage.games,
        lastActivityAt: usage.chats[0]?.lastActivityAt ?? null,
        messageCounts: counted?.counts ?? null,
        messageCountsTruncated: counted?.truncated ?? false,
      };
    },
  );
}
