// Logging batch 10 v1.0 (2026-09-23): media jobs, image and video. Generation jobs
// write job.state lines (accepted, running, completed, failed, cancelled, recovered)
// with one full failure line; the media queue writes one media.queue line per
// request with the connection host only; pollProviderTask writes job.progress lines
// and tags a thrown error with providerTaskId. Temporary directories; no provider,
// no live server.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const logDir = mkdtempSync(join(tmpdir(), "marinara-logging-b10-"));
const jobsDir = mkdtempSync(join(tmpdir(), "marinara-logging-b10-jobs-"));
process.env.LOG_DIR = logDir;
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";

const SECRET_PROMPT = "PLANTED PROMPT the dragon sleeps";

type Line = Record<string, any>;
function mainLines(): Line[] {
  return readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

try {
  const { logger } = await import("../../packages/server/src/lib/logger.js");
  const { createGenerationJobs, mediaKindOf } =
    await import("../../packages/server/src/services/generation/generation-jobs.js");
  const { runMediaGenerationRequest, mediaConnectionKeyHost, pollProviderTask, providerResponseShape } =
    await import("../../packages/server/src/services/image/image-generation-queue.js");
  const { sampleWorkerGauges } = await import("../../packages/server/src/lib/worker-gauges.js");

  // 1. mediaKindOf maps stored kinds to the shared JobKind vocabulary.
  assert.equal(mediaKindOf("gallery-scene-video"), "video");
  assert.equal(mediaKindOf("sprite-animated-expressions"), "video");
  assert.equal(mediaKindOf("sprite-sheet"), "sprite");
  assert.equal(mediaKindOf("gallery-selfie"), "image");
  assert.equal(mediaKindOf("character-avatar"), "image");
  assert.equal(mediaKindOf("illustrator"), "illustration");
  assert.equal(mediaKindOf("tts"), "tts");
  assert.equal(mediaKindOf("something-else"), undefined);

  // 2. An interrupted job on disk is recovered with one info line.
  const staleId = randomUUID();
  const staleAt = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    join(jobsDir, `${staleId}.json`),
    JSON.stringify({
      id: staleId,
      kind: "gallery-image",
      label: "stale",
      chatId: "chat-b10",
      status: "running",
      createdAt: staleAt,
      updatedAt: staleAt,
      error: null,
      resultAvailable: false,
    }),
  );
  const jobs = createGenerationJobs({ dataDir: jobsDir, shutdownWaitMs: 50 });
  assert.equal(typeof (sampleWorkerGauges().mediaJobs as any)?.running, "number");

  // 3. Success, failure, timeout and cancel.
  const okId = randomUUID();
  await jobs.run({ id: okId, kind: "gallery-image", label: "ok", chatId: "chat-b10", timeoutMs: 5_000 }, async () => ({
    url: "x",
  }));
  const failId = randomUUID();
  await assert.rejects(
    jobs.run({ id: failId, kind: "sprite-sheet", label: "fail", chatId: "chat-b10", timeoutMs: 5_000 }, async () => {
      throw new Error("provider exploded");
    }),
  );
  const timeoutId = randomUUID();
  await assert.rejects(
    jobs.run(
      { id: timeoutId, kind: "gallery-scene-video", label: "slow", timeoutMs: 20 },
      () => new Promise(() => undefined),
    ),
  );
  const cancelId = randomUUID();
  const cancelled = jobs.run(
    { id: cancelId, kind: "tts", label: "cancel", timeoutMs: 5_000 },
    (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  );
  cancelled.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await jobs.cancel(cancelId), true);
  await assert.rejects(cancelled);

  // 4. Media queue: one settle line per request, host only.
  assert.equal(
    mediaConnectionKeyHost("image:https://user:pw@gpu.example.com:8188/prompt?key=abc"),
    "gpu.example.com:8188",
  );
  assert.equal(mediaConnectionKeyHost("conn-a"), "conn-a");
  await runMediaGenerationRequest({
    kind: "video",
    connectionKey: "video:https://api.example.org/v1?token=zzz",
    queue: true,
    task: async () => "done",
  });
  await assert.rejects(
    runMediaGenerationRequest({
      connectionKey: "image:https://api.example.org/v1",
      queue: false,
      task: async () => {
        throw new Error("queue task failed");
      },
    }),
  );

  // 5. pollProviderTask: accepted, progress per status change, completed; failure tags the error.
  let polls = 0;
  const value = await pollProviderTask<string>({
    provider: "testprov",
    taskId: "task-ok",
    intervalMs: 1,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    poll: async () => {
      polls += 1;
      return polls < 3 ? { providerStatus: "queued", done: false } : { providerStatus: "done", done: true, value: "v" };
    },
  });
  assert.equal(value, "v");
  const pollError = await pollProviderTask<string>({
    provider: "testprov",
    taskId: "task-bad",
    intervalMs: 1,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    poll: async (count) => {
      if (count > 1) throw new Error("task failed upstream");
      return { providerStatus: "running", done: false };
    },
  }).catch((error: unknown) => error as Record<string, unknown>);
  assert.equal(pollError.providerTaskId, "task-bad");
  assert.equal(pollError.lastProviderStatus, "running");
  const deadline = await pollProviderTask<string>({
    provider: "testprov",
    taskId: "task-slow",
    intervalMs: 5,
    deadlineMs: 1,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    poll: async () => ({ providerStatus: "running", done: false }),
  }).catch((error: unknown) => error as Error & Record<string, unknown>);
  assert.equal(deadline.name, "ProviderTaskTimeoutError");
  assert.equal(deadline.providerTaskId, "task-slow");

  // 6. Shape summaries never carry text.
  const shape = providerResponseShape({ choices: [], note: SECRET_PROMPT }, JSON.stringify({ note: SECRET_PROMPT }));
  assert.deepEqual(shape.topLevelKeys, ["choices", "note"]);
  assert.ok(!JSON.stringify(shape).includes(SECRET_PROMPT));

  await jobs.close();
  logger.flush?.();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const lines = mainLines();
  const raw = lines.map((line) => JSON.stringify(line)).join("\n");

  const jobLines = (id: string) => lines.filter((line) => line.event === "job.state" && line.jobId === id);
  const states = (id: string) => jobLines(id).map((line) => line.state);

  const recovered = jobLines(staleId);
  assert.deepEqual(states(staleId), ["recovered"]);
  assert.equal(recovered[0]!.level, 30);
  assert.equal(recovered[0]!.errorCode, "ME_CANCELLED");

  assert.deepEqual(states(okId), ["accepted", "running", "completed"]);
  const completed = jobLines(okId).at(-1)!;
  assert.equal(completed.outcome, "ok");
  assert.equal(completed.kind, "image");
  assert.equal(completed.jobKind, "gallery-image");
  assert.equal(completed.chatId, "chat-b10");
  assert.equal(typeof completed.resultBytes, "number");
  assert.equal(typeof completed.timeoutMs, "number");
  assert.equal(typeof completed.elapsedMs, "number");
  assert.equal(typeof completed.memory?.heapUsedMiB, "number");

  assert.deepEqual(states(failId), ["accepted", "running", "failed"]);
  const failed = jobLines(failId).at(-1)!;
  assert.equal(failed.level, 40);
  assert.equal(failed.kind, "sprite");
  assert.ok(failed.errorId && failed.diagnostic?.errorId === failed.errorId);
  assert.ok(failed.err, "the terminal failure line carries err");
  assert.equal(
    lines.filter((line) => line.msg === "Generation job failed" && line.event !== "job.state").length,
    0,
    "the separate 'Generation job failed' warn is gone",
  );
  assert.equal(
    lines.filter((line) => line.errorId === failed.errorId && line.level >= 40).length,
    1,
    "one full line per job failure",
  );

  const timedOut = jobLines(timeoutId).at(-1)!;
  assert.equal(timedOut.state, "failed");
  assert.equal(timedOut.errorCode, "ME_TIMEOUT");
  assert.equal(timedOut.kind, "video");

  const cancelLines = jobLines(cancelId);
  assert.equal(cancelLines.at(-1)!.state, "cancelled");
  assert.equal(cancelLines.at(-1)!.level, 30);
  assert.equal(cancelLines.filter((line) => line.state === "cancelled").length, 1);

  const queueLines = lines.filter((line) => line.event === "media.queue");
  assert.equal(queueLines.length, 2);
  const videoQueue = queueLines.find((line) => line.kind === "video")!;
  assert.equal(videoQueue.connectionKey, "api.example.org");
  assert.equal(videoQueue.outcome, "ok");
  assert.equal(videoQueue.operation, "video.queue");
  for (const key of ["waitMs", "runMs", "activePermits", "queuedWaiters"]) {
    assert.equal(typeof videoQueue[key], "number", key);
  }
  const failedQueue = queueLines.find((line) => line.outcome === "failed")!;
  assert.equal(failedQueue.operation, "image.queue");
  assert.ok(failedQueue.errorId);
  assert.equal(failedQueue.level, 20, "queue failures are debug; the caller owns the failure line");
  assert.ok(!raw.includes("token=zzz"), "no query string from a connection key");

  const progress = lines.filter((line) => line.event === "job.progress" && line.providerTaskId === "task-ok");
  assert.deepEqual(
    progress.map((line) => line.state),
    ["accepted", "progress", "progress", "completed"],
  );
  assert.equal(progress.find((line) => line.state === "progress")!.pollCount, 1);
  const badEnd = lines.find(
    (line) => line.event === "job.progress" && line.providerTaskId === "task-bad" && line.state === "failed",
  )!;
  assert.equal(badEnd.level, 40);
  assert.equal(badEnd.lastProviderStatus, "running");

  assert.ok(!raw.includes(SECRET_PROMPT), "no prompt text in the log");
  console.log("logging-b10 regression passed");
} finally {
  rmSync(logDir, { recursive: true, force: true });
  rmSync(jobsDir, { recursive: true, force: true });
}
