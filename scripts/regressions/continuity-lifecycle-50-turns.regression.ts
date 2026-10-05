import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Fixed-seed lifecycle proof over isolated storage. Provider completion is deterministic and local.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-lifecycle-50-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

let db: any = null;
let runtime: any = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, lorebooks, lorebookEntries, messages } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true, campaignMemory: true, campaignIndex: true }));
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");

  const chatId = "lifecycle-50";
  const stableText = "The group checks the north gate before leaving camp.";
  const now = "2026-09-26T00:00:00.000Z";
  const stamp = (index: number) => new Date(Date.parse(now) + index * 1000).toISOString();
  let completionCalls = 0;
  let activeCompletions = 0;
  let peakCompletions = 0;
  let concurrencyBarrierOpened = false;
  let releaseConcurrencyBarrier!: () => void;
  const concurrencyBarrier = new Promise<void>((resolve) => {
    releaseConcurrencyBarrier = resolve;
  });
  let cancelNextExtraction = false;
  let markCancellationReached!: () => void;
  const cancellationReached = new Promise<void>((resolve) => {
    markCancellationReached = resolve;
  });
  const makeRuntime = (database: any) =>
    createGameContinuityRuntime(database, {
      maxConcurrent: 3,
      backfillConcurrency: 2,
      backfillTurnsPerReceipt: 1,
      maxDrainMs: 3000,
      complete: async ({ stage, receipt, signal }: { stage: string; receipt: any; signal: AbortSignal }) => {
        completionCalls += 1;
        activeCompletions += 1;
        peakCompletions = Math.max(peakCompletions, activeCompletions);
        try {
          if (cancelNextExtraction && stage === "extract") {
            cancelNextExtraction = false;
            markCancellationReached();
            await new Promise<never>((_resolve, reject) => {
              if (signal.aborted) reject(new Error("synthetic cancellation"));
              else signal.addEventListener("abort", () => reject(new Error("synthetic cancellation")), { once: true });
            });
          }
          if (!concurrencyBarrierOpened) {
            if (peakCompletions >= 2) {
              concurrencyBarrierOpened = true;
              releaseConcurrencyBarrier();
            } else await concurrencyBarrier;
          }
          const dispositions = receipt.sources.map((source: any) => ({
            messageId: source.messageId,
            status: source.role === "user" ? "covered" : "no_durable_facts",
            reason: "fixed synthetic lifecycle fixture",
          }));
          if (stage !== "extract") return { findings: [], dispositions };
          const userSources = receipt.sources.filter((item: any) => item.role === "user");
          return {
            records: userSources.flatMap((source: any) => {
              const turn = Number(source.messageId.match(/u(\d+)$/u)?.[1]);
              return [
                {
                  kind: "event",
                  text: stableText,
                  subjects: ["the group"],
                  conditions: [],
                  status: "asserted",
                  evidence: [{ messageId: source.messageId, quote: source.content }],
                  keys: ["north gate", "camp"],
                },
                {
                  kind: "event",
                  text: `Synthetic turn ${turn} records the gate check.`,
                  subjects: ["the group"],
                  conditions: [],
                  status: "asserted",
                  evidence: [{ messageId: source.messageId, quote: source.content }],
                  keys: [`turn ${turn}`],
                },
              ];
            }),
            dispositions,
          };
        } finally {
          activeCompletions -= 1;
        }
      },
    });
  const getStorage = () => createGameContinuityStorage(db);
  const waitFor = async (predicate: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`timed out waiting for ${label}`);
  };

  db = await createFileNativeDB();
  await db
    .insert(apiConnections)
    .values({ id: "fixture-connection", name: "Synthetic", provider: "custom", model: "stub" });
  await db.insert(lorebooks).values({
    id: "fixture-book",
    name: "Synthetic Keeper",
    chatId,
    enabled: "true",
    sourceAgentId: "game-lorebook-keeper",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(chats).values({
    id: chatId,
    name: "Synthetic 50-turn lifecycle",
    mode: "game",
    connectionId: "fixture-connection",
    metadata: JSON.stringify({
      lorebookId: "fixture-book",
      gameContinuity: { mode: "active", extractionInstructions: "synthetic", verificationInstructions: "synthetic" },
    }),
    createdAt: now,
    updatedAt: now,
  });
  const manualPage = {
    id: "fixture-manual-page",
    lorebookId: "fixture-book",
    name: "Player-authored fixture note",
    content: "Keep the brass compass with the player.",
    dynamicState: JSON.stringify({ source: "user", manual: true }),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(lorebookEntries).values(manualPage);
  const manualPageBaseline = (await db.select().from(lorebookEntries)).find((entry: any) => entry.id === manualPage.id);
  assert.ok(manualPageBaseline);

  const appendTurns = async (from: number, to: number, firstUserAlreadyPresent = false) => {
    const rows: any[] = [];
    for (let turn = from; turn <= to; turn += 1) {
      const base = (turn - 1) * 2;
      if (!(firstUserAlreadyPresent && turn === from))
        rows.push({
          id: `life-u${turn}`,
          chatId,
          role: "user",
          content: `Seed 426108: we check the north gate before leaving camp (turn ${turn}).`,
          createdAt: stamp(base + 1),
        });
      rows.push({
        id: `life-a${turn}`,
        chatId,
        role: "assistant",
        content: `Acknowledged for synthetic turn ${turn}.`,
        createdAt: stamp(base + 2),
      });
    }
    await db.insert(messages).values(rows);
  };
  const waitVerified = async (receipts: any[], label: string) =>
    waitFor(
      async () =>
        (await Promise.all(receipts.map((receipt) => getStorage().get(receipt.id)))).every(
          (receipt) => receipt?.status === "verified" || receipt?.status === "published",
        ),
      label,
    );
  const publishRange = async (backfillId: string, receipts: any[]) => {
    await waitVerified(receipts, `${backfillId} verification`);
    await runtime.publishHistoricalBackfill(
      chatId,
      backfillId,
      receipts.map((receipt) => receipt.id),
    );
    await waitFor(
      async () =>
        (await Promise.all(receipts.map((receipt) => getStorage().get(receipt.id)))).every(
          (receipt) => receipt?.status === "published",
        ),
      `${backfillId} publication`,
    );
  };

  runtime = makeRuntime(db);
  const backfillId = "lifecycle-seed-426108";
  await appendTurns(1, 25);
  await db.insert(messages).values({
    id: "life-u26",
    chatId,
    role: "user",
    content: "Seed 426108: we check the north gate before leaving camp (turn 26).",
    createdAt: stamp(51),
  });
  const firstRange = await runtime.enqueueHistoricalRange({
    chatId,
    backfillId,
    fromMessageId: "life-u1",
    toMessageId: "life-a25",
  });
  assert.equal(firstRange.acceptedTurns, 25);
  assert.equal(firstRange.receipts.length, 25);
  await publishRange(backfillId, firstRange.receipts);
  assert.equal(peakCompletions, 2, "deterministic barrier observes two simultaneous backfill owners");

  const callsBeforeExact = completionCalls;
  const exactRange = await runtime.enqueueHistoricalRange({
    chatId,
    backfillId,
    fromMessageId: "life-u1",
    toMessageId: "life-a25",
  });
  assert.deepEqual(
    exactRange.receipts.map((receipt: any) => receipt.id),
    firstRange.receipts.map((receipt: any) => receipt.id),
  );
  assert.equal(completionCalls, callsBeforeExact, "an exact published range is reused without repeated work");

  await appendTurns(26, 30, true);
  await db.insert(messages).values({
    id: "life-u31",
    chatId,
    role: "user",
    content: "Seed 426108: we check the north gate before leaving camp (turn 31).",
    createdAt: stamp(61),
  });
  const overlapRange = await runtime.enqueueHistoricalRange({
    chatId,
    backfillId,
    fromMessageId: "life-u20",
    toMessageId: "life-a30",
  });
  assert.equal(overlapRange.acceptedTurns, 11);
  assert.equal(overlapRange.receipts.length, 11);
  assert.deepEqual(
    overlapRange.receipts.slice(0, 6).map((receipt: any) => receipt.id),
    firstRange.receipts.slice(19).map((receipt: any) => receipt.id),
    "the overlap reuses the six existing receipts and adds only turns 26-30",
  );
  await publishRange(backfillId, overlapRange.receipts);

  await appendTurns(31, 35, true);
  await db.insert(messages).values({
    id: "life-u36",
    chatId,
    role: "user",
    content: "Seed 426108: we check the north gate before leaving camp (turn 36).",
    createdAt: stamp(71),
  });
  cancelNextExtraction = true;
  const interruptedRange = await runtime.enqueueHistoricalRange({
    chatId,
    backfillId,
    fromMessageId: "life-u31",
    toMessageId: "life-a35",
  });
  await Promise.race([
    cancellationReached,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for cancel checkpoint")), 10_000)),
  ]);
  await runtime.stop();
  runtime = null;
  assert.equal(interruptedRange.acceptedTurns, 5);
  await db._fileStore.flush();
  await db._fileStore.close();
  db = await createFileNativeDB();
  runtime = makeRuntime(db);
  await runtime.start();
  const interruptedIds = new Set<string>(interruptedRange.receipts.map((receipt: any) => String(receipt.id)));
  await waitFor(
    async () =>
      (await Promise.all([...interruptedIds].map((id) => getStorage().get(id)))).every(
        (receipt) => receipt?.status === "verified" || receipt?.status === "published",
      ),
    "cancelled receipts resume after cold reopen",
  );
  await runtime.publishHistoricalBackfill(chatId, backfillId, [...interruptedIds]);

  await appendTurns(36, 50, true);
  await db.insert(messages).values({
    id: "life-tail",
    chatId,
    role: "user",
    content: "Seed 426108: synthetic test tail.",
    createdAt: stamp(101),
  });
  const finalRange = await runtime.enqueueHistoricalRange({
    chatId,
    backfillId,
    fromMessageId: "life-u26",
    toMessageId: "life-a50",
  });
  assert.equal(finalRange.acceptedTurns, 25);
  assert.equal(finalRange.receipts.length, 25);
  await publishRange(backfillId, finalRange.receipts);

  const finalReceipts = await getStorage().list(chatId);
  assert.equal(finalReceipts.length, 50, "cold reopen preserves one receipt per accepted synthetic turn");
  assert.ok(finalReceipts.every((receipt: any) => receipt.status === "published"));
  const finalFacts = new Set(
    finalReceipts.flatMap((receipt: any) => receipt.records.map((record: any) => record.text)),
  );
  const expectedFacts = [
    stableText,
    ...Array.from({ length: 50 }, (_, index) => `Synthetic turn ${index + 1} records the gate check.`),
  ];
  assert.deepEqual(
    [...finalFacts].sort(),
    expectedFacts.sort(),
    "all 50 distinct event facts and the shared stable fact survive rereads/restart",
  );
  for (let turn = 1; turn <= 50; turn += 1) {
    const receipt = finalReceipts.find((candidate: any) =>
      candidate.sources.some((source: any) => source.messageId === `life-u${turn}`),
    );
    assert.ok(receipt, `turn ${turn} retains exactly one source-owning receipt`);
    assert.ok(
      receipt.records.some(
        (record: any) =>
          record.text === `Synthetic turn ${turn} records the gate check.` &&
          record.evidence.some((item: any) => item.messageId === `life-u${turn}`),
      ),
      `turn ${turn} event remains grounded in its own source after restart`,
    );
  }
  assert.ok(
    completionCalls <= 104,
    `completion work remains bounded including one cancelled extraction retry (observed ${completionCalls} calls)`,
  );
  assert.equal(peakCompletions, 2, "only the configured two backfill completions are concurrently active");
  assert.ok(concurrencyBarrierOpened, "the completion barrier released only after concurrent work was observed");
  await runtime.stop();
  runtime = null;
  await db._fileStore.flush();
  const flushedStats = db._fileStore.getStorageStats?.();
  assert.equal(flushedStats?.lastFlushError, null, "the final explicit flush reports no storage write failure");
  assert.deepEqual(flushedStats?.dirtyTables, [], "the final explicit flush leaves no dirty tables");
  await db._fileStore.close();
  db = await createFileNativeDB();
  const durableReceipts = await getStorage().list(chatId);
  assert.equal(durableReceipts.length, 50, "a second cold reopen reads all 50 receipts from durable storage");
  assert.ok(durableReceipts.every((receipt: any) => receipt.status === "published"));
  const durableFacts = new Set(
    durableReceipts.flatMap((receipt: any) => receipt.records.map((record: any) => record.text)),
  );
  assert.deepEqual(
    [...durableFacts].sort(),
    expectedFacts.sort(),
    "all distinct events and the shared fact survive the final cold reopen",
  );
  for (let turn = 1; turn <= 50; turn += 1) {
    const receipt = durableReceipts.find((candidate: any) =>
      candidate.sources.some((source: any) => source.messageId === `life-u${turn}`),
    );
    assert.ok(
      receipt?.records.some(
        (record: any) =>
          record.text === `Synthetic turn ${turn} records the gate check.` &&
          record.evidence.some((item: any) => item.messageId === `life-u${turn}`),
      ),
      `durable turn ${turn} evidence survives the final cold reopen`,
    );
  }
  assert.deepEqual(
    (await db.select().from(lorebookEntries)).find((entry: any) => entry.id === manualPage.id),
    manualPageBaseline,
    "the player-authored page remains byte-for-byte unchanged",
  );
  console.info(
    `continuity lifecycle passed: 50 turns, ${durableReceipts.length} durable receipts, ${completionCalls} mocked completions`,
  );
} finally {
  await runtime?.stop();
  await db?._fileStore?.close();
  rmSync(root, { recursive: true, force: true });
}
