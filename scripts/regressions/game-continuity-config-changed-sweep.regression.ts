import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A contract or settings change must retire the queued backlog quietly: one status write per receipt
// (stale, CONTINUITY_CONFIG_CHANGED) before any worker starts, never a provider call and never a
// warning per receipt.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-config-sweep-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { createGameContinuityStorage } = await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const db = await createFileNativeDB();
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 16, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Sweep test", provider: "custom", model: "m" });
  await db.insert(chats).values({
    id: "chat-1",
    name: "chat-1",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify({
      gameContinuity: { mode: "shadow", extractionInstructions: "x", verificationInstructions: "y" },
    }),
    createdAt: t(0),
    updatedAt: t(0),
  });
  await db.insert(messages).values([
    { id: "m-u", chatId: "chat-1", role: "user", content: "I promise to return.", createdAt: t(1) },
    { id: "m-a", chatId: "chat-1", role: "assistant", content: "Acknowledged.", createdAt: t(2) },
  ]);
  const config = await readContinuityConfig(db, "chat-1");
  const prepared = prepareContinuitySources(
    [{ id: "m-a", chatId: "chat-1", role: "assistant", content: "Acknowledged.", createdAt: t(2) }] as any,
    { gameContinuity: { mode: "shadow" } } as any,
  );
  const storage = createGameContinuityStorage(db);
  const receipt = (id: string, configHash: string) => ({
    id,
    chatId: "chat-1",
    sessionNumber: 1,
    sourceHash: `source-${id}`,
    sources: prepared,
    context: [],
    configHash,
    config: config.frozen,
    status: "queued" as const,
    attempts: 0,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    entryIds: [],
    createdAt: t(3),
    updatedAt: t(3),
  });
  // Two receipts queued under an older contract, one under the current one.
  await storage.enqueue(receipt("gcb_old-1", "contract-v-old") as any);
  await storage.enqueue(receipt("gcb_old-2", "contract-v-old") as any);
  await storage.enqueue(receipt("gcb_current", config.hash) as any);

  const calls: string[] = [];
  const runtime = createGameContinuityRuntime(db, {
    complete: async ({ stage, receipt: current }: { stage: string; receipt: any }) => {
      calls.push(`${current.id}:${stage}`);
      const dispositions = current.sources.map((source: any) => ({
        messageId: source.messageId,
        status: "no_durable_facts",
        reason: "nothing durable",
      }));
      return stage === "extract" ? { records: [], dispositions } : { findings: [], dispositions };
    },
    maxDrainMs: 3000,
  });
  await runtime.start();
  const deadline = Date.now() + 15_000;
  const settled = async () => {
    const rows = await Promise.all(["gcb_old-1", "gcb_old-2", "gcb_current"].map((id) => storage.get(id)));
    return rows.every((row) => row && !["queued", "extracting", "reviewing", "repairing"].includes(row.status));
  };
  while (!(await settled())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the runtime to settle");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await runtime.stop();

  for (const id of ["gcb_old-1", "gcb_old-2"]) {
    const row = await storage.get(id);
    assert.ok(row);
    assert.equal(row.status, "stale", `${id} is retired as stale`);
    assert.equal(row.errorCode, "CONTINUITY_CONFIG_CHANGED");
    assert.equal(row.attempts, 0, `${id} spent no attempt`);
  }
  assert.ok(!calls.some((call) => call.startsWith("gcb_old")), "no provider call for config-changed receipts");
  const current = await storage.get("gcb_current");
  assert.ok(current);
  assert.equal(current.status, "verified", "the receipt under the current contract still runs");
  assert.ok(calls.includes("gcb_current:extract"), "the current receipt reached the provider");

  // A receipt that stops being unfinished while its id still waits in the worker's in-memory queue (the
  // campaign index cancels this way) must be dropped untouched. Rewriting it to CONTINUITY_CONFIG_CHANGED
  // erased the cancellation marker, so a later rerun could not revive it and reported the session done
  // without indexing anything.
  let releaseFirst: (() => void) | null = null;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted = false;
  const cancelCalls: string[] = [];
  await storage.enqueue(receipt("gcb_hold", config.hash) as any);
  await storage.enqueue({ ...receipt("gcb_cancel", config.hash), sourceHash: "source-cancel" } as any);
  const cancelRuntime = createGameContinuityRuntime(db, {
    complete: async ({ stage, receipt: current }: { stage: string; receipt: any }) => {
      cancelCalls.push(`${current.id}:${stage}`);
      if (current.id === "gcb_hold") {
        firstStarted = true;
        await firstHeld;
      }
      const dispositions = current.sources.map((source: any) => ({
        messageId: source.messageId,
        status: "no_durable_facts",
        reason: "nothing durable",
      }));
      return stage === "extract" ? { records: [], dispositions } : { findings: [], dispositions };
    },
    maxDrainMs: 3000,
    maxConcurrent: 1,
  } as any);
  await cancelRuntime.start();
  const holdDeadline = Date.now() + 15_000;
  while (!firstStarted && Date.now() < holdDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(firstStarted, "the first receipt occupies the only worker");
  const waiting = await storage.get("gcb_cancel");
  assert.ok(waiting);
  assert.equal(waiting.status, "queued", "the second receipt is still waiting in the queue");
  // Cancel it the way the campaign index does, while its id is still queued in the worker.
  await storage.save({
    ...waiting,
    status: "stale",
    configHash: `cancelled:${waiting.configHash}`,
    errorCode: "CONTINUITY_INDEX_CANCELLED",
    error: "Campaign indexing was cancelled before this batch started.",
    updatedAt: new Date().toISOString(),
  } as any);
  releaseFirst?.();
  const drainDeadline = Date.now() + 15_000;
  while (Date.now() < drainDeadline) {
    const held = await storage.get("gcb_hold");
    if (held && !["queued", "extracting", "reviewing", "repairing"].includes(held.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  await cancelRuntime.stop();
  const cancelledRow = await storage.get("gcb_cancel");
  assert.ok(cancelledRow);
  assert.equal(cancelledRow.status, "stale");
  assert.equal(
    cancelledRow.errorCode,
    "CONTINUITY_INDEX_CANCELLED",
    "the cancellation marker survives the worker reaching the stale id",
  );
  assert.ok(cancelledRow.configHash.startsWith("cancelled:"), "the cancelled config hash is left intact");
  assert.ok(!cancelCalls.some((call) => call.startsWith("gcb_cancel")), "a cancelled receipt never reaches the provider");

  await db._fileStore.close();
  console.log("game-continuity-config-changed-sweep regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
