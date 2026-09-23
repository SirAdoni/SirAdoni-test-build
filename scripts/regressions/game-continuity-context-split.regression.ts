import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A prompt that overflows the model context is split once into two source halves under deterministic
// ids; the original is journaled as replaced. A single-slice batch is never split (it becomes
// unresolved) so an oversized turn can never loop.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-context-split-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const db = await createFileNativeDB();
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Split test", provider: "custom", model: "m" });

  const addChat = async (id: string, rows: Array<{ role: "user" | "assistant"; content: string }>) => {
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
    await db.insert(messages).values(
      rows.map((row, index) => ({
        id: `${id}-${index}`,
        chatId: id,
        role: row.role,
        content: row.content,
        createdAt: t(index + 1),
      })),
    );
  };
  // Two primary slices (user + assistant): splittable exactly once.
  await addChat("pair", [
    { role: "user", content: "I promise to return the amulet." },
    { role: "assistant", content: "The priestess nods and records the vow." },
    { role: "user", content: "Thanks." },
  ]);
  // The same shape, but every prompt overflows: halves become unresolved instead of splitting again.
  await addChat("twice", [
    { role: "user", content: "I swear to guard the gate." },
    { role: "assistant", content: "The captain accepts the oath." },
    { role: "user", content: "Thanks." },
  ]);
  // One primary slice (assistant opens the chat): never split.
  await addChat("single", [
    { role: "assistant", content: "The gate is closed for the night." },
    { role: "user", content: "I wait." },
  ]);

  const calls: Array<{ receiptId: string; stage: string; sources: number }> = [];
  const complete = async ({ stage, receipt }: { stage: "extract" | "review" | "repair"; receipt: any }) => {
    calls.push({ receiptId: receipt.id, stage, sources: receipt.sources.length });
    if (receipt.chatId === "twice")
      throw Object.assign(new Error("prompt is too long"), { code: "CONTINUITY_CONTEXT_OVERFLOW" });
    if (receipt.chatId === "single") throw new Error("Input exceeds the maximum context tokens of this model");
    if (receipt.sources.length > 1)
      throw Object.assign(new Error("context window exceeded"), { code: "CONTINUITY_CONTEXT_OVERFLOW" });
    const dispositions = receipt.sources.map((source: any) => ({
      messageId: source.messageId,
      status: "no_durable_facts",
      reason: "nothing durable",
    }));
    return stage === "extract" ? { records: [], dispositions } : { findings: [], dispositions };
  };
  const runtime = createGameContinuityRuntime(db, { complete, maxDrainMs: 3000 });
  const waitUntil = async (check: () => Promise<boolean>, timeoutMs = 15_000) => {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  // 1. Two-slice batch: split once, both halves verified, original journaled as replaced.
  const pair = await runtime.enqueueCommittedTurn({ chatId: "pair", assistantMessageId: "pair-1" });
  assert.ok(pair, "pair batch queued");
  assert.equal(pair!.sources.length, 2, "fixture batch covers two primary slices");
  await waitUntil(async () => (await runtime.get(pair!.id))?.status === "stale");
  const replaced = await runtime.get(pair!.id);
  assert.equal(replaced?.errorCode, "CONTINUITY_CONTEXT_OVERFLOW");
  const splitInto = (replaced?.config as { splitInto?: string[] }).splitInto;
  assert.ok(Array.isArray(splitInto) && splitInto.length === 2, "original records both replacement ids");
  assert.ok(
    splitInto!.every((id) => id.startsWith("gcb_") && id !== pair!.id),
    "halves keep the live prefix",
  );
  assert.notEqual(splitInto![0], splitInto![1]);
  assert.match(String(replaced?.error), new RegExp(splitInto![0]!), "error text names the replacements");
  await waitUntil(async () => {
    for (const id of splitInto!) if ((await runtime.get(id))?.status !== "verified") return false;
    return true;
  });
  const halves = await Promise.all(splitInto!.map((id) => runtime.get(id)));
  assert.deepEqual(
    halves.flatMap((half) => half!.sources),
    pair!.sources,
    "the halves cover the original sources exactly, in order",
  );
  assert.ok(
    halves.every((half) => half!.configHash === pair!.configHash),
    "halves keep the config hash",
  );
  assert.ok(halves.every((half) => half!.sources.length === 1));
  const pairReceipts = await runtime.list("pair");
  assert.equal(pairReceipts.length, 3, "one stale original plus two halves, nothing else");
  assert.equal(calls.filter((call) => call.receiptId === pair!.id).length, 1, "the original is not retried");

  // 2. Halves that still overflow become unresolved: a single-slice batch is never split again.
  const twice = await runtime.enqueueCommittedTurn({ chatId: "twice", assistantMessageId: "twice-1" });
  assert.ok(twice, "twice batch queued");
  await waitUntil(async () => {
    const receipts = await runtime.list("twice");
    return receipts.length === 3 && receipts.every((receipt) => ["stale", "unresolved"].includes(receipt.status));
  });
  const twiceReceipts = await runtime.list("twice");
  assert.equal(twiceReceipts.filter((receipt) => receipt.status === "stale").length, 1);
  const unresolved = twiceReceipts.filter((receipt) => receipt.status === "unresolved");
  assert.equal(unresolved.length, 2);
  assert.ok(unresolved.every((receipt) => receipt.errorCode === "CONTINUITY_CONTEXT_OVERFLOW"));
  assert.ok(unresolved.every((receipt) => (receipt.config as { splitInto?: unknown }).splitInto === undefined));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await runtime.list("twice")).length, 3, "no further receipts are ever created");

  // 3. A single-slice turn (message-only overflow, no code) is marked unresolved without a split.
  const single = await runtime.enqueueCommittedTurn({ chatId: "single", assistantMessageId: "single-0" });
  assert.ok(single, "single batch queued");
  assert.equal(single!.sources.length, 1);
  await waitUntil(async () => (await runtime.get(single!.id))?.status === "unresolved");
  assert.equal((await runtime.get(single!.id))?.errorCode, "CONTINUITY_CONTEXT_OVERFLOW");
  assert.equal((await runtime.list("single")).length, 1, "single-slice batch is never split");
  assert.equal(calls.filter((call) => call.receiptId === single!.id).length, 1, "overflow does not burn retries");

  await runtime.stop();
  console.log("game continuity context split regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
