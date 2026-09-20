import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Browser-disconnect proof (plan S17 / PF4). A real HTTP client starts the
// lightest route that commits continuity work (POST /:chatId/continuity/reconcile)
// and drops its socket while the handler is still running. The committed work
// must still reach a terminal verified/published receipt and the dependent
// session-summary refresh descriptor must still complete.
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-disconnect-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

const CHAT_ID = "disconnect";
const summary = {
  sessionNumber: 1,
  summary: "Original.",
  resumePoint: "At the gate.",
  partyDynamics: "Together.",
  partyState: "Ready.",
  keyDiscoveries: [],
  characterMoments: [],
  littleDetails: [],
  statsSnapshot: {},
  npcUpdates: [],
  nextSessionRequest: null,
  timestamp: "2026-09-13T00:00:00.000Z",
};

async function waitUntil(predicate: () => Promise<boolean> | boolean, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

let app: any = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages, lorebookEntries } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { buildSessionSummaryRefreshDescriptor } =
    await import("../../packages/server/src/services/game/session-summary-dependencies.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { createSessionSummaryRefreshService } =
    await import("../../packages/server/src/services/game/session-summary-refresh.js");
  const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");

  const db = await createFileNativeDB();
  const chatsStorage = createChatsStorage(db);
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 12, 0, 0, seconds)).toISOString();
  const metadata: Record<string, unknown> = {
    gameContinuity: {
      mode: "active",
      activationAt: at(0),
      extractionInstructions: "extract",
      verificationInstructions: "verify",
    },
  };
  await db.insert(apiConnections).values({ id: "conn", name: "Disconnect", provider: "custom", model: "test-model" });
  await db.insert(chats).values({
    id: CHAT_ID,
    name: CHAT_ID,
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify(metadata),
    createdAt: at(0),
    updatedAt: at(0),
  });
  // The assistant is accepted because a user follow-up was saved after it; that
  // follow-up is what a live turn commits before the browser could disconnect.
  await db.insert(messages).values([
    { id: "d-u1", chatId: CHAT_ID, role: "user", content: "I promise to return.", createdAt: at(1) },
    { id: "d-a1", chatId: CHAT_ID, role: "assistant", content: "Acknowledged.", createdAt: at(2) },
    { id: "d-u2", chatId: CHAT_ID, role: "user", content: "Onward.", createdAt: at(3) },
  ]);
  const turnMessages = (await chatsStorage.listMessages(CHAT_ID)).filter((message) => message.id !== "d-u2");
  const descriptor = buildSessionSummaryRefreshDescriptor({
    messages: turnMessages,
    metadata,
    sessionNumber: 1,
    summary,
    continuityRequired: true,
  });
  assert.equal(descriptor.status, "provisional");
  await chatsStorage.updateMetadata(CHAT_ID, {
    ...metadata,
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": descriptor },
  });

  const stageCalls: string[] = [];
  const publishedIds: string[] = [];
  app = Fastify({ forceCloseConnections: false });
  app.decorate("db", db);
  // Same accessor decoration as app.ts: gameRoutes assigns the service from its
  // encapsulated child context and the root must observe that assignment.
  let sessionSummaryRefresh: any = null;
  app.decorate("sessionSummaryRefresh", {
    getter: () => sessionSummaryRefresh,
    setter: (value: any) => {
      sessionSummaryRefresh = value;
    },
  });
  const runtime = createGameContinuityRuntime(db, {
    maxDrainMs: 1000,
    complete: async ({ stage, receipt }: { stage: "extract" | "review" | "repair"; receipt: any }) => {
      stageCalls.push(stage);
      // Deliberately slower than the socket teardown so the whole pipeline runs after the client is gone.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (stage === "extract") {
        const source = receipt.sources.find((item: any) => item.role.startsWith("user")) ?? receipt.sources[0];
        return {
          records: [
            {
              id: "model-id",
              kind: "promise",
              text: "Return promise",
              subjects: ["player"],
              conditions: [],
              status: "proposed",
              evidence: [{ messageId: source.messageId, quote: source.content.slice(0, 20) }],
              keys: ["return"],
            },
          ],
          dispositions: receipt.sources.map((item: any) => ({
            messageId: item.messageId,
            status: item.role.startsWith("user") ? "covered" : "no_durable_facts",
            reason: "source",
          })),
        };
      }
      return {
        findings: [],
        dispositions: receipt.sources.map((source: any) => ({
          messageId: source.messageId,
          status: source.role.startsWith("assistant") ? "no_durable_facts" : "covered",
          reason: "review",
        })),
      };
    },
    // Same wiring as app.ts: publication wakes the session-summary refresh.
    onPublished: (receipt: any) => {
      publishedIds.push(receipt.id);
      return app.sessionSummaryRefresh?.onDependencyChanged(receipt.chatId);
    },
  });
  // Gate the route's continuity call so the client socket can be destroyed
  // while the request handler is provably still in flight.
  let handlerEntered!: () => void;
  const entered = new Promise<void>((resolve) => (handlerEntered = resolve));
  let releaseHandler!: () => void;
  const gate = new Promise<void>((resolve) => (releaseHandler = resolve));
  let handlerFinished = false;
  const gatedRuntime = {
    ...runtime,
    async reconcileChat(chatId: string) {
      handlerEntered();
      await gate;
      const result = await runtime.reconcileChat(chatId);
      handlerFinished = true;
      return result;
    },
  };
  app.decorate("gameContinuity", gatedRuntime);
  await app.register(gameRoutes, { prefix: "/api/game" });
  await app.ready();
  // gameRoutes wires the live provider-backed refresh; replace it with a stub so no provider is called.
  await app.sessionSummaryRefresh.stop();
  let refreshCalls = 0;
  app.sessionSummaryRefresh = createSessionSummaryRefreshService(db, {
    generate: async ({ savedSummary }: { savedSummary: any }) => {
      refreshCalls += 1;
      return { ...savedSummary, summary: "Refreshed after disconnect." };
    },
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address === "object", "server must listen on an ephemeral port");
  const port = (address as { port: number }).port;

  const body = "{}";
  const request =
    `POST /api/game/${CHAT_ID}/continuity/reconcile HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Connection: keep-alive\r\n\r\n" +
    body;
  const socket = connect({ port, host: "127.0.0.1" });
  let responseBytes = 0;
  socket.on("data", (chunk) => {
    responseBytes += chunk.length;
  });
  socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(request);
  await entered;
  assert.equal(responseBytes, 0, "the handler is still in flight when the client disconnects");
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.destroy();
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handlerFinished, false, "the route work has not run yet when the socket is gone");
  releaseHandler();

  await waitUntil(() => handlerFinished, "the reconcile handler to finish after the disconnect");
  await waitUntil(async () => (await runtime.list(CHAT_ID)).some((receipt) => receipt.status === "published"), "publication");
  const receipts = await runtime.list(CHAT_ID);
  assert.equal(receipts.length, 1, "one committed turn was reconciled");
  assert.equal(receipts[0]!.status, "published");
  assert.equal(receipts[0]!.errorCode, undefined);
  assert.ok(receipts[0]!.sources.some((source) => source.messageId === "d-a1"));
  assert.deepEqual(stageCalls, ["extract", "review"], "the full pipeline ran once after the client left");
  // The durable publish commits before the onPublished callback runs; wait for the callback.
  await waitUntil(() => publishedIds.length > 0, "the onPublished callback after the disconnect");
  assert.deepEqual(publishedIds, [receipts[0]!.id]);
  assert.equal(
    (await db.select().from(lorebookEntries)).filter((row) => String(row.dynamicState ?? "").includes(receipts[0]!.id)).length,
    1,
    "the published receipt has exactly one lorebook entry",
  );
  const descriptorStatus = async () => {
    const chat = await chatsStorage.getById(CHAT_ID);
    return JSON.parse(String(chat?.metadata ?? "{}")).gameSessionSummaryRefreshes?.["1"]?.status as string | undefined;
  };
  await waitUntil(async () => (await descriptorStatus()) === "completed", "session summary refresh completion");
  assert.equal(refreshCalls, 1, "the dependent summary refresh ran exactly once");
  const meta = JSON.parse(String((await chatsStorage.getById(CHAT_ID))?.metadata ?? "{}"));
  assert.equal(meta.gamePreviousSessionSummaries[0].summary, "Refreshed after disconnect.");

  // A reconnecting client sees the durable outcome over the same route surface.
  const status = await app.inject({ method: "GET", url: `/api/game/${CHAT_ID}/continuity` });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json().counts, { published: 1 });
  assert.equal(status.json().batches[0].id, receipts[0]!.id);

  await app.sessionSummaryRefresh.stop();
  await runtime.stop();
  await app.close();
  app = null;
  await db._fileStore.close();
  console.log("game continuity disconnect regression passed");
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
