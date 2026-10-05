import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// POST /game/:chatId/continuity/backfill/:backfillId/retry requeues receipts of a
// frozen manifest by status / errorCode / limit through the runtime retry API, and
// `backfill-campaign-history.mjs --retry-failed [code]` drives it from a checkpoint.
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const cli = fileURLToPath(new URL("../backfill-campaign-history.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-backfill-retry-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
// Pin the worker budget: the Engine loads .env through dotenv when server modules are imported, so an
// installation tuned for a large archive must not change what these fixtures measure.
process.env.CONTINUITY_MAX_CONCURRENT = "2";
process.env.CONTINUITY_BACKFILL_CONCURRENCY = "1";
process.env.CONTINUITY_BACKFILL_TURNS_PER_RECEIPT = "1";
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

const chatId = "retry-regression-chat";

async function waitUntil(predicate: () => Promise<boolean> | boolean, what: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let app: any = null;
let runtime: any = null;
try {
  const { applyFeatureSettingsValue, isFeatureEnabled } =
    await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true, campaignMemory: true, campaignIndex: true }));

  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { gameContinuityBackfillRoutes } =
    await import("../../packages/server/src/routes/game-continuity-backfill.routes.js");

  const db = await createFileNativeDB();
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 12, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({
    id: "retry-connection",
    name: "Retry regression connection",
    provider: "openai",
    model: "fake-model",
    defaultForAgents: "true",
    createdAt: at(0),
    updatedAt: at(0),
  });
  await db.insert(chats).values({
    id: chatId,
    name: "Retry regression",
    mode: "game",
    connectionId: "retry-connection",
    metadata: JSON.stringify({ gameContinuity: { mode: "off" } }),
    createdAt: at(0),
    updatedAt: at(0),
  });
  await db.insert(messages).values([
    { id: "rt-user-1", chatId, role: "user", content: "Alice opens the sealed gate.", createdAt: at(1) },
    { id: "rt-assistant-1", chatId, role: "assistant", content: "The gate opens for Alice.", createdAt: at(2) },
    { id: "rt-user-2", chatId, role: "user", content: "Alice enters the archive.", createdAt: at(3) },
    { id: "rt-assistant-2", chatId, role: "assistant", content: "The archive holds a map.", createdAt: at(4) },
    { id: "rt-user-3", chatId, role: "user", content: "Alice leaves the archive.", createdAt: at(5) },
    { id: "rt-assistant-3", chatId, role: "assistant", content: "The archive door closes.", createdAt: at(6) },
    { id: "rt-user-4", chatId, role: "user", content: "Alice returns home.", createdAt: at(7) },
  ]);

  // Stubbed provider: turn 2 answers malformed JSON (a non-transient failure that exhausts its
  // attempts and lands in `failed`) until released, turn 3 is unresolved until released. A timeout
  // would not do here: timeouts are transient, refund their attempt and keep the receipt resumable.
  let timeoutTurn = true;
  let unresolvedTurn = true;
  const complete = async ({
    stage,
    receipt,
  }: {
    stage: string;
    receipt: { sources: Array<{ messageId: string; content: string }> };
  }) => {
    const source = receipt.sources.find((item) => item.messageId.startsWith("rt-user-")) ?? receipt.sources[0]!;
    if (source.messageId === "rt-user-2" && timeoutTurn) throw new Error("CONTINUITY_INVALID_JSON");
    const status = source.messageId === "rt-user-3" && unresolvedTurn ? "unresolved" : "covered";
    const dispositions = receipt.sources.map((item) => ({ messageId: item.messageId, status, reason: "stub" }));
    if (stage === "repair") return { replace: [], add: [], dispositions };
    if (stage === "extract") {
      return {
        records:
          status === "covered"
            ? [
                {
                  id: "retry-record",
                  kind: "event",
                  text: "Alice opened the sealed gate.",
                  subjects: [],
                  conditions: [],
                  status: "asserted",
                  evidence: receipt.sources.map((item) => ({ messageId: item.messageId, quote: item.content })),
                  keys: ["sealed gate"],
                },
              ]
            : [],
        dispositions,
      };
    }
    return { findings: [], dispositions };
  };

  runtime = createGameContinuityRuntime(db, { complete: complete as never });
  const storage = createGameContinuityStorage(db);
  app = Fastify();
  let publicationRequests = 0;
  app.addHook("onRequest", async (request: { method: string; url: string }) => {
    if (request.method === "POST" && request.url.endsWith("/publish")) publicationRequests += 1;
  });
  app.decorate("db", db);
  app.decorate("gameContinuity", runtime);
  await app.register(gameContinuityBackfillRoutes, { prefix: "/api/game" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${(address as { port: number }).port}/api`;

  const start = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill`,
    payload: { fromMessageId: "rt-assistant-1", toMessageId: "rt-assistant-3" },
  });
  assert.equal(start.statusCode, 200, start.body);
  const backfillId = start.json().backfillId as string;
  assert.equal(start.json().acceptedTurns, 3);
  const terminal = ["verified", "published", "failed", "unresolved", "stale"];
  const allTerminal = async () => {
    const receipts = await storage.list(chatId);
    return receipts.length === 3 && receipts.every((receipt) => terminal.includes(receipt.status));
  };
  await waitUntil(allTerminal, "the first pass to settle");
  const byTurn = async () => {
    const receipts = await storage.list(chatId);
    const find = (userId: string) => receipts.find((receipt) => receipt.sources.some((s) => s.messageId === userId))!;
    return { first: find("rt-user-1"), timeout: find("rt-user-2"), unresolved: find("rt-user-3") };
  };
  let turns = await byTurn();
  assert.equal(turns.first.status, "verified");
  assert.equal(turns.timeout.status, "failed");
  assert.equal(turns.timeout.errorCode, "CONTINUITY_INVALID_JSON");
  assert.equal(turns.unresolved.status, "unresolved");

  // Validation: statuses outside failed/unresolved/stale and unknown manifests are rejected.
  const badBody = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill/${backfillId}/retry`,
    payload: { statuses: ["verified"] },
  });
  assert.equal(badBody.statusCode, 400);
  const unknownManifest = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill/historical-continuity-nope/retry`,
    payload: {},
  });
  assert.equal(unknownManifest.statusCode, 404);

  // CLI --retry-failed CONTINUITY_INVALID_JSON: only the failed receipt with that code is requeued.
  timeoutTurn = false;
  const statePath = join(root, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      jobs: [
        {
          chatId,
          backfillId,
          fromMessageId: "rt-assistant-1",
          toMessageId: "rt-assistant-3",
          status: "failed",
          receiptIds: (await storage.list(chatId)).map((receipt) => receipt.id),
        },
      ],
    }),
  );
  const conflict = await runCli(["--retry-failed", "--watch", "--state", statePath, "--base-url", baseUrl]);
  assert.equal(conflict.code, 1, "mode flags are mutually exclusive");
  assert.match(conflict.stderr, /exactly one of/u);
  const retried = await runCli([
    "--retry-failed",
    "CONTINUITY_INVALID_JSON",
    "--state",
    statePath,
    "--base-url",
    baseUrl,
  ]);
  assert.equal(retried.code, 0, `${retried.stderr}\n${retried.stdout}`);
  assert.match(retried.stdout, /retried=1 skipped=2/u);
  assert.match(retried.stdout, /retry complete: 1 receipt\(s\) requeued/u);
  const checkpoint = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(checkpoint.jobs[0].status, "running", "a requeued job goes back to watch");
  assert.equal(typeof checkpoint.jobs[0].retriedAt, "string");
  await waitUntil(async () => (await byTurn()).timeout.status === "verified", "the failed receipt to verify");
  turns = await byTurn();
  assert.equal(turns.timeout.id, (await byTurn()).timeout.id, "retry keeps the receipt id");
  assert.equal(turns.timeout.errorCode, undefined);
  assert.equal(turns.unresolved.status, "unresolved", "errorCode filter leaves the unresolved receipt alone");

  // Endpoint filter by status + limit through the same manifest.
  unresolvedTurn = false;
  const byStatus = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill/${backfillId}/retry`,
    payload: { statuses: ["unresolved"], limit: 1 },
  });
  assert.equal(byStatus.statusCode, 200, byStatus.body);
  assert.deepEqual(byStatus.json().retried, [turns.unresolved.id]);
  assert.deepEqual(
    byStatus
      .json()
      .skipped.map((item: { id: string; reason: string }) => item.reason)
      .sort(),
    ["status:verified", "status:verified"],
  );
  await waitUntil(async () => (await byTurn()).unresolved.status === "verified", "the unresolved receipt to verify");

  const nothingLeft = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill/${backfillId}/retry`,
    payload: {},
  });
  assert.equal(nothingLeft.statusCode, 200, nothingLeft.body);
  assert.deepEqual(nothingLeft.json().retried, []);
  assert.equal(nothingLeft.json().skipped.length, 3);
  assert.ok(nothingLeft.json().skipped.every((item: { reason: string }) => item.reason === "status:verified"));

  const status = await app.inject({ method: "GET", url: `/api/game/${chatId}/continuity/backfill/${backfillId}` });
  assert.deepEqual(status.json().counts, { verified: 3 });

  // A stale batch (the config changed and changed back, so its id is the one a fresh read would get) is re-read
  // under the backfill's own config and joins the manifest. Live continuity is off here, which used to make
  // the runtime's live-turn retry return nothing ("runtime_stopped").
  const staleTarget = (await byTurn()).first;
  await storage.save({
    ...staleTarget,
    status: "stale",
    errorCode: "CONTINUITY_CONFIG_CHANGED",
    error: "The continuity configuration changed after this batch was queued.",
    updatedAt: new Date().toISOString(),
  });
  await assert.rejects(
    runtime.retry(chatId, staleTarget.id),
    /CONTINUITY_BACKFILL_RERUN_REQUIRED/u,
    "the runtime never rebuilds a historical batch as a live turn",
  );
  const staleRetry = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill/${backfillId}/retry`,
    payload: {},
  });
  assert.equal(staleRetry.statusCode, 200, staleRetry.body);
  assert.deepEqual(staleRetry.json().retried, [staleTarget.id]);
  assert.equal(staleRetry.json().requeued.length, 1, "the stale batch is read again under a new id");
  const replacementId = staleRetry.json().requeued[0] as string;
  assert.notEqual(replacementId, staleTarget.id);
  const replacement = await storage.get(replacementId);
  assert.equal(replacement?.config.historicalBackfill?.id, backfillId, "the replacement is a historical batch");
  const manifestNow = await app.inject({ method: "GET", url: `/api/game/${chatId}/continuity/backfill/${backfillId}` });
  assert.ok(manifestNow.json().manifest.receiptIds.includes(replacementId), "the manifest tracks the replacement");
  await waitUntil(async () => (await storage.get(replacementId))?.status === "verified", "the replacement to verify");
  const afterStale = await app.inject({ method: "GET", url: `/api/game/${chatId}/continuity/backfill/${backfillId}` });
  assert.deepEqual(afterStale.json().counts, { verified: 3, stale: 1 });

  // The real CLI watches the real route without publishing unless explicitly requested.
  const watchStatePath = join(root, "watch-state.json");
  writeFileSync(watchStatePath, JSON.stringify({ version: 1, jobs: [{ chatId, backfillId, status: "started" }] }));
  const watchArgs = ["--watch", "--state", watchStatePath, "--base-url", baseUrl];
  const ordinaryWatch = await runCli(watchArgs);
  assert.equal(ordinaryWatch.code, 1, ordinaryWatch.stderr);
  assert.equal(publicationRequests, 0, "ordinary watch never publishes");
  assert.deepEqual(
    (await app.inject({ method: "GET", url: `/api/game/${chatId}/continuity/backfill/${backfillId}` })).json().counts,
    { verified: 3, stale: 1 },
  );
  const explicitWatch = await runCli([...watchArgs, "--publish-reviewed"]);
  assert.equal(explicitWatch.code, 1, explicitWatch.stderr);
  assert.equal(publicationRequests, 1, "explicit watch publishes verified receipts");
  assert.deepEqual(
    (await app.inject({ method: "GET", url: `/api/game/${chatId}/continuity/backfill/${backfillId}` })).json().counts,
    { published: 3, stale: 1 },
  );
  assert.equal((await storage.get(staleTarget.id))?.status, "stale", "publication does not promote stale receipts");
  assert.equal(JSON.parse(readFileSync(watchStatePath, "utf8")).jobs[0].status, "stale");
  const repeatedWatch = await runCli([...watchArgs, "--publish-reviewed"]);
  assert.equal(repeatedWatch.code, 1, repeatedWatch.stderr);
  assert.equal(publicationRequests, 1, "no verified receipts means no repeated publication");

  // The CLI must report an OFF server response without enabling the feature or rewriting the checkpoint job.
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: false, campaignMemory: true, campaignIndex: true }));
  const disabledStatePath = join(root, "disabled-state.json");
  writeFileSync(disabledStatePath, JSON.stringify({ version: 1, jobs: [{ chatId, backfillId, status: "failed" }] }));
  const disabledRetry = await runCli(["--retry-failed", "--state", disabledStatePath, "--base-url", baseUrl]);
  assert.equal(disabledRetry.code, 1, "a disabled server rejects retry");
  assert.match(disabledRetry.stderr, /HTTP 403/u);
  const disabledCheckpoint = JSON.parse(readFileSync(disabledStatePath, "utf8"));
  assert.equal(disabledCheckpoint.aborted, true, "the server rejection is checkpointed");
  assert.match(disabledCheckpoint.error, /HTTP 403/u);
  assert.equal(disabledCheckpoint.jobs[0].status, "failed", "rejection does not mutate the job status");
  assert.equal(isFeatureEnabled("gameContinuity"), false, "the CLI does not turn the server feature back on");
  const stillDisabled = await app.inject({
    method: "GET",
    url: `/api/game/${chatId}/continuity/backfill/${backfillId}`,
  });
  assert.equal(stillDisabled.statusCode, 403, "the server remains disabled after the CLI exits");

  await runtime.stop();
  runtime = null;
  await app.close();
  app = null;
  console.log("game continuity backfill retry regression passed");
} finally {
  if (runtime) await runtime.stop().catch(() => {});
  if (app) await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
