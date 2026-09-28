import assert from "node:assert/strict";
import type {
  BaseLLMProvider,
  ChatMessage,
  ChatOptions,
} from "../../packages/server/src/services/llm/base-provider.js";
import { runIsolatedGameTurnWithProvider } from "../../packages/server/src/routes/generate/game-isolated-turn-adapter.js";

type Plan = {
  publicScene: Array<{ beat: number; text: string; perceivedBy: string[] }>;
  actorRequests: Array<{ beat: number; actorId: string; perceivedBy?: string[] }>;
};

const validPlan: Plan = {
  publicScene: [{ beat: 0, text: "Alice enters the room.", perceivedBy: ["alice"] }],
  actorRequests: [{ beat: 0, actorId: "alice" }],
};
const invalidAudiencePlan: Plan = {
  publicScene: [{ beat: 0, text: "PRIVATE PLAN MARKER", perceivedBy: ["invented-audience"] }],
  actorRequests: [{ beat: 0, actorId: "alice" }],
};
const usage = { promptTokens: 2, completionTokens: 3, totalTokens: 5 };

function makeProvider(plans: unknown[], options: { failFirst?: boolean; abortOnFirst?: AbortController } = {}) {
  const plannerMessages: ChatMessage[][] = [];
  let plannerCalls = 0;
  let actorCalls = 0;
  const provider = {
    async chatComplete(messages: readonly ChatMessage[], _options: ChatOptions) {
      if (messages.some((message) => message.content.includes("Expected actor ID:"))) {
        actorCalls++;
        return {
          content: JSON.stringify({ actorId: "alice", lines: [{ type: "main", text: "I am here." }] }),
          usage,
          finishReason: "stop",
        };
      }
      plannerMessages.push(messages.map((message) => ({ ...message })));
      plannerCalls++;
      if (options.failFirst && plannerCalls === 1) throw new Error("provider unavailable");
      if (options.abortOnFirst && plannerCalls === 1) {
        options.abortOnFirst.abort(new Error("request aborted"));
      }
      return { content: JSON.stringify(plans[plannerCalls - 1]), usage, finishReason: "stop" };
    },
  } as unknown as BaseLLMProvider;
  return {
    provider,
    plannerMessages,
    get plannerCalls() {
      return plannerCalls;
    },
    get actorCalls() {
      return actorCalls;
    },
  };
}

function run(
  provider: BaseLLMProvider,
  signal = new AbortController().signal,
  actors: Parameters<typeof runIsolatedGameTurnWithProvider>[0]["actors"] = [
    { actorId: "alice", name: "Alice", card: "Alice card" },
  ],
) {
  const prompts: Array<{ kind: string; messages: readonly ChatMessage[] }> = [];
  const result = runIsolatedGameTurnWithProvider({
    plannerMessages: [{ role: "user", content: "Original scene context" }],
    actors,
    playerAction: "I ask Alice to answer.",
    provider,
    providerOptions: { model: "test-model" },
    signal,
    onPrompt: (kind, messages) => prompts.push({ kind, messages }),
  });
  return { result, prompts };
}

const recovered = makeProvider([invalidAudiencePlan, validPlan]);
const recoveredRun = run(recovered.provider);
const recoveredResult = await recoveredRun.result;
assert.equal(recovered.plannerCalls, 2, "one validation failure gets exactly one planner retry");
assert.equal(recovered.actorCalls, 1, "actors run only after the corrected plan validates");
assert.match(recoveredResult.content, /Alice enters the room/u);
assert.equal(recoveredResult.actorDiagnostics[0]?.status, "accepted");
assert.equal(recoveredResult.usage?.promptTokens, 6, "both planner attempts and actor request count toward usage");
assert.equal(recoveredResult.usage?.completionTokens, 9);
assert.deepEqual(
  recovered.plannerMessages[0],
  recovered.plannerMessages[1]!.slice(0, -1),
  "the retry retains the original planner context and trusted roster",
);
assert.match(recovered.plannerMessages[1]!.at(-1)!.content, /unknown audience actor/u);
assert.doesNotMatch(recovered.plannerMessages[1]!.at(-1)!.content, /PRIVATE PLAN MARKER|invented-audience/u);
assert.equal(recoveredRun.prompts.filter((item) => item.kind === "planner").length, 2);

const twiceInvalid = makeProvider([invalidAudiencePlan, invalidAudiencePlan]);
await assert.rejects(run(twiceInvalid.provider).result, /ISOLATED_TURN_INVALID/u);
assert.equal(twiceInvalid.plannerCalls, 2);
assert.equal(twiceInvalid.actorCalls, 0);

const offscenePlan: Plan = {
  publicScene: [{ beat: 0, text: "The room is quiet.", perceivedBy: ["away"] }],
  actorRequests: [],
};
const offscene = makeProvider([offscenePlan, offscenePlan]);
await assert.rejects(
  run(offscene.provider, new AbortController().signal, [
    { actorId: "away", name: "Away", card: "Away card", initiallyPresent: false },
  ]).result,
  /ISOLATED_TURN_INVALID/u,
);
assert.equal(offscene.plannerCalls, 2);
assert.equal(offscene.actorCalls, 0, "offscene actors cannot receive a plan without an arrival");

const abortController = new AbortController();
const aborted = makeProvider([invalidAudiencePlan, validPlan], { abortOnFirst: abortController });
await assert.rejects(run(aborted.provider, abortController.signal).result, /request aborted/u);
assert.equal(aborted.plannerCalls, 1, "an aborted planner request is never retried");
assert.equal(aborted.actorCalls, 0);

const providerFailure = makeProvider([validPlan], { failFirst: true });
await assert.rejects(run(providerFailure.provider).result, /ISOLATED_TURN_PROVIDER_ERROR/u);
assert.equal(providerFailure.plannerCalls, 1, "provider failures are never retried");
assert.equal(providerFailure.actorCalls, 0);

console.info("isolated plan recovery regression passed");
