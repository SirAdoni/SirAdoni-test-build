import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

const root = mkdtempSync(join(tmpdir(), "marinara-continuity-unavailable-admission-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
let runtime: { start: () => Promise<void>; stop: () => Promise<void>; health: () => { pauseCode: string | null } } | null = null;
let db: any = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } = await import(
    "../../packages/server/src/services/storage/game-continuity.storage.js"
  );
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(chats).values({
    id: "unavailable-chat",
    name: "Unavailable continuity connection",
    mode: "game",
    connectionId: null,
    metadata: JSON.stringify({ gameContinuity: { mode: "shadow" } }),
    createdAt: now,
    updatedAt: now,
  });
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
    createdAt: now,
    updatedAt: now,
  };
  const storage = createGameContinuityStorage(db);
  await storage.enqueue(receipt);
  runtime = createGameContinuityRuntime(db, {
    providerBackoffMs: { initial: 100, max: 100 },
    maxDrainMs: 200,
  });
  await runtime.start();
  const deadline = Date.now() + 2_000;
  while (runtime.health().pauseCode === null && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.health().pauseCode, "CONTINUITY_PROVIDER_UNAVAILABLE");
  assert.deepEqual(unhandled, [], "unavailable admission must be handled by the runtime pump");
  const parked = await storage.get(receipt.id);
  assert.equal(parked?.status, "queued", "pending work remains queued for configuration recovery");
  assert.equal(parked?.attempts, 0, "admission failure must not spend a worker attempt");
  console.info("game continuity unavailable admission regression passed");
} finally {
  await runtime?.stop();
  await db?._fileStore.close();
  process.off("unhandledRejection", onUnhandled);
  rmSync(root, { recursive: true, force: true });
}
