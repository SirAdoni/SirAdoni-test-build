import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AgentContext, AgentResult } from "../../packages/shared/src/index.js";
import { capabilityPackageManifestSchema } from "../../packages/shared/src/index.js";
import type { AgentExecConfig } from "../../packages/server/src/services/agents/agent-executor.js";
import {
  assertCapabilityAgentRuntimeServiceRegistration,
  finalizeCapabilityAgentResults,
  prepareCapabilityAgentContexts,
  shouldDeferCapabilityAgentResult,
  canReuseCapabilityAgentInjection,
} from "../../packages/server/src/services/capability-packages/capability-agent-runtime.service.js";
import {
  registerCapabilityService,
  resetCapabilityServices,
} from "../../packages/server/src/services/capability-packages/capability-service-registry.service.js";
import { withDeadline } from "../../packages/server/src/services/capability-packages/capability-prompt-context.service.js";
import { createAgentPipeline, type ResolvedAgent } from "../../packages/server/src/services/agents/agent-pipeline.js";
import { BaseLLMProvider, type ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";

const agent = {
  id: "memory-nag-config",
  type: "memory-nag",
  name: "Memory Nag",
  phase: "post_processing",
  connectionId: null,
  settings: {},
} as AgentExecConfig;
const context = {
  chatId: "chat-1",
  chatMode: "roleplay",
  recentMessages: [],
  mainResponse: "Pierro asks about the promise.",
  gameState: null,
  characters: [],
  memory: {},
} as AgentContext;
const result: AgentResult = {
  agentId: agent.id,
  agentType: agent.type,
  type: "memory_nag",
  data: { memoryIds: ["promise"] },
  tokensUsed: 1,
  durationMs: 1,
  success: true,
  error: null,
};

resetCapabilityServices();
const localManifest = {
  schemaVersion: 2,
  capabilityApi: { major: 1, minor: 15 },
  builtAgainst: { engineVersion: "2.4.4", localSourceHash: "a".repeat(64) },
  id: "local-proof",
  name: "Local proof",
  version: "0.1.0",
  description: "Local source provenance regression",
  engine: { min: "2.4.4", maxExclusive: "4.0.0" },
  kind: ["agent"],
  entrypoints: { agents: "agents.json" },
  files: [{ path: "agents.json", bytes: 1, sha256: "b".repeat(64) }],
  permissions: ["agent-runtime"],
  restartRequired: false,
};
assert.equal(capabilityPackageManifestSchema.safeParse(localManifest).success, true);
assert.equal(
  capabilityPackageManifestSchema.safeParse({
    ...localManifest,
    builtAgainst: { engineVersion: "2.4.4" },
  }).success,
  false,
  "An unversioned local build still needs verifiable source provenance",
);
assert.equal(
  capabilityPackageManifestSchema.safeParse({
    ...localManifest,
    builtAgainst: { engineVersion: "2.4.4", localSourceHash: "not-a-hash" },
  }).success,
  false,
);
assert.doesNotThrow(() =>
  assertCapabilityAgentRuntimeServiceRegistration("memory-nag", ["agent-runtime"], "agent-runtime:memory-nag"),
);
assert.throws(
  () => assertCapabilityAgentRuntimeServiceRegistration("other-package", ["agent-runtime"], "agent-runtime:memory-nag"),
  /cannot register an agent runtime for another package/,
);
assert.throws(
  () => assertCapabilityAgentRuntimeServiceRegistration("memory-nag", [], "agent-runtime:memory-nag"),
  /must declare the "agent-runtime" permission/,
);
const release = registerCapabilityService("agent-runtime:memory-nag", {
  prepareContext: () => ({ candidates: [{ id: "promise" }] }),
  finalizeResult: ({ result: input }: { result: AgentResult }) => ({
    ...input,
    data: { nags_needed: true, memoryIds: ["promise"] },
  }),
});
assert.equal(shouldDeferCapabilityAgentResult("memory-nag"), true);
assert.equal(shouldDeferCapabilityAgentResult("memory-nag", true), false);
assert.equal(shouldDeferCapabilityAgentResult("ordinary-agent"), false);

const prepared = await prepareCapabilityAgentContexts([agent], context);
assert.deepEqual(prepared.memory._capabilityAgentContexts, {
  "memory-nag": { candidates: [{ id: "promise" }] },
});
const finalized = await finalizeCapabilityAgentResults([result], [agent], prepared);
assert.deepEqual(finalized[0]?.data, { nags_needed: true, memoryIds: ["promise"] });

const retryRouteSource = readFileSync(
  new URL("../../packages/server/src/routes/generate/retry-agents-route.ts", import.meta.url),
  "utf8",
);
const retryBatchStart = retryRouteSource.indexOf("async function executeRetryBatches(");
const retryBatchEnd = retryRouteSource.indexOf("function mergeRetryPairedBuiltInRewriteAgents", retryBatchStart);
const retryBatchSource = retryRouteSource.slice(retryBatchStart, retryBatchEnd);
assert.ok(retryBatchStart >= 0 && retryBatchEnd > retryBatchStart);
assert.match(
  retryBatchSource,
  /prepareCapabilityAgentContexts\(groupAgents, group\.context\)[\s\S]*executeAgentBatch\(\s*configs,\s*preparedGroupContext/u,
  "manual Agent reruns must prepare capability runtime context before building provider requests",
);
const retryFinalizeStart = retryRouteSource.indexOf("results = await Promise.all(");
const retryResultEventsStart = retryRouteSource.indexOf("// ── Pre-validate expression results", retryFinalizeStart);
const retryFinalizeSource = retryRouteSource.slice(retryFinalizeStart, retryResultEventsStart);
assert.ok(retryFinalizeStart >= 0 && retryResultEventsStart > retryFinalizeStart);
assert.match(
  retryFinalizeSource,
  /finalizeCapabilityAgentResults\(\[result\], \[entry\.resolved\], preparedContext\)/u,
  "manual Agent reruns must finalize capability results before they are emitted or persisted",
);
await assert.rejects(withDeadline(new Promise(() => undefined), "agent-runtime regression", 5), /exceeded 5ms/);

release();
let activeFinalizers = 0;
let peakFinalizers = 0;
const finishRelease = registerCapabilityService("agent-runtime:memory-nag", {
  finalizeResult: async ({ result: input }: { result: AgentResult }) => {
    activeFinalizers++;
    peakFinalizers = Math.max(peakFinalizers, activeFinalizers);
    try {
      await new Promise<void>((done) => setTimeout(done, 10));
      return input;
    } finally {
      activeFinalizers--;
    }
  },
});
try {
  const agents = [agent, { ...agent, id: "second-finalizer" }];
  const results = [result, { ...result, agentId: "second-finalizer" }];
  for (const sequentialExecution of [false, true]) {
    peakFinalizers = 0;
    const finalized = await finalizeCapabilityAgentResults(results, agents, {
      ...context,
      chatMode: "game",
      sequentialExecution,
    });
    assert.deepEqual(finalized, results);
    assert.equal(
      peakFinalizers,
      sequentialExecution ? 1 : 2,
      "package finalizers share the opt-in Game sequence even when they start extra model work",
    );
  }
} finally {
  finishRelease();
}
resetCapabilityServices();

let requestMessages: ChatMessage[] = [];
class LocalProofProvider extends BaseLLMProvider {
  async *chat(messages: ChatMessage[]) {
    requestMessages = messages;
    yield "unvalidated suggestion";
  }
}
const preAgent = {
  ...agent,
  id: "runtime-proof",
  type: "runtime-proof",
  name: "Runtime proof",
  phase: "pre_generation",
  promptTemplate: "Use supplied context.",
  settings: { resultType: "context_injection", maxTokens: 1000 },
  isCustomAgent: false,
  provider: new LocalProofProvider("local-proof", ""),
  model: "local-proof",
} as ResolvedAgent;
let reject = false;
let validated = false;
const stopPre = registerCapabilityService("agent-runtime:runtime-proof", {
  reuseCachedInjection: false,
  prepareContext: () => ({ candidates: ["source-backed-hook"] }),
  finalizeResult: ({ result: input }: { result: AgentResult }) => {
    if (reject) throw new Error("Closed hook rejected");
    validated = true;
    return { ...input, data: { text: "validated direction" } };
  },
});
assert.equal(canReuseCapabilityAgentInjection("runtime-proof"), false);
assert.equal(canReuseCapabilityAgentInjection("ordinary-agent"), true);
const pipeline = createAgentPipeline([preAgent], context, (entry, options) => {
  assert.equal(options?.finalized, true);
  if (entry.success) assert.equal(validated, true, "Never publish before validation");
});
const injections = await pipeline.preGenerate();
assert.equal(injections[0]?.text, "validated direction");
assert.match(JSON.stringify(requestMessages), /source-backed-hook/);
assert.deepEqual(pipeline.results[0]?.data, { text: "validated direction" });
const disconnectedPipeline = createAgentPipeline([preAgent], context, () => {
  throw new Error("Simulated closed SSE stream");
});
assert.equal(
  (await disconnectedPipeline.preGenerate())[0]?.text,
  "validated direction",
  "A disconnected result listener must not discard validated injections",
);
reject = true;
assert.deepEqual(await pipeline.preGenerate(), [], "Rejected package output must not enter the GM prompt");
assert.equal(pipeline.results.at(-1)?.success, false);
stopPre();
resetCapabilityServices();
console.info("Capability agent runtime regression passed");
