import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Worker budget: historical backfill may run several receipts of one chat at once (their source ranges
// are disjoint and publication is a separate explicit step), but it must never take the last slot while
// a live turn is waiting.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-concurrency-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { createGameContinuityStorage } = await import(
    "../../packages/server/src/services/storage/game-continuity.storage.js"
  );
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const db = await createFileNativeDB();
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 16, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Concurrency test", provider: "custom", model: "m" });
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
  await db.insert(chats).values({
    id: "chat-2",
    name: "chat-2",
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
    { id: "m2-u", chatId: "chat-2", role: "user", content: "I promise to return.", createdAt: t(1) },
    { id: "m2-a", chatId: "chat-2", role: "assistant", content: "Acknowledged.", createdAt: t(2) },
  ]);
  const config = await readContinuityConfig(db, "chat-1", { allowHistoricalBackfill: true });
  const preparedFor = (chatId: string, messageId: string) =>
    prepareContinuitySources(
      [{ id: messageId, chatId, role: "assistant", content: "Acknowledged.", createdAt: t(2) }] as never,
      { gameContinuity: { mode: "shadow" } } as never,
    );
  const storage = createGameContinuityStorage(db);
  const receipt = (id: string, historical: boolean, chatId = "chat-1") =>
    ({
      id,
      chatId,
      sessionNumber: 1,
      sourceHash: `source-${id}`,
      sources: preparedFor(chatId, chatId === "chat-1" ? "m-a" : "m2-a"),
      context: [],
      configHash: config.hash,
      config: historical
        ? {
            ...config.frozen,
            historicalBackfill: { id: "historical-x", fromMessageId: "m-a", toMessageId: "m-a", sessionNumber: 1 },
          }
        : config.frozen,
      status: "queued" as const,
      attempts: 0,
      repairAttempts: 0,
      records: [],
      dispositions: [],
      review: null,
      entryIds: [],
      createdAt: t(3),
      updatedAt: t(3),
    }) as never;

  // Five historical receipts on the session being indexed, one live turn on the session being played.
  for (let i = 0; i < 5; i += 1) await storage.enqueue(receipt(`gch_backfill-${i}`, true));
  await storage.enqueue(receipt("gcb_live-1", false, "chat-2"));

  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let concurrent = 0;
  let peakBackfill = 0;
  let backfillWhenLiveAdmitted = -1;
  const seen = new Set<string>();
  const complete = async ({ stage, receipt: current }: { stage: string; receipt: { id: string; sources: unknown[] } }) => {
    if (!current.id.startsWith("gch_") && backfillWhenLiveAdmitted < 0) backfillWhenLiveAdmitted = concurrent;
    seen.add(current.id);
    if (current.id.startsWith("gch_")) {
      concurrent += 1;
      peakBackfill = Math.max(peakBackfill, concurrent);
      await gate;
      concurrent -= 1;
    }
    const dispositions = (current.sources as Array<{ messageId: string }>).map((source) => ({
      messageId: source.messageId,
      status: "no_durable_facts",
      reason: "nothing durable",
    }));
    return stage === "extract" ? { records: [], dispositions } : { findings: [], dispositions };
  };

  const runtime = createGameContinuityRuntime(db, {
    complete,
    maxDrainMs: 5000,
    maxConcurrent: 4,
    backfillConcurrency: 4,
  } as never);
  await runtime.start();
  const deadline = Date.now() + 20_000;
  while ((peakBackfill < 3 || !seen.has("gcb_live-1")) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));

  // Several historical receipts of one chat run at once (the old rule allowed exactly one)...
  assert.equal(peakBackfill, 3, `three backfill receipts of one session run at once (saw ${peakBackfill})`);
  // ...but never the last slot: the waiting live turn is admitted rather than queued behind the backlog.
  assert.ok(seen.has("gcb_live-1"), "the live turn is admitted while the historical backlog runs");
  assert.equal(
    backfillWhenLiveAdmitted,
    3,
    `the live turn ran alongside three backfill workers, never queued behind them (saw ${backfillWhenLiveAdmitted})`,
  );
  // Once no live work is waiting, backfill may use every slot.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(peakBackfill <= 4, `backfill never exceeds the total worker budget (saw ${peakBackfill})`);

  release?.();
  await runtime.stop();
  await db._fileStore.close();
  console.log("game-continuity-concurrency regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
