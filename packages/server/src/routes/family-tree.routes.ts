import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FAMILY_KINDS } from "@marinara-engine/shared";
import { readFamilyTree, writeFamilyTree } from "../services/game/family-tree.js";
import { CampaignMemoryMutationError } from "../services/game/campaign-memory-mutations.js";
import { CampaignMemoryStorageError } from "../services/storage/campaign-memory.storage.js";
import {
  requireCampaignSurface,
  rejectCampaignSurfaceWhenDisabled,
  sendCampaignSurfaceDisabled,
} from "../services/features/campaign-surface-opt-in.js";

const writeSchema = z
  .object({
    operationId: z.string().uuid(),
    action: z.enum(["save", "remove"]),
    id: z.string().min(1).max(300).optional(),
    revision: z.number().int().positive().optional(),
    sourceId: z.string().min(1).max(1000),
    targetId: z.string().min(1).max(1000).nullable(),
    kind: z.enum(FAMILY_KINDS),
    note: z.string().max(20_000).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.id) === (value.revision !== undefined));

export async function familyTreeRoutes(app: FastifyInstance) {
  app.get<{ Params: { chatId: string } }>("/:chatId", async (request, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "familyTree")) return;
    try {
      return await readFamilyTree(app.db, request.params.chatId);
    } catch (error) {
      if (sendCampaignSurfaceDisabled(reply, error)) return;
      if (error instanceof CampaignMemoryMutationError)
        return reply.status(404).send({ error: error.message, code: error.code });
      throw error;
    }
  });
  app.post<{ Params: { chatId: string } }>("/:chatId", { bodyLimit: 128 * 1024 }, async (request, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "familyTree")) return;
    const parsed = writeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid family link", code: "FAMILY_INVALID" });
    try {
      return await writeFamilyTree(app.db, request.params.chatId, parsed.data, () =>
        requireCampaignSurface("campaignMemory", "familyTree"),
      );
    } catch (error) {
      if (sendCampaignSurfaceDisabled(reply, error)) return;
      if (error instanceof CampaignMemoryMutationError || error instanceof CampaignMemoryStorageError) {
        const status = /CONFLICT|MISMATCH/.test(error.code) ? 409 : /NOT_FOUND/.test(error.code) ? 404 : 400;
        return reply.status(status).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });
}
