import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGenerationJobs,
  getGenerationJobs,
} from "../../packages/server/src/services/generation/generation-jobs.js";

const require = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = require("fastify");

const root = await mkdtemp(join(tmpdir(), "marinara-generation-jobs-"));
try {
  const jobs = createGenerationJobs({ dataDir: root });
  const value = await jobs.run({ kind: "regression", label: "persistence", timeoutMs: 1000 }, async () => ({
    ok: true,
  }));
  assert.deepEqual(value, { ok: true });
  const listed = await jobs.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "completed");
  assert.deepEqual(await jobs.result(listed[0].id), { ok: true });

  const second = createGenerationJobs({ dataDir: root });
  assert.equal((await second.get(listed[0].id))?.resultAvailable, true);
  let calls = 0;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = second.run({ kind: "regression", label: "cancel", timeoutMs: 1000 }, async (signal) => {
    calls++;
    started();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return "late";
  });
  const pendingErrorPromise = pending.catch((error) => error);
  await startedPromise;
  const running = (await second.list()).find((item) => item.status === "running");
  assert.ok(running);
  assert.equal(await second.cancel(running!.id), true);
  const pendingError = await pendingErrorPromise;
  assert.match(pendingError?.message ?? "", /cancel/i);
  assert.equal(calls, 1);
  assert.equal((await second.get(running!.id))?.status, "cancelled");

  const timeoutStart = Date.now();
  await assert.rejects(
    second.run(
      { kind: "regression", label: "timeout", timeoutMs: 20 },
      async () => new Promise<string>(() => undefined),
    ),
    /timed out|cancel/i,
  );
  assert.ok(Date.now() - timeoutStart < 500);

  const stale = "00000000-0000-4000-8000-000000000001";
  await writeFile(
    join(root, `${stale}.json`),
    JSON.stringify({
      id: stale,
      kind: "regression",
      label: "stale",
      chatId: null,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
      resultAvailable: false,
    }),
  );
  const reopened = createGenerationJobs({ dataDir: root });
  assert.equal((await reopened.get(stale))?.status, "interrupted");
  await assert.rejects(reopened.result("../../secrets"), /Invalid/);

  const shutdownRoot = await mkdtemp(join(tmpdir(), "marinara-generation-shutdown-"));
  try {
    const shutdownJobs = createGenerationJobs({ dataDir: shutdownRoot, shutdownWaitMs: 150 });
    let cooperativeStarted!: () => void;
    const cooperativeBegan = new Promise<void>((resolve) => {
      cooperativeStarted = resolve;
    });
    const cooperative = shutdownJobs.run(
      { kind: "regression", label: "cooperative shutdown", timeoutMs: 1000 },
      async (signal) => {
        cooperativeStarted();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => setTimeout(resolve, 100), { once: true }),
        );
        return "must-not-complete";
      },
    );
    const cooperativeError = cooperative.catch((error) => error);
    await cooperativeBegan;
    const cooperativeCloseStart = Date.now();
    await shutdownJobs.close();
    assert.ok(Date.now() - cooperativeCloseStart >= 80, "shutdown must await cooperative provider cleanup");
    assert.match((await cooperativeError)?.message ?? "", /shutdown|cancel/i);
    assert.equal(
      (await shutdownJobs.list()).find((item) => item.label === "cooperative shutdown")?.status,
      "interrupted",
    );

    const lateJobs = createGenerationJobs({ dataDir: shutdownRoot, shutdownWaitMs: 40 });
    let delayedStarted!: () => void;
    const delayedBegan = new Promise<void>((resolve) => {
      delayedStarted = resolve;
    });
    const delayed = lateJobs.run({ kind: "regression", label: "late shutdown", timeoutMs: 1000 }, async () => {
      delayedStarted();
      await new Promise((resolve) => setTimeout(resolve, 120));
      return "late";
    });
    const delayedError = delayed.catch((error) => error);
    await delayedBegan;
    const closeStart = Date.now();
    await lateJobs.close();
    assert.ok(Date.now() - closeStart >= 30, "shutdown must honor its bounded wait for abort-ignoring work");
    assert.ok(Date.now() - closeStart < 100, "shutdown must not wait indefinitely for an abort-ignoring job");
    assert.match((await delayedError)?.message ?? "", /shutdown|cancel/i);
    assert.equal((await lateJobs.list()).find((item) => item.label === "late shutdown")?.status, "interrupted");
  } finally {
    await rm(shutdownRoot, { recursive: true, force: true });
  }

  const app = Fastify();
  const sharedRoot = await mkdtemp(join(tmpdir(), "marinara-generation-shared-"));
  try {
    let producer!: ReturnType<typeof getGenerationJobs>;
    let observer!: ReturnType<typeof getGenerationJobs>;
    await app.register(async (instance) => {
      producer = getGenerationJobs(instance, { dataDir: sharedRoot });
    });
    await app.register(async (instance) => {
      observer = getGenerationJobs(instance, { dataDir: sharedRoot });
    });
    assert.strictEqual(producer, observer);
    let begin!: () => void;
    const began = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let socketClosed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      socketClosed = resolve;
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    app.post("/draft", async (_request, reply) => {
      reply.raw.once("close", socketClosed);
      try {
        return await producer.run(
          { kind: "avatar-draft", label: "Disconnected draft", timeoutMs: 3000 },
          async (signal) => {
            begin();
            await released;
            assert.equal(signal.aborted, false, "Closing the response must not abort provider work");
            return { image: "data:image/png;base64,cHJlc2VydmVk", applied: false };
          },
        );
      } finally {
        finish();
      }
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const client = httpRequest(`${address}/draft`, { method: "POST" });
    client.on("error", () => undefined);
    client.end();
    await began;
    client.destroy();
    await disconnected;
    release();
    await finished;
    const recovered = (await observer.list()).find((job) => job.label === "Disconnected draft");
    assert.equal(recovered?.status, "completed");
    assert.deepEqual(await observer.result(recovered!.id), {
      image: "data:image/png;base64,cHJlc2VydmVk",
      applied: false,
    });
  } finally {
    await app.close();
    await rm(sharedRoot, { recursive: true, force: true });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
