import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-state-order-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage, CampaignMemoryStorageError } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { formatCampaignMemoryMessageOrder } =
    await import("../../packages/server/src/services/game/campaign-memory-order.js");
  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values({ id: "order-chat", name: "Order", mode: "game", createdAt, updatedAt: createdAt });
  const stamps = ["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z", "2026-01-01T00:00:03.000Z"];
  await db.insert(messages).values(
    stamps.map((stamp, index) => ({
      id: `msg-${index + 1}`,
      chatId: "order-chat",
      role: "user",
      content: `Moved ${index + 1}`,
      createdAt: stamp,
    })),
  );
  const orders = stamps.map((stamp, index) => formatCampaignMemoryMessageOrder(`msg-${index + 1}`, stamp));
  const ownerReader = {
    async readChatScope(chatId: string) {
      return {
        chatId,
        characterIds: ["hero"],
        spatialDefinition: { locations: [{ id: "inn" }, { id: "road" }, { id: "castle" }] },
      } as never;
    },
    async readExistingOwner(owner: { store: string; recordId: string }) {
      if (owner.store === "characters" && owner.recordId === "hero")
        return { store: owner.store, recordId: owner.recordId, kind: "character" as const };
      if (owner.store === "spatial-context")
        return { store: owner.store, recordId: owner.recordId, kind: "location" as const };
      return null;
    },
  };
  const storage = createCampaignMemoryStorage(db, ownerReader);
  const scope = { chatId: "order-chat" };
  const provenance = { source: "regression", sourceRevision: "r1", actor: "user" as const };
  const make = (kind: "character" | "location", store: string, id: string) =>
    storage.createEntity({
      entityId: id,
      chatId: scope.chatId,
      kind,
      owner: { type: "existing", store, recordId: id },
      aliases: [],
      tags: [],
      attributes: {},
      status: "active",
      manualLock: false,
      provenance,
    });
  const hero = await make("character", "characters", "hero");
  const inn = await make("location", "spatial-context", "inn");
  const road = await make("location", "spatial-context", "road");
  const castle = await make("location", "spatial-context", "castle");
  const event = (index: number, locationEntityId: string) =>
    storage.createEvent({
      chatId: scope.chatId,
      occurrenceOrder: orders[index]!,
      participantEntityIds: [hero.entityId],
      locationEntityId,
      sourceRevision: "r1",
      transitions: [],
      evidence: [{ messageId: `msg-${index + 1}`, quote: `Moved ${index + 1}` }],
      provenance,
    });
  const first = await event(0, inn.entityId);
  const second = await event(1, road.entityId);
  const third = await event(2, castle.entityId);
  const state = await storage.createCurrentState({
    chatId: scope.chatId,
    entityId: hero.entityId,
    property: "location",
    value: inn.entityId,
    sourceEventId: first.eventId,
    validAtOrder: orders[0]!,
    protected: false,
    provenance,
    manualLock: false,
  });
  const update = (patch: Record<string, unknown>, expectedRevision: number, operationId: string) =>
    storage.updateCurrentState(scope, state.stateId, patch, {
      expectedRevision,
      actor: "system",
      reason: "movement",
      operationId,
    });

  // In order: the newest event updates current location.
  const moved = await update({ value: castle.entityId, sourceEventId: third.eventId, validAtOrder: orders[2] }, 1, "move-3");
  assert.equal(moved.value, castle.entityId);
  assert.equal(moved.revision, 2);

  // Older movement delivered late is rejected; current stays at the newest order.
  await assert.rejects(
    () => update({ value: road.entityId, sourceEventId: second.eventId, validAtOrder: orders[1] }, 2, "move-2-late"),
    (error) => error instanceof CampaignMemoryStorageError && error.code === "CAMPAIGN_MEMORY_STALE_ORDER",
  );
  // An older source event alone (order field untouched) is also rejected.
  await assert.rejects(
    () => update({ value: road.entityId, sourceEventId: second.eventId }, 2, "move-2-event-only"),
    (error) => error instanceof CampaignMemoryStorageError && error.code === "CAMPAIGN_MEMORY_STALE_ORDER",
  );
  const current = await storage.getCurrentState(scope, state.stateId);
  assert.equal(current?.value, castle.entityId);
  assert.equal(current?.validAtOrder, orders[2]);
  assert.equal(current?.revision, 2, "rejected writes do not bump the revision");
  assert.equal((await storage.listMutationJournal(scope)).length, 1, "rejected writes are not journaled");
  // History stays intact: every event is still readable.
  assert.equal((await storage.listEvents(scope)).length, 3);
  // A correction at the same order and event is still allowed.
  const corrected = await update({ protected: true }, 2, "protect");
  assert.equal(corrected.revision, 3);
  await db._fileStore.close();
  console.log("campaign memory current-state order regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
