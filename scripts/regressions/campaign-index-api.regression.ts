import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

// Guided first-run indexing API: the plan reports unregistered owners and uncovered
// history (stale/failed receipts cover nothing), the run registers owners and starts a
// persisted per-game job that indexes sessions strictly in session order (chunked under
// the 50-turn manifest limit), survives a restart, can be cancelled (retiring only
// queued receipts) and reruns from the first uncovered session.
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-index-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
// Pin the worker budget: server modules load .env, and an installation tuned for a large archive (several turns per
// receipt) must not change the one-receipt-per-turn counts this fixture asserts.
process.env.CONTINUITY_MAX_CONCURRENT = "2";
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
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { campaignIndexRoutes, tickCampaignIndexJobs } =
    await import("../../packages/server/src/routes/campaign-index.routes.js");

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  const at = (offset: number) => new Date(Date.parse(now) + offset * 1000).toISOString();
  await db.insert(apiConnections).values({
    id: "index-connection",
    name: "Index regression connection",
    provider: "openai",
    model: "fake-model",
    defaultForAgents: "true",
    createdAt: now,
    updatedAt: now,
  });
  const gameChat = (id: string, gameId: string, session: number, extra: Record<string, unknown> = {}) => ({
    id,
    name: `${gameId} session ${session}`,
    mode: "game" as const,
    groupId: gameId,
    connectionId: "index-connection",
    metadata: JSON.stringify({
      gameId,
      gameSessionNumber: session,
      ...(gameId === "index-game" && session > 1 ? { gameSessionParentChatId: `index-s${session - 1}` } : {}),
      gameContinuity: { mode: "off" },
      ...extra,
    }),
    createdAt: at(session),
    updatedAt: at(session),
  });
  const LONG_TURNS = 60;
  // Manifest ids are a digest of the frozen range, so a retired manifest can only be
  // re-indexed in place when the fixture uses the id the backfill route would derive.
  const staleManifestId = `historical-continuity-${createHash("sha256")
    .update("index-s3\0s3-u1\0s3-a1")
    .digest("hex")
    .slice(0, 32)}`;
  await db.insert(chats).values([
    // Session 2 carries a manifest a cancellation left without receipts: its range is not indexed.
    gameChat("index-s2", "index-game", 2, {
      campaignIndexPrompt: { dismissedAt: "2026-09-01T00:00:00.000Z" },
      gameContinuityBackfills: [
        { id: "historical-continuity-emptied", fromMessageId: "s2-u1", toMessageId: "s2-a1", receiptIds: [] },
      ],
    }),
    gameChat("index-s1", "index-game", 1, { gameNpcs: [{ id: "npc-alice", name: "Alice" }] }),
    // Session 3 carries a manifest whose only receipt was retired as stale: it must not count as coverage.
    gameChat("index-s3", "index-game", 3, {
      gameContinuityBackfills: [
        { id: staleManifestId, fromMessageId: "s3-u1", toMessageId: "s3-a1", receiptIds: ["gch_stale"] },
      ],
    }),
    // Session 4 holds more accepted turns than one manifest may carry.
    gameChat("index-s4", "index-game", 4),
    gameChat("repair-s1", "repair-game", 1, {
      gameSessionStatus: "concluded",
      gameContinuity: { mode: "active" },
    }),
    gameChat("other-s1", "other-game", 1),
  ]);
  const longMessages = Array.from({ length: LONG_TURNS }, (_, turn) => [
    {
      id: `s4-u${turn + 1}`,
      chatId: "index-s4",
      role: "user",
      content: `Turn ${turn + 1} question.`,
      createdAt: at(100 + turn * 2),
    },
    {
      id: `s4-a${turn + 1}`,
      chatId: "index-s4",
      role: "assistant",
      content: `Turn ${turn + 1} answer.`,
      createdAt: at(101 + turn * 2),
    },
  ]).flat();
  await db
    .insert(messages)
    .values([
      { id: "s1-u1", chatId: "index-s1", role: "user", content: "Alice opens the gate.", createdAt: at(10) },
      { id: "s1-a1", chatId: "index-s1", role: "assistant", content: "The gate opens.", createdAt: at(11) },
      { id: "s1-u2", chatId: "index-s1", role: "user", content: "Alice enters the archive.", createdAt: at(12) },
      { id: "s1-a2", chatId: "index-s1", role: "assistant", content: "The archive holds a map.", createdAt: at(13) },
      { id: "s1-u3", chatId: "index-s1", role: "user", content: "Alice takes the map.", createdAt: at(14) },
      { id: "s1-a3", chatId: "index-s1", role: "assistant", content: "The map is hers.", createdAt: at(15) },
      { id: "s2-u1", chatId: "index-s2", role: "user", content: "Alice reads the map.", createdAt: at(20) },
      { id: "s2-a1", chatId: "index-s2", role: "assistant", content: "The map shows a tower.", createdAt: at(21) },
      { id: "s2-u2", chatId: "index-s2", role: "user", content: "Alice walks to the tower.", createdAt: at(22) },
      { id: "o-u1", chatId: "other-s1", role: "user", content: "Bob waits.", createdAt: at(30) },
      { id: "o-a1", chatId: "other-s1", role: "assistant", content: "Bob keeps waiting.", createdAt: at(31) },
      { id: "s3-u1", chatId: "index-s3", role: "user", content: "Alice climbs the tower.", createdAt: at(40) },
      { id: "s3-a1", chatId: "index-s3", role: "assistant", content: "The tower creaks.", createdAt: at(41) },
      { id: "s3-u2", chatId: "index-s3", role: "user", content: "Alice looks down.", createdAt: at(42) },
      ...longMessages,
      { id: "s4-tail", chatId: "index-s4", role: "user", content: "Tail.", createdAt: at(100 + LONG_TURNS * 2) },
      { id: "repair-u1", chatId: "repair-s1", role: "user", content: "First question.", createdAt: at(1000) },
      { id: "repair-a1", chatId: "repair-s1", role: "assistant", content: "First answer.", createdAt: at(1001) },
      { id: "repair-tail", chatId: "repair-s1", role: "user", content: "Tail.", createdAt: at(1002) },
    ]);

  // Stubbed provider: empty records, no provider calls; a gate holds workers so queue order can be observed.
  let gateOpen = true;
  const waiters: Array<() => void> = [];
  const gate = () => (gateOpen ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve)));
  const openGate = () => {
    gateOpen = true;
    waiters.splice(0).forEach((resolve) => resolve());
  };
  const complete = async ({
    stage,
    receipt,
  }: {
    stage: string;
    receipt: { sources: Array<{ messageId: string }> };
  }) => {
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
  const boot = async () => {
    const instance = Fastify();
    instance.decorate("db", db);
    instance.decorate("gameContinuity", continuity);
    await instance.register(campaignIndexRoutes, { prefix: "/api/game" });
    await instance.ready();
    return instance;
  };
  app = await boot();
  const get = (url: string) => app.inject({ method: "GET", url });
  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload });
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(null);
  assert.equal((await get("/api/game/campaign-index/plan?gameId=index-game")).statusCode, 403);
  assert.equal(
    (
      await post("/api/game/campaign-index/run", {
        gameId: "index-game",
        steps: { registerOwners: false, backfill: false, publishVerified: false },
      })
    ).statusCode,
    403,
    "Campaign Index is off by default",
  );
  applyFeatureSettingsValue(JSON.stringify({ campaignIndex: true }));
  const continuityDependency = await post("/api/game/campaign-index/run", {
    chatId: "index-s2",
    steps: { registerOwners: false, backfill: true, publishVerified: false },
  });
  assert.equal(continuityDependency.statusCode, 403, "backfill requires global Game Continuity opt-in");
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true, campaignMemory: true, campaignIndex: true }));
  continuity.resume();
  const storage = createGameContinuityStorage(db);
  await storage.enqueue({
    id: "gch_stale",
    chatId: "index-s3",
    sessionNumber: 3,
    sourceHash: "stale-source-hash",
    sources: [
      { messageId: "s3-u1", swipeIndex: 0, hash: "h1", role: "user", content: "Alice climbs the tower." },
      { messageId: "s3-a1", swipeIndex: 0, hash: "h2", role: "assistant", content: "The tower creaks." },
    ],
    context: [],
    configHash: "retired-config",
    config: {
      historicalBackfill: {
        id: staleManifestId,
        fromMessageId: "s3-u1",
        toMessageId: "s3-a1",
        sessionNumber: 3,
      },
    },
    status: "stale",
    attempts: 1,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    entryIds: [],
    errorCode: "CONTINUITY_CONFIG_CHANGED",
    error: "Configuration changed after verification.",
    createdAt: at(43),
    updatedAt: at(43),
  } as never);
  const memory = createCampaignMemoryStorage(db);
  const chatStore = createChatsStorage(db);
  const manifestsOf = async (chatId: string) => {
    const meta = JSON.parse((await chatStore.getById(chatId))!.metadata || "{}");
    return Array.isArray(meta.gameContinuityBackfills) ? meta.gameContinuityBackfills : [];
  };
  const jobOf = async (chatId = "index-s1") => JSON.parse((await chatStore.getById(chatId))!.metadata).campaignIndexJob;
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

  // Plan: unregistered owners, uncovered history, stale manifests cover nothing, session order.
  assert.equal((await get("/api/game/campaign-index/plan?gameId=missing-game")).statusCode, 404);
  let plan = await get("/api/game/campaign-index/plan?gameId=index-game");
  assert.equal(plan.statusCode, 200, plan.body);
  let game = plan.json().games[0];
  assert.equal(plan.json().games.length, 1, "gameId scopes the plan to one game");
  assert.equal(game.needsIndexing, true);
  assert.equal(game.continuityConfigured, true);
  assert.equal(game.job, null);
  assert.equal(game.promptDismissedAt, "2026-09-01T00:00:00.000Z", "dismissal is read from any chat of the game");
  assert.deepEqual(
    game.chats.map((chat: { chatId: string }) => chat.chatId),
    ["index-s1", "index-s2", "index-s3", "index-s4"],
    "chats are ordered by session number",
  );
  const [s1, s2, s3, s4] = game.chats;
  assert.equal(s1.ownersRegistered, false);
  assert.equal(s1.ownersPlanned, 1, "the tracked NPC is an unregistered owner");
  assert.equal(s2.ownersRegistered, true, "a chat without legacy entities has nothing to register");
  assert.deepEqual(s1.messageCounts, { user: 3, assistant: 3 });
  assert.equal(s1.uncoveredMessages, 4, "the unanswered final assistant turn is live, not history");
  assert.deepEqual(s1.estimate, { turns: 2, receipts: 2 });
  assert.deepEqual(s1.range, { fromMessageId: "s1-u1", toMessageId: "s1-a2" });
  assert.deepEqual(s2.estimate, { turns: 1, receipts: 1 });
  assert.equal(s2.uncoveredMessages, 2, "a manifest with no receipts covers nothing");
  assert.equal(s2.manifests[0].live, false);
  assert.equal(s2.manifests[0].receipts, 0);
  assert.equal(s2.rangeCovered, false, "an emptied manifest with the same range is not coverage");
  assert.equal(s3.uncoveredMessages, 2, "a manifest whose receipts are all stale covers nothing");
  assert.equal(s3.manifests[0].live, false);
  assert.equal(s3.rangeCovered, false, "a retired manifest with the same range is not coverage");
  assert.equal(s4.uncoveredMessages, LONG_TURNS * 2);
  assert.deepEqual(s4.estimate, { turns: LONG_TURNS, receipts: LONG_TURNS });
  const selectedPlan = await get("/api/game/campaign-index/plan?chatId=index-s2");
  assert.equal(selectedPlan.json().games[0].gameId, "index-game");
  assert.equal(selectedPlan.json().games[0].lineage.status, "ready");
  assert.deepEqual(
    selectedPlan.json().games[0].lineage.sessions.map((session: { chatId: string }) => session.chatId),
    ["index-s1", "index-s2"],
    "the plan follows only the selected session's verified predecessors",
  );
  assert.deepEqual(
    selectedPlan.json().games[0].chats.map((chat: { chatId: string }) => chat.chatId),
    ["index-s1", "index-s2"],
  );
  assert.deepEqual(
    (await get("/api/game/campaign-index/plan")).json().games.map((item: { gameId: string }) => item.gameId),
    ["index-game", "other-game", "repair-game"],
    "omitting the scope lists every game",
  );

  // Run: owners registered up front, session 1 enqueued, session 2 waits while session 1 is queued.
  assert.equal((await post("/api/game/campaign-index/run", { gameId: "index-game", steps: {} })).statusCode, 400);
  const steps = { registerOwners: true, backfill: true, publishVerified: true };
  assert.equal(
    (await post("/api/game/campaign-index/run", { gameId: "index-game", steps })).json().error.code,
    "CAMPAIGN_INDEX_TARGET_REQUIRED",
    "runs require an explicit selected chat rather than inferring the latest session",
  );
  await chatStore.patchMetadata("index-s2", (metadata) => ({
    ...metadata,
    gameSessionParentChatId: "missing-session",
  }));
  const heldPlan = await get("/api/game/campaign-index/plan?chatId=index-s4");
  assert.equal(heldPlan.json().games[0].lineage.status, "held");
  assert.equal(heldPlan.json().games[0].lineage.holds[0].chatId, "index-s2");
  const heldRun = await post("/api/game/campaign-index/run", { chatId: "index-s4", steps });
  assert.equal(heldRun.statusCode, 409);
  assert.equal(heldRun.json().error.code, "CAMPAIGN_LINEAGE_HELD");
  assert.deepEqual(await statuses("index-s1"), [], "held lineage is provider-free");
  await chatStore.patchMetadata("index-s2", (metadata) => ({ ...metadata, gameSessionParentChatId: "index-s1" }));
  const subsetSteps = { registerOwners: false, backfill: false, publishVerified: false };
  const subsetRun = await post("/api/game/campaign-index/run", {
    chatId: "index-s4",
    chatIds: ["index-s2", "index-s4"],
    steps: subsetSteps,
  });
  assert.equal(subsetRun.statusCode, 200, subsetRun.body);
  assert.deepEqual(
    subsetRun.json().jobs[0].job.order,
    ["index-s2", "index-s4"],
    "a requested session subset preserves lineage order",
  );
  await tickCampaignIndexJobs(app);
  assert.notEqual((await jobOf("index-s2")).status, "paused", "valid requested subsets pass lineage revalidation");
  gateOpen = false;
  const started = await post("/api/game/campaign-index/run", { chatId: "index-s4", steps });
  assert.equal(started.statusCode, 200, started.body);
  let job = started.json().jobs[0].job;
  const owners = started.json().jobs[0].owners;
  assert.equal(owners[0].status, "registered");
  assert.equal(owners[0].created, 1);
  assert.equal(owners[1].status, "skipped");
  assert.equal(job.status, "running");
  assert.equal(job.targetChatId, "index-s4");
  assert.equal(typeof job.lineageIdentity, "string");
  assert.deepEqual(job.order, ["index-s1", "index-s2", "index-s3", "index-s4"]);
  assert.equal(job.currentIndex, 0);
  assert.equal(job.sessions["index-s1"].status, "enqueued");
  assert.equal(job.sessions["index-s1"].acceptedTurns, 2);
  assert.equal(job.sessions["index-s1"].backfillIds.length, 1);
  assert.equal(job.sessions["index-s2"], undefined, "session 2 is not enqueued while session 1 runs");
  assert.deepEqual(await statuses("index-s2"), []);
  // The provider stub is gated shut, so session 1 cannot finish; the worker may already hold its receipt
  // (extracting) because the run yields between sessions. What matters is that it is still unfinished.
  assert.ok(
    (await statuses("index-s1")).some((status) => ["queued", "extracting", "reviewing", "repairing"].includes(status)),
    "session 1 still has unfinished work",
  );
  assert.equal((await manifestsOf("other-s1")).length, 0, "other games are untouched");
  assert.equal((await memory.listEntities({ chatId: "index-s1" })).length, 1);
  const busy = await post("/api/game/campaign-index/run", { chatId: "index-s4", steps });
  assert.equal(busy.statusCode, 409, "a running job refuses a second run");
  assert.equal(busy.json().error.code, "CAMPAIGN_INDEX_RUNNING");
  await tickCampaignIndexJobs(app);
  assert.equal((await jobOf()).currentIndex, 0, "a tick does not advance past a non-terminal session");
  assert.deepEqual(await statuses("index-s2"), []);

  // A changed predecessor chain is rechecked before publication. Restore the link and resume the same pinned job.
  openGate();
  await waitFor("session 1 verified", settled("index-s1"));
  await chatStore.patchMetadata("index-s2", (metadata) => ({ ...metadata, gameSessionParentChatId: "index-s4" }));
  await tickCampaignIndexJobs(app);
  job = await jobOf();
  assert.equal(job.status, "paused");
  assert.equal(job.lineageHold.reason, "lineage_invalid");
  assert.ok(!(await statuses("index-s1")).includes("published"), "changed lineage blocks publication");
  await chatStore.patchMetadata("index-s2", (metadata) => ({ ...metadata, gameSessionParentChatId: "index-s1" }));
  const resumed = await post("/api/game/campaign-index/run", { chatId: "index-s4", steps });
  assert.equal(resumed.statusCode, 200, resumed.body);
  job = await jobOf();
  await tickCampaignIndexJobs(app);
  job = await jobOf();
  assert.equal(job.sessions["index-s1"].status, "published");
  assert.equal(job.sessions["index-s1"].published, 2);
  assert.deepEqual(await statuses("index-s1"), ["published", "published"]);
  assert.equal(job.sessions["index-s2"].status, "enqueued");
  assert.deepEqual(
    job.sessions["index-s2"].prunedManifests,
    ["historical-continuity-emptied"],
    "the emptied manifest is pruned when its range is re-indexed",
  );
  const s2Manifests = await manifestsOf("index-s2");
  assert.equal(s2Manifests.length, 1, "the emptied manifest is replaced, not duplicated");
  assert.notEqual(s2Manifests[0].id, "historical-continuity-emptied");
  assert.equal(s2Manifests[0].receiptIds.length, 1);
  assert.equal(job.currentIndex, 1);
  const events = job.history.map((entry: { chatId: string | null; event: string }) => `${entry.chatId}:${entry.event}`);
  assert.ok(
    events.indexOf("index-s1:published") < events.indexOf("index-s2:enqueued"),
    "session 1 is published before session 2 is enqueued",
  );
  let status = await get("/api/game/campaign-index/status?gameId=index-game");
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().games[0].job.status, "running");
  assert.equal(status.json().games[0].job.sessions["index-s2"].status, "enqueued");
  assert.equal(status.json().games[0].chats[0].published, 2);
  assert.equal(status.json().games[0].chats[0].totals.entities, 1);

  // Restart: a fresh app resumes the persisted job and re-indexes the stale-manifest session.
  await waitFor("session 2 verified", settled("index-s2"));
  await app.close();
  app = await boot();
  await tickCampaignIndexJobs(app);
  job = await jobOf();
  assert.equal(job.sessions["index-s2"].status, "published");
  assert.equal(job.sessions["index-s3"].status, "enqueued", "the job resumes after a restart");
  assert.deepEqual(job.sessions["index-s3"].backfillIds, [staleManifestId], "the same range reuses the manifest id");
  assert.equal(job.sessions["index-s3"].acceptedTurns, 1);
  assert.equal((await manifestsOf("index-s3")).length, 1, "re-indexing merges into the retired manifest");
  assert.equal((await storage.list("index-s3")).length, 2, "a fresh receipt joins the stale one");
  assert.equal(job.currentIndex, 2);

  // Session 4 is split under the manifest limit; cancel retires only queued receipts.
  await waitFor("session 3 verified", settled("index-s3"));
  gateOpen = false;
  await tickCampaignIndexJobs(app);
  job = await jobOf();
  assert.equal(job.sessions["index-s3"].status, "published");
  assert.equal(job.sessions["index-s4"].status, "enqueued");
  assert.equal(job.sessions["index-s4"].backfillIds.length, 2, "60 turns split into 45 + 15 manifests");
  assert.equal(job.sessions["index-s4"].acceptedTurns, LONG_TURNS);
  assert.equal((await manifestsOf("index-s4")).length, 2);
  assert.equal((await storage.list("index-s4")).length, LONG_TURNS, "one receipt per accepted turn");
  plan = await get("/api/game/campaign-index/plan?gameId=index-game");
  game = plan.json().games[0];
  assert.equal(game.chats[2].manifests[0].live, true, "the merged manifest is live again");
  assert.equal(game.chats[3].manifests.length, 2, "the plan lists every sub-manifest");
  assert.equal(game.chats[3].uncoveredMessages, 0, "queued receipts count as coverage");
  await tickCampaignIndexJobs(app);
  assert.equal((await manifestsOf("index-s4")).length, 2, "a tick enqueues nothing new");
  await waitFor("a session 4 worker to start", async () => (await statuses("index-s4")).includes("extracting"));
  const cancelledJobId = (await jobOf()).jobId;
  const cancelled = await post("/api/game/campaign-index/cancel", { gameId: "index-game" });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().job.status, "cancelled");
  assert.equal(cancelled.json().retired, LONG_TURNS - 1, "only queued receipts are retired");
  assert.equal(cancelled.json().removedManifests.length, 1, "the manifest without live receipts is removed");
  const afterCancel = await storage.list("index-s4");
  assert.equal(afterCancel.filter((receipt) => receipt.status === "extracting").length, 1, "workers are untouched");
  const retired = afterCancel.filter((receipt) => receipt.status === "stale");
  assert.equal(retired.length, LONG_TURNS - 1);
  assert.ok(retired.every((receipt) => receipt.errorCode === "CONTINUITY_INDEX_CANCELLED"));
  assert.equal((await manifestsOf("index-s4")).length, 1);
  assert.equal((await post("/api/game/campaign-index/cancel", { gameId: "index-game" })).statusCode, 404);
  openGate();
  await waitFor("the running worker to verify", async () => (await statuses("index-s4")).includes("verified"));
  await waitFor("retired receipts to stay retired", async () => !(await statuses("index-s4")).includes("queued"));
  assert.equal((await statuses("index-s4")).filter((status) => status === "verified").length, 1);
  assert.equal((await statuses("index-s4")).filter((status) => status === "stale").length, LONG_TURNS - 1);

  // Rerun after cancel: a new job skips finished sessions and resumes from the first uncovered one.
  const rerun = await post("/api/game/campaign-index/run", {
    chatId: "index-s4",
    steps: { registerOwners: true, backfill: true, publishVerified: false },
  });
  assert.equal(rerun.statusCode, 200, rerun.body);
  assert.equal(rerun.json().jobs[0].owners[0].status, "skipped", "registered owners are not planned again");
  assert.equal((await memory.listEntities({ chatId: "index-s1" })).length, 1, "rerun never duplicates entities");
  job = rerun.json().jobs[0].job;
  assert.notEqual(job.jobId, cancelledJobId, "a cancelled job is replaced, never resumed");
  assert.equal(job.status, "running");
  for (const chatId of ["index-s1", "index-s2", "index-s3"]) {
    assert.equal(job.sessions[chatId].status, "terminal", `${chatId} has nothing left to index`);
    assert.equal(job.sessions[chatId].reason, "nothing_to_index");
  }
  assert.equal((await manifestsOf("index-s1")).length, 1, "rerun never duplicates manifests");
  assert.equal((await storage.list("index-s1")).length, 2, "rerun never duplicates receipts");
  assert.equal(job.currentIndex, 3, "the rerun starts at the first uncovered session");
  assert.equal(job.sessions["index-s4"].status, "enqueued");
  assert.equal(job.sessions["index-s4"].acceptedTurns, LONG_TURNS - 1, "only retired turns are re-indexed");
  assert.equal(job.sessions["index-s4"].backfillIds.length, 2, "59 turns split into 45 + 14");
  assert.equal((await manifestsOf("index-s4")).length, 3);
  assert.equal((await post("/api/game/campaign-index/cancel", { gameId: "index-game" })).statusCode, 200);

  // A completed concluded session is repaired by the scheduler when later history arrives.
  const repairRun = await post("/api/game/campaign-index/run", {
    chatId: "repair-s1",
    steps: { registerOwners: false, backfill: true, publishVerified: false },
  });
  assert.equal(repairRun.statusCode, 200, repairRun.body);
  await waitFor("repair session verified", settled("repair-s1"));
  await tickCampaignIndexJobs(app);
  assert.equal((await jobOf("repair-s1")).status, "done");
  await db.insert(messages).values([
    { id: "repair-u2", chatId: "repair-s1", role: "user", content: "Second question.", createdAt: at(1003) },
    { id: "repair-a2", chatId: "repair-s1", role: "assistant", content: "Second answer.", createdAt: at(1004) },
    { id: "repair-tail-2", chatId: "repair-s1", role: "user", content: "Tail again.", createdAt: at(1005) },
  ]);
  await tickCampaignIndexJobs(app);
  const repairedJob = await jobOf("repair-s1");
  assert.equal(repairedJob.status, "running", "the scheduler reopens a completed concluded session with new history");
  assert.equal(repairedJob.sessions["repair-s1"].status, "enqueued");

  await app.close();
  app = null;
  console.log("campaign-index-api regression passed");
} finally {
  await app?.close();
  await runtime?.stop();
  rmSync(root, { recursive: true, force: true });
}
