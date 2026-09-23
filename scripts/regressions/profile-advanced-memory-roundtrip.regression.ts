import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-profile-advanced-memory-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

let app: {
  close(): Promise<void>;
  ready(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<any>;
} | null = null;

try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { advancedMemoryRecords } = await import("../../packages/server/src/db/schema/advanced-memory.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createAdvancedMemoryService } = await import("../../packages/server/src/services/advanced-memory.js");

  app = await buildApp();
  await app.ready();
  const db = await getDB();
  const chats = createChatsStorage(db);
  const memoryService = createAdvancedMemoryService(db);
  const create = async (name: string) => {
    const response = await app!.inject({
      method: "POST",
      url: "/api/chats",
      payload: { name, mode: "roleplay", characterIds: [] },
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const addMessage = async (chatId: string, content: string) => {
    const response = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      payload: { role: "user", content },
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  };

  const root = await create("Profile branch root");
  const first = await addMessage(root.id, "before profile fork");
  const middle = await addMessage(root.id, "profile fork point");
  const future = await addMessage(root.id, "future profile message");
  await chats.patchMetadata(root.id, { advancedMemory: { enabled: true } });
  const memoryFixture = (
    id: string,
    sceneId: string,
    ids: string[],
    content: string,
    enabled = 1,
    manualOverride = 0,
  ) => ({
    id,
    chatId: root.id,
    sceneId,
    kind: "scene",
    status: "closed",
    startMessageId: ids[0]!,
    endMessageId: ids.at(-1)!,
    messageIds: JSON.stringify(ids),
    audienceCharacterIds: "[]",
    content,
    title: "Retained profile scene",
    timeline: null,
    enabled,
    manualOverride,
    sourceFingerprint: "",
    dependencies: "[]",
    embedding: null,
    embeddingSpaceId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await db
    .insert(advancedMemoryRecords)
    .values([
      memoryFixture(`scene-${first.id}`, `scene-${first.id}`, [first.id], ""),
      memoryFixture("profile-edited-disabled-scene", `scene-${first.id}`, [first.id], "USER_CORRECTED_MEMORY", 0, 1),
      memoryFixture(`scene-${middle.id}`, `scene-${middle.id}`, [middle.id, future.id], ""),
      memoryFixture("profile-future-scene-variant", `scene-${middle.id}`, [middle.id, future.id], "FUTURE_SECRET"),
    ]);
  await memoryService.refreshTransferredRecords(root.id);

  const branchResponse = await app.inject({
    method: "POST",
    url: `/api/chats/${root.id}/branch`,
    payload: { upToMessageId: middle.id },
  });
  assert.equal(branchResponse.statusCode, 200);
  const branch = branchResponse.json();
  const branchMessages = await chats.listMessages(branch.id);
  const branchedMemories = await db
    .select()
    .from(advancedMemoryRecords)
    .where(eq(advancedMemoryRecords.chatId, branch.id));
  const retainedCorrection = branchedMemories.find((record) => record.content === "USER_CORRECTED_MEMORY");
  assert.ok(retainedCorrection, "branch must retain the corrected memory row");
  assert.equal(retainedCorrection.enabled, 0, "disabled corrections stay disabled on a branch");
  assert.equal(retainedCorrection.manualOverride, 1);
  assert.deepEqual(JSON.parse(retainedCorrection.messageIds), [branchMessages[0]!.id]);

  const deleted = await app.inject({ method: "DELETE", url: `/api/chats/${root.id}` });
  assert.equal(deleted.statusCode, 204);
  const survivingBranch = await app.inject({ method: "GET", url: `/api/chats/${branch.id}` });
  assert.equal(survivingBranch.statusCode, 200);
  assert.equal(survivingBranch.json().metadata.branchParentChatId, root.id);

  const profileExport = await app.inject({ method: "GET", url: "/api/backup/export-profile" });
  assert.equal(profileExport.statusCode, 200, profileExport.body);
  const profile = profileExport.json();
  const backedUpRecords = profile.data.fileStorage.tables.advanced_memory_records;
  assert.ok(Array.isArray(backedUpRecords), "native backups must discover the managed memory table");
  const backedUpCorrection = backedUpRecords.find((record: { id: string }) => record.id === retainedCorrection.id);
  assert.ok(backedUpCorrection);
  await db.delete(advancedMemoryRecords).where(eq(advancedMemoryRecords.id, retainedCorrection.id));
  const profileImport = await app.inject({ method: "POST", url: "/api/backup/import-profile", payload: profile });
  assert.equal(profileImport.statusCode, 200, profileImport.body);
  const restoredCorrection = (
    await db.select().from(advancedMemoryRecords).where(eq(advancedMemoryRecords.id, retainedCorrection.id))
  )[0];
  assert.deepEqual(
    restoredCorrection,
    backedUpCorrection,
    "profile restore retains source anchors and manual/disabled provenance",
  );
} finally {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.info("Profile advanced-memory roundtrip regression passed");
