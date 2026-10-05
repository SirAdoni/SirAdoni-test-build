import { createHash } from "node:crypto";
import { worldHistorySchema } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { and, eq } from "../../db/file-query.js";
import { campaignMemoryEntities, campaignMemoryMutationJournal } from "../../db/schema/index.js";
import { parseCampaignMemoryMessageOrder } from "./campaign-memory-order.js";

type EntityRecord = {
  entityId: string;
  chatId: string;
  kind: string;
  owner: unknown;
  aliases: unknown;
  tags: unknown;
  summary: unknown;
  body: unknown;
  attributes: unknown;
  status: unknown;
  manualLock: unknown;
  provenance: unknown;
  revision: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

type HeldRecord = { recordType: "entity"; recordId: string; reason: string };
type HistorySnapshot = { journal: (typeof campaignMemoryMutationJournal.$inferSelect)[] };

const objectValue = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const arrayValue = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const parseArray = (value: unknown): unknown[] | null => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const timestampIsCanonical = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === value
  );
};

const stableId = (kind: string, ...parts: string[]) =>
  `cmbranch_${createHash("sha256")
    .update([kind, ...parts].join("\u0000"))
    .digest("hex")}`;

function parseEntity(value: unknown, sourceChatId: string, sourceEntityId: string): EntityRecord | null {
  const parsed = objectValue(value);
  if (
    parsed.entityId !== sourceEntityId ||
    parsed.chatId !== sourceChatId ||
    typeof parsed.kind !== "string" ||
    !parsed.kind ||
    !timestampIsCanonical(parsed.createdAt) ||
    !timestampIsCanonical(parsed.updatedAt)
  )
    return null;
  const owner = objectValue(parsed.owner);
  if (owner.type !== "registry" || owner.store !== "campaign-memory" || owner.recordId !== sourceEntityId) return null;
  return parsed as unknown as EntityRecord;
}

function worldHistory(value: EntityRecord) {
  if (value.kind !== "note") return null;
  const result = worldHistorySchema.safeParse(objectValue(value.attributes).worldHistory);
  return result.success ? result.data : null;
}

function hasWorldHistory(value: EntityRecord | undefined): boolean {
  return !!value && value.kind === "note" && Object.hasOwn(objectValue(value.attributes), "worldHistory");
}

function entityRow(value: EntityRecord, targetChatId: string, entityId: string, history?: unknown) {
  return {
    entityId,
    chatId: targetChatId,
    kind: value.kind,
    owner: JSON.stringify({ type: "registry", store: "campaign-memory", recordId: entityId }),
    aliases: JSON.stringify(arrayValue(value.aliases)),
    tags: JSON.stringify(arrayValue(value.tags)),
    summary: typeof value.summary === "string" ? value.summary : null,
    body: typeof value.body === "string" ? value.body : null,
    attributes: JSON.stringify(history ? { worldHistory: history } : objectValue(value.attributes)),
    status: typeof value.status === "string" ? value.status : "active",
    manualLock: value.manualLock === true || value.manualLock === 1 ? 1 : 0,
    provenance: JSON.stringify(objectValue(value.provenance)),
    revision: typeof value.revision === "number" && Number.isInteger(value.revision) ? value.revision : 1,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
  };
}

/**
 * Copy manually authored World History into a same-session chat branch.
 * Journal timestamps are the only safe cutoff evidence here: snapshots at the
 * message timestamp, tied snapshots, malformed snapshots and missing proof
 * are held rather than guessed into the child.
 */
export async function projectCampaignMemoryBranch(
  db: DB,
  input: {
    sourceChatId: string;
    targetChatId: string;
    cutoffOrder: string;
    messageIdMap: Readonly<Record<string, string>>;
    operationId: string;
  },
) {
  const cutoff = parseCampaignMemoryMessageOrder(input.cutoffOrder);
  if (!cutoff) throw new Error("CAMPAIGN_MEMORY_BRANCH_INVALID_CUTOFF");
  if (!input.operationId.trim()) throw new Error("CAMPAIGN_MEMORY_BRANCH_INVALID_OPERATION");

  const [sourceRows, journalRows] = await Promise.all([
    db.select().from(campaignMemoryEntities).where(eq(campaignMemoryEntities.chatId, input.sourceChatId)),
    db
      .select()
      .from(campaignMemoryMutationJournal)
      .where(
        and(
          eq(campaignMemoryMutationJournal.chatId, input.sourceChatId),
          eq(campaignMemoryMutationJournal.recordType, "entity"),
        ),
      ),
  ]);
  const sourceById = new Map(sourceRows.map((row) => [row.entityId, row as EntityRecord]));
  const journalsById = new Map<string, (typeof journalRows)[number][]>();
  for (const row of journalRows) {
    const entries = journalsById.get(row.recordId) ?? [];
    entries.push(row);
    journalsById.set(row.recordId, entries);
  }

  const historyIds = new Set<string>();
  for (const row of sourceRows) if (hasWorldHistory(row as EntityRecord)) historyIds.add(row.entityId);
  for (const row of journalRows) {
    if (typeof row.after === "string" && row.after.includes("worldHistory")) historyIds.add(row.recordId);
  }

  const held: HeldRecord[] = [];
  const hold = (recordId: string, reason: string) => {
    if (!held.some((entry) => entry.recordId === recordId)) held.push({ recordType: "entity", recordId, reason });
  };
  const selected = new Map<string, HistorySnapshot>();
  for (const entityId of historyIds) {
    const current = sourceById.get(entityId);
    const rows = journalsById.get(entityId) ?? [];
    if (!current || current.kind !== "note") {
      hold(entityId, "History entity is missing or has an unsupported kind");
      continue;
    }
    if (rows.length === 0) {
      hold(entityId, "No mutation-journal proof exists for this history entry");
      continue;
    }
    if (rows.some((row) => !timestampIsCanonical(row.createdAt))) {
      hold(entityId, "Mutation-journal timestamp is malformed");
      continue;
    }
    if (rows.some((row) => row.createdAt === cutoff.createdAt)) {
      hold(entityId, "Mutation-journal snapshot ties the branch cutoff timestamp");
      continue;
    }
    const beforeCutoff = rows.filter((row) => (row.createdAt as string) < cutoff.createdAt);
    if (!beforeCutoff.length) {
      hold(entityId, "No mutation-journal snapshot is strictly before the branch cutoff");
      continue;
    }
    const byTime = new Map<string, (typeof rows)[number]>();
    let invalidSnapshot = false;
    for (const row of beforeCutoff) {
      if (byTime.has(row.createdAt as string)) {
        hold(entityId, "Multiple mutation snapshots share a timestamp");
        invalidSnapshot = true;
        break;
      }
      const snapshot = parseEntity(row.after, input.sourceChatId, entityId);
      if (!snapshot || snapshot.updatedAt !== row.createdAt) {
        hold(entityId, "A pre-cutoff mutation snapshot is malformed or has mismatched ownership");
        invalidSnapshot = true;
        break;
      }
      byTime.set(row.createdAt as string, row);
    }
    if (invalidSnapshot) continue;
    const ordered = [...beforeCutoff].sort((a, b) => (a.createdAt as string).localeCompare(b.createdAt as string));
    const latest = ordered.at(-1)!;
    const entity = parseEntity(latest.after, input.sourceChatId, entityId)!;
    if (!worldHistory(entity)) {
      hold(entityId, "The latest provable pre-cutoff snapshot has no valid World History data");
      continue;
    }
    selected.set(entityId, { journal: ordered });
  }

  const idMap: Record<string, string> = {};
  for (const entityId of selected.keys()) {
    idMap[entityId] = stableId("entity", input.targetChatId, input.sourceChatId, input.operationId, entityId);
  }

  // Referenced identities without their own history are copied only when they
  // are self-owned registry rows whose creation has not been edited since.
  const dependencies = new Set<string>();
  const canCopyDependency = (entityId: string) => {
    const row = sourceById.get(entityId);
    if (!row || hasWorldHistory(row)) return false;
    const owner = objectValue(row.owner);
    return (
      owner.type === "registry" &&
      owner.store === "campaign-memory" &&
      owner.recordId === entityId &&
      timestampIsCanonical(row.createdAt) &&
      timestampIsCanonical(row.updatedAt) &&
      row.createdAt === row.updatedAt &&
      row.createdAt < cutoff.createdAt
    );
  };

  const refsByEntity = new Map<string, Set<string>>();
  for (const [entityId, snapshot] of selected) {
    const refs = new Set<string>();
    for (const journal of snapshot.journal) {
      for (const raw of [journal.before, journal.after]) {
        if (raw === null) continue;
        const entity = parseEntity(raw, input.sourceChatId, entityId);
        if (!entity) {
          hold(entityId, "A pre-cutoff mutation snapshot is malformed or has mismatched ownership");
          continue;
        }
        const attrs = objectValue(entity.attributes);
        if (!Object.hasOwn(attrs, "worldHistory")) continue;
        const parsed = worldHistorySchema.safeParse(attrs.worldHistory);
        if (!parsed.success) {
          hold(entityId, "A pre-cutoff mutation snapshot has malformed World History data");
          continue;
        }
        for (const id of parsed.data.participantEntityIds) refs.add(id);
        if (parsed.data.locationEntityId) refs.add(parsed.data.locationEntityId);
      }
      const evidenceEntries = parseArray(journal.evidence);
      if (!evidenceEntries) {
        hold(entityId, "Mutation-journal evidence is malformed");
        continue;
      }
      for (const evidence of evidenceEntries) {
        const item = objectValue(evidence);
        const messageId = item.messageId;
        if (
          typeof messageId !== "string" ||
          !input.messageIdMap[messageId] ||
          typeof item.quote !== "string" ||
          !item.quote.trim() ||
          (item.sourceHash !== undefined &&
            (typeof item.sourceHash !== "string" || !/^[a-f0-9]{64}$/iu.test(item.sourceHash)))
        ) {
          hold(entityId, "Mutation-journal evidence points outside the copied message prefix");
        }
      }
    }
    refsByEntity.set(entityId, refs);
  }

  // Resolve the full identity closure before materializing anything. A record
  // that points at a held record must also be held, independent of row order.
  for (const [entityId, refs] of refsByEntity) {
    for (const ref of refs) {
      if (selected.has(ref)) continue;
      if (canCopyDependency(ref)) {
        dependencies.add(ref);
        idMap[ref] = stableId("entity", input.targetChatId, input.sourceChatId, input.operationId, ref);
      } else {
        hold(entityId, `World History reference ${ref} is missing, future-dated, ambiguous or unavailable`);
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    const copyableOperations = new Set(
      [...selected.keys()]
        .filter((id) => !held.some((entry) => entry.recordId === id))
        .flatMap((id) => selected.get(id)!.journal.map((row) => row.operationId)),
    );
    for (const [entityId, refs] of refsByEntity) {
      if (held.some((entry) => entry.recordId === entityId)) continue;
      const unsafe = [...refs].find((ref) => selected.has(ref) && held.some((entry) => entry.recordId === ref));
      if (unsafe) {
        hold(entityId, `World History reference ${unsafe} could not be copied safely`);
        changed = true;
      }
    }
    for (const [entityId, snapshot] of selected) {
      if (held.some((entry) => entry.recordId === entityId)) continue;
      if (
        snapshot.journal.some(
          (row) => row.compensationOperationId && !copyableOperations.has(row.compensationOperationId),
        )
      ) {
        hold(entityId, "Mutation-journal compensation points to an operation outside the copied prefix");
        changed = true;
      }
    }
  }

  const safeIds = new Set([...selected.keys()].filter((id) => !held.some((entry) => entry.recordId === id)));
  for (const item of held) if (historyIds.has(item.recordId)) delete idMap[item.recordId];
  const usedDependencies = new Set(
    [...safeIds].flatMap((id) => [...(refsByEntity.get(id) ?? [])].filter((ref) => dependencies.has(ref))),
  );
  for (const id of [...dependencies]) if (!usedDependencies.has(id)) delete idMap[id];
  const remappedHistory = new Map<string, unknown>();
  for (const entityId of safeIds) {
    const snapshot = selected.get(entityId)!;
    const entity = parseEntity(snapshot.journal.at(-1)!.after, input.sourceChatId, entityId)!;
    const history = worldHistory(entity)!;
    remappedHistory.set(
      entityId,
      worldHistorySchema.parse({
        ...history,
        participantEntityIds: history.participantEntityIds.map((id) => idMap[id]!),
        locationEntityId: history.locationEntityId ? idMap[history.locationEntityId]! : null,
      }),
    );
  }

  const copied = { entities: 0 };
  const opIdMap = new Map<string, string>();
  for (const entityId of safeIds) {
    for (const journal of selected.get(entityId)!.journal) {
      opIdMap.set(
        journal.operationId,
        stableId("operation", input.targetChatId, input.sourceChatId, input.operationId, journal.operationId),
      );
    }
  }

  await db.transaction(async (tx) => {
    for (const entityId of [...safeIds, ...usedDependencies]) {
      const existing = (
        await tx
          .select()
          .from(campaignMemoryEntities)
          .where(eq(campaignMemoryEntities.entityId, idMap[entityId]!))
          .limit(1)
      )[0];
      if (!existing) {
        const source = safeIds.has(entityId)
          ? parseEntity(selected.get(entityId)!.journal.at(-1)!.after, input.sourceChatId, entityId)!
          : sourceById.get(entityId)!;
        await tx
          .insert(campaignMemoryEntities)
          .values(entityRow(source, input.targetChatId, idMap[entityId]!, remappedHistory.get(entityId)));
      } else if (existing.chatId !== input.targetChatId) {
        hold(entityId, "Deterministic branch ID is already owned by another chat");
        throw new Error("CAMPAIGN_MEMORY_BRANCH_ID_COLLISION");
      }
      copied.entities++;
    }

    for (const entityId of safeIds) {
      for (const journal of selected.get(entityId)!.journal) {
        const journalId = stableId(
          "journal",
          input.targetChatId,
          input.sourceChatId,
          input.operationId,
          journal.journalId,
        );
        const existing = (
          await tx
            .select()
            .from(campaignMemoryMutationJournal)
            .where(eq(campaignMemoryMutationJournal.journalId, journalId))
            .limit(1)
        )[0];
        if (existing) continue;
        const remapSnapshot = (raw: string | null) => {
          if (raw === null) return null;
          const source = parseEntity(raw, input.sourceChatId, entityId);
          if (!source) throw new Error("CAMPAIGN_MEMORY_BRANCH_INVALID_JOURNAL_SNAPSHOT");
          const snapshotHistory = worldHistory(source);
          const mapped = snapshotHistory
            ? worldHistorySchema.parse({
                ...snapshotHistory,
                participantEntityIds: snapshotHistory.participantEntityIds.map((id) => idMap[id]!),
                locationEntityId: snapshotHistory.locationEntityId ? idMap[snapshotHistory.locationEntityId]! : null,
              })
            : null;
          return JSON.stringify({
            ...entityRow(source, input.targetChatId, idMap[entityId]!, mapped),
            owner: { type: "registry", store: "campaign-memory", recordId: idMap[entityId]! },
            aliases: arrayValue(source.aliases),
            tags: arrayValue(source.tags),
            attributes: mapped ? { worldHistory: mapped } : {},
            provenance: objectValue(source.provenance),
            manualLock: source.manualLock === true || source.manualLock === 1,
            chatId: input.targetChatId,
          });
        };
        const journalEvidence = parseArray(journal.evidence);
        if (!journalEvidence) throw new Error("CAMPAIGN_MEMORY_BRANCH_MALFORMED_EVIDENCE");
        const evidence = journalEvidence.map((entry) => {
          const item = objectValue(entry);
          const targetMessageId = typeof item.messageId === "string" ? input.messageIdMap[item.messageId] : undefined;
          if (!targetMessageId) throw new Error("CAMPAIGN_MEMORY_BRANCH_UNMAPPED_EVIDENCE");
          return { ...item, messageId: targetMessageId };
        });
        const after = remapSnapshot(journal.after);
        const before = remapSnapshot(journal.before);
        const operationId = opIdMap.get(journal.operationId);
        if (!operationId) throw new Error("CAMPAIGN_MEMORY_BRANCH_OPERATION_MAP_MISSING");
        await tx.insert(campaignMemoryMutationJournal).values({
          journalId,
          chatId: input.targetChatId,
          operationId,
          recordType: "entity",
          recordId: idMap[entityId]!,
          actor: journal.actor,
          expectedRevision: journal.expectedRevision,
          before,
          after,
          reason: journal.reason,
          evidence: JSON.stringify(evidence),
          compensationOperationId: journal.compensationOperationId
            ? (opIdMap.get(journal.compensationOperationId) ??
              (() => {
                throw new Error("CAMPAIGN_MEMORY_BRANCH_COMPENSATION_MAP_MISSING");
              })())
            : null,
          payloadHash: createHash("sha256")
            .update(`${before ?? ""}\u0000${after ?? ""}`)
            .digest("hex"),
          createdAt: journal.createdAt,
        });
      }
    }
  });

  return { copied, held, idMap, messageIdMap: { ...input.messageIdMap } };
}
