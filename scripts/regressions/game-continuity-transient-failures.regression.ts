import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Timeouts and unavailable providers are transient: they must not spend batch attempts, the receipt
// must stay resumable, and N consecutive failures across batches must trip a runtime-wide breaker
// that a later healthy answer resets.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-transient-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
// Pin the worker budget: the Engine loads .env through dotenv when server modules are imported, so an
// installation tuned for a large archive must not change what these fixtures measure.
process.env.CONTINUITY_MAX_CONCURRENT = "2";
process.env.CONTINUITY_BACKFILL_CONCURRENCY = "1";
process.env.CONTINUITY_BACKFILL_TURNS_PER_RECEIPT = "1";

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const db = await createFileNativeDB();
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Transient test", provider: "custom", model: "m" });

  const addChat = async (id: string) => {
    await db.insert(chats).values({
      id,
      name: id,
      mode: "game",
      connectionId: "conn",
      metadata: JSON.stringify({
        gameContinuity: { mode: "shadow", extractionInstructions: "x", verificationInstructions: "y" },
      }),
      createdAt: t(0),
      updatedAt: t(0),
    });
    await db.insert(messages).values([
      { id: `${id}-u`, chatId: id, role: "user", content: `${id}: I promise to return.`, createdAt: t(1) },
      { id: `${id}-a`, chatId: id, role: "assistant", content: `${id}: Acknowledged.`, createdAt: t(2) },
      { id: `${id}-u2`, chatId: id, role: "user", content: `${id}: Thanks.`, createdAt: t(3) },
    ]);
  };
  await addChat("live-a");
  await addChat("live-b");
  await addChat("live-c");

  const PAUSE_MS = 400;
  const RESUMABLE = ["queued", "extracting", "reviewing", "repairing"];
  const calls: Array<{ receiptId: string; stage: string; at: number }> = [];
  // Phase 1: three transient failures in a row (message-only timeout, coded timeout, coded unavailable).
  const failures: Array<() => Error> = [
    () => new Error("CONTINUITY_TIMEOUT"),
    () => Object.assign(new Error("continuity extract stage timed out after 120000ms"), { code: "CONTINUITY_TIMEOUT" }),
    () => Object.assign(new Error("fetch failed"), { code: "CONTINUITY_PROVIDER_UNAVAILABLE" }),
  ];
  let blockGate: Promise<void> | null = null;
  let liveGate: Promise<void> | null = null;
  const complete = async ({ stage, receipt }: { stage: "extract" | "review" | "repair"; receipt: any }) => {
    calls.push({ receiptId: receipt.id, stage, at: Date.now() });
    if (blockGate && String(receipt.chatId).startsWith("block-")) await blockGate;
    if (liveGate && receipt.chatId === "live-c") {
      const held = liveGate;
      liveGate = null; // only the first live-c call is held
      await held;
    }
    const failure = failures.shift();
    if (failure) throw failure();
    const dispositions = receipt.sources.map((source: any) => ({
      messageId: source.messageId,
      status: "no_durable_facts",
      reason: "nothing durable",
    }));
    return stage === "extract" ? { records: [], dispositions } : { findings: [], dispositions };
  };
  const runtime = createGameContinuityRuntime(db, {
    complete,
    maxDrainMs: 3000,
    providerBackoffMs: { initial: PAUSE_MS, max: PAUSE_MS * 4 },
    unresponsiveThreshold: 3,
  });
  const waitUntil = async (check: () => Promise<boolean> | boolean, timeoutMs = 15_000) => {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  // 1. The breaker trips after the third consecutive transient failure; no attempt was spent.
  const first = await runtime.enqueueCommittedTurn({ chatId: "live-a", assistantMessageId: "live-a-a" });
  assert.ok(first, "live batch was queued");
  await waitUntil(() => runtime.health().pauseCode === "CONTINUITY_PROVIDER_UNRESPONSIVE");
  assert.equal(calls.length, 3, "the breaker trips after exactly three transient failures");
  assert.equal(runtime.health().transientFailures, 3);
  const tripped = await runtime.get(first!.id);
  assert.equal(tripped?.attempts, 0, "transient failures never spend a batch attempt");
  assert.ok(RESUMABLE.includes(String(tripped?.status)), `receipt stays resumable (got ${tripped?.status})`);
  assert.equal(tripped?.errorCode, "CONTINUITY_PROVIDER_UNRESPONSIVE", "affected receipt carries the breaker code");
  const trippedAt = calls[2]!.at;

  // 2. Nothing runs during the pause, even for newly queued live work.
  const second = await runtime.enqueueCommittedTurn({ chatId: "live-b", assistantMessageId: "live-b-a" });
  assert.ok(second, "second live batch queued");
  await new Promise((resolve) => setTimeout(resolve, PAUSE_MS / 4));
  assert.equal(calls.length, 3, "no provider call is made while the breaker is open");

  // 3. After the pause both batches complete; the first healthy answer resets the breaker and clears codes.
  await waitUntil(async () => {
    for (const id of [first!.id, second!.id]) if ((await runtime.get(id))?.status !== "verified") return false;
    return true;
  });
  assert.ok(
    calls[3]!.at - trippedAt >= PAUSE_MS - 50,
    `work resumed only after the pause (${calls[3]!.at - trippedAt}ms)`,
  );
  assert.equal(runtime.health().pauseCode, null, "the breaker closes after a healthy answer");
  assert.equal(runtime.health().transientFailures, 0, "the consecutive counter resets on success");
  for (const id of [first!.id, second!.id]) {
    const done = await runtime.get(id);
    assert.equal(done?.attempts, 1, "only the successful execution is counted");
    assert.equal(done?.errorCode, undefined, "the transient diagnostic clears after success");
  }

  // 4. Below the threshold a timeout is a plain resumable refund (CONTINUITY_TIMEOUT) and never pauses.
  // live-c's first call is held in flight while two gated blockers take the worker slots, so after the
  // timeout the receipt cannot be re-admitted (which would start a new attempt and clear the code)
  // while its persisted state is inspected.
  await addChat("block-a");
  await addChat("block-b");
  let releaseBlockers: () => void = () => {};
  let releaseLive: () => void = () => {};
  blockGate = new Promise<void>((resolve) => (releaseBlockers = resolve));
  liveGate = new Promise<void>((resolve) => (releaseLive = resolve));
  failures.push(
    () => Object.assign(new Error("stage timed out"), { code: "CONTINUITY_TIMEOUT" }),
    () => Object.assign(new Error("stage timed out"), { code: "CONTINUITY_TIMEOUT" }),
  );
  const third = await runtime.enqueueCommittedTurn({ chatId: "live-c", assistantMessageId: "live-c-a" });
  assert.ok(third, "third live batch queued");
  await waitUntil(() => calls.some((call) => call.receiptId === third!.id));
  const blockers = await Promise.all(
    ["block-a", "block-b"].map((chatId) => runtime.enqueueCommittedTurn({ chatId, assistantMessageId: `${chatId}-a` })),
  );
  assert.ok(blockers.every(Boolean), "blockers queued");
  const blockerIds = new Set(blockers.map((blocker) => blocker!.id));
  await waitUntil(() => calls.filter((call) => blockerIds.has(call.receiptId)).length === 1);
  releaseLive();
  await waitUntil(async () => (await runtime.get(third!.id))?.errorCode === "CONTINUITY_TIMEOUT");
  await waitUntil(() => calls.filter((call) => blockerIds.has(call.receiptId)).length === 2);
  const timedOut = await runtime.get(third!.id);
  assert.equal(timedOut?.attempts, 0, "a single timeout refunds its attempt");
  assert.ok(
    RESUMABLE.includes(String(timedOut?.status)),
    `timed-out receipt stays resumable (got ${timedOut?.status})`,
  );
  assert.equal(timedOut?.errorCode, "CONTINUITY_TIMEOUT", "a sub-threshold timeout keeps its own stable code");
  assert.equal(runtime.health().pauseCode, null, "one timeout does not open the breaker");
  assert.equal(runtime.health().transientFailures, 1);
  assert.equal(calls.filter((call) => call.receiptId === third!.id).length, 1, "the receipt waits for a free slot");
  releaseBlockers();
  await waitUntil(async () => {
    for (const id of [third!.id, ...blockerIds]) if ((await runtime.get(id))?.status !== "verified") return false;
    return true;
  });
  assert.equal(runtime.health().pauseCode, null, "two consecutive timeouts stay below the threshold");
  assert.equal(runtime.health().transientFailures, 0);
  assert.equal((await runtime.get(third!.id))?.attempts, 1, "two refunded timeouts plus one success count once");
  assert.equal((await runtime.get(third!.id))?.errorCode, undefined);

  await runtime.stop();
  console.log("game continuity transient failures regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
