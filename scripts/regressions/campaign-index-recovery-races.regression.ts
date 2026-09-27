import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

// Recovery races for campaign index jobs: a stale completed-job inventory read must not replace a newer job,
// and an incomplete live exact-range manifest must be extended in place when its uncovered range is retried.
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-index-recovery-races-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.CONTINUITY_MAX_CONCURRENT = "1";
process.env.CONTINUITY_BACKFILL_CONCURRENCY = "1";
process.env.CONTINUITY_BACKFILL_TURNS_PER_RECEIPT = "1";

let runtime: { stop(): Promise<void> } | null = null;
let app: any = null;
let releaseProviderWaiters: () => void = () => {};
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages, gameContinuityBatches } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { readContinuityInventory } =
    await import("../../packages/server/src/routes/game-continuity-backfill.routes.js");
  const { campaignIndexRoutes, tickCampaignIndexJobs } =
    await import("../../packages/server/src/routes/campaign-index.routes.js");

  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  const at = (offset: number) => new Date(Date.parse(now) + offset * 1000).toISOString();
  await db.insert(apiConnections).values({
    id: "race-connection",
    name: "Race regression",
    provider: "openai",
    model: "fake-model",
    defaultForAgents: "true",
    createdAt: now,
    updatedAt: now,
  });
  const gameChat = (id: string, gameId: string, session: number, status = "active") => ({
    id,
    name: `${gameId} session ${session}`,
    mode: "game" as const,
    groupId: gameId,
    connectionId: "race-connection",
    metadata: JSON.stringify({
      gameId,
      gameSessionNumber: session,
      gameSessionStatus: status,
      gameContinuity: { mode: "active" },
    }),
    createdAt: at(session),
    updatedAt: at(session),
  });
  let clock = 10;
  const turns = (chatId: string, count: number) => {
    const rows = [];
    for (let turn = 1; turn <= count; turn += 1) {
      rows.push({
        id: `${chatId}-u${turn}`,
        chatId,
        role: "user",
        content: `Turn ${turn} ask.`,
        createdAt: at(clock++),
      });
      rows.push({
        id: `${chatId}-a${turn}`,
        chatId,
        role: "assistant",
        content: `Turn ${turn} reply.`,
        createdAt: at(clock++),
      });
    }
    rows.push({ id: `${chatId}-tail`, chatId, role: "user", content: "Tail.", createdAt: at(clock++) });
    return rows;
  };
  await db
    .insert(chats)
    .values([
      gameChat("old-anchor", "race-game", 1, "concluded"),
      gameChat("new-anchor", "race-game", 2),
      gameChat("manifest-chat", "manifest-game", 1),
    ]);
  await db
    .insert(messages)
    .values([...turns("old-anchor", 1), ...turns("new-anchor", 1), ...turns("manifest-chat", 1)]);

  let providerGateOpen = true;
  const providerWaiters: Array<() => void> = [];
  const providerGate = () =>
    providerGateOpen ? Promise.resolve() : new Promise<void>((resolve) => providerWaiters.push(resolve));
  const openProviderGate = () => {
    providerGateOpen = true;
    providerWaiters.splice(0).forEach((resolve) => resolve());
  };
  releaseProviderWaiters = openProviderGate;
  const complete = async ({
    stage,
    receipt,
  }: {
    stage: string;
    receipt: { sources: Array<{ messageId: string }> };
  }) => {
    await providerGate();
    const dispositions = receipt.sources.map((source) => ({
      messageId: source.messageId,
      status: "no_durable_facts",
      reason: "race regression stub",
    }));
    return stage === "extract" || stage === "repair" ? { records: [], dispositions } : { findings: [], dispositions };
  };
  const continuity = createGameContinuityRuntime(db, { complete: complete as never });
  runtime = continuity;
  let heldList: { chatId: string; reached: () => void; release: Promise<void> } | null = null;
  const enqueueCalls: Array<{ chatId: string; backfillId: string }> = [];
  const wrapped = {
    ...continuity,
    async list(chatId?: string) {
      const held = heldList;
      if (held && held.chatId === chatId) {
        heldList = null;
        held.reached();
        await held.release;
      }
      return continuity.list(chatId);
    },
    async enqueueHistoricalRange(input: { chatId: string; backfillId: string }) {
      enqueueCalls.push({ chatId: input.chatId, backfillId: input.backfillId });
      return continuity.enqueueHistoricalRange(input as never);
    },
  };
  app = Fastify();
  app.decorate("db", db);
  app.decorate("gameContinuity", wrapped);
  await app.register(campaignIndexRoutes, { prefix: "/api/game" });
  await app.ready();
  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload });
  const storage = createGameContinuityStorage(db);
  const chatStore = createChatsStorage(db);
  const jobOn = async (chatId: string) => JSON.parse((await chatStore.getById(chatId))!.metadata).campaignIndexJob;
  const waitFor = async (label: string, check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const steps = { registerOwners: false, backfill: true, publishVerified: false };

  // Hold the completed job's inventory/list await while a new, differently anchored run starts and is cancelled.
  // The old tick must neither replace that cancelled job nor initiate old-anchor provider work.
  const initial = await post("/api/game/campaign-index/run", { gameId: "race-game", chatIds: ["old-anchor"], steps });
  assert.equal(initial.statusCode, 200, initial.body);
  await waitFor("old anchor terminal", async () => {
    const receipts = await storage.list("old-anchor");
    return (
      receipts.length > 0 && receipts.every((receipt) => ["verified", "published", "stale"].includes(receipt.status))
    );
  });
  await tickCampaignIndexJobs(app);
  assert.equal((await jobOn("old-anchor")).status, "done");
  await db.insert(messages).values([
    {
      id: "old-anchor-late-a",
      chatId: "old-anchor",
      role: "assistant",
      content: "Late accepted reply.",
      createdAt: at(clock++),
    },
    { id: "old-anchor-late-u", chatId: "old-anchor", role: "user", content: "Next turn.", createdAt: at(clock++) },
  ]);
  const oldEnqueueCount = enqueueCalls.filter((call) => call.chatId === "old-anchor").length;

  let releaseOld!: () => void;
  let reachedOld!: () => void;
  const oldInventoryReached = new Promise<void>((resolve) => {
    reachedOld = resolve;
  });
  const oldInventoryRelease = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  heldList = { chatId: "old-anchor", reached: reachedOld, release: oldInventoryRelease };
  const staleTick = tickCampaignIndexJobs(app);
  await oldInventoryReached;
  providerGateOpen = false;
  const newer = await post("/api/game/campaign-index/run", { gameId: "race-game", chatIds: ["new-anchor"], steps });
  assert.equal(newer.statusCode, 200, newer.body);
  const newerJobId = newer.json().jobs[0].job.jobId;
  assert.equal(newer.json().jobs[0].job.order[0], "new-anchor", "new run is anchored to another session");
  const cancelled = await post("/api/game/campaign-index/cancel", { gameId: "race-game" });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  releaseOld();
  await staleTick;
  assert.equal((await jobOn("new-anchor")).jobId, newerJobId, "stale old tick preserves the newer run identity");
  assert.equal((await jobOn("new-anchor")).status, "cancelled", "stale old tick cannot reopen a cancelled newer run");
  assert.equal(
    enqueueCalls.filter((call) => call.chatId === "old-anchor").length,
    oldEnqueueCount,
    "old completed-job recovery does not enqueue provider work after being superseded",
  );
  releaseProviderWaiters();

  // Seed a live receipt for an exact-range custom manifest, then shorten its assistant source interval to make that
  // exact range uncovered. The retry must pass the custom ID back and merge the replacement receipt in place.
  const firstRange = { fromMessageId: "manifest-chat-u1", toMessageId: "manifest-chat-a1" };
  const seeded = await continuity.enqueueHistoricalRange({
    chatId: "manifest-chat",
    backfillId: "custom-manifest",
    ...firstRange,
  } as never);
  assert.ok(seeded.receipts.length > 0, "seed range creates a live receipt");
  await waitFor("seeded receipt settles", async () => {
    const receipt = await storage.get(seeded.receipts[0]!.id);
    const queue = continuity.queueStats();
    return receipt?.status === "verified" && queue.activeBackfill === 0 && queue.pendingBackfill === 0;
  });
  const settledSeed = await storage.get(seeded.receipts[0]!.id);
  assert.ok(settledSeed);
  const originalAssistant = settledSeed.sources.find((source) => source.messageId === "manifest-chat-a1")!;
  const partialSources = settledSeed.sources.map((source) =>
    source.messageId === originalAssistant.messageId
      ? { ...source, content: [...source.content].slice(0, 5).join(""), end: (source.start ?? 0) + 5 }
      : source,
  );
  // Keep message identity/hash, the fully covered user source, and valid no-fact history intact.
  // Only the assistant's covered character interval becomes shorter.
  const partialHash = createHash("sha256")
    .update(JSON.stringify({ sources: partialSources, context: settledSeed.context }))
    .digest("hex");
  const partialId = `gch_${createHash("sha256")
    .update(JSON.stringify({ chatId: "manifest-chat", sourceHash: partialHash, configHash: settledSeed.configHash }))
    .digest("hex")
    .slice(0, 40)}`;
  // Build a legitimate partial-receipt fixture, whose deterministic ID matches its source ranges.
  // Keeping the full receipt's ID after shortening it would manufacture an impossible hash collision.
  await db.delete(gameContinuityBatches).where(eq(gameContinuityBatches.id, settledSeed.id));
  const partialReceipt = await storage.save({
    ...settledSeed,
    id: partialId,
    sources: partialSources,
    sourceHash: partialHash,
  });
  assert.equal(
    partialSources.find((source) => source.messageId === originalAssistant.messageId)!.hash,
    originalAssistant.hash,
  );
  await chatStore.patchMetadata("manifest-chat", (metadata) => ({
    gameContinuityBackfills: [
      {
        id: "custom-manifest",
        fromMessageId: "manifest-chat-a1",
        toMessageId: "manifest-chat-a1",
        receiptIds: [partialReceipt.id],
        sessionNumber: 1,
      },
    ],
  }));
  const manifestRun = await post("/api/game/campaign-index/run", {
    gameId: "manifest-game",
    chatIds: ["manifest-chat"],
    steps: { ...steps, publishVerified: true },
  });
  assert.equal(manifestRun.statusCode, 200, manifestRun.body);
  const retry = enqueueCalls.find((call) => call.chatId === "manifest-chat" && call.backfillId === "custom-manifest");
  assert.ok(retry, "an incomplete live exact-range manifest is enqueued again using its existing custom ID");
  const manifestRecords = JSON.parse((await chatStore.getById("manifest-chat"))!.metadata).gameContinuityBackfills;
  assert.equal(
    manifestRecords.filter((record: { id: string }) => record.id === "custom-manifest").length,
    1,
    "the retry preserves one custom manifest record",
  );
  const merged = manifestRecords.find((record: { id: string }) => record.id === "custom-manifest");
  assert.ok(merged, "the existing custom manifest remains present");
  assert.ok(merged.receiptIds.includes(partialReceipt.id), "preexisting receipt IDs are retained");
  assert.ok(merged.receiptIds.length > 1, "new receipt IDs are merged into the existing manifest");
  const inventory = await readContinuityInventory(app, "manifest-chat", { includePreparedSources: true });
  assert.equal(
    inventory?.manifests.find((manifest) => manifest.id === "custom-manifest")?.coverageGaps.length,
    0,
    "the replacement receipt covers the same-hash missing character range",
  );

  await app.close();
  app = null;
  console.log("campaign-index-recovery-races regression passed");
} finally {
  releaseProviderWaiters();
  await app?.close();
  await runtime?.stop();
  rmSync(root, { recursive: true, force: true });
}
