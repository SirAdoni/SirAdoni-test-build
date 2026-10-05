import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

const root = mkdtempSync(join(tmpdir(), "marinara-continuity-structure-"));
const envKeys = ["DATA_DIR", "FILE_STORAGE_DIR", "MARINARA_BACKGROUND_CALLS_PER_HOUR"];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR = "off";

let closeDb: (() => Promise<void>) | undefined;
let closeServer: (() => Promise<void>) | undefined;
let resetBudget: ((limit: number | null) => void) | undefined;
let requestCount = 0;
let abortedResponseClosed = false;
let resolveAbortedResponseClosed!: () => void;
const abortedResponseClosedPromise = new Promise<void>((resolve) => {
  resolveAbortedResponseClosed = resolve;
});
const server = createServer((request, response) => {
  requestCount += 1;
  const ordinal = requestCount;
  if (ordinal === 1) {
    response.on("close", () => {
      if (!response.writableEnded) {
        abortedResponseClosed = true;
        resolveAbortedResponseClosed();
      }
    });
    request.resume();
    return;
  }
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: '{"movements":[],"relationships":[]}' }, finish_reason: "stop" }],
      }),
    );
  });
});

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, lorebookEntries, lorebooks, messages } =
    await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true, campaignMemory: true, campaignIndex: true }));
  const {
    backgroundCallBudgetSnapshot,
    consumeBackgroundCallOrThrow,
    resetBackgroundCallBudgetForTests,
    BACKGROUND_CALL_BUDGET_EXCEEDED,
  } = await import("../../packages/server/src/services/generation/background-call-budget.js");
  resetBudget = resetBackgroundCallBudgetForTests;
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { structurePublishedContinuity, CONTINUITY_STRUCTURE_VERSION } =
    await import("../../packages/server/src/services/game/continuity-structure.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closeServer = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      if (!server.listening) resolve();
      else server.close(() => resolve());
    });
  const port = (server.address() as AddressInfo).port;
  const db = await createFileNativeDB();
  closeDb = () => db._fileStore.close();
  const now = new Date().toISOString();
  const metadata = JSON.stringify({
    gameContinuity: {
      mode: "active",
      extractorConnectionId: "stub",
      stageTimeoutMs: { review: 180 },
    },
  });
  await db.insert(apiConnections).values({
    id: "stub",
    name: "Local structure stub",
    provider: "openai",
    model: "stub-model",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKeyEncrypted: "dummy-secret",
    maxContext: 8192,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(chats).values({
    id: "chat-1",
    name: "Structure timeout",
    mode: "game",
    connectionId: "stub",
    metadata,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(lorebooks).values({
    id: "book-1",
    name: "Continuity",
    chatId: "chat-1",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values({
    id: "message-1",
    chatId: "chat-1",
    role: "assistant",
    content: "Sera arrived at the library.",
    createdAt: now,
  });
  const config = await readContinuityConfig(db, "chat-1", { allowHistoricalBackfill: true });
  const source = prepareContinuitySources(
    [{ id: "message-1", chatId: "chat-1", role: "assistant", content: "Sera arrived at the library.", createdAt: now }] as never,
    { gameContinuity: { mode: "active" } } as never,
  )[0]!;
  const id = "gcb-structure-test";
  const record = {
    kind: "event" as const,
    text: "Sera arrived at the library.",
    subjects: ["Sera"],
    conditions: [],
    status: "completed" as const,
    knowledge: { scope: "world" as const, holders: [] },
    evidence: [{ messageId: "message-1", quote: "Sera arrived at the library." }],
    keys: ["arrived", "library"],
  };
  const receipt: GameContinuityReceipt = {
    id,
    chatId: "chat-1",
    sessionNumber: 1,
    sourceHash: "source-1",
    sources: [source],
    context: [],
    configHash: config.hash,
    config: config.frozen,
    status: "published",
    attempts: 1,
    repairAttempts: 0,
    records: [{ ...record, id: createGameContinuityRecordId(id, record) }],
    dispositions: [{ messageId: "message-1", status: "covered", reason: "Recorded." }],
    review: { findings: [], dispositions: [{ messageId: "message-1", status: "covered", reason: "Reviewed." }] },
    entryIds: ["entry-1"],
    createdAt: now,
    updatedAt: now,
  };
  await createGameContinuityStorage(db).save(receipt);
  await db.insert(lorebookEntries).values({
    id: "entry-1",
    lorebookId: "book-1",
    name: "Continuity receipt",
    content: "Sera arrived at the library.",
    keys: JSON.stringify(["Sera", "library"]),
    dynamicState: JSON.stringify({ receiptId: id, structure: { version: 0 } }),
    createdAt: now,
    updatedAt: now,
  });

  // The application invokes this pass from the background onPublished hook; exhaust that shared budget here.
  resetBackgroundCallBudgetForTests(1);
  consumeBackgroundCallOrThrow("test:occupy-budget");
  await assert.rejects(
    () => structurePublishedContinuity(db, "chat-1", { receiptIds: [id] }),
    (error: any) => error.code === BACKGROUND_CALL_BUDGET_EXCEEDED,
  );
  assert.equal(requestCount, 0, "budget exhaustion rejects before sending a provider request");

  resetBackgroundCallBudgetForTests(2);
  const timeoutStartedAt = Date.now();
  await assert.rejects(
    () => structurePublishedContinuity(db, "chat-1", { receiptIds: [id] }),
    (error: any) => error.code === "CONTINUITY_TIMEOUT",
  );
  assert.ok(Date.now() - timeoutStartedAt >= 150, "the configured review timeout bounds the structure request");
  assert.ok(Date.now() - timeoutStartedAt < 2000, "structure timeout uses the configured value, not the long default");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1000);
    abortedResponseClosedPromise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.equal(requestCount, 1, "the timed-out structure pass reached only the local provider stub");
  assert.equal(abortedResponseClosed, true, "timeout abort closes the in-flight provider response");

  const result = await structurePublishedContinuity(db, "chat-1", { receiptIds: [id] });
  assert.equal(result.calls, 1, "a subsequent local provider response completes the actual structure pass");
  assert.equal(requestCount, 2);
  assert.equal(backgroundCallBudgetSnapshot().bySource["continuity:structure"], 2);
  assert.equal(
    JSON.parse((await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, "entry-1")))[0]!.dynamicState)
      .structure.version,
    CONTINUITY_STRUCTURE_VERSION,
    "a valid response advances the receipt's structure marker",
  );
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(requestCount, 2, "settled calls do not leave a timer that triggers another provider request");
  console.log("game-continuity-structure regression passed");
} finally {
  resetBudget?.(null);
  try {
    await closeServer?.();
  } finally {
    try {
      await closeDb?.();
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}

assert.equal(server.listening, false, "the local provider stub is closed during cleanup");
assert.equal(existsSync(root), false, "the isolated database directory is removed during cleanup");
