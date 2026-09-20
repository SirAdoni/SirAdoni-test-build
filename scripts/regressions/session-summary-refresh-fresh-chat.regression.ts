// Regression: the session-summary refresh service must start on a store that holds a game chat which never
// had a refresh descriptor. Such chats carry plain metadata (summary: null, tags: []) where the descriptor
// map falls back to the metadata root; start() used to read `.status` of `null` and abort the whole boot.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "session-summary-fresh-chat-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createSessionSummaryRefreshService } = await import("../../packages/server/src/services/game/session-summary-refresh.js");
  const db = await createFileNativeDB({});
  const chats = createChatsStorage(db);
  const chat = await chats.create({ name: "Fresh game chat", mode: "game", characterIds: [] } as Parameters<typeof chats.create>[0]);
  assert.ok(chat);
  await chats.patchMetadata(chat.id, () => ({ summary: null, tags: [], gameSessionNumber: 1 }));
  let calls = 0;
  const service = createSessionSummaryRefreshService(db, { generate: async ({ savedSummary }: any) => { calls += 1; return savedSummary; } });
  await service.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls, 0, "a chat without descriptors enqueues nothing");
  await service.stop?.();
  await db._fileStore.close();
  console.log("session-summary-refresh-fresh-chat regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
