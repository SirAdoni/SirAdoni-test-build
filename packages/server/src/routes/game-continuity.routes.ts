import type { FastifyPluginAsync } from "fastify";
import { createChatsStorage } from "../services/storage/chats.storage.js";
import { readGameContinuityState } from "../services/game/continuity-state.js";
import { rejectCampaignFeatureWhenDisabled, requireCampaignOptIn } from "../services/features/campaign-opt-in.js";
import { continuityOwnershipSchema, readContinuityOwnership } from "../services/game/continuity-ownership.js";

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const gameContinuityRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (_request, reply) => {
    if (rejectCampaignFeatureWhenDisabled(reply, "gameContinuity")) return reply;
  });
  app.patch<{ Params: { chatId: string }; Body: { ownership?: unknown } }>(
    "/:chatId/continuity",
    async (req, reply) => {
      const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      if (Object.keys(body).length !== 1 || !("ownership" in body)) {
        return reply.status(400).send({ error: "Invalid continuity ownership update" });
      }
      if (rejectCampaignFeatureWhenDisabled(reply, "gameMemoryControls")) return reply;
      const parsed =
        body.ownership === null
          ? { success: true as const, data: null }
          : continuityOwnershipSchema.safeParse(body.ownership);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid continuity ownership update" });
      const chats = createChatsStorage(app.db);
      const chat = await chats.getById(req.params.chatId);
      if (!chat) return reply.status(404).send({ error: "Chat not found" });
      if (chat.mode !== "game") return reply.status(400).send({ error: "Continuity settings require a game chat" });
      const metadata = objectValue(chat.metadata);
      const continuity = objectValue(metadata.gameContinuity);
      await chats.patchMetadata(
        req.params.chatId,
        {
          gameContinuity: { ...continuity, ownership: parsed.data },
        },
        {
          assertWritable: () => {
            requireCampaignOptIn("gameContinuity");
            requireCampaignOptIn("gameMemoryControls");
          },
        },
      );
      return { ownership: parsed.data };
    },
  );

  app.get<{ Params: { chatId: string } }>("/:chatId/continuity", async (req, reply) => {
    const chat = await createChatsStorage(app.db).getById(req.params.chatId);
    if (!chat) return reply.status(404).send({ error: "Chat not found" });
    const state = await readGameContinuityState(app.db, req.params.chatId);
    const batches = state.receipts.map(({ receipt, sourceCurrent }) => ({
      ...receipt,
      status: receipt.status === "published" && !sourceCurrent ? "stale" : receipt.status,
      sourceCurrent,
    }));
    const counts: Record<string, number> = {};
    for (const batch of batches) counts[batch.status] = (counts[batch.status] ?? 0) + 1;
    const metadata = objectValue(chat.metadata);
    const continuity = objectValue(metadata.gameContinuity);
    return {
      config: {
        mode: continuity.mode === "active" || continuity.mode === "shadow" ? continuity.mode : "off",
        ownership: readContinuityOwnership({ ownership: continuity.ownership }),
        ...(typeof continuity.extractorConnectionId === "string"
          ? { extractorConnectionId: continuity.extractorConnectionId }
          : {}),
        ...(typeof continuity.verifierConnectionId === "string"
          ? { verifierConnectionId: continuity.verifierConnectionId }
          : {}),
        ...(typeof continuity.extractionInstructions === "string"
          ? { extractionInstructions: continuity.extractionInstructions }
          : {}),
        ...(typeof continuity.verificationInstructions === "string"
          ? { verificationInstructions: continuity.verificationInstructions }
          : {}),
      },
      counts,
      verifiedThroughMessageId: state.verifiedThroughMessageId,
      gaps: state.gaps,
      batches: batches.map((batch) => ({
        id: batch.id,
        chatId: batch.chatId,
        sessionNumber: batch.sessionNumber,
        sourceHash: batch.sourceHash,
        status: batch.status,
        sourceCurrent: batch.sourceCurrent,
        attempts: batch.attempts,
        repairAttempts: batch.repairAttempts,
        entryIds: batch.entryIds,
        errorCode: batch.errorCode ?? null,
        error: batch.error ?? null,
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt,
      })),
    };
  });
};
