import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-backfill-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
// Pin the worker budget: the Engine loads .env through dotenv when server modules are imported, so an
// installation tuned for a large archive must not change what these fixtures measure.
process.env.CONTINUITY_MAX_CONCURRENT = "2";
process.env.CONTINUITY_BACKFILL_CONCURRENCY = "1";
process.env.CONTINUITY_BACKFILL_TURNS_PER_RECEIPT = "1";

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { gameContinuityBackfillRoutes } =
    await import("../../packages/server/src/routes/game-continuity-backfill.routes.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  const chatId = "backfill-regression-chat";
  await db.insert(apiConnections).values({
    id: "backfill-regression-connection",
    name: "Backfill regression connection",
    provider: "openai",
    model: "fake-model",
    defaultForAgents: "true",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(chats).values({
    id: chatId,
    name: "Backfill regression",
    mode: "game",
    connectionId: "backfill-regression-connection",
    metadata: JSON.stringify({ gameContinuity: { mode: "off" } }),
    createdAt: now,
    updatedAt: now,
  });
  const messageTime = (offset: number) => new Date(Date.parse(now) + offset * 1000).toISOString();
  await db.insert(messages).values([
    { id: "bf-user-1", chatId, role: "user", content: "Alice opens the sealed gate.", createdAt: messageTime(1) },
    {
      id: "bf-assistant-1",
      chatId,
      role: "assistant",
      content: "The gate opens for Alice.",
      createdAt: messageTime(2),
    },
    { id: "bf-user-2", chatId, role: "user", content: "Alice enters the archive.", createdAt: messageTime(3) },
    {
      id: "bf-assistant-2",
      chatId,
      role: "assistant",
      content: "The archive contains a map.",
      createdAt: messageTime(4),
    },
    { id: "bf-user-3", chatId, role: "user", content: "Alice leaves the archive.", createdAt: messageTime(5) },
    { id: "bf-assistant-3", chatId, role: "assistant", content: "The archive door closes.", createdAt: messageTime(6) },
    { id: "bf-user-4", chatId, role: "user", content: "Alice returns home.", createdAt: messageTime(7) },
    { id: "bf-user-5", chatId, role: "user", content: "Alice records the route home.", createdAt: messageTime(8) },
    { id: "bf-assistant-4", chatId, role: "assistant", content: "The route is recorded.", createdAt: messageTime(9) },
    { id: "bf-user-6", chatId, role: "user", content: "Alice checks the record.", createdAt: messageTime(10) },
    { id: "bf-excluded", chatId, role: "assistant", content: "Derived recap.", extra: JSON.stringify({ hiddenFromAI: true }), createdAt: messageTime(11) },
    { id: "bf-after-excluded", chatId, role: "user", content: "Continue.", createdAt: messageTime(12) },
  ]);

  let allowUnresolved = true;
  const complete = async ({
    stage,
    receipt,
  }: {
    stage: string;
    receipt: { sources: Array<{ messageId: string; content: string }> };
  }) => {
    const source = receipt.sources.find((item) => item.messageId.startsWith("bf-user-")) ?? receipt.sources[0]!;
    if (source.messageId === "bf-user-3" && allowUnresolved) {
      return stage === "extract" || stage === "repair"
        ? {
            records: [],
            dispositions: receipt.sources.map((item) => ({
              messageId: item.messageId,
              status: "unresolved",
              reason: "regression unresolved",
            })),
          }
        : {
            findings: [],
            dispositions: receipt.sources.map((item) => ({
              messageId: item.messageId,
              status: "unresolved",
              reason: "regression unresolved",
            })),
          };
    }
    return stage === "extract" || stage === "repair"
      ? {
          records: [
            {
              id: "backfill-record",
              kind: "event",
              text: "Alice opened the sealed gate.",
              subjects: [],
              conditions: [],
              status: "asserted",
              evidence: receipt.sources.map((item) => ({ messageId: item.messageId, quote: item.content })),
              keys: ["sealed gate"],
            },
          ],
          dispositions: receipt.sources.map((item) => ({
            messageId: item.messageId,
            status: "covered",
            reason: "recorded",
          })),
        }
      : {
          findings: [],
          dispositions: receipt.sources.map((item) => ({
            messageId: item.messageId,
            status: "covered",
            reason: "verified",
          })),
        };
  };

  const runtime = createGameContinuityRuntime(db, { complete: complete as never });
  const app = Fastify();
  app.decorate("db", db);
  app.decorate("gameContinuity", runtime);
  await app.register(gameContinuityBackfillRoutes, { prefix: "/api/game" });

  const start = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill`,
    payload: { fromMessageId: "bf-assistant-1", toMessageId: "bf-assistant-2" },
  });
  assert.equal(start.statusCode, 200, start.body);
  const started = start.json();
  assert.equal(started.acceptedTurns, 2);
  const backfillId = started.backfillId;

  const replay = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill`,
    payload: { fromMessageId: "bf-assistant-1", toMessageId: "bf-assistant-2" },
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(
    replay.json().receipts.map((receipt: { id: string }) => receipt.id),
    started.receipts.map((receipt: { id: string }) => receipt.id),
    "replaying the same range reuses deterministic receipt IDs",
  );

  const storage = createGameContinuityStorage(db);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipts = await storage.list(chatId);
    if (
      receipts.length > 0 &&
      receipts.every((receipt) => ["verified", "unresolved", "failed"].includes(receipt.status))
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const receipts = await storage.list(chatId);
  assert.equal(receipts.length, 2, "two accepted turns produce two durable receipts");
  assert.ok(
    receipts.every((receipt) => receipt.id.startsWith("gch_")),
    "historical receipts cannot collide with live gcb receipts",
  );
  assert.ok(receipts.every((receipt) => receipt.config.historicalBackfill?.id === backfillId));
  assert.equal(
    JSON.parse((await db.select().from(chats)).find((chat) => chat.id === chatId)!.metadata).gameContinuity.mode,
    "off",
  );
  assert.ok(
    receipts.every((receipt) => receipt.status === "verified"),
    JSON.stringify(receipts),
  );

  const status = await app.inject({ method: "GET", url: `/api/game/${chatId}/continuity/backfill/${backfillId}` });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().counts.verified, 2);

  const activeMetadata = JSON.parse((await db.select().from(chats)).find((chat) => chat.id === chatId)!.metadata);
  activeMetadata.gameContinuity = { mode: "active" };
  await db
    .update(chats)
    .set({ metadata: JSON.stringify(activeMetadata) })
    .where(eq(chats.id, chatId));
  await runtime.resumeChat(chatId);
  assert.equal(
    (await storage.list(chatId)).filter((receipt) => receipt.status === "verified").length,
    2,
    "historical verified receipts do not auto-publish in active mode",
  );

  const staleStart = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill`,
    payload: { fromMessageId: "bf-assistant-4", toMessageId: "bf-assistant-4" },
  });
  assert.equal(staleStart.statusCode, 200, staleStart.body);
  const staleId = staleStart.json().backfillId;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const staleReceipt = (await storage.list(chatId)).find(
      (receipt) => receipt.config.historicalBackfill?.id === staleId,
    );
    if (staleReceipt && staleReceipt.status === "verified") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    (await storage.list(chatId)).find((receipt) => receipt.config.historicalBackfill?.id === staleId)?.status,
    "verified",
    JSON.stringify(await storage.list(chatId)),
  );
  await db.update(messages).set({ content: "Alice records a different route." }).where(eq(messages.id, "bf-user-5"));
  const staleStatus = await app.inject({
    method: "GET",
    url: `/api/game/${chatId}/continuity/backfill/${staleId}`,
  });
  assert.equal(staleStatus.statusCode, 200, staleStatus.body);
  assert.equal(staleStatus.json().counts.verified, 1, staleStatus.body);
  const stale = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill/${staleId}/publish`,
    payload: { confirm: true },
  });
  assert.ok([200, 400].includes(stale.statusCode), stale.body);
  if (stale.statusCode === 200) assert.deepEqual(stale.json().published, []);
  assert.notEqual(
    (await storage.list(chatId)).find((r) => r.config.historicalBackfill?.id === staleId)?.status,
    "published",
    "changed sources never publish, whether detected by the worker or the publication check",
  );
  await db.update(messages).set({ content: "Alice records the route home." }).where(eq(messages.id, "bf-user-5"));

  const unauthorized = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill/${backfillId}/publish`,
    payload: {},
  });
  assert.equal(unauthorized.statusCode, 400);
  const excludedRange = await app.inject({
    method: "POST", url: `/api/game/${chatId}/continuity/backfill`,
    payload: { fromMessageId: "bf-excluded", toMessageId: "bf-excluded" },
  });
  assert.equal(excludedRange.statusCode, 200, excludedRange.body);
  assert.equal(excludedRange.json().acceptedTurns, 0);
  assert.deepEqual(excludedRange.json().receipts, []);
  const overlap = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill`,
    payload: { fromMessageId: "bf-assistant-1", toMessageId: "bf-assistant-1" },
  });
  assert.equal(overlap.statusCode, 200, overlap.body);
  assert.equal(overlap.json().receipts[0].id, started.receipts[0].id);
  const overlapPublish = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill/${overlap.json().backfillId}/publish`,
    payload: { confirm: true },
  });
  assert.equal(overlapPublish.statusCode, 200, overlapPublish.body);
  assert.equal(
    overlapPublish.json().published.length,
    1,
    "overlap membership authorizes the reused historical receipt",
  );
  const published = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill/${backfillId}/publish`,
    payload: { confirm: true },
  });
  assert.equal(published.statusCode, 200, published.body);
  assert.equal((await storage.list(chatId)).filter((receipt) => receipt.status === "published").length, 2);
  const beforeReplay = await storage.get(started.receipts[0].id);
  const projectionReplay = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill/${backfillId}/publish`,
    payload: { confirm: true, repairPublished: true },
  });
  assert.equal(projectionReplay.statusCode, 200, projectionReplay.body);
  assert.equal(projectionReplay.json().published.length, 2);
  assert.deepEqual(await storage.get(started.receipts[0].id), beforeReplay, "projection repair preserves published history");

  const unresolvedStart = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill`,
    payload: { fromMessageId: "bf-assistant-3", toMessageId: "bf-assistant-3" },
  });
  assert.equal(unresolvedStart.statusCode, 200, unresolvedStart.body);
  const unresolvedId = unresolvedStart.json().backfillId;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const unresolved = (await storage.list(chatId)).find(
      (receipt) => receipt.config.historicalBackfill?.id === unresolvedId,
    );
    if (unresolved && ["unresolved", "failed"].includes(unresolved.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const unresolvedBefore = (await storage.list(chatId)).find(
    (receipt) => receipt.config.historicalBackfill?.id === unresolvedId,
  )!;
  assert.ok(["unresolved", "failed"].includes(unresolvedBefore.status));
  const unresolvedPublish = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/continuity/backfill/${unresolvedId}/publish`,
    payload: { confirm: true },
  });
  assert.equal(unresolvedPublish.statusCode, 200);
  assert.deepEqual(
    unresolvedPublish.json().published,
    [],
    "nonverified receipts are skipped without blocking other reviewed work",
  );
  assert.ok(
    ["unresolved", "failed"].includes(
      (await storage.list(chatId)).find((receipt) => receipt.id === unresolvedBefore.id)!.status,
    ),
    "unresolved receipts are never published",
  );

  allowUnresolved = false;
  await runtime.stop();
  await storage.save({
    ...unresolvedBefore,
    status: "queued",
    attempts: 0,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    errorCode: undefined,
    error: undefined,
    updatedAt: new Date().toISOString(),
  });
  const resumedRuntime = createGameContinuityRuntime(db, { complete: complete as never });
  await resumedRuntime.start();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const resumed = (await storage.list(chatId)).find((receipt) => receipt.id === unresolvedBefore.id);
    if (resumed?.status === "verified") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    (await storage.get(unresolvedBefore.id))?.status,
    "verified",
    "queued historical work resumes after runtime restart",
  );

  await resumedRuntime.stop();
  await app.close();
  await db._fileStore.close();
  console.log(
    "game continuity backfill regression passed: bounded route, off-mode preservation, overlap idempotency, explicit publication, and durable receipts",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
