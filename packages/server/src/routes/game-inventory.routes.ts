// One route for every change the player makes to Game Mode's inventory. The screen sends
// operations; the server applies them to the stacks as saved and writes the stacks, the detailed
// inventory and the journal together, then answers with what the inventory now is.
import type { FastifyInstance } from "fastify";
import { applyGameInventoryOps, gameInventoryOpsRequestSchema } from "@marinara-engine/shared";
import { commitGameInventoryChange, loadGameInventoryItemBook } from "../services/game/game-inventory.service.js";

export async function gameInventoryRoutes(app: FastifyInstance) {
  app.post("/", async (req, reply) => {
    const parsed = gameInventoryOpsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid inventory change", issues: parsed.error.issues.slice(0, 10) });
    }
    const { chatId, ops } = parsed.data;
    // The ruleset's items, read before the change so no catalog is read with the chat's queue held.
    const rules = await loadGameInventoryItemBook(app.db, { chatId }, "player");
    const committed = await commitGameInventoryChange(app.db, chatId, (stacks) => {
      const outcome = applyGameInventoryOps(stacks, ops, undefined, rules);
      return { stacks: outcome.stacks, journal: outcome.journal, value: outcome.results };
    });
    if (!committed) return reply.status(404).send({ error: "Chat not found" });
    return {
      inventory: committed.stacks,
      results: committed.value,
      ...(committed.playerStats ? { playerStats: committed.playerStats } : {}),
    };
  });
}
