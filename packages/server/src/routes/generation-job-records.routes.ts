// ──────────────────────────────────────────────
// Routes: Generation job records (opt-in job tracking)
//
// Only /settings answers while tracking is off; every other route falls
// through to the normal 404 handler, exactly as if it were not registered.
// Cancelling and fetching a result keep using /api/generation-jobs.
// ──────────────────────────────────────────────
import type { FastifyInstance, FastifyReply } from "fastify";
import { getGenerationJobTracker, TRACKING_LIMITS } from "../services/generation/generation-job-tracker.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SEEN_IDS = 100;

export async function generationJobRecordsRoutes(app: FastifyInstance) {
  const tracker = await getGenerationJobTracker(app);
  const settingsResponse = () => ({
    enabled: tracker.isEnabled(),
    retentionDays: Math.round(TRACKING_LIMITS.retentionMs / 86_400_000),
    maxRecords: TRACKING_LIMITS.maxRecords,
  });
  const disabled = (reply: FastifyReply) => {
    if (tracker.isEnabled()) return false;
    reply.callNotFound();
    return true;
  };

  app.get("/settings", async () => settingsResponse());

  app.put<{ Body: { enabled?: unknown } }>("/settings", async (request, reply) => {
    if (typeof request.body?.enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    await tracker.setEnabled(request.body.enabled);
    return settingsResponse();
  });

  app.get<{ Querystring: { chatId?: string | string[]; limit?: string } }>("/", async (request, reply) => {
    if (disabled(reply)) return reply;
    if (Array.isArray(request.query.chatId)) return reply.code(400).send({ error: "chatId must be a single value" });
    const limit = Number.parseInt(request.query.limit ?? "", 10);
    return {
      records: await tracker.list({
        chatId: request.query.chatId || undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    };
  });

  /** The client accounted for these finished jobs; recovered=false means the user watched them finish. */
  app.post<{ Body: { ids?: unknown; recovered?: unknown } }>("/seen", async (request, reply) => {
    if (disabled(reply)) return reply;
    const ids = request.body?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_SEEN_IDS ||
      !ids.every((id) => typeof id === "string" && UUID_RE.test(id))
    )
      return reply.code(400).send({ error: `ids must be up to ${MAX_SEEN_IDS} job ids` });
    return { updated: await tracker.markSeen(ids as string[], request.body?.recovered !== false) };
  });

  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    if (disabled(reply)) return reply;
    if (!UUID_RE.test(request.params.id)) return reply.code(400).send({ error: "Invalid generation job id" });
    const record = await tracker.get(request.params.id);
    if (!record) return reply.code(404).send({ error: "Generation job record not found" });
    return record;
  });

  /** The job's structured log trail: the same events the server logged, for support lookups. */
  app.get<{ Params: { id: string } }>("/:id/trail", async (request, reply) => {
    if (disabled(reply)) return reply;
    if (!UUID_RE.test(request.params.id)) return reply.code(400).send({ error: "Invalid generation job id" });
    const record = await tracker.get(request.params.id);
    if (!record) return reply.code(404).send({ error: "Generation job record not found" });
    return { jobId: record.id, trail: record.trail ?? [] };
  });
}
