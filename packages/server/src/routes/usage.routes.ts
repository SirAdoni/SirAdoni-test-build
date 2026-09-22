// ──────────────────────────────────────────────
// Routes: Usage dashboard (token usage ledger + price settings)
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_USAGE_DASHBOARD_SETTINGS,
  USAGE_DASHBOARD_SETTINGS_KEY,
  usageDashboardSettingsSchema,
  usageSummaryQuerySchema,
  type UsageDashboardSettings,
  type UsageSummary,
} from "@marinara-engine/shared";
import { inArray } from "../db/file-query.js";
import { apiConnections, chats } from "../db/schema/index.js";
import { logger } from "../lib/logger.js";
import { createAppSettingsStorage } from "../services/storage/app-settings.storage.js";
import { createGenerationUsageStorage } from "../services/storage/generation-usage.storage.js";
import { aggregateUsage, resolveUsageRange } from "../services/usage/usage-aggregation.js";

export async function usageRoutes(app: FastifyInstance) {
  const settings = createAppSettingsStorage(app.db);
  const ledger = createGenerationUsageStorage(app.db);

  app.get("/summary", async (req, reply): Promise<UsageSummary | void> => {
    const query = usageSummaryQuerySchema.parse(req.query);
    const range = resolveUsageRange(query.from, query.to, query.tzOffsetMinutes);
    if (!range) return reply.status(400).send({ error: "Invalid date range" });

    const rows = await ledger.listBetween(range.fromIso, range.toIso);
    const connectionIds = [...new Set(rows.map((row) => row.connectionId).filter((id): id is string => !!id))];
    const chatIds = [...new Set(rows.map((row) => row.chatId).filter((id): id is string => !!id))];
    const [connectionRows, chatRows] = await Promise.all([
      connectionIds.length
        ? app.db
            .select({ id: apiConnections.id, name: apiConnections.name })
            .from(apiConnections)
            .where(inArray(apiConnections.id, connectionIds))
        : [],
      chatIds.length
        ? app.db.select({ id: chats.id, name: chats.name }).from(chats).where(inArray(chats.id, chatIds))
        : [],
    ]);
    return aggregateUsage(rows, range, query.tzOffsetMinutes, {
      connections: new Map(connectionRows.map((row) => [row.id, row.name])),
      chats: new Map(chatRows.map((row) => [row.id, row.name])),
    });
  });

  app.get("/settings", async (): Promise<UsageDashboardSettings> => {
    const value = await settings.get(USAGE_DASHBOARD_SETTINGS_KEY);
    if (!value) return DEFAULT_USAGE_DASHBOARD_SETTINGS;
    try {
      return usageDashboardSettingsSchema.parse(JSON.parse(value));
    } catch (error) {
      logger.warn(error, "Ignoring invalid stored usage dashboard settings");
      return DEFAULT_USAGE_DASHBOARD_SETTINGS;
    }
  });

  app.put("/settings", async (req): Promise<UsageDashboardSettings> => {
    const next = usageDashboardSettingsSchema.parse(req.body);
    await settings.set(USAGE_DASHBOARD_SETTINGS_KEY, JSON.stringify(next));
    return next;
  });
}
