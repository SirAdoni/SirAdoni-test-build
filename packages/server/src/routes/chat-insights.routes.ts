// ──────────────────────────────────────────────
// Routes: Chat insights (global search, chat stats, activity overview)
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { chats } from "../db/schema/index.js";
import { eq } from "../db/file-query.js";
import {
  computeStoredChatStats,
  createActivityOverviewCache,
  isInternalAssistantChat,
  normalizeTimezoneOffset,
  searchAllChats,
} from "../services/chat-insights/chat-insights.service.js";

export async function chatInsightsRoutes(app: FastifyInstance) {
  const activityCache = createActivityOverviewCache(app.db);

  // Search message text across every chat, newest chats first, capped and paginated.
  app.get<{
    Querystring: {
      q?: string;
      mode?: string;
      characterId?: string;
      role?: string;
      from?: string;
      to?: string;
      offset?: string;
      limit?: string;
    };
  }>("/search", async (req, reply) => {
    const query = typeof req.query.q === "string" ? req.query.q.slice(0, 500) : "";
    if (!query.trim()) return reply.status(400).send({ error: "Search query is required" });
    return searchAllChats(app.db, {
      query,
      mode: req.query.mode ?? null,
      characterId: req.query.characterId ?? null,
      role: req.query.role ?? null,
      from: req.query.from ?? null,
      to: req.query.to ?? null,
      offset: req.query.offset === undefined ? undefined : Number(req.query.offset),
      limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
    });
  });

  // `tz` is the browser IANA zone (DST aware); `tzOffset` is the fixed fallback.
  app.get<{ Querystring: { tzOffset?: string; tz?: string; refresh?: string } }>("/activity", async (req) =>
    activityCache.get(normalizeTimezoneOffset(req.query.tzOffset), {
      refresh: req.query.refresh === "true",
      timeZone: req.query.tz ?? null,
    }),
  );

  app.get<{ Params: { id: string }; Querystring: { tzOffset?: string; tz?: string } }>("/chats/:id/stats", async (req, reply) => {
    const [chat] = await app.db.select().from(chats).where(eq(chats.id, req.params.id));
    if (!chat || isInternalAssistantChat(chat)) return reply.status(404).send({ error: "Chat not found" });
    return computeStoredChatStats(app.db, chat, {
      timezoneOffsetMinutes: normalizeTimezoneOffset(req.query.tzOffset),
      timeZone: req.query.tz ?? null,
    });
  });
}
