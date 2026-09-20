import type { FastifyInstance } from "fastify";
import { getGenerationJobs } from "../services/generation/generation-jobs.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validId(id: string): boolean {
  return UUID_RE.test(id);
}

export async function generationJobsRoutes(app: FastifyInstance) {
  const jobs = getGenerationJobs(app);
  app.get<{ Querystring: { chatId?: string | string[] } }>("/", async (request, reply) => {
    if (Array.isArray(request.query.chatId)) return reply.code(400).send({ error: "chatId must be a single value" });
    return jobs.list(request.query.chatId);
  });
  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    if (!validId(request.params.id)) return reply.code(400).send({ error: "Invalid generation job id" });
    const item = await jobs.get(request.params.id);
    if (!item) return reply.code(404).send({ error: "Generation job not found" });
    return item;
  });
  app.get<{ Params: { id: string } }>("/:id/result", async (request, reply) => {
    if (!validId(request.params.id)) return reply.code(400).send({ error: "Invalid generation job id" });
    try {
      return await jobs.result(request.params.id);
    } catch (error: any) {
      if (error?.code === "ENOENT") return reply.code(404).send({ error: "Generation result not found" });
      throw error;
    }
  });
  app.post<{ Params: { id: string } }>("/:id/cancel", async (request, reply) => {
    if (!validId(request.params.id)) return reply.code(400).send({ error: "Invalid generation job id" });
    const cancelled = await jobs.cancel(request.params.id);
    if (!cancelled) {
      const item = await jobs.get(request.params.id);
      if (!item) return reply.code(404).send({ error: "Generation job not found" });
      return item;
    }
    return jobs.get(request.params.id);
  });
}
