import { privateNotebookUpdateSchema } from "@marinara-engine/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { featureDisabledResponse, isFeatureEnabled } from "../services/features/feature-settings.js";
import {
  PrivateNotebookChatNotFoundError,
  PrivateNotebookConflictError,
  PrivateNotebookFeatureDisabledError,
  PrivateNotebookScopeUnavailableError,
  PrivateNotebookStoredDocumentError,
  readPrivateNotebookContext,
  replacePrivateNotebookDocument,
} from "../services/private-notebook.service.js";

const privateNotebookChatParamsSchema = z.object({ chatId: z.string().min(1) }).strict();
const PRIVATE_NOTEBOOK_BODY_LIMIT_BYTES = 700_000;

function sendFeatureDisabled(reply: FastifyReply) {
  return reply.status(403).send(featureDisabledResponse("privateNotebook"));
}

function sendPrivateNotebookError(error: unknown, reply: FastifyReply) {
  if (error instanceof PrivateNotebookChatNotFoundError) {
    return reply.status(404).send({ error: error.message, code: "chat-not-found" });
  }
  if (error instanceof PrivateNotebookScopeUnavailableError) {
    return reply.status(400).send({ error: error.message, code: "scope-unavailable", target: error.target });
  }
  if (error instanceof PrivateNotebookFeatureDisabledError) return sendFeatureDisabled(reply);

  if (error instanceof PrivateNotebookConflictError) {
    return reply.status(409).send({ error: error.message, code: "revision-conflict", document: error.current });
  }
  if (error instanceof PrivateNotebookStoredDocumentError) {
    return reply.status(409).send({ error: error.message, code: "stored-document-unreadable", target: error.target });
  }
  throw error;
}

export async function privateNotebookRoutes(app: FastifyInstance) {
  app.get<{ Params: { chatId: string } }>("/chats/:chatId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!isFeatureEnabled("privateNotebook")) return sendFeatureDisabled(reply);
    const { chatId } = privateNotebookChatParamsSchema.parse(request.params);
    try {
      return await readPrivateNotebookContext(app.db, chatId);
    } catch (error) {
      return sendPrivateNotebookError(error, reply);
    }
  });

  app.put<{ Params: { chatId: string } }>(
    "/chats/:chatId",
    { bodyLimit: PRIVATE_NOTEBOOK_BODY_LIMIT_BYTES },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!isFeatureEnabled("privateNotebook")) return sendFeatureDisabled(reply);
      const { chatId } = privateNotebookChatParamsSchema.parse(request.params);
      const input = privateNotebookUpdateSchema.parse(request.body);
      try {
        return await replacePrivateNotebookDocument(app.db, chatId, input);
      } catch (error) {
        return sendPrivateNotebookError(error, reply);
      }
    },
  );
}
