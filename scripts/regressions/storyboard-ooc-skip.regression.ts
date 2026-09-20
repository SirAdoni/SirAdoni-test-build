import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storyboardPlanHasNoVisualBeats } from "../../packages/server/src/services/game/storyboard-planner-fallback.js";

assert.equal(storyboardPlanHasNoVisualBeats({ keyframes: [] }), true);
for (const malformed of [null, {}, [], { keyframes: null }, { keyframes: [{}] }]) {
  assert.equal(storyboardPlanHasNoVisualBeats(malformed), false);
}
assert.equal(storyboardPlanHasNoVisualBeats({ keyframes: [{ imagePrompt: "A quiet garden" }] }), false);

const root = mkdtempSync(join(tmpdir(), "marinara-storyboard-skip-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
const { buildApp } = await import("../../packages/server/src/app.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const app = await buildApp();
try {
  await app.ready();
  const chats = createChatsStorage(app.db);
  const chat = await chats.create({ name: "Storyboard OOC proof", mode: "game", characterIds: [] });
  assert(chat);
  for (const prefix of ["[To the GM]", "[GM]", "[OOC]", "OOC:"]) {
    await chats.createMessage({ chatId: chat.id, role: "user", content: `${prefix} Arrange another arrival.` });
    const answer = await chats.createMessage({
      chatId: chat.id,
      role: "assistant",
      content: "Understood, ready when you are.",
    });
    assert(answer);
    for (const previewOnly of [false, true]) {
      const result = await app.inject({
        method: "POST",
        url: "/api/game/storyboard/generate",
        payload: {
          chatId: chat.id,
          messageId: answer.id,
          automatic: true,
          previewOnly,
        },
      });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().reason, "ooc");
      assert.equal(result.json().skipped, true);
      assert.deepEqual(result.json().items, []);
    }
  }
  // A later scene must not inherit an earlier OOC skip. With no agent installed,
  // reaching that validation proves that the scene was not skipped as OOC.
  await chats.createMessage({ chatId: chat.id, role: "user", content: "I open the garden door." });
  const scene = await chats.createMessage({ chatId: chat.id, role: "assistant", content: "Rain falls on the garden." });
  assert(scene);
  const result = await app.inject({
    method: "POST",
    url: "/api/game/storyboard/generate",
    payload: { chatId: chat.id, messageId: scene.id },
  });
  assert.equal(result.statusCode, 409, result.body);
  console.log("Storyboard OOC skips and empty-plan classification passed without provider calls.");
} finally {
  await app.close();
  const { closeDB } = await import("../../packages/server/src/db/connection.js");
  await closeDB();
  rmSync(root, { recursive: true, force: true });
}
