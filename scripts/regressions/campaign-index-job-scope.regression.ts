import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

// Campaign index job bookkeeping:
// - a run that names only some sessions stores its job on the first of those, not on the game's first chat;
//   the scheduler, the status route and the 409 guard must still find it;
// - a session deleted while the job runs is skipped instead of crashing every advance;
// - a cancel that lands while an advance is in flight stays cancelled, and the batches that advance enqueued
//   are retired;
// - one failed segment pauses the job even when another segment of the session enqueued, and resuming keeps
//   the manifests recorded before the pause.
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-index-job-scope-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.CONTINUITY_MAX_CONCURRENT = "1";
process.env.CONTINUITY_BACKFILL_CONCURRENCY = "1";
process.env.CONTINUITY_BACKFILL_TURNS_PER_RECEIPT = "1";

let runtime: { stop(): Promise<void> } | null = null;
let app: any = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { campaignIndexRoutes, tickCampaignIndexJobs } =
    await import("../../packages/server/src/routes/campaign-index.routes.js");

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  const at = (offset: number) => new Date(Date.parse(now) + offset * 1000).toISOString();
  await db.insert(apiConnections).values({
    id: "scope-connection",
    name: "Scope regression connection",
    provider: "openai",
    model: "fake-model",
    defaultForAgents: "true",
    createdAt: now,
    updatedAt: now,
  });
  const gameChat = (id: string, gameId: string, session: number) => ({
    id,
    name: `${gameId} session ${session}`,
    mode: "game" as const,
    groupId: gameId,
    connectionId: "scope-connection",
    metadata: JSON.stringify({ gameId, gameSessionNumber: session, gameContinuity: { mode: "off" } }),
    createdAt: at(session),
    updatedAt: at(session),
  });
  let clock = 10;
  const turns = (chatId: string, count: number) => {
    const rows = [];
    for (let turn = 1; turn <= count; turn += 1) {
      rows.push({ id: `${chatId}-u${turn}`, chatId, role: "user", content: `Turn ${turn} ask.`, createdAt: at(clock++) });
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
      gameChat("sc-1", "scope-game", 1),
      gameChat("sc-2", "scope-game", 2),
      gameChat("sc-3", "scope-game", 3),
      gameChat("gn-1", "gone-game", 1),
      gameChat("gn-2", "gone-game", 2),
      gameChat("cn-1", "cancel-game", 1),
      gameChat("cn-2", "cancel-game", 2),
      gameChat("sp-1", "split-game", 1),
    ]);
  await db
    .insert(messages)
    .values([
      ...turns("sc-1", 1),
      ...turns("sc-2", 1),
      ...turns("sc-3", 1),
      ...turns("gn-1", 1),
      ...turns("gn-2", 1),
      ...turns("cn-1", 1),
      ...turns("cn-2", 4),
      ...turns("sp-1", 50),
    ]);

  let gateOpen = true;
  const waiters: Array<() => void> = [];
  const gate = () => (gateOpen ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve)));
  const openGate = () => {
    gateOpen = true;
    waiters.splice(0).forEach((resolve) => resolve());
  };
  const complete = async ({ stage, receipt }: { stage: string; receipt: { sources: Array<{ messageId: string }> } }) => {
    await gate();
    const dispositions = receipt.sources.map((item) => ({
      messageId: item.messageId,
      status: "no_durable_facts",
      reason: "regression stub",
    }));
    return stage === "extract" || stage === "repair" ? { records: [], dispositions } : { findings: [], dispositions };
  };
  const continuity = createGameContinuityRuntime(db, { complete: complete as never });
  runtime = continuity;
  // Hooks into the runtime the routes see: hold a list() call, or fail one historical enqueue.
  let holdList: { chatId: string; reached: () => void; release: Promise<void> } | null = null;
  let failEnqueue: { chatId: string; call: number; seen: number } | null = null;
  const wrapped = {
    ...continuity,
    async list(chatId?: string) {
      const hold = holdList;
      if (hold && chatId === hold.chatId) {
        holdList = null;
        hold.reached();
        await hold.release;
      }
      return continuity.list(chatId);
    },
    async enqueueHistoricalRange(input: { chatId: string }) {
      if (failEnqueue && input.chatId === failEnqueue.chatId && ++failEnqueue.seen === failEnqueue.call)
        throw new Error("CONTINUITY_PROVIDER_UNAVAILABLE: regression failure");
      return (continuity.enqueueHistoricalRange as (value: unknown) => Promise<unknown>)(input);
    },
  };
  app = Fastify();
  app.decorate("db", db);
  app.decorate("gameContinuity", wrapped);
  await app.register(campaignIndexRoutes, { prefix: "/api/game" });
  await app.ready();
  const get = (url: string) => app.inject({ method: "GET", url });
  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload });
  const storage = createGameContinuityStorage(db);
  const chatStore = createChatsStorage(db);
  const jobOn = async (chatId: string) => JSON.parse((await chatStore.getById(chatId))!.metadata).campaignIndexJob;
  const statuses = async (chatId: string) => (await storage.list(chatId)).map((receipt) => receipt.status);
  const waitFor = async (label: string, check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const settled = (chatId: string) => async () => {
    const list = await statuses(chatId);
    return list.length > 0 && list.every((status) => ["verified", "published", "stale"].includes(status));
  };
  const steps = { registerOwners: false, backfill: true, publishVerified: true };

  // 1. A run over sessions 2 and 3 only.
  gateOpen = false;
  const scoped = await post("/api/game/campaign-index/run", { gameId: "scope-game", chatIds: ["sc-2", "sc-3"], steps });
  assert.equal(scoped.statusCode, 200, scoped.body);
  const scopedJob = scoped.json().jobs[0].job;
  assert.deepEqual(scopedJob.order, ["sc-2", "sc-3"]);
  assert.equal(scopedJob.sessions["sc-2"].status, "enqueued");
  assert.equal((await jobOn("sc-2")).jobId, scopedJob.jobId, "the job is stored on the run's first chat");
  const busy = await post("/api/game/campaign-index/run", { gameId: "scope-game", steps });
  assert.equal(busy.statusCode, 409, "a whole-game run sees the job stored on session 2");
  const status = await get("/api/game/campaign-index/status?gameId=scope-game");
  assert.equal(status.json().games[0].job?.jobId, scopedJob.jobId, "status reports the job");
  openGate();
  await waitFor("session 2 verified", settled("sc-2"));
  await tickCampaignIndexJobs(app);
  assert.equal((await jobOn("sc-2")).sessions["sc-3"]?.status, "enqueued", "the scheduler advances the scoped job");
  await waitFor("session 3 verified", settled("sc-3"));
  await tickCampaignIndexJobs(app);
  assert.equal((await jobOn("sc-2")).status, "done");
  assert.deepEqual(await statuses("sc-1"), [], "the unnamed session is not indexed");

  // 2. A session deleted while its job waits on the previous one.
  gateOpen = false;
  const gone = await post("/api/game/campaign-index/run", { gameId: "gone-game", steps });
  assert.equal(gone.statusCode, 200, gone.body);
  await chatStore.remove("gn-2");
  openGate();
  await waitFor("gone session 1 verified", settled("gn-1"));
  await tickCampaignIndexJobs(app);
  const goneJob = await jobOn("gn-1");
  assert.equal(goneJob.sessions["gn-2"]?.reason, "chat_missing", "the deleted session is skipped");
  assert.equal(goneJob.status, "done", "the job finishes instead of failing on every tick");

  // 3. A cancel that lands while the scheduler is enqueuing the next session.
  const cancelRun = await post("/api/game/campaign-index/run", { gameId: "cancel-game", steps });
  assert.equal(cancelRun.statusCode, 200, cancelRun.body);
  await waitFor("cancel session 1 verified", settled("cn-1"));
  gateOpen = false;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    holdList = { chatId: "cn-2", reached: resolve, release: new Promise<void>((done) => (release = done)) };
  });
  const tick = tickCampaignIndexJobs(app);
  await reached;
  const cancelled = await post("/api/game/campaign-index/cancel", { gameId: "cancel-game" });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  release();
  await tick;
  const afterCancel = await jobOn("cn-1");
  assert.equal(afterCancel.status, "cancelled", "the in-flight advance does not restart a cancelled job");
  const cn2 = await storage.list("cn-2");
  assert.equal(cn2.length, 4, "the advance did enqueue session 2");
  assert.equal(cn2.filter((receipt) => receipt.status === "queued").length, 0, "nothing it enqueued stays queued");
  assert.ok(
    cn2.filter((receipt) => receipt.errorCode === "CONTINUITY_INDEX_CANCELLED").length >= 3,
    "the batches the advance enqueued are retired",
  );
  await tickCampaignIndexJobs(app);
  assert.equal((await jobOn("cn-1")).status, "cancelled", "later ticks leave it cancelled");
  openGate();

  // 4. The second of two segments fails to enqueue.
  gateOpen = false;
  failEnqueue = { chatId: "sp-1", call: 2, seen: 0 };
  const split = await post("/api/game/campaign-index/run", { gameId: "split-game", steps });
  assert.equal(split.statusCode, 200, split.body);
  let splitJob = split.json().jobs[0].job;
  assert.equal(splitJob.sessions["sp-1"].status, "failed", "a failed segment is reported");
  assert.equal(splitJob.status, "paused", "the job pauses on the partly enqueued session");
  assert.equal(splitJob.sessions["sp-1"].backfillIds.length, 1);
  const firstManifest = splitJob.sessions["sp-1"].backfillIds[0];
  failEnqueue = null;
  const resumed = await post("/api/game/campaign-index/run", { gameId: "split-game", steps });
  assert.equal(resumed.statusCode, 200, resumed.body);
  splitJob = resumed.json().jobs[0].job;
  assert.equal(splitJob.jobId, (await jobOn("sp-1")).jobId);
  assert.equal(splitJob.sessions["sp-1"].status, "enqueued", "resume enqueues the failed range");
  assert.equal(splitJob.sessions["sp-1"].backfillIds.length, 2, "manifests from before the pause are kept");
  assert.ok(splitJob.sessions["sp-1"].backfillIds.includes(firstManifest));
  assert.equal((await storage.list("sp-1")).length, 50, "every turn is enqueued exactly once");
  openGate();

  await app.close();
  app = null;
  console.log("campaign-index-job-scope regression passed");
} finally {
  await app?.close();
  await runtime?.stop();
  rmSync(root, { recursive: true, force: true });
}
