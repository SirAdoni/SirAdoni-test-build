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

const provider = createServer(async (request, response) => {
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
  response.end(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }));
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

  console.log("game continuity generation path regression passed");
} finally {
  if (app) await app.close().catch(() => undefined);
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}
