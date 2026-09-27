import type { CampaignMemoryEntity, GameContinuityReceipt } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { lorebookEntries } from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { createLLMProvider } from "../llm/provider-registry.js";
import { resolveBaseUrl } from "../generation/connection-base-url.js";
import { createCampaignMemoryStorage } from "../storage/campaign-memory.storage.js";
import { createConnectionsStorage } from "../storage/connections.storage.js";
import { createGameContinuityStorage } from "../storage/game-continuity.storage.js";
import { applyCampaignMemoryTransition, type CampaignMemoryTransitionCommand } from "./campaign-memory-transitions.js";
import { parseContinuityJson, readContinuityConfig } from "./continuity-provider.js";

/**
 * Movements and relationships from published continuity records.
 *
 * Extraction reads each turn into plain-text records ("Faelan returned with the woman to the library"). The
 * transition layer can only move a person or link two people when it knows exactly who and where, and guessing
 * that from wording left current state nearly empty and relationships at zero. This pass asks the continuity model
 * one narrow question about records that are already verified and published: which of them state that a named
 * person arrived somewhere or left, and which establish, change or end a relationship between two named people.
 * Names must come from the registered lists it is given, and anything that does not resolve to exactly one
 * registered person or place is dropped rather than guessed.
 */

export const CONTINUITY_STRUCTURE_VERSION = 1;
const MAX_RECORDS_PER_CALL = 60;

/** Relationship types a person-to-person link may use, with the label read from the other side. */
export const CONTINUITY_RELATIONSHIP_TYPES: Readonly<Record<string, string>> = {
  "stranger-to": "regarded-as-stranger-by",
  "acquaintance-of": "regarded-as-acquaintance-by",
  "neutral-toward": "treated-neutrally-by",
  "suspicious-of": "suspected-by",
  "friend-of": "friend-of",
  "enemy-of": "enemy-of",
  "arch-nemesis-of": "regarded-as-arch-nemesis-by",
  "eternal-ally-of": "regarded-as-eternal-ally-by",
  "rival-of": "rival-of",
  loves: "loved-by",
  hates: "hated-by",
  trusts: "trusted-by",
  distrusts: "distrusted-by",
  "parent-of": "child-of",
  "child-of": "parent-of",
  "sibling-of": "sibling-of",
  "spouse-of": "spouse-of",
  "betrothed-to": "betrothed-to",
  "lover-of": "lover-of",
  "mentor-of": "student-of",
  "student-of": "mentor-of",
  "allied-with": "allied-with",
  serves: "served-by",
  employs: "employed-by",
  "sworn-to": "holds-oath-of",
};

export interface ContinuityStructureMovement {
  recordId: string;
  who: string[];
  to: string;
  presence: "present" | "absent";
}
export interface ContinuityStructureRelationship {
  recordId: string;
  source: string;
  target: string;
  type: string;
  status: "active" | "ended" | "proposed";
}
export interface ContinuityStructure {
  movements: ContinuityStructureMovement[];
  relationships: ContinuityStructureRelationship[];
}

export interface ContinuityStructureResult {
  receipts: number;
  calls: number;
  movementsApplied: number;
  relationshipsApplied: number;
  dropped: Record<string, number>;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

/** Keep only well-formed entries; the model's answer is untrusted input. */
export function parseContinuityStructure(value: unknown, recordIds: ReadonlySet<string>): ContinuityStructure {
  const root = objectValue(value);
  const movements: ContinuityStructureMovement[] = [];
  for (const item of Array.isArray(root.movements) ? root.movements : []) {
    const entry = objectValue(item);
    const recordId = typeof entry.recordId === "string" ? entry.recordId : "";
    const to = typeof entry.to === "string" ? entry.to.trim() : "";
    const who = strings(entry.who);
    if (!recordIds.has(recordId) || !to || !who.length) continue;
    movements.push({ recordId, who, to, presence: entry.presence === "absent" ? "absent" : "present" });
  }
  const relationships: ContinuityStructureRelationship[] = [];
  for (const item of Array.isArray(root.relationships) ? root.relationships : []) {
    const entry = objectValue(item);
    const recordId = typeof entry.recordId === "string" ? entry.recordId : "";
    const source = typeof entry.source === "string" ? entry.source.trim() : "";
    const target = typeof entry.target === "string" ? entry.target.trim() : "";
    const type = typeof entry.type === "string" ? entry.type.trim().toLowerCase() : "";
    const status = entry.status === "ended" || entry.status === "proposed" ? entry.status : "active";
    if (!recordIds.has(recordId) || !source || !target || !(type in CONTINUITY_RELATIONSHIP_TYPES)) continue;
    relationships.push({ recordId, source, target, type, status });
  }
  return { movements, relationships };
}

/** Resolve a name to exactly one registered entity of the given kinds, or nothing. */
export function createContinuityEntityResolver(entities: readonly CampaignMemoryEntity[]) {
  const byAlias = new Map<string, Set<string>>();
  const aliasesById = new Map<string, string[]>();
  for (const entity of entities) {
    if (entity.status !== "active") continue;
    const names = [...new Set(entity.aliases.map(normalize).filter(Boolean))];
    aliasesById.set(entity.entityId, names);
    for (const name of names) {
      const set = byAlias.get(name) ?? new Set<string>();
      set.add(entity.entityId);
      byAlias.set(name, set);
    }
  }
  const kindById = new Map(entities.map((entity) => [entity.entityId, entity.kind]));
  return (name: string, kinds: readonly string[]): string | null => {
    const key = normalize(name);
    if (!key) return null;
    const exact = [...(byAlias.get(key) ?? [])].filter((id) => kinds.includes(kindById.get(id) ?? ""));
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) return null;
    // A shortened place name ("the library") may name one registered place ("West Hall Library").
    const tokens = key.split(" ").filter((token) => token.length > 2 && token !== "the");
    if (!tokens.length) return null;
    const partial = [...aliasesById.entries()]
      .filter(([id]) => kinds.includes(kindById.get(id) ?? ""))
      .filter(([, names]) => names.some((alias) => tokens.every((token) => ` ${alias} `.includes(` ${token} `))))
      .map(([id]) => id);
    return partial.length === 1 ? partial[0]! : null;
  };
}

export function buildContinuityStructurePrompt(input: {
  records: Array<{ id: string; kind: string; status: string; text: string; subjects: string[] }>;
  people: string[];
  places: string[];
}): string {
  return [
    "You read verified game or roleplay campaign memory records and report two kinds of change they state.",
    "",
    'MOVEMENTS: a record states that a named person arrived at, entered, returned to or left a specific place. Report only completed movement that the record itself states. Plans, invitations, orders and intentions are not movement. presence is "present" for arriving and "absent" for leaving.',
    "",
    `RELATIONSHIPS: a record establishes, changes, reveals or ends a lasting bond or expressly states a current stance between two named people. Use exactly one type from: ${Object.keys(CONTINUITY_RELATIONSHIP_TYPES).join(", ")}. status is "active", "ended" (the bond or stance ended) or "proposed" (offered, not yet accepted). A single conversation, a favour or a passing mood is not a relationship. Stranger and neutral require explicit wording, not the absence of evidence. Suspicion must be stated or visibly acted on. Lover-of requires an established romantic relationship, not one-sided attraction; use loves for explicit one-sided love. Arch-nemesis and eternal ally require an explicit enduring commitment, never a reputation score alone. Direction matters: A's suspicion of B says nothing about B's suspicion of A. Hiring or a signed contract of service is "employs" from the employer. Swearing into someone's service is "sworn-to" from the one who swears.`,
    "",
    "Use names exactly as they appear in the lists below. If a person or place is not in the lists, leave that item out. Report nothing you would have to guess.",
    "",
    `PEOPLE: ${input.people.join("; ")}`,
    `PLACES: ${input.places.join("; ")}`,
    "",
    "RECORDS:",
    ...input.records.map(
      (record) =>
        `- id=${record.id} [${record.kind}/${record.status}] ${record.text}${record.subjects.length ? ` (subjects: ${record.subjects.join(", ")})` : ""}`,
    ),
    "",
    'Answer with one JSON object and nothing else: {"movements":[{"recordId":"...","who":["..."],"to":"...","presence":"present"}],"relationships":[{"recordId":"...","source":"...","target":"...","type":"...","status":"active"}]}. Use empty arrays when nothing qualifies.',
  ].join("\n");
}

async function completeStructure(db: DB, chatId: string, prompt: string): Promise<unknown> {
  const config = await readContinuityConfig(db, chatId, { allowHistoricalBackfill: true });
  const snapshot = config.frozen.extractor;
  if (!snapshot?.connectionId) throw new Error("CONTINUITY_STRUCTURE_NO_CONNECTION");
  const connection = await createConnectionsStorage(db).getWithKey(snapshot.connectionId);
  if (!connection) throw new Error("CONTINUITY_STRUCTURE_NO_CONNECTION");
  const provider = createLLMProvider(
    connection.provider,
    resolveBaseUrl(connection),
    connection.apiKey,
    connection.maxContext,
    connection.openrouterProvider,
    connection.maxTokensOverride,
    connection.claudeFastMode === "true",
    connection.treatAsLocalEndpoint === "true",
    connection.defaultParameters,
    connection.id,
  );
  const result = await provider.chatComplete([{ role: "system", content: prompt }], {
    model: connection.model,
    maxTokens: 4000,
    stream: false,
    responseFormat: { type: "json_object" },
  });
  if (!result.content?.trim()) throw new Error("CONTINUITY_STRUCTURE_EMPTY_RESPONSE");
  return parseContinuityJson(result.content);
}

type StructureCompleter = (chatId: string, prompt: string) => Promise<unknown>;

function structureMarker(entry: { dynamicState?: unknown }): number {
  const structure = objectValue(objectValue(entry.dynamicState).structure);
  return typeof structure.version === "number" ? structure.version : 0;
}

/**
 * Derive and apply movements and relationships for a chat's published receipts that have not been structured at
 * this version, oldest first. Each receipt is marked on its generated lore entry once handled, so the pass resumes
 * where it stopped and never pays twice for the same records.
 */
export async function structurePublishedContinuity(
  db: DB,
  chatId: string,
  options: { complete?: StructureCompleter; receiptIds?: readonly string[]; onBatch?: () => Promise<void> } = {},
): Promise<ContinuityStructureResult> {
  const complete = options.complete ?? ((id: string, prompt: string) => completeStructure(db, id, prompt));
  const result: ContinuityStructureResult = {
    receipts: 0,
    calls: 0,
    movementsApplied: 0,
    relationshipsApplied: 0,
    dropped: {},
  };
  const drop = (reason: string) => {
    result.dropped[reason] = (result.dropped[reason] ?? 0) + 1;
  };
  const wanted = options.receiptIds ? new Set(options.receiptIds) : null;
  const receipts: Array<{ receipt: GameContinuityReceipt; entryId: string }> = [];
  for (const receipt of await createGameContinuityStorage(db).list(chatId)) {
    if (receipt.status !== "published" || !receipt.records.length || !receipt.entryIds[0]) continue;
    if (wanted && !wanted.has(receipt.id)) continue;
    const entry = (
      await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, receipt.entryIds[0])).limit(1)
    )[0];
    if (!entry || objectValue(entry.dynamicState).receiptId !== receipt.id) continue;
    if (structureMarker(entry) >= CONTINUITY_STRUCTURE_VERSION) continue;
    receipts.push({ receipt, entryId: entry.id });
  }
  receipts.sort(
    (a, b) => a.receipt.updatedAt.localeCompare(b.receipt.updatedAt) || a.receipt.id.localeCompare(b.receipt.id),
  );
  result.receipts = receipts.length;
  if (!receipts.length) return result;

  const memory = createCampaignMemoryStorage(db);
  const entities = await memory.listEntities({ chatId });
  const resolve = createContinuityEntityResolver(entities);
  const firstAlias = (kinds: string[]) =>
    entities
      .filter((entity) => entity.status === "active" && kinds.includes(entity.kind) && entity.aliases[0])
      .map((entity) => entity.aliases[0]!);
  const people = [...new Set(firstAlias(["character", "persona"]))].sort();
  const places = [...new Set(firstAlias(["location"]))].sort();

  // Batches follow receipt order and never split a receipt, so each batch can be marked done as a unit.
  const batches: Array<typeof receipts> = [];
  let current: typeof receipts = [];
  let size = 0;
  for (const item of receipts) {
    if (current.length && size + item.receipt.records.length > MAX_RECORDS_PER_CALL) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.receipt.records.length;
  }
  if (current.length) batches.push(current);

  for (const batch of batches) {
    const records = batch.flatMap(({ receipt }) => receipt.records.map((record) => ({ receipt, record })));
    const byId = new Map(records.map((item) => [item.record.id, item]));
    const prompt = buildContinuityStructurePrompt({
      records: records.map(({ record }) => ({
        id: record.id,
        kind: record.kind,
        status: record.status,
        text: record.text,
        subjects: record.subjects,
      })),
      people,
      places,
    });
    result.calls += 1;
    const structure = parseContinuityStructure(await complete(chatId, prompt), new Set(byId.keys()));

    const apply = async (command: CampaignMemoryTransitionCommand, kind: "movement" | "relationship") => {
      try {
        const applied = await applyCampaignMemoryTransition(db, command);
        if (applied.status === "applied" || applied.status === "stale") {
          if (kind === "movement") result.movementsApplied += 1;
          else result.relationshipsApplied += 1;
        } else drop(`${kind}-${applied.status}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        drop(`${kind}-${message.match(/^[A-Z][A-Z_]+/u)?.[0] ?? "failed"}`);
      }
    };
    const baseFor = (receipt: GameContinuityReceipt, record: GameContinuityReceipt["records"][number]) => {
      const historical = receipt.config.historicalBackfill !== undefined || receipt.id.startsWith("gch_");
      return {
        chatId,
        actor: historical ? ("import" as const) : ("system" as const),
        reason: record.text,
        source: { messageId: record.evidence[0]!.messageId },
        evidence: record.evidence.map((item) => ({ messageId: item.messageId, quote: item.quote })),
      };
    };

    for (const movement of structure.movements) {
      const { receipt, record } = byId.get(movement.recordId)!;
      if (!record.evidence.length) {
        drop("movement-no-evidence");
        continue;
      }
      if (record.status !== "completed" && record.status !== "asserted") {
        drop("movement-not-completed");
        continue;
      }
      const locationEntityId = resolve(movement.to, ["location"]);
      if (!locationEntityId) {
        drop("movement-place-unresolved");
        continue;
      }
      for (const name of movement.who) {
        const entityId = resolve(name, ["character", "persona"]);
        if (!entityId) {
          drop("movement-person-unresolved");
          continue;
        }
        await apply(
          {
            ...baseFor(receipt, record),
            basis: "observed",
            class: "movement",
            entityId,
            locationEntityId,
            presence: movement.presence,
          },
          "movement",
        );
      }
    }
    for (const relationship of structure.relationships) {
      const { receipt, record } = byId.get(relationship.recordId)!;
      if (!record.evidence.length) {
        drop("relationship-no-evidence");
        continue;
      }
      const sourceEntityId = resolve(relationship.source, ["character", "persona"]);
      const targetEntityId = resolve(relationship.target, ["character", "persona"]);
      if (!sourceEntityId || !targetEntityId || sourceEntityId === targetEntityId) {
        drop("relationship-person-unresolved");
        continue;
      }
      await apply(
        {
          ...baseFor(receipt, record),
          basis: relationship.status === "proposed" ? "offer" : "observed",
          class: "relationship",
          sourceEntityId,
          targetEntityId,
          type: relationship.type,
          inverseLabel: CONTINUITY_RELATIONSHIP_TYPES[relationship.type]!,
          status: relationship.status,
        },
        "relationship",
      );
    }

    for (const { receipt, entryId } of batch) {
      const rows = await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, entryId)).limit(1);
      if (!rows[0] || objectValue(rows[0].dynamicState).receiptId !== receipt.id) continue;
      const state = objectValue(rows[0].dynamicState);
      await db
        .update(lorebookEntries)
        .set({
          dynamicState: JSON.stringify({
            ...state,
            structure: { version: CONTINUITY_STRUCTURE_VERSION, at: new Date().toISOString() },
          }),
        })
        .where(eq(lorebookEntries.id, entryId));
    }
    await options.onBatch?.();
  }
  logger.info({ chatId, ...result }, "[game-continuity] structured published memory");
  return result;
}
