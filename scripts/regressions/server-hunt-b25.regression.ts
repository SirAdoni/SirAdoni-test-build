import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// Advanced Memory batch 25:
// 1. importMemory must not fail on an anchor-derived scaffold id that already exists locally.
// 2. put() must not reload the whole chat for every record written during preparation.
// 3. The open-scene prefix search must not re-estimate the transcript once per dropped message.
// 4. status() must not rescan and re-parse the whole chat for every record.

const directory = mkdtempSync(join(tmpdir(), "marinara-server-hunt-b25-"));
process.env.DATA_DIR = directory;
process.env.FILE_STORAGE_DIR = join(directory, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MARINARA_LITE = "true";

// Local stub only: embeddings for indexing; no paid provider is ever contacted.
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { input?: string | string[] };
  response.setHeader("Content-Type", "application/json");
  if (request.url?.endsWith("/embeddings")) {
    const input = Array.isArray(body.input) ? body.input : [body.input ?? ""];
    response.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0, 0.5] })) }));
    return;
  }
  response.statusCode = 500;
  response.end(JSON.stringify({ error: "unexpected completion request" }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;

const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createAdvancedMemoryService } = await import("../../packages/server/src/services/advanced-memory.js");
const { createConnectionSchema } = await import("../../packages/shared/src/schemas/connection.schema.ts");
const { DEFAULT_ADVANCED_MEMORY_SETTINGS } = await import("../../packages/shared/src/types/advanced-memory.ts");
const { messages: messagesTable } = await import("../../packages/server/src/db/schema/chats.ts");
const { advancedMemoryRecords } = await import("../../packages/server/src/db/schema/advanced-memory.ts");

const db = await createFileNativeDB();
let messageReads = 0;
const select = db.select.bind(db);
db.select = ((...args: unknown[]) => {
  const query = (select as (...args: unknown[]) => any)(...args);
  const from = query.from.bind(query);
  query.from = (table: unknown) => {
    if (table === messagesTable) messageReads++;
    return from(table);
  };
  return query;
}) as typeof db.select;

const chats = createChatsStorage(db);
const memory = createAdvancedMemoryService(db);
try {
  const connection = await createConnectionsStorage(db).create(
    createConnectionSchema.parse({
      name: "Batch 25 stub",
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl,
      apiKey: "test-key",
      maxContext: 4096,
      embeddingBaseUrl: baseUrl,
      embeddingModel: "stub",
      treatAsLocalEndpoint: true,
    }),
  );
  const chat = await chats.create({ name: "b25", mode: "roleplay", characterIds: [], connectionId: connection!.id });
  assert(chat);
  await chats.patchMetadata(chat.id, {
    advancedMemory: { ...DEFAULT_ADVANCED_MEMORY_SETTINGS, enabled: true, maxContextTokens: 4096 },
  });
  const count = 90;
  await chats.createMessagesBatch(
    chat.id,
    Array.from({ length: count }, (_, index) => ({
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      content: `Message ${index}: the lantern road continues.`,
    })),
  );

  // Finding 2: one open scene, one scaffold plus 30 excerpts (each also re-put after embedding).
  messageReads = 0;
  await memory.initialize(chat.id, { detectScenes: false });
  assert.equal((await memory.status(chat.id)).job.status, "ready");
  assert(
    messageReads <= 12,
    `preparation reloads the chat per scene, not per record (message table reads: ${messageReads})`,
  );

  // Finding 4: a status poll parses each message's extra a bounded number of times, not once per record.
  const status = await memory.status(chat.id);
  assert(status.records.length >= 30, "the archive holds one record per excerpt");
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parses++;
    return parse(...args);
  }) as typeof JSON.parse;
  try {
    await memory.status(chat.id);
  } finally {
    JSON.parse = parse;
  }
  assert(
    parses < status.records.length * count,
    `status() does not reparse the chat for every record (${parses} parses for ${status.records.length} records)`,
  );
  assert(
    status.records.every((record) => record.embeddingStatus !== "stale"),
    "memoized validation still reports fresh records as valid",
  );

  // Finding 1: export, let the open scene grow, then import the older export back.
  const exported = await memory.exportMemory(chat.id);
  await chats.createMessagesBatch(chat.id, [
    { role: "user" as const, content: "Message 90: the lantern road bends." },
    { role: "assistant" as const, content: "Message 91: the lantern road ends." },
  ]);
  await memory.initialize(chat.id, { detectScenes: false });
  const scaffold = (await memory.status(chat.id)).records.find(
    (record) => record.kind === "scene" && record.id === record.sceneId,
  );
  assert(scaffold, "the open scene keeps a scaffold");
  const beforeRows = (await db.select().from(advancedMemoryRecords)).length;
  const result = await memory.importMemory(chat.id, exported);
  assert.equal(typeof result.imported, "number", "importing an older export into a grown scene succeeds");
  const scaffoldRows = (await db.select().from(advancedMemoryRecords)).filter((row) => row.id === scaffold.id);
  assert.equal(scaffoldRows.length, 1, "the local scaffold is kept and not duplicated");
  assert.equal(JSON.parse(String(scaffoldRows[0]!.messageIds)).length, count + 2, "local coverage is preserved");
  assert((await db.select().from(advancedMemoryRecords)).length >= beforeRows);

  // Finding 3: source check that the prefix search is logarithmic, not a linear walk.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../packages/server/src/services/advanced-memory.ts"), "utf8");
  assert(!/prefixLength\+\+/.test(source), "the temporary prefix is not found by a one-message-at-a-time walk");
  assert(
    /const middle = (?:\(low \+ high\) >>> 1|Math\.floor\(\(prefixLength \+ upper\) \/ 2\));/.test(source),
    "the temporary prefix uses a binary search",
  );

  console.log("server-hunt-b25 regression passed");
} finally {
  server.close();
  rmSync(directory, { recursive: true, force: true });
}
