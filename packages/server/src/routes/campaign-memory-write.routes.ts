import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  GAME_CALENDAR_METADATA_KEY,
  isWorldHistoryDateValid,
  sanitizeGameCalendarState,
  worldHistorySchema,
} from "@marinara-engine/shared";
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
import {
  rejectCampaignFeatureWhenDisabled,
  sendCampaignFeatureDisabled,
} from "../services/features/campaign-opt-in.js";

import { campaignMemoryRelationshipKindError } from "../services/game/campaign-memory-relationship-kinds.js";
import type { DB } from "../db/connection.js";
import { eq } from "../db/file-query.js";
import {
  rejectCampaignSurfaceWhenDisabled,
  requireCampaignSurface,
  sendCampaignSurfaceDisabled,
} from "../services/features/campaign-surface-opt-in.js";
import { campaignMemoryEntities, campaignMemoryFacts, chats } from "../db/schema/index.js";
import {
  campaignEntityIdentity,
  readCampaignMemoryProjection,
  type CampaignMemoryProjection,
} from "../services/game/campaign-memory-campaign-scope.js";
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
    notes: z.string().max(20000).optional(),
    status: z.enum(["proposed", "active", "ended", "held"]).default("proposed"),
    effectiveFrom: z.string().trim().max(300).optional(),
    effectiveTo: z.string().trim().max(300).optional(),
    evidence: z.array(evidenceSchema).max(100).default([]),
    manualLock: z.boolean().default(false),
  })
  .strict();

// Patches carry only the fields the wiki changed: every field is optional and no create default fills a missing key,
// or an edit of one field would reset the others (aliases, tags, status, lock) to their create defaults.
const entityPatch = z
  .object({
    aliases: entityInput.shape.aliases.removeDefault(),
    tags: entityInput.shape.tags.removeDefault(),
    summary: entityInput.shape.summary,
    body: entityInput.shape.body,
    attributes: entityInput.shape.attributes.removeDefault(),
    status: entityInput.shape.status.removeDefault(),
    manualLock: entityInput.shape.manualLock.removeDefault(),
  })
  .partial()
  .strict();
const factPatch = z
  .object({
    predicate: factInput.shape.predicate,
    value: factInput.shape.value,
    conditions: factInput.shape.conditions.removeDefault(),
    status: factInput.shape.status.removeDefault(),
    validFromOrder: factInput.shape.validFromOrder,
    validToOrder: factInput.shape.validToOrder,
    evidence: factInput.shape.evidence.removeDefault(),
    supersedesFactId: factInput.shape.supersedesFactId,
    manualLock: factInput.shape.manualLock.removeDefault(),
  })
  .partial()
  .strict();
const knowledgePatch = z
  .object({
    epistemicState: knowledgeInput.shape.epistemicState,
    learnedFrom: knowledgeInput.shape.learnedFrom.removeDefault(),
    learnedAtOrder: knowledgeInput.shape.learnedAtOrder,
    confidence: knowledgeInput.shape.confidence,
    manualLock: knowledgeInput.shape.manualLock.removeDefault(),
  })
  .partial()
  .strict();
const relationshipPatch = z
  .object({
    type: relationshipInput.shape.type,
    inverseLabel: relationshipInput.shape.inverseLabel,
    notes: relationshipInput.shape.notes,
    status: relationshipInput.shape.status.removeDefault(),
    effectiveFrom: relationshipInput.shape.effectiveFrom,
    effectiveTo: relationshipInput.shape.effectiveTo,
    evidence: relationshipInput.shape.evidence.removeDefault(),
    manualLock: relationshipInput.shape.manualLock.removeDefault(),
  })
  .partial()
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
    recordId: z.string().trim().min(1).max(300).optional(),
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
  if (sendCampaignFeatureDisabled(reply, error) || sendCampaignSurfaceDisabled(reply, error)) return reply;
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
          code === "CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE" ||
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
  if (sendCampaignFeatureDisabled(reply, error) || sendCampaignSurfaceDisabled(reply, error)) return reply;
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

/**
 * The campaign wiki shows one page per person across every session (the projection's anchor id) and the facts of
 * every session, but a write goes to one chat and storage accepts only references inside that chat. Swap each id
 * from another session for the same record in the write chat: entities by the campaign projection that holds both
 * sessions (so name folds count too), facts by the projection's re-read dedupe. When the write chat has no such
 * record, say so plainly instead of the storage layer's bare INVALID_REFERENCE.
 */
async function mapCrossSessionReferences(db: DB, command: CampaignMemoryMutationCommand) {
  const chatId = command.chatId;
  const storage = createCampaignMemoryStorage(db);
  const projections = new Map<string, CampaignMemoryProjection | null>();
  // The projection of the later of the two sessions holds both; null when they are not sessions of one campaign.
  const sharedProjection = async (otherChatId: string) => {
    if (projections.has(otherChatId)) return projections.get(otherChatId)!;
    let found: CampaignMemoryProjection | null = null;
    for (const candidate of [otherChatId, chatId]) {
      const projection = await readCampaignMemoryProjection(db, candidate);
      if (projection.sessionChatIds.includes(chatId) && projection.sessionChatIds.includes(otherChatId)) {
        found = projection;
        break;
      }
    }
    projections.set(otherChatId, found);
    return found;
  };
  const crossSession = (message: string) =>
    new CampaignMemoryMutationError("CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE", message);

  const mapEntityId = async (entityId: string): Promise<string> => {
    if (await storage.getEntity({ chatId }, entityId)) return entityId;
    const foreignRow = (
      await db.select().from(campaignMemoryEntities).where(eq(campaignMemoryEntities.entityId, entityId)).limit(1)
    )[0] as { chatId: string } | undefined;
    // Unknown everywhere: leave it for storage to reject as before.
    if (!foreignRow || foreignRow.chatId === chatId) return entityId;
    const foreign = await storage.getEntity({ chatId: foreignRow.chatId }, entityId);
    if (!foreign) return entityId;
    // Only another session of the same campaign is mapped; an unrelated chat's entity is rejected by storage as before.
    const projection = await sharedProjection(foreignRow.chatId);
    if (!projection) return entityId;
    const identity = campaignEntityIdentity(foreign);
    const local = await storage.listEntities({ chatId });
    const anchor = projection?.entityIdMap.get(entityId);
    const match =
      local.find((entity) => campaignEntityIdentity(entity) === identity) ??
      (anchor ? local.find((entity) => projection!.entityIdMap.get(entity.entityId) === anchor) : undefined);
    if (match) return match.entityId;
    const name = foreign.aliases[0] ?? entityId;
    throw crossSession(
      `${name} has no page in that session yet, so this record cannot be written there. Add ${name} to that session first.`,
    );
  };

  const mapFactId = async (factId: string): Promise<string> => {
    if (await storage.getFact({ chatId }, factId)) return factId;
    const foreignRow = (
      await db.select().from(campaignMemoryFacts).where(eq(campaignMemoryFacts.factId, factId)).limit(1)
    )[0] as { chatId: string } | undefined;
    if (!foreignRow || foreignRow.chatId === chatId) return factId;
    const projection = await sharedProjection(foreignRow.chatId);
    if (projection) {
      const resolve = (id: string) => {
        let current = id;
        for (let hops = 0; hops < 64 && projection.factIdAlias.has(current); hops += 1)
          current = projection.factIdAlias.get(current)!;
        return current;
      };
      const kept = resolve(factId);
      const match = (await storage.listFacts({ chatId })).find((fact) => resolve(fact.factId) === kept);
      if (match) return match.factId;
    }
    // Knowledge and supersession must point at a fact of the write chat; a fact of another session has no copy here.
    throw crossSession(
      "That fact belongs to another session and has no copy in this one, so this record cannot be written here. Write it in the session the fact comes from.",
    );
  };

  if (command.action === "update") {
    if (command.recordType === "fact" && command.patch.supersedesFactId)
      command.patch.supersedesFactId = await mapFactId(command.patch.supersedesFactId);
    return;
  }
  if (command.recordType === "fact") {
    command.input.subjectEntityId = await mapEntityId(command.input.subjectEntityId);
    if (command.input.supersedesFactId)
      command.input.supersedesFactId = await mapFactId(command.input.supersedesFactId);
  } else if (command.recordType === "knowledge") {
    command.input.holderEntityId = await mapEntityId(command.input.holderEntityId);
    if (command.input.attributedClaim)
      command.input.attributedClaim = {
        ...command.input.attributedClaim,
        subjectEntityId: await mapEntityId(command.input.attributedClaim.subjectEntityId),
      };
    if (command.input.factId) command.input.factId = await mapFactId(command.input.factId);
  } else if (command.recordType === "relationship") {
    command.input.sourceEntityId = await mapEntityId(command.input.sourceEntityId);
    command.input.targetEntityId = await mapEntityId(command.input.targetEntityId);
  }
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

/** World History lives in user-authored note attributes, so validate it at the shared mutation boundary as well as in the editor. */
async function validateWorldHistoryCommand(db: DB, command: CampaignMemoryMutationCommand) {
  if (command.recordType !== "entity") return;
  const candidate = (command.action === "create" ? command.input : command.patch) as {
    kind?: unknown;
    attributes?: unknown;
  };
  const attributes = candidate?.attributes;
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return;
  const values = attributes as Record<string, unknown>;
  if (!Object.hasOwn(values, "worldHistory")) return;

  const storage = createCampaignMemoryStorage(db);
  const existing =
    command.action === "update" ? await storage.getEntity({ chatId: command.chatId }, command.recordId) : null;
  const kind = command.action === "create" ? candidate.kind : existing?.kind;
  if (kind !== "note")
    throw new CampaignMemoryMutationError("CAMPAIGN_MEMORY_INVALID_VALUE", "World History must be stored on a note");

  const parsedHistory = worldHistorySchema.safeParse(values.worldHistory);
  if (!parsedHistory.success)
    throw new CampaignMemoryMutationError("CAMPAIGN_MEMORY_INVALID_VALUE", "Invalid World History entry");

  const chat = (
    await db
      .select({ mode: chats.mode, metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, command.chatId))
      .limit(1)
  )[0];
  if (!chat || chat.mode !== "game")
    throw new CampaignMemoryMutationError("CAMPAIGN_MEMORY_CHAT_NOT_FOUND", "World History requires a Game chat");

  let metadata: unknown = chat.metadata;
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = {};
    }
  }
  const metadataRecord =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  const calendar = sanitizeGameCalendarState(metadataRecord[GAME_CALENDAR_METADATA_KEY]);
  if (!isWorldHistoryDateValid(parsedHistory.data.date, calendar.config))
    throw new CampaignMemoryMutationError(
      "CAMPAIGN_MEMORY_INVALID_VALUE",
      "World History date is invalid for this chat's calendar",
    );

  const projection = await readCampaignMemoryProjection(db, command.chatId);
  const byId = new Map(projection.entities.map((entity) => [entity.entityId, entity]));
  for (const id of parsedHistory.data.participantEntityIds) {
    const entity = byId.get(projection.entityIdMap.get(id) ?? id);
    if (!entity || (entity.kind !== "character" && entity.kind !== "organization"))
      throw new CampaignMemoryMutationError(
        "CAMPAIGN_MEMORY_INVALID_REFERENCE",
        `World History participant ${id} is unavailable`,
      );
  }
  if (parsedHistory.data.locationEntityId) {
    const id = parsedHistory.data.locationEntityId;
    const entity = byId.get(projection.entityIdMap.get(id) ?? id);
    if (!entity || entity.kind !== "location")
      throw new CampaignMemoryMutationError(
        "CAMPAIGN_MEMORY_INVALID_REFERENCE",
        `World History location ${id} is unavailable`,
      );
  }
}
function hasWorldHistoryAttribute(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attributes = (value as { attributes?: unknown }).attributes;
  return Boolean(
    attributes &&
    typeof attributes === "object" &&
    !Array.isArray(attributes) &&
    Object.hasOwn(attributes, "worldHistory"),
  );
}

const FACTION_RELATIONSHIP_TYPES = new Set([
  "allied-with",
  "rival-faction-of",
  "subordinate-to",
  "neutral-faction-toward",
]);

async function factionRelationshipState(
  db: DB,
  chatId: string,
  relationship: { sourceEntityId: string; targetEntityId: string; type: string } | null,
) {
  if (!relationship || !FACTION_RELATIONSHIP_TYPES.has(relationship.type))
    return { requiresFactionWeb: false, validFactionRelationship: false };
  const storage = createCampaignMemoryStorage(db);
  const [source, target] = await Promise.all([
    storage.getEntity({ chatId }, relationship.sourceEntityId),
    storage.getEntity({ chatId }, relationship.targetEntityId),
  ]);
  return {
    // Missing endpoints must fail closed for the broad Wiki route.
    requiresFactionWeb: !source || !target || (source.kind === "organization" && target.kind === "organization"),
    validFactionRelationship: source?.kind === "organization" && target?.kind === "organization",
  };
}

async function semanticMutationFeatures(db: DB, command: CampaignMemoryMutationCommand) {
  const required: ("worldHistory" | "factionWeb")[] = [];
  const storage = createCampaignMemoryStorage(db);
  if (command.recordType === "entity") {
    const existing =
      command.action === "update" ? await storage.getEntity({ chatId: command.chatId }, command.recordId) : null;
    if (
      hasWorldHistoryAttribute(existing) ||
      hasWorldHistoryAttribute(command.action === "create" ? command.input : command.patch)
    )
      required.push("worldHistory");
  }
  if (command.recordType === "relationship") {
    const scope = { chatId: command.chatId };
    const existing = command.action === "update" ? await storage.getRelationship(scope, command.recordId) : null;
    if (command.action === "update" && !existing)
      throw new CampaignMemoryMutationError("CAMPAIGN_MEMORY_NOT_FOUND", `Relationship ${command.recordId} not found`);
    const resulting = command.action === "create" ? command.input : { ...existing!, ...command.patch };
    const [originalState, resultingState] = await Promise.all([
      factionRelationshipState(db, command.chatId, existing),
      factionRelationshipState(db, command.chatId, resulting),
    ]);
    if (originalState.requiresFactionWeb || resultingState.requiresFactionWeb) required.push("factionWeb");
  }
  return required;
}
type MutationSurface = "wiki" | "factionWeb" | "worldHistory";
async function execute(
  app: FastifyInstance,
  reply: FastifyReply,
  chatId: string,
  body: unknown,
  mode: "preview" | "apply",
  surface: MutationSurface = "wiki",
) {
  const required =
    surface === "wiki"
      ? (["campaignMemory", "campaignWiki"] as const)
      : surface === "factionWeb"
        ? (["campaignMemory", "factionWeb"] as const)
        : (["campaignMemory", "worldHistory"] as const);
  if (rejectCampaignSurfaceWhenDisabled(reply, ...required)) return;
  const parsed = parseBody(reply, body);
  if (!parsed) return;
  try {
    const command = buildCommand(chatId, parsed);
    await mapCrossSessionReferences(app.db, command);
    if (surface === "factionWeb") {
      if (command.recordType !== "relationship")
        throw new CampaignMemoryMutationError(
          "CAMPAIGN_MEMORY_INVALID_VALUE",
          "Faction authoring accepts only faction relationships",
        );
      const storage = createCampaignMemoryStorage(app.db);
      const existing = command.action === "update" ? await storage.getRelationship({ chatId }, command.recordId) : null;
      if (command.action === "update" && !existing)
        throw new CampaignMemoryMutationError(
          "CAMPAIGN_MEMORY_NOT_FOUND",
          `Relationship ${command.recordId} not found`,
        );
      const resulting = command.action === "create" ? command.input : { ...existing!, ...command.patch };
      const [originalState, resultingState] = await Promise.all([
        factionRelationshipState(app.db, chatId, existing),
        factionRelationshipState(app.db, chatId, resulting),
      ]);
      if (
        !resultingState.validFactionRelationship ||
        (command.action === "update" && !originalState.validFactionRelationship)
      )
        throw new CampaignMemoryMutationError(
          "CAMPAIGN_MEMORY_INVALID_ENDPOINT_KIND",
          "Faction authoring requires organization-to-organization faction relationships",
        );
    } else if (surface === "worldHistory") {
      if (command.recordType !== "entity")
        throw new CampaignMemoryMutationError(
          "CAMPAIGN_MEMORY_INVALID_VALUE",
          "World History authoring accepts only note entities",
        );
      const storage = createCampaignMemoryStorage(app.db);
      const existing = command.action === "update" ? await storage.getEntity({ chatId }, command.recordId) : null;
      const candidate = command.action === "create" ? command.input : { ...existing, ...command.patch };
      if (
        (command.action === "create" && candidate.kind !== "note") ||
        (command.action === "update" &&
          (!existing || existing.kind !== "note" || !hasWorldHistoryAttribute(existing))) ||
        !hasWorldHistoryAttribute(candidate)
      )
        throw new CampaignMemoryMutationError(
          "CAMPAIGN_MEMORY_INVALID_VALUE",
          "World History authoring requires a note that retains its World History entry",
        );
    }
    await validateWorldHistoryCommand(app.db, command);
    await validateRelationshipEndpoints(app.db, command);
    const semantic = await semanticMutationFeatures(app.db, command);
    const assertWriteAllowed = () => requireCampaignSurface(...required, ...semantic);
    assertWriteAllowed();
    return mode === "preview"
      ? await previewCampaignMemoryMutation(app.db, command)
      : await applyCampaignMemoryMutation(app.db, command, assertWriteAllowed);
  } catch (error) {
    return errorResponse(reply, error);
  }
}

export async function campaignMemoryWriteRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (_request, reply) => {
    if (rejectCampaignFeatureWhenDisabled(reply, "campaignMemory")) return reply;
  });

  const options = { bodyLimit: MAX_BODY_BYTES };
  app.post<{ Params: { chatId: string } }>("/:chatId/memory/mutations/preview", options, async (request, reply) =>
    execute(app, reply, request.params.chatId, request.body, "preview"),
  );
  app.post<{ Params: { chatId: string } }>("/:chatId/memory/mutations", options, async (request, reply) =>
    execute(app, reply, request.params.chatId, request.body, "apply"),
  );
  const leafMutation =
    (surface: "factionWeb" | "worldHistory", mode: "preview" | "apply") =>
    async (request: { params: { chatId: string }; body: unknown }, reply: FastifyReply) =>
      execute(app, reply, request.params.chatId, request.body, mode, surface);
  app.post<{ Params: { chatId: string } }>(
    "/:chatId/memory/factions/mutations/preview",
    options,
    leafMutation("factionWeb", "preview"),
  );
  app.post<{ Params: { chatId: string } }>(
    "/:chatId/memory/factions/mutations",
    options,
    leafMutation("factionWeb", "apply"),
  );
  app.post<{ Params: { chatId: string } }>(
    "/:chatId/memory/world-history/mutations/preview",
    options,
    leafMutation("worldHistory", "preview"),
  );
  app.post<{ Params: { chatId: string } }>(
    "/:chatId/memory/world-history/mutations",
    options,
    leafMutation("worldHistory", "apply"),
  );
  app.post<{ Params: { chatId: string } }>("/:chatId/memory/mutations/compensate", options, async (request, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "campaignWiki")) return;
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
      const storage = createCampaignMemoryStorage(app.db);
      const journal = await storage.listMutationJournal({ chatId: request.params.chatId });
      const original = journal.find((row) => row.operationId === parsed.data.originalOperationId);
      const originalTargets = original
        ? ([original.before, original.after].filter((item) => item && typeof item === "object") as Record<
            string,
            unknown
          >[])
        : [];
      const features: ("worldHistory" | "factionWeb")[] = [];
      if (original?.recordType === "entity" && originalTargets.some(hasWorldHistoryAttribute))
        features.push("worldHistory");
      if (original?.recordType === "relationship") {
        const scoped = await Promise.all(
          originalTargets.map(async (target) => {
            if (typeof target.type !== "string") return true;
            if (!FACTION_RELATIONSHIP_TYPES.has(target.type)) return false;
            if (typeof target.sourceEntityId !== "string" || typeof target.targetEntityId !== "string") return true;
            const [source, destination] = await Promise.all([
              storage.getEntity({ chatId: request.params.chatId }, target.sourceEntityId),
              storage.getEntity({ chatId: request.params.chatId }, target.targetEntityId),
            ]);
            return !source || !destination || (source.kind === "organization" && destination.kind === "organization");
          }),
        );
        if (scoped.some(Boolean) || originalTargets.length === 0) features.push("factionWeb");
      }
      requireCampaignSurface("campaignMemory", "campaignWiki", ...features);
      return await compensateCampaignMemoryMutation(
        app.db,
        {
          ...parsed.data,
          chatId: request.params.chatId,
          actor: "user",
        },
        () => requireCampaignSurface("campaignMemory", "campaignWiki", ...features),
      );
    } catch (error) {
      return errorResponse(reply, error);
    }
  });
  app.post<{ Params: { chatId: string } }>("/:chatId/memory/import/preview", options, async (request, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "campaignWiki")) return;
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
      requireCampaignSurface("campaignMemory", "campaignWiki");
      return safeImportPreview(plan);
    } catch (error) {
      return importErrorResponse(reply, error);
    }
  });
  app.post<{ Params: { chatId: string } }>("/:chatId/memory/import", options, async (request, reply) => {
    if (rejectCampaignSurfaceWhenDisabled(reply, "campaignMemory", "campaignWiki")) return;
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
      requireCampaignSurface("campaignMemory", "campaignWiki");
      const result = await applyCampaignMemoryLegacyImport(app.db, plan, () =>
        requireCampaignSurface("campaignMemory", "campaignWiki"),
      );
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
  const audit =
    (surface: "wiki" | "factionWeb") =>
    async (request: FastifyRequest<{ Params: { chatId: string } }>, reply: FastifyReply) => {
      const required =
        surface === "wiki"
          ? (["campaignMemory", "campaignWiki"] as const)
          : (["campaignMemory", "factionWeb"] as const);
      if (rejectCampaignSurfaceWhenDisabled(reply, ...required)) return;
      const query = querySchema.safeParse(request.query ?? {});
      if (!query.success)
        return reply.status(400).send({
          error: {
            code: "CAMPAIGN_MEMORY_INVALID_VALUE",
            message: "Invalid audit pagination",
            details: query.error.flatten(),
          },
        });
      if (surface === "factionWeb" && !query.data.recordId)
        return reply
          .status(400)
          .send({ error: { code: "CAMPAIGN_MEMORY_INVALID_VALUE", message: "A faction relationship ID is required" } });
      try {
        const chatId = request.params.chatId;
        const storage = createCampaignMemoryStorage(app.db);
        const allRows = await storage.listMutationJournal({ chatId });
        let rows = query.data.recordId
          ? allRows
              .filter((row) => row.recordId === query.data.recordId)
              .reverse()
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          : allRows;
        if (surface === "factionWeb") {
          const relationship = await storage.getRelationship({ chatId }, query.data.recordId!);
          if (!relationship || !FACTION_RELATIONSHIP_TYPES.has(relationship.type))
            return reply
              .status(404)
              .send({ error: { code: "CAMPAIGN_MEMORY_NOT_FOUND", message: "Faction relationship not found" } });
          const [source, target] = await Promise.all([
            storage.getEntity({ chatId }, relationship.sourceEntityId),
            storage.getEntity({ chatId }, relationship.targetEntityId),
          ]);
          if (source?.kind !== "organization" || target?.kind !== "organization")
            return reply
              .status(404)
              .send({ error: { code: "CAMPAIGN_MEMORY_NOT_FOUND", message: "Faction relationship not found" } });
          rows = rows.filter((row) => row.recordType === "relationship");
        }
        if (rejectCampaignSurfaceWhenDisabled(reply, ...required)) return;
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
  app.get<{ Params: { chatId: string } }>("/:chatId/memory/audit", audit("wiki"));
  app.get<{ Params: { chatId: string } }>("/:chatId/memory/factions/audit", audit("factionWeb"));
}
