import { createHash } from "node:crypto";
import type { CampaignMemoryEntity, GameContinuityHolderSnapshot } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { characters, chats, personas } from "../../db/schema/index.js";
import { createCampaignMemoryOwnerReader, validateCampaignMemoryEntityOwner } from "./campaign-memory-owners.js";
import { collectCampaignMemoryLegacySource, legacyCampaignMemoryEntityId } from "./campaign-memory-import.js";
import { createCampaignMemoryStorage } from "../storage/campaign-memory.storage.js";

type SnapshotResult = {
  holders: GameContinuityHolderSnapshot[];
  hash: string;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedName(name: string): string {
  return name.trim().normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function ownerStore(
  entity: CampaignMemoryEntity,
): { kind: "character" | "persona"; store: "characters" | "personas" | "game-npcs" } | null {
  if (entity.kind === "character" && entity.owner.type === "existing" && entity.owner.store === "characters")
    return { kind: "character", store: "characters" };
  if (entity.kind === "character" && entity.owner.type === "existing" && entity.owner.store === "game-npcs")
    return { kind: "character", store: "game-npcs" };
  if (entity.kind === "persona" && entity.owner.type === "existing" && entity.owner.store === "personas")
    return { kind: "persona", store: "personas" };
  return null;
}

async function ownerName(
  db: DB,
  chatId: string,
  store: "characters" | "personas" | "game-npcs",
  recordId: string,
): Promise<string | null> {
  if (store === "characters") {
    const row = await db.select({ data: characters.data }).from(characters).where(eq(characters.id, recordId)).limit(1);
    if (!row[0]) return null;
    try {
      const value = JSON.parse(row[0].data) as { name?: unknown };
      return typeof value.name === "string" && value.name.trim() ? value.name.trim() : null;
    } catch {
      return null;
    }
  }
  if (store === "personas") {
    const row = await db.select({ name: personas.name }).from(personas).where(eq(personas.id, recordId)).limit(1);
    return row[0]?.name?.trim() || null;
  }
  const row = await db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, chatId)).limit(1);
  const npcs = objectValue(row[0]?.metadata).gameNpcs;
  if (!Array.isArray(npcs)) return null;
  const npc = npcs.find(
    (value) =>
      value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).id === recordId,
  );
  const name = npc && typeof npc === "object" ? (npc as Record<string, unknown>).name : null;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** Capture immutable, exact-owner holder identities for a newly created receipt. */
export async function captureContinuityHolderSnapshot(db: DB, chatId: string): Promise<SnapshotResult> {
  const entities = await createCampaignMemoryStorage(db).listEntities({ chatId });
  const ownerReader = createCampaignMemoryOwnerReader(db);
  const candidates: GameContinuityHolderSnapshot[] = [];
  for (const entity of entities) {
    if (entity.status !== "active") continue;
    const store = ownerStore(entity);
    if (!store) continue;
    const resolution = await validateCampaignMemoryEntityOwner(entity, ownerReader);
    if (!resolution.selected) continue;
    const name = await ownerName(db, chatId, store.store, entity.owner.recordId);
    const fallback = entity.aliases.find((alias) => alias.trim());
    if (!name && !fallback) continue;
    candidates.push({
      entityId: entity.entityId,
      kind: store.kind,
      store: store.store,
      recordId: entity.owner.recordId,
      name: name ?? fallback!.trim(),
    });
  }
  const byName = new Map<string, GameContinuityHolderSnapshot[]>();
  for (const candidate of candidates) {
    const key = normalizedName(candidate.name);
    if (!key) continue;
    const list = byName.get(key) ?? [];
    list.push(candidate);
    byName.set(key, list);
  }
  const holders = [...candidates]
    .filter((candidate) => (byName.get(normalizedName(candidate.name))?.length ?? 0) === 1)
    .sort((left, right) => {
      const a = `${left.entityId}\u0000${left.kind}\u0000${left.recordId}`;
      const b = `${right.entityId}\u0000${right.kind}\u0000${right.recordId}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return { holders, hash: hashContinuityHolderSnapshot(holders) };
}

export function hashContinuityHolderSnapshot(holders: readonly GameContinuityHolderSnapshot[]): string {
  return digest(holders);
}

/**
 * Register only currently scoped character/persona owners before a new receipt
 * captures its map. Existing entities are left untouched; this is deliberately
 * separate from capture so read-only snapshot resolution stays side-effect free.
 */
export async function ensureContinuityHolderReferences(db: DB, chatId: string): Promise<void> {
  const source = await collectCampaignMemoryLegacySource(db, chatId);
  const candidates = source.entities.filter(
    (entity) =>
      (entity.kind === "character" || entity.kind === "persona") &&
      entity.owner?.type === "existing" &&
      (entity.owner.store === "characters" || entity.owner.store === "personas" || entity.owner.store === "game-npcs"),
  );
  if (candidates.length === 0) return;
  await db.transaction(
    async (tx) => {
      const storage = createCampaignMemoryStorage(tx);
      const existing = await storage.listEntities({ chatId });
      for (const candidate of candidates) {
        const owner = candidate.owner!;
        const registered = existing.find(
          (entity) =>
            entity.kind === candidate.kind &&
            entity.owner.type === "existing" &&
            entity.owner.store === owner.store &&
            entity.owner.recordId === owner.recordId,
        );
        if (registered) {
          const missing = (candidate.aliases ?? []).filter((alias) => !registered.aliases.includes(alias));
          if (missing.length && !registered.manualLock && registered.status === "active") {
            await storage.updateEntity(
              { chatId },
              registered.entityId,
              { aliases: [...registered.aliases, ...missing] },
              {
                actor: "import",
                reason: "Add the names prose uses for this person",
                expectedRevision: registered.revision,
                operationId: `continuity-holder-aliases:${registered.entityId}:${registered.revision}`,
              } as never,
            );
          }
          continue;
        }
        const entityId = legacyCampaignMemoryEntityId(chatId, candidate.kind, owner.recordId);
        if (existing.some((entity) => entity.entityId === entityId)) continue;
        const created = await storage.createEntity({
          entityId,
          chatId,
          kind: candidate.kind,
          owner,
          aliases: [...(candidate.aliases ?? [])],
          tags: ["continuity-holder-reference"],
          attributes: {},
          status: "active",
          manualLock: false,
          provenance: {
            source: "continuity-holder-reference",
            sourceRevision: source.legacySourceHash,
            actor: "import",
          },
        });
        existing.push(created);
      }
    },
    { durable: true },
  );
}

/** Re-check a stored identity against the current campaign-memory owner scope. */
export async function resolveSnapshotHolder(
  db: DB,
  chatId: string,
  holder: GameContinuityHolderSnapshot,
): Promise<CampaignMemoryEntity | null> {
  const entity = await createCampaignMemoryStorage(db).getEntity({ chatId }, holder.entityId);
  if (
    !entity ||
    entity.status !== "active" ||
    entity.kind !== holder.kind ||
    entity.owner.type !== "existing" ||
    entity.owner.store !== holder.store ||
    entity.owner.recordId !== holder.recordId
  )
    return null;
  const resolution = await validateCampaignMemoryEntityOwner(entity, createCampaignMemoryOwnerReader(db));
  return resolution.selected ? entity : null;
}
