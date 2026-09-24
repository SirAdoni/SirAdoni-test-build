// Regression: the per-game "GM reasoning effort" (chat metadata gameGmReasoningEffort) overrides the resolved
// reasoning effort for the Game Master narration turn only, clamps to what the model supports, leaves the request
// byte-identical when absent or "default", and never reaches side calls that set their own effort.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "marinara-gm-effort-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.LOG_DIR = join(dir, "logs");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const shared = await import("../../packages/shared/src/index.js");
const { resolveGenerationProviderRuntime } =
  await import("../../packages/server/src/services/generation/provider-generation-runtime.js");

// ── Shared helpers ──
{
  const { gameGmReasoningEffortOptions, normalizeGameGmReasoningEffort, resolveGameGmReasoningEffort } = shared;
  assert.equal(normalizeGameGmReasoningEffort(undefined), "default");
  assert.equal(normalizeGameGmReasoningEffort("bogus"), "default");
  assert.equal(normalizeGameGmReasoningEffort("xhigh"), "xhigh");

  const opus = { provider: "claude_subscription", model: "claude-opus-5-5" };
  // Opus 5.5 always thinks, so it offers no "none"; every level down to low is its own value.
  assert.deepEqual(gameGmReasoningEffortOptions(opus), ["default", "low", "medium", "high", "xhigh", "maximum"]);
  // A model without extra-high or max shows one "high" instead of three that all send "high".
  assert.deepEqual(gameGmReasoningEffortOptions({ provider: "openai", model: "gpt-5" }), [
    "default",
    "none",
    "low",
    "medium",
    "high",
  ]);
  // No effort control on the model: only Default.
  assert.deepEqual(gameGmReasoningEffortOptions({ provider: "grok_subscription", model: "grok-4" }), ["default"]);
  assert.deepEqual(gameGmReasoningEffortOptions({ provider: "openai", model: "gpt-4o" }), ["default"]);

  assert.equal(resolveGameGmReasoningEffort({ ...opus, setting: undefined }), undefined);
  assert.equal(resolveGameGmReasoningEffort({ ...opus, setting: "default" }), undefined);
  assert.equal(resolveGameGmReasoningEffort({ ...opus, setting: "garbage" }), undefined);
  assert.equal(resolveGameGmReasoningEffort({ ...opus, setting: "low" }), "low");
  assert.equal(resolveGameGmReasoningEffort({ ...opus, setting: "none" }), "low", "Opus 5.5 cannot turn thinking off");
  assert.equal(resolveGameGmReasoningEffort({ provider: "openai", model: "gpt-5", setting: "none" }), null);
  assert.equal(resolveGameGmReasoningEffort({ provider: "openai", model: "gpt-4o", setting: "low" }), undefined);
}

// ── Provider runtime ──
const baseRuntimeArgs = (overrides: {
  provider?: string;
  model?: string;
  chatMode?: string;
  isSceneChat?: boolean;
  gameGmReasoningEffort?: unknown;
  chatParameters?: unknown;
}) => ({
  connectionId: "fixture",
  connection: {
    provider: overrides.provider ?? "claude_subscription",
    model: overrides.model ?? "claude-opus-5-5",
    apiKey: "",
  },
  baseUrl: "",
  chatMode: overrides.chatMode ?? "game",
  isSceneChat: overrides.isSceneChat ?? false,
  chatParameters: overrides.chatParameters ?? null,
  ...("gameGmReasoningEffort" in overrides ? { gameGmReasoningEffort: overrides.gameGmReasoningEffort } : {}),
  managedParameterDefinitions: [],
  modelAccessPolicy: { suppressModelParameters: false },
  initial: {
    temperature: 1,
    maxTokens: 4096,
    topP: 1,
    topK: 0,
    minP: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    showThoughts: true,
    reasoningEffort: shared.DEFAULT_GENERATION_PARAMS.reasoningEffort,
    verbosity: null,
    serviceTier: null,
    assistantPrefill: "",
    assistantReasoningPrefill: "",
    customThinkingTags: [],
    customParameters: {},
    enabledParameters: undefined,
    stopSequences: [],
    effectiveMaxContext: undefined,
  },
});
const comparable = (runtime: ReturnType<typeof resolveGenerationProviderRuntime>) => {
  const { primaryProvider: _primary, provider: _provider, ...rest } = runtime;
  return rest;
};
{
  assert.equal(shared.DEFAULT_GENERATION_PARAMS.reasoningEffort, "maximum");
  const absent = resolveGenerationProviderRuntime(baseRuntimeArgs({}));
  assert.equal(absent.reasoningEffort, "maximum", "Default keeps the built-in maximum");
  assert.equal(absent.providerReasoningEffort, "max");
  const asDefault = resolveGenerationProviderRuntime(baseRuntimeArgs({ gameGmReasoningEffort: "default" }));
  assert.deepEqual(comparable(asDefault), comparable(absent), "Default is identical to an absent setting");

  for (const level of ["low", "medium", "high", "xhigh"] as const) {
    const runtime = resolveGenerationProviderRuntime(baseRuntimeArgs({ gameGmReasoningEffort: level }));
    assert.equal(runtime.providerReasoningEffort, level, `${level} reaches the provider options`);
    assert.equal(runtime.parameterSources.reasoningEffort, "gameGm");
  }
  const max = resolveGenerationProviderRuntime(baseRuntimeArgs({ gameGmReasoningEffort: "maximum" }));
  assert.equal(max.providerReasoningEffort, "max");

  // The game setting wins over a chat-level parameter override for the narration turn.
  const overChat = resolveGenerationProviderRuntime(
    baseRuntimeArgs({ gameGmReasoningEffort: "medium", chatParameters: { reasoningEffort: "high" } }),
  );
  assert.equal(overChat.providerReasoningEffort, "medium");

  // Clamping: Opus 5.5 cannot turn thinking off, and GPT-5 has no extra-high or max.
  const off = resolveGenerationProviderRuntime(baseRuntimeArgs({ gameGmReasoningEffort: "none" }));
  assert.equal(off.providerReasoningEffort, "low");
  assert.equal(off.enableThinking, true);
  const gpt5 = resolveGenerationProviderRuntime(
    baseRuntimeArgs({ provider: "openai", model: "gpt-5", gameGmReasoningEffort: "maximum" }),
  );
  assert.equal(gpt5.providerReasoningEffort, "high", "an unsupported level is lowered to the model's ceiling");
  const gpt5Off = resolveGenerationProviderRuntime(
    baseRuntimeArgs({ provider: "openai", model: "gpt-5", gameGmReasoningEffort: "none" }),
  );
  assert.equal(gpt5Off.providerReasoningEffort, "none");
  assert.equal(gpt5Off.enableThinking, false);

  // Other modes and scene chats ignore the key.
  const roleplay = resolveGenerationProviderRuntime(
    baseRuntimeArgs({ chatMode: "roleplay", gameGmReasoningEffort: "low" }),
  );
  assert.equal(roleplay.providerReasoningEffort, "max");
  const scene = resolveGenerationProviderRuntime(baseRuntimeArgs({ isSceneChat: true, gameGmReasoningEffort: "low" }));
  assert.equal(scene.providerReasoningEffort, "max");
}

// ── Side calls never read the setting ──
{
  const serverSrc = fileURLToPath(new URL("../../packages/server/src/", import.meta.url));
  const readers: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts") && readFileSync(full, "utf8").includes("gameGmReasoningEffort")) {
        readers.push(relative(serverSrc, full).replaceAll("\\", "/"));
      }
    }
  };
  walk(serverSrc);
  assert.deepEqual(readers.sort(), [
    "routes/generate.routes.ts",
    "routes/generate/dry-run-route.ts",
    "routes/generate/parameter-preview-route.ts",
    "services/generation/provider-generation-runtime.ts",
  ]);
  // Scene analysis, planners and continuity keep their fixed low effort.
  const sceneTimeline = readFileSync(join(serverSrc, "services/game/scene-timeline.service.ts"), "utf8");
  assert.ok(sceneTimeline.includes('reasoningEffort: "low"'));
}

// ── Game GM turn through /api/generate with a stub provider ──
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");

type WireBody = { messages: Array<{ role: string; content: string }>; reasoning_effort?: unknown } & Record<
  string,
  unknown
>;
const narratorBodies: string[] = [];
const provider = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw) as WireBody;
  if (body.messages?.some((message) => String(message.content).includes("GM_EFFORT_MARKER"))) narratorBodies.push(raw);
  const content = "The corridor hums.";
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
const db = await getDB();
const chats = createChatsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(generateRoutes, { prefix: "/api/generate" });
try {
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const connection = await createConnectionsStorage(db).create({
    name: "GM effort fixture",
    provider: "openai",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "gpt-5",
    apiKey: "fixture",
    maxContext: 32768,
  });
  const chat = (await chats.create({
    name: "GM effort game",
    mode: "game",
    characterIds: [],
    connectionId: connection.id,
    promptPresetId: null,
  }))!;
  await chats.patchMetadata(chat.id, {
    enableAgents: false,
    enableTools: false,
    gameSystemPrompt: "GM_EFFORT_MARKER",
  });
  await chats.createMessage({ chatId: chat.id, role: "user", content: "I open the hatch." });

  const turn = async (setting: unknown, regenerateMessageId?: string) => {
    if (setting === undefined) {
      await chats.patchMetadata(chat.id, (current: Record<string, unknown>) => {
        const { gameGmReasoningEffort: _dropped, ...rest } = current;
        return rest;
      });
    } else {
      await chats.patchMetadata(chat.id, { gameGmReasoningEffort: setting });
    }
    const before = narratorBodies.length;
    const response = await app.inject({
      method: "POST",
      url: "/api/generate/",
      payload: { chatId: chat.id, streaming: true, ...(regenerateMessageId ? { regenerateMessageId } : {}) },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes('"type":"error"'), response.body);
    assert.equal(narratorBodies.length, before + 1, "one narrator request per turn");
    return narratorBodies.at(-1)!;
  };

  await turn(undefined);
  const assistant = (await chats.listMessages(chat.id)).filter((message) => message.role === "assistant").at(-1)!;
  assert.ok(assistant, "the GM turn saved a message");
  const readGenerationInfo = async () => {
    const message = (await chats.listMessages(chat.id)).find((candidate) => candidate.id === assistant.id)!;
    const extra = typeof message.extra === "string" ? JSON.parse(message.extra) : (message.extra ?? {});
    return (extra as { generationInfo?: { reasoningEffort?: unknown } }).generationInfo ?? {};
  };

  const absentBody = await turn(undefined, assistant.id);
  assert.equal((JSON.parse(absentBody) as WireBody).reasoning_effort, "high", "built-in maximum sent as gpt-5's high");
  const defaultBody = await turn("default", assistant.id);
  assert.equal(defaultBody, absentBody, "Default leaves the provider request byte-identical");

  const lowBody = JSON.parse(await turn("low", assistant.id)) as WireBody;
  assert.equal(lowBody.reasoning_effort, "low", "a low override reaches the provider");
  assert.equal((await readGenerationInfo()).reasoningEffort, "low", "the usage line records the effort used");
  const mediumBody = JSON.parse(await turn("medium", assistant.id)) as WireBody;
  assert.equal(mediumBody.reasoning_effort, "medium");
  const clampedBody = JSON.parse(await turn("xhigh", assistant.id)) as WireBody;
  assert.equal(clampedBody.reasoning_effort, "high", "an unsupported level is clamped");

  // Continue of the GM turn uses the same override.
  const continueResponse = await app.inject({
    method: "POST",
    url: "/api/generate/",
    payload: { chatId: chat.id, streaming: true, continueMessageId: assistant.id },
  });
  assert.equal(continueResponse.statusCode, 200, continueResponse.body);
  assert.equal((JSON.parse(narratorBodies.at(-1)!) as WireBody).reasoning_effort, "high");

  console.log("game GM reasoning effort regression passed");
} finally {
  await app.close();
  await closeDB();
  await new Promise<void>((done) => provider.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
}
