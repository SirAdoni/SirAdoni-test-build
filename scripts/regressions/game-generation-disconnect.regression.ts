import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-generation-disconnect-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
let app: any;
let provider: any;
try {
  const startedWaiters: Array<() => void> = [];
  const releaseWaiters: Array<() => void> = [];
  let providerReleased = false;
  const waitForProvider = () => new Promise<void>((resolve) => releaseWaiters.push(resolve));
  const waitProviderStarted = () => new Promise<void>((resolve) => startedWaiters.push(resolve));
  provider = createServer(async (_request, response) => {
    startedWaiters.shift()?.();
    await waitForProvider();
    providerReleased = true;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ publicScene: [{ beat: 0, text: "The server completed after disconnect.", perceivedBy: [] }], actorRequests: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress === "object");

  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
  const db = await getDB();
  const chats = createChatsStorage(db);
  const connection = await createConnectionsStorage(db).create({ name: "disconnect fake", provider: "custom", baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`, apiKey: "test", model: "fake", fallbackForMain: true, treatAsLocalEndpoint: true } as any);
  app = await buildApp();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });

  const createChat = async (name: string) => {
    const chat = await chats.create({ name, mode: "game", characterIds: [] } as any);
    await chats.updateMetadata(chat.id, { gameNpcKnowledgeMode: "isolated", gameNpcs: [], gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] } } as any);
    await chats.createMessage({ chatId: chat.id, role: "user", content: "I enter." } as any);
    return chat;
  };
  const postGenerate = (chatId: string) => {
    const chunks: Buffer[] = [];
    const req = httpRequest(`${address}/api/generate`, { method: "POST", headers: { "content-type": "application/json" } });
    const done = new Promise<string>((resolve, reject) => {
      req.on("response", (res) => { res.on("data", (chunk) => chunks.push(Buffer.from(chunk))); res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); });
      req.on("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); });
    });
    req.end(JSON.stringify({ chatId, userMessage: "I enter.", connectionId: connection.id, streaming: true }));
    return { req, done };
  };

  const disconnectedChat = await createChat("disconnect");
  const firstProviderStarted = waitProviderStarted();
  const first = postGenerate(disconnectedChat.id);
  await firstProviderStarted;
  first.req.destroy();
  void first.done.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 40));
  releaseWaiters.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const disconnectedMessages = await chats.listMessages(disconnectedChat.id);
  assert.equal(providerReleased, true);
  const recoveredStatus = await (await fetch(`${address}/api/generate/status/${disconnectedChat.id}`)).json() as { active: boolean };
  assert.equal(recoveredStatus.active, false, "reconnect status must report the accepted generation complete");
  assert.equal(disconnectedMessages.filter((message: any) => message.role === "assistant").length, 1, "disconnect must not abort accepted generation");
  assert.match(disconnectedMessages.find((message: any) => message.role === "assistant")?.content ?? "", /completed after disconnect/u);

  const cancelledChat = await createChat("cancel");
  const secondProviderStarted = waitProviderStarted();
  let cancelRequest!: any;
  const cancelled = new Promise<void>((resolve, reject) => {
    cancelRequest = httpRequest(`${address}/api/generate`, { method: "POST", headers: { "content-type": "application/json" } });
    cancelRequest.on("response", (res: any) => { res.resume(); res.on("end", resolve); });
    cancelRequest.on("error", (error: Error) => reject(error));
    cancelRequest.end(JSON.stringify({ chatId: cancelledChat.id, userMessage: "I enter.", connectionId: connection.id, streaming: true }));
  });
  await secondProviderStarted;
  const abort = await fetch(`${address}/api/generate/abort`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: cancelledChat.id }) });
  assert.equal(abort.status, 200);
  releaseWaiters.shift()?.();
  await cancelled;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await chats.listMessages(cancelledChat.id)).filter((message: any) => message.role === "assistant").length, 0, "explicit abort must not falsely complete");
  await app.close(); app = null;
  await new Promise<void>((resolve) => provider.close(() => resolve())); provider = null;
  console.log("game-generation-disconnect regression passed");
} finally {
  if (app) await app.close().catch(() => {});
  if (provider) await new Promise<void>((resolve) => provider.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
