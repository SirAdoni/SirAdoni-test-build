import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in generation job tracking (E02): the job-records table and its wiring, the
// store observer seam, persistence, completion with no client connected, client
// reattach, server-restart recovery, cancel, retention, log redaction, and the
// "setting off" contract (same responses, no storage writes, no new log lines).

const root = mkdtempSync(join(tmpdir(), "marinara-job-tracking-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "info";
process.env.LOG_FILE_LEVEL = "silent";

// Capture every serialized log line the server writes.
const logLines: string[] = [];
Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
const stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  logLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  return true;
}) as typeof process.stderr.write;
void stderrWrite;

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 5000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await wait(10);
  }
}

const PLANTED_KEY = "sk-plantedSECRET0123456789abcdef";
const PLANTED_PROMPT = "PLANTED-PROMPT moonlit harbor with a violet lighthouse";
const ids = {
  offDone: "11111111-1111-4111-8111-111111111111",
  offFail: "11111111-1111-4111-8111-111111111112",
  persist: "22222222-2222-4222-8222-222222222221",
  closed: "22222222-2222-4222-8222-222222222222",
  cancel: "22222222-2222-4222-8222-222222222223",
  fail: "22222222-2222-4222-8222-222222222224",
  text: "22222222-2222-4222-8222-222222222225",
  held: "22222222-2222-4222-8222-222222222226",
  staleLost: "33333333-3333-4333-8333-333333333331",
  staleDone: "33333333-3333-4333-8333-333333333332",
  orphan: "33333333-3333-4333-8333-333333333333",
  cancelOrder: "33333333-3333-4333-8333-333333333334",
};

try {
  const { createFileNativeDB, FILE_BACKED_TABLES, getFileTableShardStrategy, isLazyUnitTable } =
    await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, appSettings, generationJobRecords } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createGenerationJobs, getGenerationJobs } =
    await import("../../packages/server/src/services/generation/generation-jobs.js");
  const tracking = await import("../../packages/server/src/services/generation/generation-job-tracker.js");
  const { generationJobsRoutes } = await import("../../packages/server/src/routes/generation-jobs.routes.js");
  const { generationJobRecordsRoutes } =
    await import("../../packages/server/src/routes/generation-job-records.routes.js");
  const clientLib = await import("../../packages/client/src/lib/generation-job-tracking.js");

  // ── Wiring ──
  assert.ok(FILE_BACKED_TABLES.includes("generation_job_records"), "the table is registered with the store");
  assert.equal(getFileTableShardStrategy("generation_job_records").kind, "primary-key");
  assert.equal(isLazyUnitTable("generation_job_records"), false, "records stay resident (chatId may be null)");
  const store = read("../../packages/server/src/db/file-backed-store.ts");
  assert.match(store, /\{ parent: "chats", child: "generation_job_records", parentKey: "id", childKey: "chatId" \}/);
  assert.match(read("../protect-launcher-data.mjs"), /"generation_job_records"/);
  assert.match(read("../../packages/server/src/db/schema/index.ts"), /generation-job-records\.js/);
  assert.match(
    read("../../packages/server/src/routes/index.ts"),
    /app\.register\(generationJobRecordsRoutes, \{ prefix: "\/api\/generation-job-records" \}\)/,
  );
  assert.match(read("../../packages/server/src/routes/admin.routes.ts"), /runDelete\("generation_job_records"/);

  // ── Pure helpers ──
  assert.equal(tracking.mediaKindFor("gallery-selfie"), "image");
  assert.equal(tracking.mediaKindFor("sprite-sheet"), "sprite");
  assert.equal(tracking.mediaKindFor("gallery-scene-video"), "video");
  assert.equal(tracking.mediaKindFor("game-party-turn"), null, "text jobs are not tracked");
  assert.equal(tracking.mediaKindFor("toString"), null, "prototype keys are not kinds");
  const built = tracking.buildJobLogEvent({
    state: "failed",
    jobId: ids.fail,
    chatId: null,
    kind: "image",
    sourceKind: "gallery-image",
    stage: "settle",
    at: "2026-09-23T00:00:00.000Z",
    elapsedMs: 12.6,
    errorCode: `Provider said ${PLANTED_PROMPT}`,
    errorId: "not-a-uuid",
    outcome: "failed",
    ...({ prompt: PLANTED_PROMPT, apiKey: PLANTED_KEY } as object),
  });
  assert.equal(built.errorCode, "ME_INTERNAL", "a non-code error string is replaced");
  assert.equal(built.errorId, undefined);
  assert.equal(built.elapsedMs, 13);
  assert.equal(built.event, "job.state");
  assert.ok(!JSON.stringify(built).includes("PLANTED"), "extra fields are dropped");
  const progressEvent = { ...built, state: "progress" as const, event: "job.progress" as const };
  let trail = tracking.appendTrail([], { ...built, state: "accepted" });
  trail = tracking.appendTrail(trail, progressEvent);
  trail = tracking.appendTrail(trail, { ...progressEvent, elapsedMs: 99 });
  assert.equal(trail.length, 2, "consecutive progress ticks coalesce");
  assert.equal(trail[1]!.elapsedMs, 99);
  let long: typeof trail = [];
  for (let index = 0; index < 50; index++) long = tracking.appendTrail(long, { ...built, elapsedMs: index }, 10);
  assert.equal(long.length, 10);
  assert.equal(long[0]!.elapsedMs, 0, "the first entry survives the cap");
  assert.equal(long.at(-1)!.elapsedMs, 49);
  assert.equal(
    tracking.findResultRef(ids.persist, {
      image: "data:image/png;base64,AAAA",
      saved: { url: "/api/gallery/file/a.png" },
    }),
    "/api/gallery/file/a.png",
  );
  assert.equal(
    tracking.findResultRef(ids.persist, { url: "https://evil.example/a.png" }),
    `/api/generation-jobs/${ids.persist}/result`,
  );
  assert.equal(
    tracking.findResultRef(ids.persist, "/api/../../etc/passwd"),
    `/api/generation-jobs/${ids.persist}/result`,
  );
  const day = 86_400_000;
  const nowMs = Date.parse("2026-09-23T12:00:00.000Z");
  const at = (offset: number) => new Date(nowMs - offset).toISOString();
  const rows = [
    { id: "a", status: "completed", createdAt: at(10 * day), updatedAt: at(10 * day) },
    { id: "b", status: "running", createdAt: at(30 * day), updatedAt: at(30 * day) },
    { id: "c", status: "failed", createdAt: at(3), updatedAt: at(3) },
    { id: "d", status: "completed", createdAt: at(2), updatedAt: at(2) },
    { id: "e", status: "cancelled", createdAt: at(1), updatedAt: at(1) },
  ];
  assert.deepEqual(
    tracking.selectExpiredRecords(rows, nowMs, { retentionMs: 7 * day, maxRecords: 2 }).sort(),
    ["a", "c"],
    "too old or beyond the cap, never an unfinished record",
  );

  // Client reattach rules.
  const job = (id: string, status: string, finishedAt: string | null, seenAt: string | null = null) =>
    ({ id, status, finishedAt, updatedAt: finishedAt ?? at(0), seenAt }) as never;
  const split = clientLib.partitionFinishedJobs(
    [
      job("before-load", "completed", at(60_000)),
      job("while-hidden", "failed", at(20_000)),
      job("while-present", "completed", at(5_000)),
      job("already-seen", "completed", at(60_000), at(1)),
      job("running", "running", null),
    ],
    { pageLoadedAt: nowMs - 30_000, away: [{ from: nowMs - 25_000, to: nowMs - 10_000 }] },
  );
  assert.deepEqual(
    split.announce.map((item: { id: string }) => item.id),
    ["before-load", "while-hidden"],
  );
  assert.deepEqual(
    split.quiet.map((item: { id: string }) => item.id),
    ["while-present"],
  );
  assert.equal(clientLib.formatJobAge(3_725_000), "1h 2m");
  assert.equal(clientLib.safeResultHref("/api/gallery/file/a.png"), "/api/gallery/file/a.png");
  assert.equal(clientLib.safeResultHref(`/api/generation-jobs/${ids.persist}/result`), null);
  assert.equal(clientLib.safeResultHref("javascript:alert(1)"), null);

  // ── Server fixtures ──
  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values({ id: "chat-1", name: "Harbor", mode: "roleplay", createdAt, updatedAt: createdAt });
  await db.insert(chats).values({ id: "chat-2", name: "Keep", mode: "roleplay", createdAt, updatedAt: createdAt });
  await db._fileStore.flush(true);

  const gates = new Map<
    string,
    { began: Promise<void>; begin: () => void; release: () => void; released: Promise<void> }
  >();
  const gate = (id: string) => {
    let entry = gates.get(id);
    if (!entry) {
      let begin!: () => void;
      let release!: () => void;
      const began = new Promise<void>((resolve) => (begin = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      entry = { began, begin, release, released };
      gates.set(id, entry);
    }
    return entry;
  };

  async function buildApp(options: { tracker: boolean; jobsRoot: string; progressIntervalMs?: number }) {
    const app = Fastify();
    app.decorate("db", db);
    const jobs = getGenerationJobs(app, { dataDir: options.jobsRoot, shutdownWaitMs: 200 });
    if (options.tracker) {
      await tracking.getGenerationJobTracker(app, { progressIntervalMs: options.progressIntervalMs ?? 30_000 });
      await app.register(generationJobRecordsRoutes, { prefix: "/api/generation-job-records" });
    }
    await app.register(generationJobsRoutes, { prefix: "/api/generation-jobs" });
    // Stands in for a media route: the provider is a gate the test opens, so no model is ever called.
    app.post<{ Params: { kind: string }; Body: { id: string; chatId?: string; fail?: boolean; held?: boolean } }>(
      "/stub/:kind",
      async (request, reply) => {
        const { id, chatId, fail, held } = request.body;
        const apiKey = PLANTED_KEY;
        const prompt = PLANTED_PROMPT;
        try {
          return await jobs.run(
            { id, kind: request.params.kind, label: "Stub media", chatId, timeoutMs: 10_000 },
            async () => {
              const entry = gate(id);
              entry.begin();
              if (held) await entry.released;
              if (fail) throw new Error(`Provider rejected "${prompt}" for key ${apiKey}`);
              return { image: "data:image/png;base64,AAAA", saved: { url: `/api/gallery/file/${id}.png` } };
            },
          );
        } catch (error) {
          return reply.code(500).send({ error: "Generation failed" });
        }
      },
    );
    await app.ready();
    return { app, jobs };
  }

  function storageSnapshot(): Map<string, string> {
    const snapshot = new Map<string, string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else snapshot.set(path.slice(root.length), createHash("sha256").update(readFileSync(path)).digest("hex"));
      }
    };
    // Table shards are the data; manifest.json is rewritten by every forced flush and is not a table write.
    walk(join(process.env.FILE_STORAGE_DIR!, "tables"));
    return snapshot;
  }

  // Raw bodies are compared byte for byte except for wall-clock times and random diagnostic ids.
  const normalize = (body: string): string =>
    body
      .replace(/"(createdAt|updatedAt)":"[^"]+"/g, '"$1":"<t>"')
      .replace(/"(errorId|requestId)":"[^"]+"/g, '"$1":"<id>"');

  // ── Setting off: byte-identical to not having the feature ──
  async function offFlow(app: Awaited<ReturnType<typeof buildApp>>["app"]) {
    const out: unknown[] = [];
    const call = async (method: "GET" | "POST", url: string, payload?: object) => {
      const response = await app.inject({ method, url, payload });
      out.push({
        url,
        status: response.statusCode,
        type: response.headers["content-type"],
        body: normalize(response.body),
      });
    };
    await call("POST", "/stub/gallery-image", { id: ids.offDone, chatId: "chat-1" });
    await call("POST", "/stub/gallery-image", { id: ids.offFail, chatId: "chat-1", fail: true });
    await call("GET", "/api/generation-jobs");
    await call("GET", "/api/generation-jobs?chatId=chat-1");
    await call("GET", `/api/generation-jobs/${ids.offDone}`);
    await call("GET", `/api/generation-jobs/${ids.offDone}/result`);
    await call("GET", `/api/generation-jobs/${ids.offFail}/result`);
    await call("POST", `/api/generation-jobs/${ids.offDone}/cancel`);
    await call("GET", "/api/generation-job-records");
    await call("GET", `/api/generation-job-records/${ids.offDone}`);
    await call("GET", `/api/generation-job-records/${ids.offDone}/trail`);
    await call("POST", "/api/generation-job-records/seen", { ids: [ids.offDone] });
    return out;
  }
  const before = storageSnapshot();
  const baselineRoot = join(root, "jobs-baseline");
  const baseline = await buildApp({ tracker: false, jobsRoot: baselineRoot });
  const baselineOut = await offFlow(baseline.app);
  await baseline.app.close();
  await db._fileStore.flush(true);
  assert.deepEqual(storageSnapshot(), before, "the baseline flow writes nothing to the database");

  const jobsRoot = join(root, "jobs");
  const logStart = logLines.length;
  const tracked = await buildApp({ tracker: true, jobsRoot, progressIntervalMs: 40 });
  const offOut = await offFlow(tracked.app);
  assert.deepEqual(offOut, baselineOut, "with the setting off every response matches the feature-less server");
  const settingsOff = await tracked.app.inject({ method: "GET", url: "/api/generation-job-records/settings" });
  assert.deepEqual(settingsOff.json(), { enabled: false, retentionDays: 7, maxRecords: 300 });
  await db._fileStore.flush(true);
  assert.deepEqual(storageSnapshot(), before, "with the setting off nothing new is written");
  assert.deepEqual(
    readdirSync(jobsRoot).sort(),
    readdirSync(baselineRoot).sort(),
    "the generation-jobs store writes the same files",
  );
  assert.equal((await db.select().from(generationJobRecords)).length, 0);
  assert.ok(
    !logLines.slice(logStart).some((line) => line.includes('"job.state"') || line.includes('"job.progress"')),
    "no lifecycle log lines while off",
  );
  const trackerTimer = async () =>
    ((await tracking.getGenerationJobTracker(tracked.app)) as unknown as { sweepTimer: NodeJS.Timeout | null })
      .sweepTimer;
  assert.equal(await trackerTimer(), null, "no retention timer while the setting is off");

  // ── Turn it on ──
  assert.equal(
    (
      await tracked.app.inject({
        method: "PUT",
        url: "/api/generation-job-records/settings",
        payload: { enabled: "yes" },
      })
    ).statusCode,
    400,
  );
  const on = await tracked.app.inject({
    method: "PUT",
    url: "/api/generation-job-records/settings",
    payload: { enabled: true },
  });
  assert.equal(on.json().enabled, true);
  assert.equal((await trackerTimer())?.hasRef(), false, "turning it on starts the unref'd retention timer");
  assert.equal(
    (await db.select().from(appSettings).where(eq(appSettings.key, tracking.GENERATION_JOB_TRACKING_SETTINGS_KEY)))[0]
      ?.value,
    "true",
  );
  const record = async (id: string) => {
    const response = await tracked.app.inject({ method: "GET", url: `/api/generation-job-records/${id}` });
    return response.statusCode === 200 ? response.json() : null;
  };

  // ── Persist: accepted, running, progress, completed ──
  const persistRequest = tracked.app.inject({
    method: "POST",
    url: "/stub/sprite-sheet",
    payload: { id: ids.persist, chatId: "chat-1", held: true },
  });
  await gate(ids.persist).began;
  const running = await until(async () => {
    const value = await record(ids.persist);
    return value?.status === "running" && value;
  }, "running record");
  assert.equal(running.kind, "sprite");
  assert.equal(running.sourceKind, "sprite-sheet");
  assert.equal(running.chatId, "chat-1");
  assert.equal(running.cancellable, true);
  const listed = (await tracked.app.inject({ method: "GET", url: "/api/generation-job-records?chatId=chat-1" })).json();
  assert.equal(listed.records[0].id, ids.persist, "active jobs are listed for reattach");
  assert.equal(listed.records[0].trail, undefined, "the list stays small; the trail is per job");
  await until(
    async () => (await record(ids.persist))?.trail.some((entry: { state: string }) => entry.state === "progress"),
    "progress",
  );
  gate(ids.persist).release();
  assert.equal((await persistRequest).statusCode, 200);
  const completed = await until(async () => {
    const value = await record(ids.persist);
    return value?.status === "completed" && value;
  }, "completed record");
  assert.equal(completed.resultRef, `/api/gallery/file/${ids.persist}.png`);
  assert.equal(typeof completed.elapsedMs, "number");
  assert.equal(completed.cancellable, false);
  assert.deepEqual(
    completed.trail.map((entry: { state: string }) => entry.state),
    ["accepted", "running", "progress", "completed"],
  );
  assert.equal(completed.trail.at(-1).outcome, "ok");
  const trailRoute = (
    await tracked.app.inject({ method: "GET", url: `/api/generation-job-records/${ids.persist}/trail` })
  ).json();
  assert.deepEqual(trailRoute, { jobId: ids.persist, trail: completed.trail }, "lookup route returns the log trail");
  assert.equal((await tracked.app.inject({ method: "GET", url: "/api/generation-job-records/nope" })).statusCode, 400);

  // Text jobs through the same store are not tracked.
  await tracked.app.inject({ method: "POST", url: "/stub/game-party-turn", payload: { id: ids.text } });
  assert.equal(await record(ids.text), null);

  // ── Browser closed: the client disconnects, the job still finishes and is saved ──
  const address = await tracked.app.listen({ port: 0, host: "127.0.0.1" });
  const client = httpRequest(`${address}/stub/gallery-selfie`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  client.on("error", () => undefined);
  client.end(JSON.stringify({ id: ids.closed, chatId: "chat-2", held: true }));
  await gate(ids.closed).began;
  client.destroy();
  await wait(30);
  gate(ids.closed).release();
  const finishedAway = await until(async () => {
    const value = await record(ids.closed);
    return value?.status === "completed" && value;
  }, "completion without a client");
  assert.equal(finishedAway.seenAt, null, "nobody has seen it yet");

  // ── Reconnect: the client lists, finds the unseen result, surfaces it and marks it recovered ──
  const reattach = (await tracked.app.inject({ method: "GET", url: "/api/generation-job-records" })).json();
  const unseen = reattach.records.filter(
    (item: { seenAt: string | null; status: string }) => !item.seenAt && item.status === "completed",
  );
  assert.ok(unseen.some((item: { id: string }) => item.id === ids.closed));
  const seen = await tracked.app.inject({
    method: "POST",
    url: "/api/generation-job-records/seen",
    payload: { ids: [ids.closed] },
  });
  assert.deepEqual(seen.json(), { updated: 1 });
  const afterSeen = await record(ids.closed);
  assert.ok(afterSeen.seenAt);
  assert.deepEqual(
    {
      state: afterSeen.trail.at(-1).state,
      stage: afterSeen.trail.at(-1).stage,
      outcome: afterSeen.trail.at(-1).outcome,
    },
    { state: "recovered", stage: "client-reattach", outcome: "ok" },
  );
  const again = await tracked.app.inject({
    method: "POST",
    url: "/api/generation-job-records/seen",
    payload: { ids: [ids.closed] },
  });
  assert.deepEqual(again.json(), { updated: 0 }, "a result is announced once");
  const quiet = await tracked.app.inject({
    method: "POST",
    url: "/api/generation-job-records/seen",
    payload: { ids: [ids.persist], recovered: false },
  });
  assert.deepEqual(quiet.json(), { updated: 1 });
  assert.notEqual(
    (await record(ids.persist)).trail.at(-1).state,
    "recovered",
    "watched jobs are not logged as recovered",
  );
  assert.equal(
    (await tracked.app.inject({ method: "POST", url: "/api/generation-job-records/seen", payload: { ids: ["x"] } }))
      .statusCode,
    400,
  );

  // ── Cancel through the existing route ──
  const cancelRequest = tracked.app.inject({
    method: "POST",
    url: "/stub/gallery-image",
    payload: { id: ids.cancel, held: true },
  });
  await gate(ids.cancel).began;
  await until(async () => (await record(ids.cancel))?.status === "running", "cancel target running");
  await tracked.app.inject({ method: "POST", url: `/api/generation-jobs/${ids.cancel}/cancel` });
  await cancelRequest;
  gate(ids.cancel).release();
  const cancelled = await until(async () => {
    const value = await record(ids.cancel);
    return value?.status === "cancelled" && value;
  }, "cancelled record");
  assert.equal(cancelled.errorCode, "ME_CANCELLED");
  assert.equal(cancelled.trail.at(-1).outcome, "cancelled");

  // ── Failure with a planted secret and prompt ──
  await tracked.app.inject({
    method: "POST",
    url: "/stub/gallery-image",
    payload: { id: ids.fail, chatId: "chat-1", fail: true },
  });
  const failed = await until(async () => {
    const value = await record(ids.fail);
    return value?.status === "failed" && value;
  }, "failed record");
  assert.match(failed.errorCode, /^ME_[A-Z_]+$/);
  assert.equal(failed.trail.at(-1).state, "failed");
  assert.equal(failed.trail.at(-1).outcome, "failed");

  // ── Log redaction ──
  const jobLines = logLines.filter((line) => line.includes('"job.state"') || line.includes('"job.progress"'));
  assert.ok(jobLines.length >= 10, "lifecycle lines were logged");
  const states = new Set(jobLines.map((line) => JSON.parse(line).state));
  for (const state of ["accepted", "running", "progress", "completed", "failed", "cancelled", "recovered"])
    assert.ok(states.has(state), `a ${state} line was logged`);
  const completedLine = JSON.parse(jobLines.find((line) => line.includes('"completed"'))!);
  assert.equal(completedLine.operation, "generation.job");
  assert.equal(typeof completedLine.elapsedMs, "number");
  assert.equal(completedLine.outcome, "ok");
  assert.ok(completedLine.jobId && completedLine.kind, "job id and kind are present");
  for (const line of jobLines) {
    assert.ok(!line.includes("PLANTED"), "no prompt text in lifecycle lines");
    assert.ok(!line.includes(PLANTED_KEY), "no key in lifecycle lines");
    assert.ok(!line.includes("Provider rejected"), "no provider message in lifecycle lines");
  }
  assert.ok(!logLines.join("").includes(PLANTED_KEY), "the planted key never reaches any log line");
  const everything = JSON.stringify(await db.select().from(generationJobRecords));
  assert.ok(!everything.includes("PLANTED") && !everything.includes(PLANTED_KEY), "records hold no prompt or key");

  // ── Server restart: stale records are reconciled, nothing is re-run ──
  const heldRequest = tracked.app.inject({
    method: "POST",
    url: "/stub/gallery-image",
    payload: { id: ids.held, held: true },
  });
  await gate(ids.held).began;
  await until(async () => (await record(ids.held))?.status === "running", "held job running");
  const stamp = new Date().toISOString();
  const staleRow = (id: string) => ({
    id,
    kind: "image",
    sourceKind: "gallery-image",
    label: "Stale",
    chatId: null,
    status: "running",
    createdAt: stamp,
    updatedAt: stamp,
    startedAt: stamp,
    trail: "[]",
  });
  await db.insert(generationJobRecords).values(staleRow(ids.staleLost));
  // A job whose store metadata completed but whose record update was lost in a crash.
  const sideStore = createGenerationJobs({ dataDir: jobsRoot });
  await sideStore.run({ id: ids.staleDone, kind: "gallery-image", label: "Side", timeoutMs: 1000 }, async () => ({
    ok: true,
  }));
  await sideStore.close();
  await db.insert(generationJobRecords).values(staleRow(ids.staleDone));
  await tracked.app.close();
  gate(ids.held).release();
  await heldRequest.catch(() => undefined);

  const restarted = await buildApp({ tracker: true, jobsRoot });
  const restartedRecord = async (id: string) =>
    (await restarted.app.inject({ method: "GET", url: `/api/generation-job-records/${id}` })).json();
  const lost = await restartedRecord(ids.staleLost);
  assert.equal(lost.status, "interrupted");
  assert.equal(lost.errorCode, "ME_INTERRUPTED");
  assert.deepEqual(
    { state: lost.trail.at(-1).state, stage: lost.trail.at(-1).stage, outcome: lost.trail.at(-1).outcome },
    { state: "recovered", stage: "server-restart", outcome: "failed" },
  );
  const done = await restartedRecord(ids.staleDone);
  assert.equal(done.status, "completed", "the store's finished result wins");
  assert.equal(done.resultRef, `/api/generation-jobs/${ids.staleDone}/result`);
  const heldAfter = await restartedRecord(ids.held);
  assert.equal(heldAfter.status, "interrupted", "a job cut off by shutdown ends interrupted, never re-run");
  assert.equal(heldAfter.errorCode, "ME_INTERRUPTED");

  // ── Chat deletion cleans up ──
  await db.delete(chats).where(eq(chats.id, "chat-1"));
  assert.equal(
    (await db.select().from(generationJobRecords).where(eq(generationJobRecords.chatId, "chat-1"))).length,
    0,
  );
  assert.ok((await db.select().from(generationJobRecords).where(eq(generationJobRecords.id, ids.closed))).length === 1);
  // A chat deleted while its job still runs: the job's later writes must not bring the record back.
  await db.insert(chats).values({ id: "chat-3", name: "Tide", mode: "roleplay", createdAt, updatedAt: createdAt });
  const orphanRequest = restarted.app.inject({
    method: "POST",
    url: "/stub/gallery-image",
    payload: { id: ids.orphan, chatId: "chat-3", held: true },
  });
  await gate(ids.orphan).began;
  await until(async () => (await restartedRecord(ids.orphan))?.status === "running", "orphan job running");
  await db.delete(chats).where(eq(chats.id, "chat-3"));
  gate(ids.orphan).release();
  assert.equal((await orphanRequest).statusCode, 200);
  await (await tracking.getGenerationJobTracker(restarted.app)).list();
  assert.equal(
    (await db.select().from(generationJobRecords).where(eq(generationJobRecords.id, ids.orphan))).length,
    0,
    "a record removed with its chat stays removed when the job finishes",
  );
  await restarted.app.close();

  // ── Retention ──
  await db.delete(generationJobRecords).run();
  const retentionNow = Date.parse("2026-09-23T12:00:00.000Z");
  const aged = (id: string, status: string, ageMs: number) => {
    const iso = new Date(retentionNow - ageMs).toISOString();
    return { ...staleRow(id), status, createdAt: iso, updatedAt: iso, finishedAt: iso };
  };
  const retentionIds = [0, 1, 2, 3, 4, 5].map((index) => `44444444-4444-4444-8444-44444444444${index}`);
  await db.insert(generationJobRecords).values(aged(retentionIds[0]!, "completed", 9 * day));
  for (let index = 1; index <= 5; index++)
    await db.insert(generationJobRecords).values(aged(retentionIds[index]!, "completed", index * 60_000));
  const expiredBefore = logLines.filter((line) => line.includes('"expired"')).length;
  const retentionStore = createGenerationJobs({ dataDir: join(root, "jobs-retention") });
  const retentionTracker = new tracking.GenerationJobTracker(db, retentionStore, {
    now: () => retentionNow,
    retentionMs: 7 * day,
    maxRecords: 3,
  });
  await retentionTracker.init();
  const kept = (await db.select().from(generationJobRecords)).map((row) => row.id).sort();
  assert.deepEqual(kept, retentionIds.slice(1, 4).sort(), "old records and records beyond the cap are removed");
  assert.equal(
    logLines.filter((line) => line.includes('"expired"')).length - expiredBefore,
    3,
    "each removal is logged",
  );
  assert.equal(
    (retentionTracker as unknown as { sweepTimer: NodeJS.Timeout }).sweepTimer.hasRef(),
    false,
    "cleanup timer is unref'd",
  );
  await retentionTracker.close();
  await retentionStore.close();

  // Failure-safe: a broken store never throws out of init or sweep.
  const broken = {
    select() {
      throw new Error("disk on fire");
    },
  } as unknown as typeof db;
  const brokenStore = createGenerationJobs({ dataDir: join(root, "jobs-broken") });
  const brokenTracker = new tracking.GenerationJobTracker(broken, brokenStore);
  await brokenTracker.init();
  assert.equal(brokenTracker.isEnabled(), false);
  assert.equal(await brokenTracker.sweep(), 0);
  await brokenTracker.close();
  await brokenStore.close();

  // ── A throwing observer never reaches the generation ──
  const throwingStore = createGenerationJobs({ dataDir: join(root, "jobs-throwing") });
  let observed = 0;
  throwingStore.setObserver(() => {
    observed++;
    throw new Error("observer exploded");
  });
  const value = await throwingStore.run(
    { kind: "gallery-image", label: "Observer throws", timeoutMs: 1000 },
    async () => ({ saved: true }),
  );
  assert.deepEqual(value, { saved: true }, "the generation still succeeds and returns its value");
  assert.equal(observed, 3, "accepted, running and settled were all attempted");
  const throwingJob = (await throwingStore.list())[0]!;
  assert.equal(throwingJob.status, "completed");
  assert.ok(
    logLines.some((line) => line.includes("Generation job observer failed")),
    "the failure is logged as a warning",
  );
  await throwingStore.close();

  // ── Cancel racing the settle: "settled" fires only after the cancelled status is on disk ──
  const orderRoot = join(root, "jobs-order");
  const orderStore = createGenerationJobs({ dataDir: orderRoot, shutdownWaitMs: 50 });
  const settledOnDisk: string[] = [];
  orderStore.setObserver((event) => {
    if (event.type !== "settled") return;
    settledOnDisk.push(JSON.parse(readFileSync(join(orderRoot, `${event.metadata.id}.json`), "utf8")).status);
  });
  const orderRun = orderStore.run(
    { id: ids.cancelOrder, kind: "gallery-image", label: "Order", timeoutMs: 10_000 },
    () => new Promise(() => undefined),
  );
  orderRun.catch(() => undefined);
  await until(async () => orderStore.isLive(ids.cancelOrder) && (await orderStore.get(ids.cancelOrder)), "order job");
  assert.equal(await orderStore.cancel(ids.cancelOrder), true);
  assert.equal(await orderStore.cancel(ids.cancelOrder), false, "a second cancel is a no-op");
  await until(async () => settledOnDisk.length > 0, "settled event");
  await wait(20);
  assert.deepEqual(settledOnDisk, ["cancelled"], "one settled event, after the cancel was saved");
  await orderStore.close();

  process.stdout.write("generation-job-tracking regression passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
