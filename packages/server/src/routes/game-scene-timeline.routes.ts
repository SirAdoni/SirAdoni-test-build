import type { FastifyInstance, FastifyReply } from "fastify";
import { isGameSceneTimelineEnabled } from "@marinara-engine/shared";
import { rejectCampaignFeatureWhenDisabled } from "../services/features/campaign-opt-in.js";
import { queueSceneTimeline, readSceneTimeline } from "../services/game/scene-timeline.service.js";
import { createChatsStorage } from "../services/storage/chats.storage.js";

function metadataRecord(raw: unknown): Record<string, unknown> {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function rejectChatTimeline(reply: FastifyReply): false {
  reply.status(403).send({
    error: { code: "FEATURE_DISABLED", feature: "sceneTimeline", message: "This feature is disabled in Settings." },
  });
  return false;
}

async function timelineEnabled(app: FastifyInstance, chatId: string, reply: FastifyReply): Promise<boolean> {
  if (rejectCampaignFeatureWhenDisabled(reply, "sceneTimeline")) return false;
  const chat = await createChatsStorage(app.db).getById(chatId);
  if (rejectCampaignFeatureWhenDisabled(reply, "sceneTimeline")) return false;
  if (!chat) {
    reply.status(404).send({ error: "Chat not found" });
    return false;
  }
  return isGameSceneTimelineEnabled(metadataRecord(chat.metadata)) || rejectChatTimeline(reply);
}

export async function gameSceneTimelineRoutes(app: FastifyInstance) {
  app.get<{ Params: { chatId: string } }>("/:chatId/scene-timeline", async (req, reply) => {
    if (!(await timelineEnabled(app, req.params.chatId, reply))) return;
    const timeline = await readSceneTimeline(app.db, req.params.chatId);
    if (!(await timelineEnabled(app, req.params.chatId, reply))) return;
    return timeline;
  });

  app.post<{ Params: { chatId: string } }>("/:chatId/scene-timeline/sync", async (req, reply) => {
    if (!(await timelineEnabled(app, req.params.chatId, reply))) return;
    await readSceneTimeline(app.db, req.params.chatId);
    if (!(await timelineEnabled(app, req.params.chatId, reply))) return;
    queueSceneTimeline(
      app.db,
      req.params.chatId,
      () =>
        (app as unknown as { activeGenerations?: Map<string, unknown> }).activeGenerations?.has(req.params.chatId) ??
        false,
    );
    return { queued: true };
  });
}
