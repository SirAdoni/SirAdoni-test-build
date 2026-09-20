import { createHash, randomUUID } from "node:crypto";
import type { CampaignMemoryEntity, CampaignMemoryEntityKind, CampaignMemoryEvidence } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { and, desc, eq } from "../../db/file-query.js";
import { campaignMemoryMutationJournal, chats, messages } from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { createCampaignMemoryStorage } from "../storage/campaign-memory.storage.js";
import { readCampaignMemorySources } from "./campaign-memory-sources.js";
import {
  applyCampaignMemoryTransition,
  campaignMemoryTransitionId,
  type CampaignMemoryQuestStatus,
  type CampaignMemoryTransitionCommand,
  type CampaignMemoryTransitionResult,
} from "./campaign-memory-transitions.js";
import { getReputationTier, type ReputationTier } from "./reputation.service.js";

/**
 * Pulse 4 adapters for the legacy game writers (spatial owner turn, presence,
 * quest progress, reputation). The legacy stores stay authoritative for their
 * own fields; each adapter only projects the change into campaign memory as a
 * typed transition. Every emission is best-effort: a failure is logged and never
 * fails the player's turn, and the deterministic transition ID (source message +
 * active swipe + natural key) makes a repeat of the same turn a replay.
 */
export type LegacyTransitionStatus = "applied" | "pending" | "stale" | "skipped" | "failed";
export interface LegacyTransitionOutcome {
  status: LegacyTransitionStatus;
  transitionId?: string;
  reasons: string[];
  result?: CampaignMemoryTransitionResult;
}
export type LegacyJournalQuestStatus = "active" | "completed" | "failed";
export interface LegacyReputationChange {
  npcId: string;
  npcName: string;
  action: string;
  previousReputation: number;
  newReputation: number;
}

const EVIDENCE_QUOTE_LIMIT = 160;
type Storage = ReturnType<typeof createCampaignMemoryStorage>;
type Source = { sourceHash: string; order: string; evidence: CampaignMemoryEvidence[] };
type OwnerMatch = { kind: CampaignMemoryEntityKind; stores: readonly string[]; recordId: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : isRecord(value)
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, stable(v)]),
        )
      : value;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
const skipped = (reason: string): LegacyTransitionOutcome => ({ status: "skipped", reasons: [reason] });
const unregisteredId = (match: OwnerMatch) => `unregistered:${match.kind}:${match.recordId}`;

/** First non-blank line of the active swipe, so the quote is verifiably present in the source. */
function evidenceQuote(content: string): string {
  const line = content
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ? line.slice(0, EVIDENCE_QUOTE_LIMIT) : "";
}

/** The newest message of the chat, for legacy routes that carry no message anchor of their own. */
export async function resolveLegacySourceMessageId(
  db: DB,
  chatId: string,
  preferred?: string | null,
): Promise<string | null> {
  if (typeof preferred === "string" && preferred.trim()) return preferred;
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

class LegacyWriterContext {
  private entities: Promise<CampaignMemoryEntity[]> | null = null;
  readonly storage: Storage;
  constructor(
    readonly db: DB,
    readonly chatId: string,
  ) {
    this.storage = createCampaignMemoryStorage(db);
  }
  /** Null when the message is not on a game chat or carries no quotable text. */
  async source(messageId: string): Promise<Source | null> {
    const sources = await readCampaignMemorySources(this.db, { chatId: this.chatId, messageIds: [messageId] });
    const source = sources.get(messageId);
    if (!source?.captureOrder) return null;
    const quote = evidenceQuote(source.content);
    if (!quote) return null;
    return {
      sourceHash: source.sourceHash,
      order: source.captureOrder,
      evidence: [{ messageId, quote, sourceHash: source.sourceHash }],
    };
  }
  async entity(match: OwnerMatch): Promise<CampaignMemoryEntity | null> {
    this.entities ??= this.storage.listEntities({ chatId: this.chatId });
    return (
      (await this.entities).find(
        (row) =>
          row.kind === match.kind &&
          row.owner.type === "existing" &&
          match.stores.includes(row.owner.store) &&
          row.owner.recordId === match.recordId,
      ) ?? null
    );
  }
  async personaId(): Promise<string | null> {
    const rows = await this.db.select({ personaId: chats.personaId }).from(chats).where(eq(chats.id, this.chatId));
    return rows[0]?.personaId ?? null;
  }
}

/** Nothing is written for an unregistered participant; the decision is journaled once under `<transitionId>/pending`. */
async function journalPending(
  ctx: LegacyWriterContext,
  command: CampaignMemoryTransitionCommand,
  source: Source,
  reasons: string[],
): Promise<LegacyTransitionOutcome> {
  const transitionId = campaignMemoryTransitionId(command, source.sourceHash);
  const operationId = `${transitionId}/pending`;
  const result: CampaignMemoryTransitionResult = {
    transitionId,
    chatId: command.chatId,
    class: command.class,
    status: "pending",
    order: source.order,
    sourceHash: source.sourceHash,
    reasons,
    operations: [],
    replayed: false,
  };
  const replayed = await ctx.db.transaction(
    async (tx) => {
      const held = await tx
        .select({ journalId: campaignMemoryMutationJournal.journalId })
        .from(campaignMemoryMutationJournal)
        .where(
          and(
            eq(campaignMemoryMutationJournal.chatId, command.chatId),
            eq(campaignMemoryMutationJournal.operationId, operationId),
          ),
        )
        .limit(1);
      if (held[0]) return true;
      await tx.insert(campaignMemoryMutationJournal).values({
        journalId: randomUUID(),
        chatId: command.chatId,
        operationId,
        recordType: "transition",
        recordId: transitionId,
        actor: command.actor,
        expectedRevision: null,
        before: null,
        after: JSON.stringify(result),
        reason: command.reason,
        evidence: JSON.stringify(command.evidence),
        compensationOperationId: null,
        payloadHash: hash(command),
        createdAt: new Date().toISOString(),
      });
      return false;
    },
    { durable: true },
  );
  return { status: "pending", transitionId, reasons, result: { ...result, replayed } };
}

async function emit(
  ctx: LegacyWriterContext,
  label: string,
  command: CampaignMemoryTransitionCommand,
  source: Source,
  missing: string[],
): Promise<LegacyTransitionOutcome> {
  try {
    if (missing.length) return await journalPending(ctx, command, source, missing);
    const result = await applyCampaignMemoryTransition(ctx.db, command);
    return { status: result.status, transitionId: result.transitionId, reasons: result.reasons, result };
  } catch (error) {
    logger.warn(
      { err: error, chatId: command.chatId, class: command.class, messageId: command.source.messageId },
      "[campaign-memory] Legacy %s transition was not recorded",
      label,
    );
    return { status: "failed", reasons: [error instanceof Error ? error.message : String(error)] };
  }
}

function withContext(db: DB, chatId: string, messageId: string | null, label: string) {
  if (!messageId) return { ctx: null, outcome: skipped(`${label}: no source message on chat ${chatId}`) };
  return { ctx: new LegacyWriterContext(db, chatId), outcome: null };
}

/** Spatial owner turn: the party (chat persona) moved; the spatial snapshot stays the location owner. */
export async function recordLegacyMovement(
  db: DB,
  input: { chatId: string; messageId: string; toLocationId: string; fromLocationId?: string | null },
): Promise<LegacyTransitionOutcome> {
  try {
    const ctx = new LegacyWriterContext(db, input.chatId);
    const source = await ctx.source(input.messageId);
    if (!source) return skipped("movement: source message is not a quotable game-chat message");
    const personaId = await ctx.personaId();
    const mover: OwnerMatch = { kind: "persona", stores: ["personas"], recordId: personaId ?? "" };
    const place: OwnerMatch = { kind: "location", stores: ["spatial-context"], recordId: input.toLocationId };
    const [moverEntity, placeEntity] = personaId
      ? await Promise.all([ctx.entity(mover), ctx.entity(place)])
      : [null, await ctx.entity(place)];
    const missing = [
      ...(personaId ? [] : ["chat has no persona to move"]),
      ...(personaId && !moverEntity ? [`persona ${personaId} has no registered campaign-memory entity`] : []),
      ...(placeEntity ? [] : [`location ${input.toLocationId} has no registered campaign-memory entity`]),
    ];
    return emit(
      ctx,
      "movement",
      {
        class: "movement",
        chatId: input.chatId,
        actor: "system",
        reason: `Spatial owner turn moved the party from ${input.fromLocationId ?? "an unknown location"} to ${input.toLocationId}`,
        source: { messageId: input.messageId, sourceHash: source.sourceHash },
        evidence: source.evidence,
        basis: "observed",
        entityId: moverEntity?.entityId ?? unregisteredId(mover),
        locationEntityId: placeEntity?.entityId ?? unregisteredId(place),
        presence: "present",
      },
      source,
      missing,
    );
  } catch (error) {
    logger.warn({ err: error, chatId: input.chatId }, "[campaign-memory] Legacy movement transition was not recorded");
    return { status: "failed", reasons: [error instanceof Error ? error.message : String(error)] };
  }
}

const presentIds = (value: unknown): string[] => {
  let rows: unknown = value;
  if (typeof rows === "string") {
    try {
      rows = JSON.parse(rows) as unknown;
    } catch {
      rows = [];
    }
  }
  if (!Array.isArray(rows)) return [];
  return [
    ...new Set(
      rows.flatMap((row) => {
        const id = isRecord(row) ? row.characterId : undefined;
        return typeof id === "string" && id.trim() ? [id.trim()] : [];
      }),
    ),
  ];
};

/** Present-characters edits: one presence transition per character that arrived or left. */
export async function recordLegacyPresence(
  db: DB,
  input: {
    chatId: string;
    messageId: string | null;
    before: unknown;
    after: unknown;
    locationId: string | null;
  },
): Promise<LegacyTransitionOutcome[]> {
  const { ctx, outcome } = withContext(db, input.chatId, input.messageId, "presence");
  if (!ctx) return [outcome!];
  try {
    const before = new Set(presentIds(input.before));
    const after = new Set(presentIds(input.after));
    const changes = [
      ...[...after].filter((id) => !before.has(id)).map((id) => ({ id, presence: "present" as const })),
      ...[...before].filter((id) => !after.has(id)).map((id) => ({ id, presence: "absent" as const })),
    ];
    if (!changes.length) return [];
    const source = await ctx.source(input.messageId!);
    if (!source) return [skipped("presence: source message is not a quotable game-chat message")];
    const place: OwnerMatch = { kind: "location", stores: ["spatial-context"], recordId: input.locationId ?? "" };
    const placeEntity = input.locationId ? await ctx.entity(place) : null;
    const outcomes: LegacyTransitionOutcome[] = [];
    for (const change of changes) {
      const who: OwnerMatch = { kind: "character", stores: ["characters", "game-npcs"], recordId: change.id };
      const whoEntity = await ctx.entity(who);
      const missing = [
        ...(whoEntity ? [] : [`character ${change.id} has no registered campaign-memory entity`]),
        ...(input.locationId ? [] : ["presence changed without an authoritative location"]),
        ...(input.locationId && !placeEntity
          ? [`location ${input.locationId} has no registered campaign-memory entity`]
          : []),
      ];
      outcomes.push(
        await emit(
          ctx,
          "presence",
          {
            class: "movement",
            chatId: input.chatId,
            actor: "system",
            reason: `Character Tracker marked ${change.id} ${change.presence} at ${input.locationId ?? "an unknown location"}`,
            source: { messageId: input.messageId!, sourceHash: source.sourceHash },
            evidence: source.evidence,
            basis: "observed",
            entityId: whoEntity?.entityId ?? unregisteredId(who),
            locationEntityId: placeEntity?.entityId ?? unregisteredId(place),
            presence: change.presence,
          },
          source,
          missing,
        ),
      );
    }
    return outcomes;
  } catch (error) {
    logger.warn(
      { err: error, chatId: input.chatId },
      "[campaign-memory] Legacy presence transitions were not recorded",
    );
    return [{ status: "failed", reasons: [error instanceof Error ? error.message : String(error)] }];
  }
}

const QUEST_STATUS: Record<LegacyJournalQuestStatus, CampaignMemoryQuestStatus> = {
  active: "active",
  completed: "completed",
  failed: "cancelled",
};

/** Journal quest progress; the state machine decides, and an illegal legacy jump is journaled pending, never rejected. */
export async function recordLegacyQuestProgress(
  db: DB,
  input: { chatId: string; messageId: string | null; questEntryId: string; status: LegacyJournalQuestStatus },
): Promise<LegacyTransitionOutcome> {
  const { ctx, outcome } = withContext(db, input.chatId, input.messageId, "quest");
  if (!ctx) return outcome!;
  try {
    const source = await ctx.source(input.messageId!);
    if (!source) return skipped("quest: source message is not a quotable game-chat message");
    const quest: OwnerMatch = { kind: "quest", stores: ["game-state"], recordId: input.questEntryId };
    const questEntity = await ctx.entity(quest);
    return emit(
      ctx,
      "quest",
      {
        class: "quest",
        chatId: input.chatId,
        actor: "system",
        reason: `Quest journal marked ${input.questEntryId} ${input.status}`,
        source: { messageId: input.messageId!, sourceHash: source.sourceHash },
        evidence: source.evidence,
        basis: "observed",
        questEntityId: questEntity?.entityId ?? unregisteredId(quest),
        status: QUEST_STATUS[input.status],
        ...(input.status === "failed" ? { outcome: "failed" } : {}),
      },
      source,
      questEntity ? [] : [`quest ${input.questEntryId} has no registered campaign-memory entity`],
    );
  } catch (error) {
    logger.warn({ err: error, chatId: input.chatId }, "[campaign-memory] Legacy quest transition was not recorded");
    return { status: "failed", reasons: [error instanceof Error ? error.message : String(error)] };
  }
}

export const reputationRelationshipType = (tier: ReputationTier) => `reputation:${tier}`;

/**
 * Reputation: the qualitative standing (tier) becomes a typed NPC -> persona edge;
 * the numeric score stays in `chat.metadata.gameNpcs` and never enters campaign memory.
 * A tier change ends the previous standing edge and activates the new one.
 */
export async function recordLegacyReputation(
  db: DB,
  input: { chatId: string; messageId: string | null; changes: readonly LegacyReputationChange[] },
): Promise<LegacyTransitionOutcome[]> {
  const { ctx, outcome } = withContext(db, input.chatId, input.messageId, "reputation");
  if (!ctx) return [outcome!];
  try {
    if (!input.changes.length) return [];
    const source = await ctx.source(input.messageId!);
    if (!source) return [skipped("reputation: source message is not a quotable game-chat message")];
    const personaId = await ctx.personaId();
    const party: OwnerMatch = { kind: "persona", stores: ["personas"], recordId: personaId ?? "" };
    const partyEntity = personaId ? await ctx.entity(party) : null;
    const outcomes: LegacyTransitionOutcome[] = [];
    for (const change of input.changes) {
      const npc: OwnerMatch = { kind: "character", stores: ["game-npcs", "characters"], recordId: change.npcId };
      const npcEntity = await ctx.entity(npc);
      const missing = [
        ...(npcEntity ? [] : [`NPC ${change.npcId} has no registered campaign-memory entity`]),
        ...(personaId ? [] : ["chat has no persona to hold the standing"]),
        ...(personaId && !partyEntity ? [`persona ${personaId} has no registered campaign-memory entity`] : []),
      ];
      const previousTier = getReputationTier(change.previousReputation);
      const newTier = getReputationTier(change.newReputation);
      const edge = (tier: ReputationTier, status: "active" | "ended"): CampaignMemoryTransitionCommand => ({
        class: "relationship",
        chatId: input.chatId,
        actor: "system",
        reason: `${change.npcName} reacted to "${change.action}": standing ${previousTier} -> ${newTier}`,
        source: { messageId: input.messageId!, sourceHash: source.sourceHash },
        evidence: source.evidence,
        basis: "observed",
        sourceEntityId: npcEntity?.entityId ?? unregisteredId(npc),
        targetEntityId: partyEntity?.entityId ?? unregisteredId(party),
        type: reputationRelationshipType(tier),
        inverseLabel: `party-standing:${tier}`,
        status,
      });
      if (previousTier !== newTier)
        outcomes.push(await emit(ctx, "reputation", edge(previousTier, "ended"), source, missing));
      outcomes.push(await emit(ctx, "reputation", edge(newTier, "active"), source, missing));
    }
    return outcomes;
  } catch (error) {
    logger.warn(
      { err: error, chatId: input.chatId },
      "[campaign-memory] Legacy reputation transitions were not recorded",
    );
    return [{ status: "failed", reasons: [error instanceof Error ? error.message : String(error)] }];
  }
}
