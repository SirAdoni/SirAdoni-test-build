import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// A chat whose continuity has no usable extraction/review connection must not stop continuity for every other
// chat. Before this, four old sessions without a connection kept the whole runtime paused for an hour at a time,
// so the current session's queue (186 batches) never ran. The misconfigured chat's work now waits on its own,
// unspent and resumable, while a healthy chat is still processed.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-unavailable-admission-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.CONTINUITY_MAX_CONCURRENT = "2";
process.env.CONTINUITY_BACKFILL_CONCURRENCY = "1";
process.env.CONTINUITY_BACKFILL_TURNS_PER_RECEIPT = "1";

const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
let runtime: any = null;
let db: any = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } = await import(
    "../../packages/server/src/services/storage/game-continuity.storage.js"
  );
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  db = await createFileNativeDB();
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Healthy", provider: "custom", model: "m" });
  await db.insert(chats).values({
    id: "unavailable-chat",
    name: "No continuity connection",
    mode: "game",
    connectionId: null,
    metadata: JSON.stringify({ gameContinuity: { mode: "shadow" } }),
    createdAt: t(0),
    updatedAt: t(0),
  });
  await db.insert(chats).values({
    id: "healthy-chat",
    name: "Healthy",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify({
      gameContinuity: { mode: "shadow", extractionInstructions: "x", verificationInstructions: "y" },
    }),
    createdAt: t(0),
    updatedAt: t(0),
  });
  await db.insert(messages).values([
    { id: "h-u", chatId: "healthy-chat", role: "user", content: "I promise to return.", createdAt: t(1) },
    { id: "h-a", chatId: "healthy-chat", role: "assistant", content: "Acknowledged.", createdAt: t(2) },
  ]);
  const receipt: GameContinuityReceipt = {
    id: "receipt-unavailable",
    chatId: "unavailable-chat",
    sessionNumber: 1,
    sourceHash: "source",
    sources: [],
    context: [],
    configHash: "config",
    config: {},
    status: "queued",
    attempts: 0,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    entryIds: [],
    createdAt: t(0),
    updatedAt: t(0),
  };
  const storage = createGameContinuityStorage(db);
  await storage.enqueue(receipt);
  const calls: string[] = [];
  runtime = createGameContinuityRuntime(db, {
    complete: async ({ receipt: current }: { receipt: GameContinuityReceipt }) => {
      calls.push(current.chatId);
      throw Object.assign(new Error("stub stops here"), { code: "CONTINUITY_STAGE_FAILED" });
    },
    providerBackoffMs: { initial: 100, max: 100 },
    maxDrainMs: 500,
  });
  await runtime.start();
  await runtime.enqueueCommittedTurn({ chatId: "healthy-chat", assistantMessageId: "h-a" });
  const deadline = Date.now() + 5_000;
  while (!calls.includes("healthy-chat") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(calls.includes("healthy-chat"), "a healthy chat is still processed");
  assert.equal(calls.includes("unavailable-chat"), false, "the chat without a connection never reaches a stage");
  assert.equal(runtime.health().pauseCode, null, "a missing connection for one chat does not pause the runtime");
  assert.deepEqual(unhandled, [], "unavailable admission must be handled by the runtime pump");
  const waiting = await storage.get(receipt.id);
  assert.equal(waiting?.status, "queued", "its work stays queued for configuration recovery");
  assert.equal(waiting?.attempts, 0, "admission failure must not spend a worker attempt");
  console.info("game continuity unavailable admission regression passed");
} finally {
  await runtime?.stop();
  await db?._fileStore.close();
  process.off("unhandledRejection", onUnhandled);
  rmSync(root, { recursive: true, force: true });
}
