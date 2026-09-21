import {
  OpenAIChatGPTProvider,
  resolveOpenAIChatGPTCacheSession,
} from "../../packages/server/src/services/llm/providers/openai-chatgpt.provider.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { fitMessagesToContext, type ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";
import { OpenAIProvider } from "../../packages/server/src/services/llm/providers/openai.provider.js";
import {
  mergeAdjacentMessages,
  squashLeadingSystemMessages,
} from "../../packages/server/src/services/prompt/merger.js";
import {
  buildFullLorebookContext,
  processLorebooks,
  scopeLorebookScanResultToCharacterContext,
} from "../../packages/server/src/services/lorebook/index.js";

const previousStorageDir = process.env.FILE_STORAGE_DIR;
const storageDir = mkdtempSync(join(tmpdir(), "marinara-full-lore-"));
process.env.FILE_STORAGE_DIR = storageDir;
const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
const db = await createFileNativeDB();
try {
  const store = createLorebooksStorage(db);
  const book = await store.create({ name: "Active", isGlobal: true, tokenBudget: 1 } as any);
  const otherBook = await store.create({ name: "Other chat", chatId: "elsewhere" } as any);
  const disabledBook = await store.create({ name: "Disabled", isGlobal: true, enabled: false } as any);
  const folder = await store.createFolder(book.id, { name: "Disabled folder", enabled: false } as any);
  const first = await store.createEntry({
    lorebookId: book.id,
    name: "First",
    content: "<canon>First & unchanged.</canon>",
    keys: ["never-mentioned"],
    probability: 0,
    order: 20,
  } as any);
  const depth = await store.createEntry({
    lorebookId: book.id,
    name: "Depth",
    content: "Depth lore is always present.",
    position: 2,
    depth: 3,
    order: 10,
    ephemeral: 1,
  } as any);
  await store.createEntry({ lorebookId: book.id, name: "Disabled", content: "EXCLUDED_ENTRY", enabled: false } as any);
  await store.createEntry({
    lorebookId: book.id,
    name: "Disabled folder child",
    content: "EXCLUDED_FOLDER",
    folderId: folder.id,
  } as any);
  await store.createEntry({ lorebookId: otherBook.id, name: "Other", content: "EXCLUDED_CHAT" } as any);
  await store.createEntry({ lorebookId: disabledBook.id, name: "Other", content: "EXCLUDED_BOOK" } as any);
  const overridden = await store.createEntry({
    lorebookId: book.id,
    name: "Override",
    content: "EXCLUDED_OVERRIDE",
  } as any);
  await store.createEntry({
    lorebookId: book.id,
    name: "Another character",
    content: "EXCLUDED_CHARACTER",
    characterFilterMode: "include",
    characterFilterIds: ["other-character"],
  } as any);
  const scanOptions = {
    chatId: "test-chat",
    characterIds: [],
    fullContext: true,
    tokenBudget: 1,
    entryStateOverrides: { [overridden.id]: { enabled: false } },
  };
  const before = await processLorebooks(db, [{ role: "user", content: "Weather: sunny" }], null, scanOptions);
  const after = await processLorebooks(
    db,
    [
      { role: "user", content: "Weather: rainy" },
      { role: "assistant", content: "A new scene." },
    ],
    null,
    scanOptions,
  );
  assert.equal(before.fullContext, "Depth lore is always present.\n\n<canon>First & unchanged.</canon>");
  assert.equal(before.stableFullContext, before.fullContext);
  assert.equal(before.dynamicFullContext, "");
  assert.equal(after.fullContext, before.fullContext, "turn changes cannot reshuffle or deactivate full lore");
  assert.deepEqual(before.activatedEntryIds, [depth.id, first.id]);
  assert.deepEqual(before.depthEntries, [], "depth lore is included once in the stable prefix");
  assert.equal(before.worldInfoBefore, "");
  assert.equal(before.updatedEntryStateOverrides, undefined, "full lore does not consume ephemeral counters");
  assert.equal(before.updatedEntryTimingStates, undefined);
  const legacy = await processLorebooks(db, [], null, { ...scanOptions, fullContext: false, previewOnly: true });
  assert.equal(legacy.fullContext, undefined, "selective mode remains available");
  const shuffled = buildFullLorebookContext([first, depth] as any);
  assert.equal(shuffled.fullContext, before.fullContext, "storage enumeration order cannot change the prefix");
  const edited = buildFullLorebookContext([{ ...first, content: "Edited canon" }, depth] as any);
  assert.notEqual(
    edited.fullContext,
    before.fullContext,
    "edits are sent immediately, never served from stale local text",
  );
  const scoped = scopeLorebookScanResultToCharacterContext(before, [first, depth] as any, { characterId: "c1" });
  assert.equal(scoped.fullContext, before.fullContext);
  assert.equal(
    scoped.worldInfoBefore,
    "",
    "character scoping must not duplicate full lore into dynamic system content",
  );

  let dynamicValue = 0;
  let committed = 0;
  const dynamicEntries = [
    { ...first, content: "Static canon" },
    { ...depth, id: `${depth.id}-dynamic`, content: "Turn {{time}} value" },
    { ...depth, id: `${depth.id}-state`, content: "State {{getvar::weather}}" },
  ];
  const dynamicScan = buildFullLorebookContext(dynamicEntries as any, (value) => ({
    content: value.replace(/\{\{time\}\}/g, `T${++dynamicValue}`),
    commit: () => {
      committed++;
    },
    rollback: () => undefined,
  }));
  assert.equal(dynamicScan.fullContext, "Turn T1 value\n\nState {{getvar::weather}}\n\nStatic canon");
  assert.equal(dynamicScan.stableFullContext, "Static canon");
  assert.equal(dynamicScan.dynamicFullContext, "Turn T1 value\n\nState {{getvar::weather}}");
  assert.equal(committed, dynamicEntries.length, "each entry transaction commits exactly once");
  const dynamicScoped = scopeLorebookScanResultToCharacterContext(dynamicScan, dynamicEntries as any, {
    characterId: "c1",
  });
  assert.equal(dynamicScoped.fullContext, dynamicScan.fullContext);
  assert.equal(dynamicScoped.stableFullContext, dynamicScan.stableFullContext);
  assert.equal(dynamicScoped.dynamicFullContext, dynamicScan.dynamicFullContext);

  const lore: ChatMessage = {
    role: "system",
    content: "Full lore. ".repeat(400),
    contextKind: "prompt",
    providerMetadata: { marinaraFullLoreContext: true, marinaraCacheScope: "full-lore-regression-chat" },
  };
  const oldHistory: ChatMessage = { role: "user", content: "Old conversation. ".repeat(500), contextKind: "history" };
  const latest: ChatMessage = { role: "user", content: "Continue the scene.", contextKind: "history" };
  const adjacent = [lore, { role: "system" as const, content: "Changing state" }, latest];
  assert.equal(mergeAdjacentMessages(adjacent as any)[0]?.content, lore.content);
  assert.equal(squashLeadingSystemMessages(adjacent as any)[0]?.content, lore.content);
  const fitted = fitMessagesToContext([lore, oldHistory, latest], { maxContext: 4096, maxTokens: 256 });
  assert.equal(fitted.messages[0]?.content, lore.content);
  assert.ok(fitted.trimmed);
  assert.throws(() => fitMessagesToContext([lore, latest], { maxContext: 512, maxTokens: 64 }), /Full lore exceeds/);
  const dynamicLore: ChatMessage = {
    role: "system",
    content: "Dynamic lore. ".repeat(400),
    contextKind: "injection",
    providerMetadata: { marinaraDynamicLoreContext: true },
  };
  assert.throws(
    () => fitMessagesToContext([dynamicLore, latest], { maxContext: 512, maxTokens: 64 }),
    /Full lore exceeds/,
    "freshly resolved dynamic lore must remain protected from context fitting",
  );
  assert.equal(dynamicLore.content, "Dynamic lore. ".repeat(400));
  assert.throws(
    () =>
      fitMessagesToContext([lore, { role: "system", content: "Required GM rules. ".repeat(800) }, latest], {
        maxContext: 4096,
        maxTokens: 256,
      }),
    /Full lore exceeds/,
    "fitting full lore must not sacrifice GM rules or the latest player input",
  );
  assert.equal(lore.content, "Full lore. ".repeat(400), "context fitting cannot mutate the source");

  const requests: any[] = [];
  const requestHeaders: Record<string, string>[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    requestHeaders.push(
      Object.fromEntries(
        Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
    );
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output_text":"OK","usage":{"input_tokens":2000,"output_tokens":1,"input_tokens_details":{"cached_tokens":1500}}}}\n\n',
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const provider = new OpenAIProvider(
      `http://127.0.0.1:${address.port}/v1`,
      "test",
      undefined,
      undefined,
      undefined,
      "openai-chatgpt",
    );
    for (const state of ["Sunny", "Rainy"]) {
      const result = await provider.chatComplete(
        [lore, { role: "system", content: `GM rules. Current weather: ${state}` }, latest],
        { model: "gpt-5.6-sol" },
      );
      assert.equal(result.usage?.cachedPromptTokens, 1500);
    }
    assert.equal(requests[0].instructions, lore.content);
    assert.equal(requests[1].instructions, requests[0].instructions);
    assert.equal(requests[0].prompt_cache_key, requests[1].prompt_cache_key);
    assert.match(requests[1].input[0].content, /Rainy/);
    assert.equal(requests[1].input[0].role, "system");
    assert.equal(requests[0].prompt_cache_options, undefined, "unsupported cache fields must not reach ChatGPT");
    assert.equal(requests[0].store, false);
    const editedLore = { ...lore, content: "Edited full lore" };
    await provider.chatComplete([editedLore, latest], { model: "gpt-5.6-sol" });
    assert.equal(requests[2].instructions, editedLore.content, "edited lore is sent in the actual request");
    assert.equal(requests[2].prompt_cache_key, requests[0].prompt_cache_key, "scope keeps routing stable after edits");
    await provider.chatComplete([{ role: "system", content: "Original instructions" }, latest], {
      model: "gpt-5.6-sol",
    });
    assert.equal(requests[3].instructions, "Original instructions");
    assert.equal(requests[3].prompt_cache_key, undefined, "ordinary calls keep their existing request shape");

    // Exercise the actual ChatGPT delegate with isolated fake auth, then route
    // its real OpenAI transport to this local server. Never read user auth.
    const previousCodexHome = process.env.CODEX_HOME;
    writeFileSync(
      join(storageDir, "auth.json"),
      JSON.stringify({
        tokens: { access_token: "synthetic-test-token", account_id: "synthetic-account" },
        last_refresh: new Date().toISOString(),
      }),
    );
    const chatgpt = new OpenAIChatGPTProvider("", "") as unknown as {
      delegate(messages: ChatMessage[]): Promise<OpenAIProvider>;
    };
    const throughDelegate = async (messages: ChatMessage[]) => {
      let delegated: OpenAIProvider;
      process.env.CODEX_HOME = storageDir;
      try {
        delegated = await chatgpt.delegate(messages);
      } finally {
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
      }
      (delegated as unknown as { baseUrl: string }).baseUrl = `http://127.0.0.1:${address.port}/v1`;
      await delegated.chatComplete(messages, { model: "gpt-5.6-sol" });
    };
    const sunny: ChatMessage = { role: "system", content: "GM rules. Current weather: Sunny" };
    await throughDelegate([lore, sunny, latest]);
    const session = resolveOpenAIChatGPTCacheSession([lore, latest]);
    assert.ok(session);
    assert.equal(requestHeaders[4]["session-id"], session, "delegate must emit the official cache routing header");
    assert.equal(requestHeaders[4].session_id, undefined, "legacy underscore spelling must not be emitted");
    assert.deepEqual(requests[4], requests[0], "header correction must not alter the request body");
    await throughDelegate([editedLore, latest]);
    assert.equal(requestHeaders[5]["session-id"], session, "same chat keeps session affinity after lore changes");
    assert.deepEqual(requests[5], requests[2]);
    const otherLore = { ...lore, providerMetadata: { ...lore.providerMetadata, marinaraCacheScope: "other-chat" } };
    await throughDelegate([otherLore, latest]);
    assert.notEqual(requestHeaders[6]["session-id"], session, "different chat scopes remain isolated");
    assert.equal(requestHeaders[6]["session-id"], resolveOpenAIChatGPTCacheSession([otherLore, latest]));
    await throughDelegate([{ role: "system", content: "Original instructions" }, latest]);
    assert.equal(requestHeaders[7]["session-id"], undefined, "unscoped ordinary prompts do not gain a session header");
    assert.deepEqual(requests[7], requests[3]);
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  }
  process.stdout.write("Full lore context regression passed.\n");
} finally {
  await db._fileStore.close();
  if (previousStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageDir;
  assert.equal(dirname(resolve(storageDir)), resolve(tmpdir()));
  rmSync(storageDir, { recursive: true, force: true });
}

const sessionLore = {
  role: "system" as const,
  content: "Stable lore",
  providerMetadata: { marinaraFullLoreContext: true, marinaraCacheScope: "chat-a" },
};
const cacheSession = resolveOpenAIChatGPTCacheSession([sessionLore]);
assert.match(cacheSession!, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
assert.equal(resolveOpenAIChatGPTCacheSession([sessionLore, { role: "user", content: "Changed scene" }]), cacheSession);
assert.equal(
  resolveOpenAIChatGPTCacheSession([{ ...sessionLore, content: "Edited lore" }]),
  cacheSession,
  "the same chat scope keeps routing stable when lore is edited",
);
assert.notEqual(
  resolveOpenAIChatGPTCacheSession([
    {
      ...sessionLore,
      providerMetadata: { ...sessionLore.providerMetadata, marinaraCacheScope: "chat-b" },
    },
  ]),
  cacheSession,
  "different chat scopes must not share routing",
);
const legacyLore = { ...sessionLore, providerMetadata: { marinaraFullLoreContext: true } };
const legacySession = resolveOpenAIChatGPTCacheSession([legacyLore]);
assert.notEqual(legacySession, cacheSession, "scoped and legacy routing identities are distinct");
assert.equal(
  resolveOpenAIChatGPTCacheSession([{ ...legacyLore, content: "Edited lore" }]) ===
    resolveOpenAIChatGPTCacheSession([legacyLore]),
  false,
  "the legacy fallback remains content-derived for unscoped callers",
);
assert.equal(resolveOpenAIChatGPTCacheSession([{ role: "system", content: "Ordinary prompt" }]), undefined);
