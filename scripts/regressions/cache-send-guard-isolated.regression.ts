import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dataDir = mkdtempSync(join(tmpdir(), "marinara-cache-guard-isolated-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");

const { DATA_DIR } = await import("../../packages/server/src/utils/data-dir.js");
assert.equal(DATA_DIR, dataDir, "isolated regression must load its temporary data directory");
const { runIsolatedGameTurnWithProvider } =
  await import("../../packages/server/src/routes/generate/game-isolated-turn-adapter.js");
const {
  CacheGuardHold,
  fingerprintPrompt,
  predictCacheHit,
  readCacheGuardSettings,
  readLastSentPrompt,
  recordSentPrompt,
} = await import("../../packages/server/src/services/generation/cache-send-guard.js");

const scope = {
  provider: "openai_chatgpt",
  model: "gpt-5",
  connectionId: "isolated-connection",
  requestKind: "isolated-planner" as const,
};
const providerOptions = {
  model: scope.model,
  maxContext: 20_000,
  maxTokens: 512,
};
let providerCalls = 0;
const provider = {
  chatComplete: async () => {
    providerCalls += 1;
    return {
      content: JSON.stringify({
        publicScene: [{ beat: 0, text: "The scene continues.", perceivedBy: [] }],
        actorRequests: [],
      }),
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    };
  },
} as any;

const run = async (chatId: string, acknowledged: boolean) => {
  let recorded: any = null;
  const result = await runIsolatedGameTurnWithProvider({
    plannerMessages: [
      {
        role: "system",
        content: "stable lore",
        providerMetadata: { marinaraFullLoreContext: true },
      },
    ],
    actors: [],
    playerAction: "continue",
    provider,
    providerOptions,
    signal: new AbortController().signal,
    beforeRequest: async (kind, messages) => {
      if (kind !== "planner") return;
      const fingerprint = fingerprintPrompt(messages, Date.now(), scope);
      recorded = fingerprint;
      if (acknowledged) return;
      const settings = readCacheGuardSettings({});
      const prediction = predictCacheHit(
        await readLastSentPrompt(chatId, scope),
        fingerprint,
        settings,
        Date.now(),
        "openai-prefix",
      );
      if (prediction && prediction.percent < settings.thresholdPercent) {
        throw new CacheGuardHold({ ...prediction, thresholdPercent: settings.thresholdPercent });
      }
    },
    afterRequest: async (kind) => {
      if (kind === "planner" && recorded) await recordSentPrompt(chatId, recorded);
    },
  });
  return { result, recorded };
};

try {
  await recordSentPrompt(
    "held-chat",
    fingerprintPrompt(
      [{ role: "system", content: "changed lore", providerMetadata: { marinaraFullLoreContext: true } }],
      Date.now(),
      scope,
    ),
  );
  await assert.rejects(run("held-chat", false), CacheGuardHold);
  assert.equal(providerCalls, 0, "planner hold must happen before the provider call");

  const accepted = await run("accepted-chat", true);
  assert.equal(providerCalls, 1, "acknowledgment releases the planner call");
  assert.ok(accepted.recorded);
  const saved = await readLastSentPrompt("accepted-chat", scope);
  assert.deepEqual(
    saved?.entries,
    accepted.recorded.entries,
    "successful planner response records its scoped fingerprint",
  );

  console.log("isolated cache-guard regression passed");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
