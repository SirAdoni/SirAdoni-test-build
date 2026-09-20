import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FILE_STORAGE_DIR = mkdtempSync(join(tmpdir(), "marinara-storyboard-durable-"));
const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { createGameStoryboardsStorage } =
  await import("../../packages/server/src/services/storage/game-storyboards.storage.js");
const { chats, messages } = await import("../../packages/server/src/db/schema/index.js");
let db = await createFileNativeDB();
try {
  await db.insert(chats).values({ id: "durable-chat", name: "Offline storyboard proof", mode: "game" });
  await db
    .insert(messages)
    .values({ id: "durable-turn", chatId: "durable-chat", role: "assistant", content: "The performance begins." });
  const storage = createGameStoryboardsStorage(db);
  const row = await storage.create({
    chatId: "durable-chat",
    messageId: "durable-turn",
    swipeIndex: 0,
    sourceNarration: "The performance begins.",
    sourceNarrationHash: "proof",
    status: "planning",
  });
  assert.ok(row);
  const reconnected = createGameStoryboardsStorage(db);
  assert.equal((await reconnected.listForTurn("durable-chat", "durable-turn", 0))[0]?.status, "planning");
  const plannedFrames = await storage.replaceKeyframes(
    row.id,
    Array.from({ length: 8 }, (_, index) => ({
      index,
      imagePrompt: `Original scene ${index}`,
      characters: '["Ada"]',
    })),
  );
  await storage.updateKeyframe(plannedFrames[0]!.id, { imagePrompt: "Accepted compact scene" });
  const failure = "Storyboard image prompt exceeds 1000 words. No image request was sent.";
  await storage.update(row.id, { status: "failed", error: failure });
  await db._fileStore.close();
  db = await createFileNativeDB();
  const saved = (await createGameStoryboardsStorage(db).listForTurn("durable-chat", "durable-turn", 0))[0];
  assert.equal(saved?.id, row.id);
  assert.equal(saved?.status, "failed");
  assert.equal(saved?.error, failure);
  const retainedFrames = await createGameStoryboardsStorage(db).listKeyframes(row.id);
  assert.deepEqual(
    retainedFrames.map((frame) => frame.id),
    plannedFrames.map((frame) => frame.id),
  );
  assert.equal(retainedFrames[0]?.imagePrompt, "Accepted compact scene");
  assert.equal(retainedFrames[7]?.imagePrompt, "Original scene 7");
  const route = readFileSync(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");
  const endpoint = route.slice(route.indexOf('app.post("/storyboard/generate"'));
  assert.ok(
    endpoint.indexOf("const planningRow = await storyboards.create(") <
      endpoint.indexOf("const visualHistory = await Promise.all("),
  );
  assert.match(endpoint, /storyboards\.update\(planningStoryboardId, \{ status: "failed", error: message \}\)/);
  assert.match(endpoint, /input\.previewOnly\s*\? createResponseAbortSignal[\s\S]*?: AbortSignal\.timeout/);
  assert.ok(
    /input\.automatic\s*&&\s*\(await storyboards\.listForTurn/.test(endpoint),
    "Automatic admission checks saved jobs",
  );
  console.info(
    "Planning is readable on reconnect; exact preparation failure survives storage reopen. Route persists before provider work and only previews use the response abort signal.",
  );
} finally {
  await db._fileStore.close();
}

// Exercise the actual route's cache predicate against changed source and review inputs.
const { createRequire } = await import("node:module");
const require = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const ts = require("typescript");
const source = readFileSync(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("game.routes.ts", source, ts.ScriptTarget.Latest, true);
let predicate = "";
function visit(node) {
  if (ts.isArrowFunction(node) && node.body.getText(tree).includes('row.error?.startsWith("Storyboard image prompt")'))
    predicate = node.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(predicate);
const state = { historyHash: "history", settingsHash: "review-settings" };
const canReuse = new Function(
  "roleplaySourceNarrationHash",
  "storyboardSourceNarrationHash",
  "sourceNarration",
  "illustratorMessages",
  "visualSceneState",
  `return (${predicate});`,
)("source", () => "", "", { systemPrompt: "director" }, state);
const candidate = {
  status: "failed",
  error: "Storyboard image prompt exceeds 1000 words.",
  sourceNarrationHash: "source",
  directorPrompt: "director",
  visualSceneState: JSON.stringify(state),
};
assert.equal(canReuse(candidate), true);
for (const patch of [
  { status: "complete" },
  { error: "Provider unavailable" },
  { sourceNarrationHash: "edited source" },
  { directorPrompt: "changed planner" },
  { visualSceneState: JSON.stringify({ ...state, settingsHash: "changed review" }) },
  { visualSceneState: JSON.stringify({ ...state, historyHash: "changed history" }) },
])
  assert.equal(canReuse({ ...candidate, ...patch }), false);
console.info("Reviewed-plan reuse rejects different source, planner, review rules, history, and unrelated failures.");
