import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The generation route must admit a turn without awaiting a full continuity reconcile: the accepted
// assistant is enqueued synchronously (unchanged), while reconcileChat runs debounced off the request.
const dataDir = mkdtempSync(join(tmpdir(), "marinara-continuity-generation-path-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

let providerRequestCount = 0;
const provider = createServer(async (request, response) => {
  providerRequestCount += 1;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
  if (body.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "The hall falls silent." } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [
        {
          message: { content: JSON.stringify({ records: [], dispositions: [], findings: [] }) },
          finish_reason: "stop",
        },
      ],
    }),
  );
});

let app: {
  ready(): Promise<void>;
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<any>;
} & Record<string, any> = null as any;

try {
  const routeSource = readFileSync(
    new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    routeSource,
    /await app\.gameContinuity\.reconcileChat\(/u,
    "generate route never awaits a full continuity reconcile",
  );
  assert.match(
    routeSource,
    /continuityChanges\.notify\(input\.chatId\)/u,
    "generate route notifies the debounced reconciler",
  );
  assert.match(
    routeSource,
    /await app\.gameContinuity\s*\.enqueueCommittedTurn\(/u,
    "accepted turn is still enqueued synchronously",
  );

  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createConnectionsStorage } =
    await import("../../packages/server/src/services/storage/connections.storage.js");
  const db = await getDB();
  app = await buildApp();
  await app.ready();
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true, campaignMemory: true, campaignIndex: true }));
  const chats = createChatsStorage(db);
  const connections = createConnectionsStorage(db);
  const connection = await connections.create({
    name: "generation path fake",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "test",
    model: "fake",
    treatAsLocalEndpoint: true,
  } as any);
  const chat = await chats.create({ name: "continuity generation path", mode: "game", characterIds: [] } as any);
  await chats.update(chat.id, { connectionId: connection.id } as any);
  await chats.updateMetadata(chat.id, {
    gameSessionNumber: 1,
    gameNpcs: [],
    gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] },
    gameContinuity: { mode: "shadow", extractionInstructions: "x", verificationInstructions: "y" },
  } as any);
  await chats.createMessage({ chatId: chat.id, role: "user", content: "I promise to return." } as any);
  const accepted = await chats.createMessage({ chatId: chat.id, role: "assistant", content: "Acknowledged." } as any);

  // Instrument the runtime: reconcile is slow, so an awaited call would hold the request open.
  const RECONCILE_MS = 3000;
  const reconcileCalls: number[] = [];
  const runtime = app.gameContinuity;
  const realReconcile = runtime.reconcileChat.bind(runtime);
  runtime.reconcileChat = async (chatId: string) => {
    reconcileCalls.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, RECONCILE_MS));
    return realReconcile(chatId);
  };

  const started = Date.now();
  const response = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: { chatId: chat.id, userMessage: "Then I go.", connectionId: connection.id, streaming: true },
  });
  const finished = Date.now();
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.body, /The hall falls silent/u);
  assert.ok(
    reconcileCalls.length === 0 || finished < reconcileCalls[0]! + RECONCILE_MS - 500,
    `generation returned in ${finished - started}ms without awaiting reconcile`,
  );

  // The accept/enqueue semantics are unchanged: the accepted assistant already has a receipt.
  const receipts = await runtime.list(chat.id);
  assert.ok(
    receipts.some((receipt: any) => receipt.sources.some((source: any) => source.messageId === accepted.id)),
    "the accepted assistant turn was enqueued synchronously",
  );

  // The debounced reconcile still runs exactly once for the turn.
  const deadline = Date.now() + 5000;
  while (reconcileCalls.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(reconcileCalls.length, 1, "reconcile ran once, off the request path");
  assert.ok(reconcileCalls[0]! >= started, "reconcile was triggered by this turn");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(reconcileCalls.length, 1, "a single turn schedules a single reconcile");

  // A transient continuity storage/enqueue failure after the new user message is saved must not
  // reject the send. The finally notification lets reconciliation recover the same accepted row.
  const retryChat = await chats.create({ name: "continuity enqueue retry", mode: "game", characterIds: [] } as any);
  await chats.update(retryChat.id, { connectionId: connection.id } as any);
  await chats.updateMetadata(retryChat.id, {
    gameSessionNumber: 1,
    gameNpcs: [],
    gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] },
    gameContinuity: { mode: "shadow", extractionInstructions: "x", verificationInstructions: "y" },
  } as any);
  const retryAccepted = await chats.createMessage({
    chatId: retryChat.id,
    role: "assistant",
    content: "The road is clear.",
  } as any);
  await chats.updateMetadata(retryChat.id, {
    gameSessionNumber: 1,
    gameNpcs: [],
    gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] },
    gameContinuity: {
      mode: "shadow",
      activationMessageId: retryAccepted.id,
      extractionInstructions: "x",
      verificationInstructions: "y",
    },
  } as any);
  const enqueueCalls: string[] = [];
  const enqueue = runtime.enqueueCommittedTurn.bind(runtime);
  let failOnce = true;
  runtime.enqueueCommittedTurn = async (input: {
    chatId: string;
    assistantMessageId: string;
    sessionNumber?: number;
  }) => {
    enqueueCalls.push(input.assistantMessageId);
    if (failOnce) {
      failOnce = false;
      throw new Error("synthetic transient continuity storage failure");
    }
    return enqueue(input);
  };
  const notifiedChats: string[] = [];
  const notify = app.continuityChanges.notify.bind(app.continuityChanges);
  app.continuityChanges.notify = (chatId: string, ids?: Iterable<string>) => {
    notifiedChats.push(chatId);
    notify(chatId, ids);
  };
  const warningEvents: unknown[] = [];
  const warn = app.log.warn.bind(app.log);
  app.log.warn = ((fields: unknown, message?: string) => {
    if (message?.includes("immediate turn enqueue failed")) warningEvents.push(fields);
    return warn(fields as any, message);
  }) as any;
  const providerRequestsBeforeFailure = providerRequestCount;
  const retryResponse = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: retryChat.id,
      userMessage: "I will keep the lantern lit.",
      connectionId: connection.id,
      streaming: true,
    },
  });
  assert.equal(retryResponse.statusCode, 200, retryResponse.body);
  assert.match(retryResponse.body, /The hall falls silent/u, "normal generation proceeds after the memory failure");
  assert.ok(providerRequestCount > providerRequestsBeforeFailure, "the provider request still ran");
  assert.ok(
    (await chats.listMessages(retryChat.id)).some((message: any) => message.content === "I will keep the lantern lit."),
    "user input remains persisted",
  );
  assert.ok(notifiedChats.includes(retryChat.id), "the failed enqueue still schedules reconciliation");
  assert.equal(warningEvents.length, 1, "the continuity failure remains visible in the shared Pino log");
  assert.equal((warningEvents[0] as { err?: Error }).err?.message, "synthetic transient continuity storage failure");

  const recoveryDeadline = Date.now() + 5000;
  let recovered = [] as any[];
  while (Date.now() < recoveryDeadline) {
    recovered = await runtime.list(retryChat.id);
    if (recovered.some((receipt: any) => receipt.sources.some((source: any) => source.messageId === retryAccepted.id)))
      break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(
    enqueueCalls.filter((id) => id === retryAccepted.id).length,
    1,
    "reconciliation recovers from the saved source without re-entering the failed route enqueue",
  );
  const recoveredAcceptedReceipts = recovered.filter((receipt: any) =>
    receipt.sources.some((source: any) => source.messageId === retryAccepted.id),
  );
  assert.equal(recoveredAcceptedReceipts.length, 1, "recovery stores one receipt for the already-saved assistant");
  await runtime.reconcileChat(retryChat.id);
  const afterRecovery = await runtime.list(retryChat.id);
  assert.equal(
    afterRecovery.filter((receipt: any) => receipt.sources.some((source: any) => source.messageId === retryAccepted.id))
      .length,
    1,
    "a later reconcile does not duplicate the recovered receipt",
  );
  assert.equal(
    enqueueCalls.filter((id) => id === retryAccepted.id).length,
    1,
    "later recovery does not repeat the route enqueue",
  );

  console.log("game continuity generation path regression passed");
} finally {
  if (app) await app.close().catch(() => undefined);
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}
