import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-storyboard-source-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

const { buildApp } = await import("../../packages/server/src/app.js");
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  app = await buildApp();
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const chats = createChatsStorage(app.db);
  const chat = await chats.create({ name: "Storyboard source availability", mode: "game", characterIds: [] });
  assert(chat);

  const automatic = await app.inject({
    method: "POST",
    url: "/api/game/storyboard/generate",
    payload: {
      chatId: chat.id,
      messageId: "restored-session-synthetic-message",
      automatic: true,
      sections: [],
    },
  });
  assert.equal(automatic.statusCode, 200, "automatic stale source should be a clean skip");
  assert.deepEqual(automatic.json(), { skipped: true, reason: "source_unavailable" });

  const manual = await app.inject({
    method: "POST",
    url: "/api/game/storyboard/generate",
    payload: {
      chatId: chat.id,
      messageId: "restored-session-synthetic-message",
      automatic: false,
      sections: [],
    },
  });
  assert.equal(manual.statusCode, 404, "manual stale source should retain its diagnostic error");
  assert.equal(manual.json().error, "GM message not found");
  console.info(
    "PASS: automatic storyboard admission skips a stale source while manual requests retain 404 diagnostics.",
  );
} finally {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
}
