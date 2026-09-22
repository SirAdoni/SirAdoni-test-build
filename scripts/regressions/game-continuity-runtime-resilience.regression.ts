import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// Continuity runtime bookkeeping that used to strand work or fail loudly:
// 1. A stale receipt whose text and config match again (config A -> B -> A, a swipe back) is read again under a
//    new id; before, the stale row was found and handed back, so the turn was never read and retry did nothing.
// 2. Reconcile takes no holder snapshot (a durable write) for turns that are already published.
// 3. A small edit that keeps every quote of the final records but breaks a quote kept in the receipt's history
//    retires the receipt; before, the reanchor threw and the receipt stayed published on the old text.
// 4. One chat whose reconcile throws no longer fails start() and the reconcile of every later chat.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-runtime-resilience-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.CONTINUITY_MAX_CONCURRENT = "2";
process.env.CONTINUITY_BACKFILL_CONCURRENCY = "1";
process.env.CONTINUITY_BACKFILL_TURNS_PER_RECEIPT = "1";

let runtime: { stop(): Promise<void> } | null = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages, campaignMemoryEntities } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  const db = await createFileNativeDB();
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 20, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Resilience", provider: "custom", model: "m" });
  const continuityMeta = (mode: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      gameContinuity: { mode, extractionInstructions: "x", verificationInstructions: "y", activationAt: t(0) },
      ...extra,
    });
  const chat = (id: string, mode: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    mode: "game" as const,
    connectionId: "conn",
    metadata: continuityMeta(mode, extra),
    createdAt: t(0),
    updatedAt: t(0),
  });
  await db.insert(chats).values([
    chat("revive", "shadow"),
    chat("lazy", "active", { gameNpcs: [{ id: "npc-mira", name: "Mira" }] }),
    chat("anchor", "off"),
  ]);
  const turn = (chatId: string, n: number, assistant: string, offset: number) => [
    { id: `${chatId}-u${n}`, chatId, role: "user", content: `Question ${n}.`, createdAt: t(offset) },
    { id: `${chatId}-a${n}`, chatId, role: "assistant", content: assistant, createdAt: t(offset + 1) },
  ];
  await db.insert(messages).values([
    ...turn("revive", 1, "The bell rings twice.", 1),
    { id: "revive-u2", chatId: "revive", role: "user", content: "Next.", createdAt: t(3) },
    ...turn("lazy", 1, "Mira lights the lamp.", 1),
    ...turn("lazy", 2, "Mira closes the shutters.", 3),
    { id: "lazy-u3", chatId: "lazy", role: "user", content: "Next.", createdAt: t(5) },
    ...turn("anchor", 1, "Line A stays. Line B will change.", 1),
    { id: "anchor-u2", chatId: "anchor", role: "user", content: "Next.", createdAt: t(3) },
  ]);

  const extracted: string[] = [];
  const complete = async ({ stage, receipt }: { stage: string; receipt: GameContinuityReceipt }) => {
    const dispositions = receipt.sources.map((source) => ({
      messageId: source.messageId,
      status: "no_durable_facts",
      reason: "stub",
    }));
    if (stage === "extract") extracted.push(receipt.id);
    return stage === "extract" || stage === "repair" ? { records: [], dispositions } : { findings: [], dispositions };
  };
  const continuity = createGameContinuityRuntime(db, { complete: complete as never, maxDrainMs: 3000 });
  runtime = continuity;
  const storage = createGameContinuityStorage(db);
  const waitUntil = async (predicate: () => Promise<boolean>, label: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  const settled = (chatId: string, status: string) => async () => {
    const list = await storage.list(chatId);
    return list.length > 0 && list.every((receipt) => receipt.status === status || receipt.status === "stale");
  };

  // 1. Stale receipt with the current text and config.
  const first = await continuity.enqueueCommittedTurn({ chatId: "revive", assistantMessageId: "revive-a1" });
  assert.ok(first);
  await waitUntil(settled("revive", "verified"), "the shadow turn to verify");
  // The worker still writes once after the status reads verified; wait until the row stops changing.
  let lastSeen = "";
  let quiet = 0;
  await waitUntil(async () => {
    const seen = JSON.stringify(await storage.get(first.id));
    quiet = seen === lastSeen ? quiet + 1 : 0;
    lastSeen = seen;
    return quiet >= 10;
  }, "the shadow worker to finish");
  const verified = (await storage.get(first.id))!;
  await storage.save({
    ...verified,
    status: "stale",
    errorCode: "CONTINUITY_CONFIG_CHANGED",
    error: "The continuity configuration changed after this batch was queued.",
    updatedAt: new Date().toISOString(),
  });
  extracted.length = 0;
  const retried = await continuity.retry("revive", first.id);
  assert.ok(retried);
  assert.notEqual(retried.id, first.id, "retry reads the stale turn again under a new id");
  assert.equal(retried.status, "queued");
  await waitUntil(async () => (await storage.get(retried.id))?.status === "verified", "the revived turn to verify");
  assert.deepEqual(extracted, [retried.id], "the turn was actually read again");
  assert.equal((await storage.get(first.id))?.status, "stale", "the stale row keeps its history");
  await continuity.reconcileChat("revive");
  assert.equal((await storage.list("revive")).length, 2, "reconcile does not re-read a turn that has a live receipt");

  // 2. Reconcile over published turns takes no holder snapshot.
  for (const id of ["lazy-a1", "lazy-a2"])
    assert.ok(await continuity.enqueueCommittedTurn({ chatId: "lazy", assistantMessageId: id }));
  await waitUntil(settled("lazy", "published"), "the active turns to publish");
  let durableWrites = 0;
  const transaction = db.transaction.bind(db);
  db.transaction = ((callback: unknown, options?: { durable?: boolean }) => {
    if (options?.durable) durableWrites += 1;
    return (transaction as (...args: unknown[]) => unknown)(callback, options);
  }) as typeof db.transaction;
  await continuity.reconcileChat("lazy");
  db.transaction = transaction;
  assert.equal(durableWrites, 0, "published turns cost no durable holder write on reconcile");

  // 3. Small edit that breaks a quote kept only in history.
  const anchorMessages = await db.select().from(messages).where(eq(messages.chatId, "anchor"));
  const sources = prepareContinuitySources(
    anchorMessages.filter((message: { id: string }) => message.id !== "anchor-u2"),
    {},
  ).map((source) => ({ ...source })) as GameContinuityReceipt["sources"];
  const assistantSource = sources.find((source) => source.messageId === "anchor-a1")!;
  const base: GameContinuityReceipt = {
    id: "gcb_anchor",
    chatId: "anchor",
    sessionNumber: 0,
    sourceHash: "anchor-source",
    sources,
    context: [],
    configHash: "anchor-config",
    config: {},
    status: "queued",
    attempts: 0,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    entryIds: [],
    createdAt: t(10),
    updatedAt: t(10),
  };
  const recordFor = (quote: string) => {
    const record = {
      kind: "event" as const,
      text: quote,
      subjects: [],
      conditions: [],
      status: "asserted" as const,
      evidence: [{ messageId: "anchor-a1", quote }],
      keys: ["line"],
    };
    return { ...record, id: createGameContinuityRecordId(base.id, record) };
  };
  const dispositions = sources.map((source) => ({
    messageId: source.messageId,
    status: source.messageId === "anchor-a1" ? ("covered" as const) : ("no_durable_facts" as const),
    reason: "stub",
  }));
  assert.ok(assistantSource.content.includes("Line B will change."));
  await storage.enqueue(base);
  await storage.save({ ...base, status: "extracting", attempts: 1, records: [recordFor("Line B will change.")], dispositions, updatedAt: t(11) });
  await storage.save({ ...base, status: "verified", attempts: 1, records: [recordFor("Line A stays.")], dispositions, review: { findings: [], dispositions }, updatedAt: t(12) });
  await storage.publish(base.id, async () => []);
  assert.ok((await storage.getHistory("anchor", base.id)).some((snapshot) => snapshot.records[0]?.text === "Line B will change."));
  let callbackRan = false;
  const edited = "Line A stays. Line B changed!";
  const editedSources = sources.map((source) =>
    source.messageId === "anchor-a1" ? { ...source, content: edited, hash: `${source.hash}-edited` } : source,
  );
  assert.equal(
    await storage.reanchor(base.id, editedSources, async () => {
      callbackRan = true;
    }),
    null,
    "storage refuses a reanchor its history cannot survive",
  );
  assert.equal(callbackRan, false, "nothing is re-stamped for a refused reanchor");
  await db.update(messages).set({ content: edited }).where(eq(messages.id, "anchor-a1"));
  await continuity.reconcileChat("anchor", { changedMessageIds: ["anchor-a1"] });
  assert.equal((await storage.get(base.id))?.status, "stale", "the receipt is retired instead of kept on old text");

  // 4. A chat whose reconcile throws does not fail start().
  await db.insert(chats).values([chat("broken", "active"), chat("healthy", "active")]);
  await db.insert(messages).values([
    ...turn("broken", 1, "The door creaks.", 20),
    { id: "broken-u2", chatId: "broken", role: "user", content: "Next.", createdAt: t(22) },
    ...turn("healthy", 1, "The fire crackles.", 20),
    { id: "healthy-u2", chatId: "healthy", role: "user", content: "Next.", createdAt: t(22) },
  ]);
  await db.insert(campaignMemoryEntities).values({
    entityId: "broken-entity",
    chatId: "broken",
    kind: "lore",
    owner: "{not json",
    aliases: "[not json",
    tags: "[]",
    status: "active",
    manualLock: 0,
    revision: 1,
    createdAt: t(0),
    updatedAt: t(0),
  } as never);
  await assert.rejects(continuity.reconcileChat("broken"), "the fixture makes reconcile throw for this chat");
  await continuity.start();
  await waitUntil(async () => (await storage.list("healthy")).length > 0, "the healthy chat to be reconciled");

  console.log("game-continuity-runtime-resilience regression passed");
} finally {
  await runtime?.stop();
  rmSync(root, { recursive: true, force: true });
}
