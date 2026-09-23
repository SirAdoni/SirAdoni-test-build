import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings > Features "ChatGPT history replay" (chatgptHistoryReplay). ON (default) keeps today's
// behaviour: eligible Game turns replay the previous prompt, and full-lore ChatGPT requests carry a
// session-id header and a prompt_cache_key. OFF is upstream: no replay, no header, no cache key, and
// the request body is otherwise byte-identical. Only a local stub server is called.
const dataDir = mkdtempSync(join(tmpdir(), "marinara-feature-chatgpt-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";

const { resetFeatureSettingsForTests } =
  await import("../../packages/server/src/services/features/feature-settings.js");
const { OpenAIProvider } = await import("../../packages/server/src/services/llm/providers/openai.provider.js");
const { resolveOpenAIChatGPTCacheSession } =
  await import("../../packages/server/src/services/llm/providers/openai-chatgpt.provider.js");
const { isPromptHistoryReplayEligible } = await import("../../packages/server/src/routes/generate.routes.js");
type ChatMessage = import("../../packages/server/src/services/llm/base-provider.js").ChatMessage;

const lore: ChatMessage = {
  role: "system",
  content: "Stable lore for the Tamsin campaign. ".repeat(40),
  providerMetadata: { marinaraFullLoreContext: true, marinaraCacheScope: "chat-feature-test" },
};
const turn: ChatMessage = { role: "user", content: "Ysolde opens the gate.", contextKind: "history" };
const eligibleTurn = {
  chatMode: "game",
  usesIndividualGroupGeneration: false,
  provider: "openai_chatgpt",
  followUpIteration: 0,
  currentTurnUserMessageId: "m-2",
  userMessage: "Ysolde opens the gate.",
  toolCount: 0,
};

const requests: string[] = [];
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  requests.push(raw);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output_text":"OK","usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
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

  // ON = today
  resetFeatureSettingsForTests();
  assert.equal(isPromptHistoryReplayEligible(eligibleTurn), true, "ON: eligible Game turns replay");
  const session = resolveOpenAIChatGPTCacheSession([lore, turn]);
  assert.match(session ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u, "ON: header value");
  await provider.chatComplete([lore, turn], { model: "gpt-5.6-sol" });
  const onBody = JSON.parse(requests[0]!);
  assert.match(onBody.prompt_cache_key, /^me-lore-[0-9a-f]{40}$/u, "ON: prompt_cache_key sent");

  // OFF = upstream
  resetFeatureSettingsForTests({ chatgptHistoryReplay: false });
  assert.equal(isPromptHistoryReplayEligible(eligibleTurn), false, "OFF: the prompt is rebuilt every turn");
  assert.equal(resolveOpenAIChatGPTCacheSession([lore, turn]), undefined, "OFF: no session-id header");
  await provider.chatComplete([lore, turn], { model: "gpt-5.6-sol" });
  const offBody = JSON.parse(requests[1]!);
  assert.equal("prompt_cache_key" in offBody, false, "OFF: no prompt_cache_key");
  const { prompt_cache_key: _key, ...onWithoutKey } = onBody;
  assert.equal(JSON.stringify(offBody), JSON.stringify(onWithoutKey), "OFF: the rest of the body is byte-identical");

  // Back ON restores the exact same request.
  resetFeatureSettingsForTests({ chatgptHistoryReplay: true });
  await provider.chatComplete([lore, turn], { model: "gpt-5.6-sol" });
  assert.equal(requests[2], requests[0], "ON again: byte-identical to the first ON request");
} finally {
  resetFeatureSettingsForTests();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("feature-switch-chatgpt-replay regression passed");
