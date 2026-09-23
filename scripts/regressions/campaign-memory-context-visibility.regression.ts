import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-visibility-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, lorebooks, lorebookEntries, lorebookFolders, campaignMemoryEntities, campaignMemoryFacts, campaignMemoryKnowledge } =
    await import("../../packages/server/src/db/schema/index.js");
  const { buildCampaignMemoryContextFromStorage } = await import("../../packages/server/src/services/game/campaign-memory-context.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  const metadata = {
    activeLorebookIds: ["unrelated-active-book"],
    gameLorebookKeeperEnabled: false,
    gameLorebookKeeperLorebookId: "keeper-book",
    excludedLorebookIds: [],
  };
  await db.insert(chats).values({ id: "visibility-chat", name: "Visibility", mode: "game", characterIds: "[]", metadata: JSON.stringify(metadata), createdAt: now, updatedAt: now });
  await db.insert(lorebooks).values({ id: "keeper-book", name: "Keeper", chatId: "visibility-chat", sourceAgentId: "game-lorebook-keeper", enabled: "true", createdAt: now, updatedAt: now });
  await db.insert(lorebooks).values({ id: "unrelated-active-book", name: "Active", enabled: "true", createdAt: now, updatedAt: now });
  await db.insert(lorebookFolders).values({ id: "hidden-folder", lorebookId: "keeper-book", name: "Hidden", enabled: "true", createdAt: now, updatedAt: now });
  await db.insert(lorebookEntries).values({ id: "keeper-entry", lorebookId: "keeper-book", folderId: "hidden-folder", name: "Receipt", content: "secret", description: "secret", enabled: "true", createdAt: now, updatedAt: now });
  await db.insert(lorebookEntries).values({ id: "active-entry", lorebookId: "unrelated-active-book", name: "Active", content: "active", description: "active", enabled: "true", createdAt: now, updatedAt: now });
  const provenance = JSON.stringify({ source: "visibility", sourceRevision: "r1", actor: "user" });
  const entity = (entityId: string, kind: string, owner: unknown) => ({ entityId, chatId: "visibility-chat", kind, owner: JSON.stringify(owner), aliases: "[]", tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance, revision: 1, createdAt: now, updatedAt: now });
  await db.insert(campaignMemoryEntities).values([
    entity("lore-entity", "lore", { type: "existing", store: "lorebook-entries", recordId: "keeper-entry" }),
    entity("active-lore-entity", "lore", { type: "existing", store: "lorebook-entries", recordId: "active-entry" }),
    entity("note-entity", "note", { type: "registry", store: "campaign-memory", recordId: "note-entity" }),
  ]);
  const fact = (factId: string, subjectEntityId: string) => ({ factId, chatId: "visibility-chat", subjectEntityId, predicate: "continuity.other", value: JSON.stringify({ text: factId }), conditions: "[]", status: "verified", sourceRevision: "r1", evidence: "[]", author: "user", provenance, manualLock: 0, revision: 1, createdAt: now, updatedAt: now });
  await db.insert(campaignMemoryFacts).values([fact("hidden-fact", "lore-entity"), fact("active-fact", "active-lore-entity"), fact("visible-fact", "note-entity")]);
  await db.insert(campaignMemoryKnowledge).values({ knowledgeId: "hidden-knowledge", chatId: "visibility-chat", holderEntityId: "note-entity", factId: "hidden-fact", epistemicState: "knows", learnedFrom: "[]", provenance, manualLock: 0, revision: 1, createdAt: now, updatedAt: now });

  const hidden = await buildCampaignMemoryContextFromStorage(db, { chatId: "visibility-chat", audience: { kind: "gm" }, maxCharacters: 10000 });
  assert.equal(hidden.includedIds.includes("hidden-fact"), false);
  assert.equal(hidden.includedIds.includes("hidden-knowledge"), false);
  assert.equal(hidden.includedIds.includes("visible-fact"), true);
  assert.equal(hidden.includedIds.includes("active-fact"), true);

  metadata.activeLorebookIds = [];
  await db.update(chats).set({ metadata: JSON.stringify(metadata) }).where(eq(chats.id, "visibility-chat"));
  const removedActive = await buildCampaignMemoryContextFromStorage(db, { chatId: "visibility-chat", audience: { kind: "gm" }, maxCharacters: 10000 });
  assert.equal(removedActive.includedIds.includes("active-fact"), false);
  assert.equal(removedActive.includedIds.includes("visible-fact"), true);
  metadata.activeLorebookIds = ["unrelated-active-book"];
  await db.update(chats).set({ metadata: JSON.stringify(metadata) }).where(eq(chats.id, "visibility-chat"));

  metadata.gameLorebookKeeperEnabled = true;
  metadata.activeLorebookIds = ["unrelated-active-book", "keeper-book"];
  await db.update(chats).set({ metadata: JSON.stringify(metadata) }).where(eq(chats.id, "visibility-chat"));
  const visible = await buildCampaignMemoryContextFromStorage(db, { chatId: "visibility-chat", audience: { kind: "gm" }, maxCharacters: 10000 });
  assert.equal(visible.includedIds.includes("hidden-fact"), true);

  metadata.excludedLorebookIds = ["keeper-book"];
  await db.update(chats).set({ metadata: JSON.stringify(metadata) }).where(eq(chats.id, "visibility-chat"));
  assert.equal((await buildCampaignMemoryContextFromStorage(db, { chatId: "visibility-chat", audience: { kind: "gm" }, maxCharacters: 10000 })).includedIds.includes("hidden-fact"), false);

  metadata.excludedLorebookIds = [];
  await db.update(chats).set({ metadata: JSON.stringify(metadata) }).where(eq(chats.id, "visibility-chat"));
  await db.update(lorebooks).set({ enabled: "false" }).where(eq(lorebooks.id, "keeper-book"));
  assert.equal((await buildCampaignMemoryContextFromStorage(db, { chatId: "visibility-chat", audience: { kind: "gm" }, maxCharacters: 10000 })).includedIds.includes("hidden-fact"), false);
  await db.update(lorebooks).set({ enabled: "true" }).where(eq(lorebooks.id, "keeper-book"));
  await db.update(lorebookEntries).set({ enabled: "false" }).where(eq(lorebookEntries.id, "keeper-entry"));
  assert.equal((await buildCampaignMemoryContextFromStorage(db, { chatId: "visibility-chat", audience: { kind: "gm" }, maxCharacters: 10000 })).includedIds.includes("hidden-fact"), false);
  await db.update(lorebookEntries).set({ enabled: "true" }).where(eq(lorebookEntries.id, "keeper-entry"));
  await db.update(lorebookFolders).set({ enabled: "false" }).where(eq(lorebookFolders.id, "hidden-folder"));
  assert.equal((await buildCampaignMemoryContextFromStorage(db, { chatId: "visibility-chat", audience: { kind: "gm" }, maxCharacters: 10000 })).includedIds.includes("hidden-fact"), false);

  await db._fileStore.close();
  console.log("campaign memory context visibility regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
