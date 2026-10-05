import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Parking only covers receipts that already exist. A turn committed while the chat's continuity connection is
// unavailable never becomes a receipt: enqueueCommittedTurn throws CONTINUITY_CONNECTION_UNAVAILABLE (and
// generate.routes.ts rethrows it via releaseActiveGenerationAndRethrow, failing the player's send after the user
// message was saved). When the user then sets a working connection, PATCH /continuity calls resumeChat, which only
// re-reads existing rows; nothing reconciles the missed turn until the next Engine restart.
const root = mkdtempSync(join(tmpdir(), "marinara-bughunt-unavailable-turn-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true, campaignMemory: true, campaignIndex: true }));

  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Working", provider: "custom", model: "m" });
  const meta = (extractorConnectionId: string) =>
    JSON.stringify({
      gameSessionNumber: 1,
      gameContinuity: { mode: "active", extractorConnectionId, activationAt: "2026-09-16T00:00:00.000Z" },
    });
  await db.insert(chats).values({
    id: "chat",
    name: "Unavailable",
    mode: "game",
    connectionId: "conn",
    metadata: meta("deleted-connection"),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values([
    { id: "m1", chatId: "chat", role: "user", content: "I open the gate.", createdAt: "2026-09-16T00:00:01.000Z" },
    {
      id: "m2",
      chatId: "chat",
      role: "assistant",
      content: "The gate groans open.",
      createdAt: "2026-09-16T00:00:02.000Z",
    },
    { id: "m3", chatId: "chat", role: "user", content: "I step through.", createdAt: "2026-09-16T00:00:03.000Z" },
  ]);
  // The fake provider never answers, so nothing is published; only whether a receipt exists matters here.
  const runtime = createGameContinuityRuntime(db, { complete: () => new Promise(() => undefined) });

  let enqueueError: unknown = null;
  try {
    await runtime.enqueueCommittedTurn({ chatId: "chat", sessionNumber: 1, assistantMessageId: "m2" });
  } catch (error) {
    enqueueError = error;
  }

  // The user fixes the connection; the settings route persists it and calls resumeChat.
  await db
    .update(chats)
    .set({ metadata: meta("conn") })
    .where(eq(chats.id, "chat"));
  const after = await runtime.resumeChat("chat");
  await runtime.stop();
  await db._fileStore.close();

  const queuedAfterFix = after.some((receipt) => receipt.sources.some((source) => source.messageId === "m2"));
  console.log(
    `enqueue threw: ${enqueueError instanceof Error ? enqueueError.message : "no"}; queued after fix: ${queuedAfterFix}`,
  );
  assert.equal(
    enqueueError,
    null,
    `committing a turn must not throw when only the continuity connection is missing (got ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)})`,
  );
  assert.ok(
    after.some((receipt) => receipt.sources.some((source) => source.messageId === "m2")),
    "after the connection is fixed, the turn committed during the outage must be queued",
  );
  console.log("bughunt-continuity-unavailable-turn regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
