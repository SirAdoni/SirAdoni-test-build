import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Provider quota exhaustion must pause continuity work without spending batch attempts, and live turns
// must be admitted before historical backfill once the pause ends.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-provider-limit-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const db = await createFileNativeDB();
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Limit test", provider: "custom", model: "test-model" });

  const addChat = async (id: string, mode: "shadow" | "off") => {
    await db.insert(chats).values({
      id,
      name: id,
      mode: "game",
      connectionId: "conn",
      metadata: JSON.stringify({ gameContinuity: { mode, extractionInstructions: "x", verificationInstructions: "y" } }),
      createdAt: t(0),
      updatedAt: t(0),
    });
    await db.insert(messages).values([
      { id: `${id}-u`, chatId: id, role: "user", content: `${id}: I promise to return.`, createdAt: t(1) },
      { id: `${id}-a`, chatId: id, role: "assistant", content: `${id}: Acknowledged.`, createdAt: t(2) },
      { id: `${id}-u2`, chatId: id, role: "user", content: `${id}: Thanks.`, createdAt: t(3) },
    ]);
  };
  await addChat("live-a", "shadow");
  await addChat("live-b", "shadow");
  await addChat("history", "off");

  const PAUSE_MS = 400;
  const calls: Array<{ receiptId: string; stage: string; at: number }> = [];
  let limitsRemaining = 1;
  const complete = async ({ stage, receipt }: { stage: "extract" | "review" | "repair"; receipt: any }) => {
    calls.push({ receiptId: receipt.id, stage, at: Date.now() });
    if (limitsRemaining > 0) {
      limitsRemaining -= 1;
      throw new Error("CONTINUITY_PROVIDER_LIMITED");
    }
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
  });
  const waitUntil = async (check: () => Promise<boolean>, timeoutMs = 15_000) => {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  // 1. The first live batch hits the limit.
  const first = await runtime.enqueueCommittedTurn({ chatId: "live-a", assistantMessageId: "live-a-a" });
  assert.ok(first, "live batch was queued");
  await waitUntil(async () => (await runtime.get(first!.id))?.errorCode === "CONTINUITY_PROVIDER_LIMITED");
  const limited = await runtime.get(first!.id);
  assert.equal(limited?.attempts, 0, "a provider limit does not spend a batch attempt");
  assert.ok(
    ["queued", "extracting", "reviewing", "repairing"].includes(String(limited?.status)),
    `limited batch stays resumable (got ${limited?.status})`,
  );
  const limitedAt = calls[0]!.at;

  // 2. While paused, a historical backfill and a second live turn are queued. Nothing may run yet.
  const backfill = await runtime.enqueueHistoricalRange({
    chatId: "history",
    backfillId: "limit-backfill",
    fromMessageId: "history-u",
    toMessageId: "history-a",
  });
  assert.ok(backfill.receipts.length > 0, "backfill queued");
  const second = await runtime.enqueueCommittedTurn({ chatId: "live-b", assistantMessageId: "live-b-a" });
  assert.ok(second, "second live batch queued");
  await new Promise((resolve) => setTimeout(resolve, PAUSE_MS / 4));
  assert.equal(calls.length, 1, "no provider call is made during the pause");

  // 3. After the pause every batch completes; live batches are admitted before backfill.
  const all = [first!.id, second!.id, ...backfill.receipts.map((receipt) => receipt.id)];
  await waitUntil(async () => {
    for (const id of all) if ((await runtime.get(id))?.status !== "verified") return false;
    return true;
  });
  const resumedAt = calls[1]!.at;
  assert.ok(resumedAt - limitedAt >= PAUSE_MS - 50, `work resumed only after the pause (${resumedAt - limitedAt}ms)`);
  const firstAdmission = new Map<string, number>();
  calls.slice(1).forEach((call, index) => {
    if (call.stage === "extract" && !firstAdmission.has(call.receiptId)) firstAdmission.set(call.receiptId, index);
  });
  const liveOrder = Math.max(firstAdmission.get(first!.id)!, firstAdmission.get(second!.id)!);
  for (const receipt of backfill.receipts)
    assert.ok(firstAdmission.get(receipt.id)! > liveOrder, "historical backfill waits for live turns");
  assert.equal((await runtime.get(first!.id))?.attempts, 1, "only the successful execution is counted");
  assert.equal((await runtime.get(first!.id))?.errorCode, undefined, "the limit diagnostic clears after success");

  await runtime.stop();
  console.log("game continuity provider limit regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
