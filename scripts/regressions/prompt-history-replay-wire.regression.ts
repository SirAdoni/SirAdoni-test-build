import assert from "node:assert/strict";
import { OpenAIProvider } from "../../packages/server/src/services/llm/providers/openai.provider.js";
import {
  createPromptHistoryReplayDescriptor,
  seedPromptHistoryReplaySnapshot,
  tryReplayPromptHistory,
  type PromptHistoryReplayScope,
} from "../../packages/server/src/services/generation/prompt-history-replay.js";
import type { ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";

const scope: PromptHistoryReplayScope = { provider: "openai_chatgpt", model: "gpt-5.6-sol", scope: "mapper" };
const lore: ChatMessage = {
  role: "system",
  content: "Stable lore ".repeat(500),
  providerMetadata: { marinaraFullLoreContext: true },
};
const marked = (content: string): ChatMessage => ({
  role: "system",
  content,
  contextKind: "injection",
  providerMetadata: { marinaraRuntimeContext: true, marinaraPromptHistoryReplaySnapshot: true },
});
const u = (content: string): ChatMessage => ({ role: "user", content, contextKind: "history" });
const a = (content: string): ChatMessage => ({ role: "assistant", content, contextKind: "history" });
const initial = seedPromptHistoryReplaySnapshot([lore, u("A"), a("A answer"), marked("STATE A"), u("B")]);
const d1 = createPromptHistoryReplayDescriptor(initial, initial, scope);
assert.ok(d1);
const turn2 = seedPromptHistoryReplaySnapshot([
  lore,
  u("A"),
  a("A answer"),
  u("B"),
  a("B answer"),
  marked("STATE B"),
  u("C"),
]);
const r2 = tryReplayPromptHistory({ currentMessages: turn2, previousPrompt: initial, previousDescriptor: d1, scope });
assert.ok(r2);
const turn3 = seedPromptHistoryReplaySnapshot([
  lore,
  u("A"),
  a("A answer"),
  u("B"),
  a("B answer"),
  u("C"),
  a("C answer"),
  marked("STATE C"),
  u("D"),
]);
const r3 = tryReplayPromptHistory({
  currentMessages: turn3,
  previousPrompt: r2.prompt,
  previousDescriptor: r2.descriptor,
  scope,
});
assert.ok(r3);
const provider = new OpenAIProvider("", "", undefined, undefined, undefined, "openai-chatgpt");
const replayTool = {
  type: "function",
  function: { name: "state_probe", description: "synthetic regression tool", parameters: { type: "object" } },
};
const buildResponsesBody = (candidate: OpenAIProvider) =>
  (
    candidate as unknown as {
      buildResponsesBody(messages: ChatMessage[], options: Record<string, unknown>): Record<string, unknown>;
    }
  ).buildResponsesBody(initial, { model: "gpt-5.6-sol", tools: [replayTool], stream: true });
assert.equal(
  buildResponsesBody(provider).tools,
  undefined,
  "ChatGPT Responses transport omits configured native tool schemas",
);
const ordinaryOpenAiProvider = new OpenAIProvider("", "", undefined, undefined, undefined, "openai");
assert.equal(
  Array.isArray(buildResponsesBody(ordinaryOpenAiProvider).tools),
  true,
  "ordinary OpenAI Responses transport retains configured native tool schemas",
);
const format = (messages: ChatMessage[]) =>
  (
    provider as unknown as {
      formatResponsesInput(messages: ChatMessage[]): { instructions?: string; input: Array<Record<string, unknown>> };
    }
  ).formatResponsesInput(messages);
const b1 = format(initial);
const b2 = format(r2.prompt);
const b3 = format(r3.prompt);
assert.equal(b1.instructions, b2.instructions);
assert.equal(b2.instructions, b3.instructions);
assert.deepEqual(b2.input.slice(0, b1.input.length), b1.input);
assert.deepEqual(b3.input.slice(0, b2.input.length), b2.input);
assert.equal(b3.input.at(-1)?.content, "D");
process.stdout.write("Actual OpenAI Responses mapper replay-prefix regression passed.\n");

const history: ChatMessage[] = [{ ...lore, contextKind: "injection" }, u("opening"), a("opening response")];
let previousPrompt: ChatMessage[] | undefined;
let previousDescriptor: ReturnType<typeof createPromptHistoryReplayDescriptor> = null;
let previousBody: ReturnType<typeof format> | undefined;
for (let turn = 1; turn <= 3; turn += 1) {
  const present = turn === 1 ? ["guide", "visitor"] : ["guide"];
  const continuity = JSON.stringify({ present });
  const canonical = seedPromptHistoryReplaySnapshot([
    ...history,
    { role: "user", content: `GM state ${turn}`, contextKind: "injection" },
    marked(continuity),
    { role: "user", content: `Player canon ${turn}`, contextKind: "injection" },
    marked(`GM dynamic ${turn}`),
    marked("Unchanged spatial state. ".repeat(150)),
    u(`turn ${turn}`),
  ]);
  assert.equal(canonical[history.length]?.providerMetadata?.marinaraPromptHistoryReplayPreamble, true);
  const replay =
    previousPrompt && previousDescriptor
      ? tryReplayPromptHistory({ currentMessages: canonical, previousPrompt, previousDescriptor, scope })
      : undefined;
  if (previousPrompt) assert.ok(replay);
  const prompt = replay?.prompt ?? canonical;
  const descriptor = createPromptHistoryReplayDescriptor(canonical, prompt, scope);
  assert.ok(descriptor);
  const body = format(prompt);
  if (previousBody) {
    assert.equal(body.instructions, previousBody.instructions);
    assert.deepEqual(body.input.slice(0, previousBody.input.length), previousBody.input);
  }
  assert.deepEqual(
    body.input.slice(-7).map((message) => message.role),
    ["system", "user", "system", "user", "system", "system", "user"],
  );
  assert.equal(String(body.input.at(-5)?.content).includes(continuity), true);
  assert.equal(body.input.at(-1)?.content, `turn ${turn}`);
  assert.equal(
    String(body.input.at(-2)?.content).startsWith("<marinara_replay_snapshot_ref "),
    turn > 1,
    "actual Responses wire uses a compact reference after first full state",
  );
  history.push(u(`turn ${turn}`), a(`response ${turn}`));
  previousPrompt = prompt;
  previousDescriptor = descriptor;
  previousBody = body;
}
process.stdout.write("Mixed Game Mode wire-prefix and newest-state regression passed.\n");
