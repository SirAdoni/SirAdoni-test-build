import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  applyCampaignMemoryMutation,
  compensateCampaignMemoryMutation,
  previewCampaignMemoryMutation,
  CampaignMemoryMutationError,
  type CampaignMemoryMutationCommand,
} from "../services/game/campaign-memory-mutations.js";
import {
  CampaignMemoryStorageError,
  createCampaignMemoryStorage,
} from "../services/storage/campaign-memory.storage.js";
import { logger } from "../lib/logger.js";
import { campaignMemoryRelationshipKindError } from "../services/game/campaign-memory-relationship-kinds.js";
import type { DB } from "../db/connection.js";
import {
  applyCampaignMemoryLegacyImport,
  collectCampaignMemoryLegacySource,
  planCampaignMemoryLegacyImport,
} from "../services/game/campaign-memory-import.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TEXT = 10_000;
const MAX_ENTITY_BODY = 20_000;
const recordTypes = ["entity", "fact", "knowledge", "relationship"] as const;
const recordTypeSchema = z.enum(recordTypes);
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.string().max(MAX_TEXT),
    z.boolean(),
    z.number().finite(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
const evidenceSchema = z
  .object({
    messageId: z.string().trim().min(1).max(200),
    quote: z.string().trim().min(1).max(MAX_TEXT),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .strict();
const ownerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("existing"),
      store: z.string().trim().min(1).max(200),
      recordId: z.string().trim().min(1).max(300),
    })
    .strict(),
  z
    .object({
      type: z.literal("registry"),
      store: z.literal("campaign-memory"),
      recordId: z.string().trim().min(1).max(300),
    })
    .strict(),
]);
const entityInput = z
  .object({
    entityId: z.string().trim().min(1).max(300).optional(),
    kind: z.enum(["character", "persona", "location", "organization", "item", "quest", "lore", "note"]),
    owner: ownerSchema,
    aliases: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
    tags: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
    summary: z.string().max(MAX_TEXT).optional(),
    body: z.string().trim().max(MAX_ENTITY_BODY).optional(),
    attributes: z.record(z.string().max(200), jsonValue).default({}),
    status: z.enum(["active", "archived"]).default("active"),
    manualLock: z.boolean().default(false),
  })
  .strict();
const factInput = z
  .object({
    factId: z.string().trim().min(1).max(300).optional(),
    subjectEntityId: z.string().trim().min(1).max(300),
    predicate: z.string().trim().min(1).max(500),
    value: jsonValue,
    conditions: z
      .array(z.object({ kind: z.string().trim().min(1).max(200), value: jsonValue }).strict())
      .max(100)
      .default([]),
    status: z.enum(["proposed", "verified", "superseded", "held", "retracted"]).default("proposed"),
    validFromOrder: z.string().trim().max(300).optional(),
    validToOrder: z.string().trim().max(300).optional(),
    sourceRevision: z.string().trim().min(1).max(300).optional(),
    evidence: z.array(evidenceSchema).max(100).default([]),
    supersedesFactId: z.string().trim().max(300).optional(),
    manualLock: z.boolean().default(false),
  })
  .strict();
const knowledgeInput = z
  .object({
    knowledgeId: z.string().trim().min(1).max(300).optional(),
    holderEntityId: z.string().trim().min(1).max(300),
    factId: z.string().trim().max(300).optional(),
    attributedClaim: z
      .object({
        subjectEntityId: z.string().trim().min(1).max(300),
        predicate: z.string().trim().min(1).max(500),
        value: jsonValue,
      })
      .strict()
      .optional(),
    epistemicState: z.enum(["knows", "believes", "rumor", "unknown"]),
    learnedFrom: z.array(evidenceSchema).max(100).default([]),
    learnedAtOrder: z.string().trim().max(300).optional(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    manualLock: z.boolean().default(false),
  })
  .strict();
const relationshipInput = z
  .object({
    relationshipId: z.string().trim().min(1).max(300).optional(),
    sourceEntityId: z.string().trim().min(1).max(300),
    targetEntityId: z.string().trim().min(1).max(300),
    type: z.string().trim().min(1).max(500),
    inverseLabel: z.string().trim().min(1).max(500),
    status: z.enum(["proposed", "active", "ended", "held"]).default("proposed"),
    effectiveFrom: z.string().trim().max(300).optional(),
    effectiveTo: z.string().trim().max(300).optional(),
    evidence: z.array(evidenceSchema).max(100).default([]),
    manualLock: z.boolean().default(false),
  })
  .strict();

const entityPatch = z
  .object({
    aliases: entityInput.shape.aliases,
    tags: entityInput.shape.tags,
    summary: entityInput.shape.summary,
    body: entityInput.shape.body,
    attributes: entityInput.shape.attributes,
    status: entityInput.shape.status,
    manualLock: entityInput.shape.manualLock,
  })
  .strict();
const factPatch = z
  .object({
    predicate: factInput.shape.predicate,
    value: factInput.shape.value,
    conditions: factInput.shape.conditions,
    status: factInput.shape.status,
    validFromOrder: factInput.shape.validFromOrder,
    validToOrder: factInput.shape.validToOrder,
    evidence: factInput.shape.evidence,
    supersedesFactId: factInput.shape.supersedesFactId,
    manualLock: factInput.shape.manualLock,
  })
  .strict();
const knowledgePatch = z
  .object({
    epistemicState: knowledgeInput.shape.epistemicState,
    learnedFrom: knowledgeInput.shape.learnedFrom,
    learnedAtOrder: knowledgeInput.shape.learnedAtOrder,
    confidence: knowledgeInput.shape.confidence,
    manualLock: knowledgeInput.shape.manualLock,
  })
  .strict();
const relationshipPatch = z
  .object({
    type: relationshipInput.shape.type,
    inverseLabel: relationshipInput.shape.inverseLabel,
    status: relationshipInput.shape.status,
    effectiveFrom: relationshipInput.shape.effectiveFrom,
    effectiveTo: relationshipInput.shape.effectiveTo,
    evidence: relationshipInput.shape.evidence,
    manualLock: relationshipInput.shape.manualLock,
  })
  .strict();

const rootSchema = z
  .object({
    operationId: z.string().trim().min(1).max(128),
    action: z.enum(["create", "update"]),
    recordType: recordTypeSchema,
    recordId: z.string().trim().min(1).max(300).optional(),
    expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    reason: z.string().trim().min(1).max(2_000),
    evidence: z.array(evidenceSchema).max(100).default([]),
    input: z.unknown().optional(),
    patch: z.unknown().optional(),
  })
  .strict();
const compensationSchema = z
  .object({
    operationId: z.string().trim().min(1).max(128),
    originalOperationId: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(1).max(2_000),
    evidence: z.array(evidenceSchema).max(100).default([]),
  })
  .strict();
const importPreviewSchema = z.object({ operationId: z.string().trim().min(1).max(128) }).strict();
const importApplySchema = z
  .object({ operationId: z.string().trim().min(1).max(128), expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/i) })
  .strict();
const querySchema = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

type ParsedAuthoring = z.infer<typeof rootSchema>;
type PatchByType = {
  entity: z.infer<typeof entityPatch>;
  fact: z.infer<typeof factPatch>;
  knowledge: z.infer<typeof knowledgePatch>;
  relationship: z.infer<typeof relationshipPatch>;
};

function errorResponse(reply: FastifyReply, error: unknown) {
  const known = error instanceof CampaignMemoryMutationError || error instanceof CampaignMemoryStorageError;
  const code = known ? error.code : "CAMPAIGN_MEMORY_AUTHORING_FAILED";
  const message = error instanceof Error ? error.message : "Campaign memory authoring failed";
  const status = !known
    ? 500
    : code === "CAMPAIGN_MEMORY_NOT_FOUND" ||
        code === "CAMPAIGN_MEMORY_CHAT_NOT_FOUND" ||
        code === "CAMPAIGN_MEMORY_INVALID_REFERENCE"
      ? 404
      : code === "CAMPAIGN_MEMORY_CAS_MISMATCH" ||
          code === "CAMPAIGN_MEMORY_LOCKED" ||
          code === "CAMPAIGN_MEMORY_CONFLICT" ||
          code === "CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT"
        ? 409
        : code === "CAMPAIGN_MEMORY_IMMUTABLE"
          ? 409
          : 400;
  if (!known) logger.error({ err: error }, "Campaign memory authoring failed");
  return reply.status(status).send({ error: { code, message } });
}

function provenance(operationId: string) {
  // Keep the generated provenance stable across delayed retries and preview/apply.
  return { source: "user-source", sourceRevision: operationId, actor: "user" as const };
}

function buildCommand(chatId: string, parsed: ParsedAuthoring): CampaignMemoryMutationCommand {
  if (parsed.action === "create") {
    if (parsed.recordId !== undefined || parsed.expectedRevision !== undefined || parsed.patch !== undefined)
      throw new CampaignMemoryMutationError(
        "CAMPAIGN_MEMORY_INVALID_VALUE",
        "Create requests cannot include recordId, expectedRevision, or patch",
      );
    if (parsed.input === undefined)
      throw new CampaignMemoryMutationError("CAMPAIGN_MEMORY_INVALID_VALUE", "Create requests require input");
    const inputResult =
      parsed.recordType === "entity"
        ? entityInput.safeParse(parsed.input)
        : parsed.recordType === "fact"
          ? factInput.safeParse(parsed.input)
          : parsed.recordType === "knowledge"
            ? knowledgeInput.safeParse(parsed.input)
            : relationshipInput.safeParse(parsed.input);
    if (!inputResult.success)
      throw new CampaignMemoryMutationError("CAMPAIGN_MEMORY_INVALID_VALUE", `Invalid ${parsed.recordType} input`);
    const input = { ...inputResult.data, provenance: provenance(parsed.operationId) } as Record<string, unknown>;
    if (parsed.recordType === "fact") input.author = "user";
    if (parsed.recordType === "fact") input.sourceRevision ??= parsed.operationId;
    return {
      chatId,
      operationId: parsed.operationId,
      actor: "user",
      reason: parsed.reason,
      evidence: parsed.evidence,
      recordType: parsed.recordType,
      action: "create",
      input,
    } as CampaignMemoryMutationCommand;
  }
  if (
    !parsed.recordId ||
    parsed.expectedRevision === undefined ||
    parsed.input !== undefined ||
    parsed.patch === undefined
  )
    throw new CampaignMemoryMutationError(
      "CAMPAIGN_MEMORY_INVALID_VALUE",
      "Update requests require recordId, expectedRevision, and patch",
    );
  const patchResult =
    parsed.recordType === "entity"
      ? entityPatch.safeParse(parsed.patch)
      : parsed.recordType === "fact"
        ? factPatch.safeParse(parsed.patch)
        : parsed.recordType === "knowledge"
          ? knowledgePatch.safeParse(parsed.patch)
          : relationshipPatch.safeParse(parsed.patch);
  if (!patchResult.success)
    throw new CampaignMemoryMutationError("CAMPAIGN_MEMORY_INVALID_VALUE", `Invalid ${parsed.recordType} patch`);
  const patch = patchResult.data as PatchByType[typeof parsed.recordType];
  return {
    chatId,
    operationId: parsed.operationId,
    actor: "user",
    reason: parsed.reason,
    evidence: parsed.evidence,
    recordType: parsed.recordType,
    action: "update",
    recordId: parsed.recordId,
    expectedRevision: parsed.expectedRevision,
    patch,
  } as CampaignMemoryMutationCommand;
}

function parseBody(reply: FastifyReply, body: unknown): ParsedAuthoring | null {
  const parsed = rootSchema.safeParse(body);
  if (!parsed.success) {
    reply.status(400).send({
      error: {
        code: "CAMPAIGN_MEMORY_INVALID_VALUE",
        message: "Invalid campaign memory authoring request",
        details: parsed.error.flatten(),
      },
    });
    return null;
  }
  return parsed.data;
}

function importErrorResponse(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "Campaign memory import failed";
  const code = message.startsWith("CAMPAIGN_MEMORY_IMPORT_SOURCE_CHANGED")
    ? "CAMPAIGN_MEMORY_IMPORT_SOURCE_CHANGED"
    : message.startsWith("CAMPAIGN_MEMORY_CHAT_NOT_FOUND")
      ? "CAMPAIGN_MEMORY_CHAT_NOT_FOUND"
      : "CAMPAIGN_MEMORY_IMPORT_FAILED";
  const status =
    code === "CAMPAIGN_MEMORY_IMPORT_SOURCE_CHANGED" ? 409 : code === "CAMPAIGN_MEMORY_CHAT_NOT_FOUND" ? 404 : 400;
  if (status === 400 && code === "CAMPAIGN_MEMORY_IMPORT_FAILED")
    logger.error({ err: error }, "Campaign memory import failed");
  return reply.status(status).send({
    error: {
      code,
      message:
        code === "CAMPAIGN_MEMORY_IMPORT_SOURCE_CHANGED" ? "Campaign memory source changed since preview" : message,
    },
  });
}

function safeImportPreview(plan: Awaited<ReturnType<typeof planCampaignMemoryLegacyImport>>) {
  return {
    manifest: plan.manifest,
    heldEntityIds: plan.manifest.heldEntityIds,
    skippedExistingEntityIds: plan.skippedExistingEntityIds,
  };
}

/** Relationship endpoints must exist in the request's chat scope and carry kinds the type permits. Storage re-checks this on write. */
async function validateRelationshipEndpoints(db: DB, command: CampaignMemoryMutationCommand) {
  if (command.recordType !== "relationship") return;
  const storage = createCampaignMemoryStorage(db);
  const scope = { chatId: command.chatId };
  let endpoints: { sourceEntityId: string; targetEntityId: string; type: string };
  if (command.action === "create") endpoints = command.input;
  else {
    if (command.patch.type === undefined) return;
    const current = await storage.getRelationship(scope, command.recordId);
    if (!current)
      throw new CampaignMemoryMutationError("CAMPAIGN_MEMORY_NOT_FOUND", `Relationship ${command.recordId} not found`);
    endpoints = { ...current, type: command.patch.type };
  }
  const [source, target] = await Promise.all([
    storage.getEntity(scope, endpoints.sourceEntityId),
    storage.getEntity(scope, endpoints.targetEntityId),
  ]);
  if (!source || !target)
    throw new CampaignMemoryMutationError(
      "CAMPAIGN_MEMORY_INVALID_REFERENCE",
      `Relationship endpoints must belong to chat ${command.chatId}`,
    );
  const message = campaignMemoryRelationshipKindError(endpoints.type, source.kind, target.kind);
  if (message) throw new CampaignMemoryMutationError("CAMPAIGN_MEMORY_INVALID_ENDPOINT_KIND", message);
}

async function execute(
  app: FastifyInstance,
  reply: FastifyReply,
  chatId: string,
  body: unknown,
  mode: "preview" | "apply",
) {
  const parsed = parseBody(reply, body);
  if (!parsed) return;
  try {
    const command = buildCommand(chatId, parsed);
    await validateRelationshipEndpoints(app.db, command);
    return mode === "preview"
      ? await previewCampaignMemoryMutation(app.db, command)
      : await applyCampaignMemoryMutation(app.db, command);
  } catch (error) {
    return errorResponse(reply, error);
  }
}

export async function campaignMemoryWriteRoutes(app: FastifyInstance) {
  const options = { bodyLimit: MAX_BODY_BYTES };
  app.post<{ Params: { chatId: string } }>("/:chatId/memory/mutations/preview", options, async (request, reply) =>
    execute(app, reply, request.params.chatId, request.body, "preview"),
  );
  app.post<{ Params: { chatId: string } }>("/:chatId/memory/mutations", options, async (request, reply) =>
    execute(app, reply, request.params.chatId, request.body, "apply"),
  );
  app.post<{ Params: { chatId: string } }>("/:chatId/memory/mutations/compensate", options, async (request, reply) => {
    const parsed = compensationSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({
        error: {
          code: "CAMPAIGN_MEMORY_INVALID_VALUE",
          message: "Invalid compensation request",
          details: parsed.error.flatten(),
        },
      });
    try {
      return await compensateCampaignMemoryMutation(app.db, {
        ...parsed.data,
        chatId: request.params.chatId,
        actor: "user",
      });
    } catch (error) {
      return errorResponse(reply, error);
    }
  });
  app.post<{ Params: { chatId: string } }>("/:chatId/memory/import/preview", options, async (request, reply) => {
    const parsed = importPreviewSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({
        error: {
          code: "CAMPAIGN_MEMORY_INVALID_VALUE",
          message: "Invalid campaign memory import preview request",
          details: parsed.error.flatten(),
        },
      });
    try {
      const source = await collectCampaignMemoryLegacySource(app.db, request.params.chatId);
      const plan = await planCampaignMemoryLegacyImport(app.db, source, { operationId: parsed.data.operationId });
      return safeImportPreview(plan);
    } catch (error) {
      return importErrorResponse(reply, error);
    }
  });
  app.post<{ Params: { chatId: string } }>("/:chatId/memory/import", options, async (request, reply) => {
    const parsed = importApplySchema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({
        error: {
          code: "CAMPAIGN_MEMORY_INVALID_VALUE",
          message: "Invalid campaign memory import request",
          details: parsed.error.flatten(),
        },
      });
    try {
      const source = await collectCampaignMemoryLegacySource(app.db, request.params.chatId);
      if (source.legacySourceHash !== parsed.data.expectedSourceHash)
        return reply.status(409).send({
          error: {
            code: "CAMPAIGN_MEMORY_IMPORT_SOURCE_CHANGED",
            message: "Campaign memory source changed since preview",
          },
        });
      const plan = await planCampaignMemoryLegacyImport(app.db, source, { operationId: parsed.data.operationId });
      const result = await applyCampaignMemoryLegacyImport(app.db, plan);
      return {
        manifest: result.manifest,
        createdEntityIds: result.created.map((entity) => entity.entityId),
        heldEntityIds: result.manifest.heldEntityIds,
        skippedExistingEntityIds: result.skippedExistingEntityIds,
      };
    } catch (error) {
      return importErrorResponse(reply, error);
    }
  });
  const audit = async (request: FastifyRequest<{ Params: { chatId: string } }>, reply: FastifyReply) => {
    const query = querySchema.safeParse(request.query ?? {});
    if (!query.success)
      return reply.status(400).send({
        error: {
          code: "CAMPAIGN_MEMORY_INVALID_VALUE",
          message: "Invalid audit pagination",
          details: query.error.flatten(),
        },
      });
    try {
      const rows = await createCampaignMemoryStorage(app.db).listMutationJournal({ chatId: request.params.chatId });
      return {
        items: rows.slice(query.data.offset, query.data.offset + query.data.limit),
        total: rows.length,
        offset: query.data.offset,
        limit: query.data.limit,
      };
    } catch (error) {
      return errorResponse(reply, error);
    }
  };
  app.get<{ Params: { chatId: string } }>("/:chatId/memory/audit", audit);
}
