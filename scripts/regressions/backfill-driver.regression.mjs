import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { saveJson } from "../backfill-campaign-history.mjs";

const root = await mkdtemp(join(tmpdir(), "marinara-backfill-driver-"));
const cli = join(process.cwd(), "scripts", "backfill-campaign-history.mjs");
const jobs = new Map();
let publishCalls = 0;

const checkpointPath = join(root, "checkpoint.json");
await writeFile(checkpointPath, "{\"version\":1,\"marker\":\"previous\"}\n");
let transientRenameAttempts = 0;
await saveJson(checkpointPath, { version: 1, marker: "updated" }, {
  delayMs: 0,
  renameFn: async (source, destination) => {
    transientRenameAttempts += 1;
    if (transientRenameAttempts < 3) {
      const error = new Error("simulated OneDrive rename lock");
      error.code = "EPERM";
      throw error;
    }
    await rename(source, destination);
  },
});
assert.equal(transientRenameAttempts, 3, "transient checkpoint rename should retry");
assert.equal(JSON.parse(await readFile(checkpointPath, "utf8")).marker, "updated");

const preservedCheckpointPath = join(root, "preserved-checkpoint.json");
await writeFile(preservedCheckpointPath, "{\"version\":1,\"marker\":\"previous\"}\n");
await assert.rejects(
  saveJson(preservedCheckpointPath, { version: 1, marker: "must not replace" }, {
    delayMs: 0,
    retries: 2,
    renameFn: async () => {
      const error = new Error("simulated persistent OneDrive rename lock");
      error.code = "EPERM";
      throw error;
    },
  }),
  /persistent OneDrive rename lock/u,
);
assert.equal(JSON.parse(await readFile(preservedCheckpointPath, "utf8")).marker, "previous");

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const parts = (request.url ?? "").split("/").filter(Boolean);
  if (
    request.method === "POST" &&
    parts.length === 5 &&
    parts[0] === "api" &&
    parts[1] === "game" &&
    parts[3] === "continuity" &&
    parts[4] === "backfill"
  ) {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (input.fromMessageId === "fail") return json(response, 503, { error: "mock unavailable" });
    const backfillId = `mock-${input.fromMessageId}`;
    const status =
      input.fromMessageId === "unresolved" ? "unresolved" : input.fromMessageId === "unknown" ? "mystery" : "verified";
    const receipts =
      input.fromMessageId === "race"
        ? [
            { id: `receipt-${backfillId}-one`, status: "verified" },
            { id: `receipt-${backfillId}-two`, status: "reviewing" },
          ]
        : [{ id: `receipt-${backfillId}`, status }];
    jobs.set(backfillId, { status, published: false, receipts });
    return json(response, 200, { backfillId, acceptedTurns: 1, receipts: receipts.map(({ id }) => ({ id })) });
  }
  if (
    request.method === "GET" &&
    parts.length === 6 &&
    parts[0] === "api" &&
    parts[1] === "game" &&
    parts[3] === "continuity" &&
    parts[4] === "backfill"
  ) {
    const backfillId = decodeURIComponent(parts[5]);
    const job = jobs.get(backfillId);
    if (!job) return json(response, 404, { error: "missing mock job" });
    const receipts = job.receipts
      ? job.receipts.map((receipt) => ({ ...receipt, status: job.published ? "published" : receipt.status }))
      : [{ id: `receipt-${backfillId}`, status: job.published ? "published" : job.status }];
    const counts = Object.fromEntries(
      receipts.map(({ status }) => [status, receipts.filter((receipt) => receipt.status === status).length]),
    );
    return json(response, 200, { backfillId, counts, receipts });
  }
  if (request.method === "POST" && parts.length === 7 && parts[6] === "publish") {
    publishCalls += 1;
    const backfillId = decodeURIComponent(parts[5]);
    const job = jobs.get(backfillId);
    if (!job) return json(response, 404, { error: "missing mock job" });
    if (backfillId === "mock-race") {
      if (job.receipts[0].status === "published") job.receipts[1].status = "published";
      else {
        job.receipts[0].status = "published";
        job.receipts[1].status = "verified";
      }
    } else if (backfillId !== "mock-noop") job.published = true;
    return json(response, 200, { backfillId, published: [`receipt-${backfillId}`] });
  }
  return json(response, 404, { error: "unhandled mock route" });
});

function run(args, baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, "--base-url", baseUrl], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function writePlan(path, fromMessageId) {
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      path,
      JSON.stringify({
        chats: [{ chatId: "mock-chat", name: "Mock", ranges: [{ fromMessageId, toMessageId: "end" }] }],
      }),
    ),
  );
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  const verifiedPlan = join(root, "verified-plan.json");
  const verifiedState = join(root, "verified-state.json");
  await writePlan(verifiedPlan, "verified");
  const started = await run(["--start", "--plan", verifiedPlan, "--state", verifiedState], baseUrl);
  assert.equal(started.code, 0, started.stderr);
  const checkpoint = JSON.parse(await readFile(verifiedState, "utf8"));
  assert.equal(checkpoint.jobs[0].backfillId, "mock-verified");
  const completed = await run(["--watch", "--publish-reviewed", "--interval", "1", "--state", verifiedState], baseUrl);
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(JSON.parse(await readFile(verifiedState, "utf8")).jobs[0].status, "complete");
  assert.equal(publishCalls, 1);

  const racePlan = join(root, "race-plan.json");
  const raceState = join(root, "race-state.json");
  await writePlan(racePlan, "race");
  assert.equal((await run(["--start", "--plan", racePlan, "--state", raceState], baseUrl)).code, 0);
  const race = await run(["--watch", "--publish-reviewed", "--interval", "1", "--state", raceState], baseUrl);
  assert.equal(race.code, 0, `${race.stderr}\n${race.stdout}`);
  assert.equal(JSON.parse(await readFile(raceState, "utf8")).jobs[0].status, "complete");

  const noopPlan = join(root, "noop-plan.json");
  const noopState = join(root, "noop-state.json");
  await writePlan(noopPlan, "noop");
  assert.equal((await run(["--start", "--plan", noopPlan, "--state", noopState], baseUrl)).code, 0);
  const noop = await run(["--watch", "--publish-reviewed", "--interval", "1", "--state", noopState], baseUrl);
  assert.equal(noop.code, 1, "noop publication must not report success");
  const noopCheckpoint = JSON.parse(await readFile(noopState, "utf8"));
  assert.equal(noopCheckpoint.aborted, true);
  assert.match(noopCheckpoint.error, /without publishing/u);

  for (const [fromMessageId, expectedStatus] of [
    ["unresolved", "unresolved"],
    ["unknown", "stale"],
  ]) {
    const plan = join(root, `${fromMessageId}-plan.json`);
    const state = join(root, `${fromMessageId}-state.json`);
    await writePlan(plan, fromMessageId);
    assert.notEqual((await run(["--start", "--plan", plan, "--state", state], baseUrl)).code, 1, "start must succeed");
    const result = await run(["--watch", "--interval", "1", "--state", state], baseUrl);
    assert.equal(result.code, 1, `${fromMessageId} should be incomplete`);
    assert.equal(JSON.parse(await readFile(state, "utf8")).jobs[0].status, expectedStatus);
  }

  const failedPlan = join(root, "failed-plan.json");
  const failedState = join(root, "failed-state.json");
  await writePlan(failedPlan, "fail");
  const failed = await run(["--start", "--plan", failedPlan, "--state", failedState], baseUrl);
  assert.equal(failed.code, 1);
  const failedCheckpoint = JSON.parse(await readFile(failedState, "utf8"));
  assert.equal(failedCheckpoint.aborted, true);
  assert.match(failedCheckpoint.error, /HTTP 503/u);
  console.log(
    "backfill driver regression passed: checkpoint, verified publication, unresolved and unknown terminal states, and API failure abort",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
