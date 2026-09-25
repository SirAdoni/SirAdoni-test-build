import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CampaignMemoryExistingOwnerRef } from "@marinara-engine/shared";

// Entity owner and kind are immutable after registration, but every update re-resolved the owner against its
// store. A Campaign Wiki page whose library card or Keeper lorebook entry was later deleted could then never be
// edited or archived (CAMPAIGN_MEMORY_INVALID_REFERENCE). Updates now keep the owner that was resolved at
// registration; a changed owner is still rejected.
const root = mkdtempSync(join(tmpdir(), "marinara-deleted-owner-update-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
let db: any;

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");

  db = await createFileNativeDB();
  const now = "2026-09-20T00:00:00.000Z";
  await db.insert(schema.apiConnections).values({ id: "conn", name: "Owner test", provider: "custom", model: "m" });
  await db.insert(schema.chats).values({
    id: "chat",
    name: "Session 1",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify({ gameId: "game-1", gameSessionNumber: 1 }),
    createdAt: now,
    updatedAt: now,
  });

  const live = new Set(["lorebook-entries:entry-quenby", "characters:char-mira"]);
  const reader = {
    async readChatScope(chatId: string) {
      if (chatId !== "chat") return null;
      return {
        chatId,
        characterIds: live.has("characters:char-mira") ? ["char-mira"] : [],
        linkedCharacterIds: [],
        npcIds: [],
        personaId: null,
        lorebookEntryIds: live.has("lorebook-entries:entry-quenby") ? ["entry-quenby"] : [],
        questEntryIds: [],
        spatialDefinition: null,
      } as any;
    },
    async readExistingOwner(owner: CampaignMemoryExistingOwnerRef) {
      const key = `${owner.store}:${owner.recordId}`;
      if (!live.has(key)) return null;
      return {
        store: owner.store,
        recordId: owner.recordId,
        kind: owner.store === "characters" ? "character" : "lore",
      } as any;
    },
  };
  const storage = createCampaignMemoryStorage(db, reader as any);
  const provenance = { source: "regression", sourceRevision: "r1", actor: "user" as const };

  const lore = await storage.createEntity({
    chatId: "chat",
    kind: "lore",
    owner: { type: "existing", store: "lorebook-entries", recordId: "entry-quenby" },
    aliases: ["Quenby Hollow"],
    tags: [],
    summary: "A quiet valley.",
    attributes: {},
    status: "active",
    provenance,
  } as any);
  const character = await storage.createEntity({
    chatId: "chat",
    kind: "character",
    owner: { type: "existing", store: "characters", recordId: "char-mira" },
    aliases: ["Mira"],
    tags: [],
    attributes: {},
    status: "active",
    provenance,
  } as any);

  // The owner records are deleted after registration.
  live.clear();

  const edited = await storage.updateEntity(
    { chatId: "chat" },
    lore.entityId,
    { summary: "A quiet valley with a mill." },
    { expectedRevision: 1, actor: "user", reason: "edit after owner deletion" },
  );
  assert.equal(edited.summary, "A quiet valley with a mill.", "a page whose owner was deleted can still be edited");
  const archived = await storage.updateEntity(
    { chatId: "chat" },
    lore.entityId,
    { status: "archived" },
    { expectedRevision: 2, actor: "user", reason: "archive after owner deletion" },
  );
  assert.equal(archived.status, "archived", "a page whose owner was deleted can still be archived");
  const renamed = await storage.updateEntity(
    { chatId: "chat" },
    character.entityId,
    { aliases: ["Mira", "Aria Vell"] },
    { expectedRevision: 1, actor: "user", reason: "alias edit after card deletion" },
  );
  assert.deepEqual(renamed.aliases, ["Mira", "Aria Vell"]);
  assert.equal((await storage.getEntity({ chatId: "chat" }, lore.entityId))?.status, "archived");

  // A genuinely different owner is still rejected, even one that does not exist at all.
  await assert.rejects(
    () =>
      storage.updateEntity(
        { chatId: "chat" },
        character.entityId,
        { owner: { type: "existing", store: "characters", recordId: "char-missing" } },
        { expectedRevision: 2, actor: "user", reason: "owner swap" },
      ),
    (error: any) => error?.code === "CAMPAIGN_MEMORY_INVALID_REFERENCE",
  );
  // Creating a new entity still validates its owner.
  await assert.rejects(
    () =>
      storage.createEntity({
        chatId: "chat",
        kind: "lore",
        owner: { type: "existing", store: "lorebook-entries", recordId: "entry-quenby" },
        aliases: ["Quenby Hollow again"],
        tags: [],
        attributes: {},
        status: "active",
        provenance,
      } as any),
    (error: any) => error?.code === "CAMPAIGN_MEMORY_INVALID_REFERENCE",
  );
  console.log("campaign-memory-deleted-owner-update regression passed");
} finally {
  await db?._fileStore?.close?.();
  rmSync(root, { recursive: true, force: true });
}
