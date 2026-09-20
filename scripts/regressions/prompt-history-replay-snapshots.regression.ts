import assert from "node:assert/strict";
import {
  createPromptHistoryReplayDescriptor,
  PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE,
  seedPromptHistoryReplaySnapshot,
  tryReplayPromptHistory,
  type PromptHistoryReplayScope,
} from "../../packages/server/src/services/generation/prompt-history-replay.js";
import { markNewRuntimeContextMessages } from "../../packages/server/src/services/generation/prompt-cache-layout.js";
import type { ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";
import { isPromptCacheBoundary } from "../../packages/server/src/services/prompt/merger.js";

const scope: PromptHistoryReplayScope = { provider: "openai_chatgpt", model: "gpt-5.6-sol", scope: "chat-1" };
const lore: ChatMessage = {
  role: "system",
  content: "Stable canon ".repeat(500),
  providerMetadata: { marinaraFullLoreContext: true },
};
const marked = (content: string): ChatMessage => ({
  role: "system",
  content,
  contextKind: "injection",
  providerMetadata: { marinaraRuntimeContext: true, marinaraPromptHistoryReplaySnapshot: true },
});
const user = (content: string): ChatMessage => ({ role: "user", content, contextKind: "history" });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content, contextKind: "history" });
const materializeReferences = (messages: readonly ChatMessage[]): ChatMessage[] => {
  const fullById = new Map<string, ChatMessage>();
  return messages.map((message) => {
    const full = /^<marinara_replay_snapshot id="([a-f0-9]{64})">\n[\s\S]*\n<\/marinara_replay_snapshot>$/.exec(
      message.content,
    );
    if (full && message.providerMetadata?.marinaraPromptHistoryReplaySnapshotFull === true) {
      fullById.set(full[1]!, message);
      return message;
    }
    const ref = /^<marinara_replay_snapshot_ref id="([a-f0-9]{64})">\1<\/marinara_replay_snapshot_ref>$/.exec(
      message.content,
    );
    if (!ref) return message;
    const target = fullById.get(ref[1]!);
    assert.ok(target, "each visible reference must resolve backward to full content");
    return target;
  });
};

const initialUnseeded = [lore, user("A"), assistant("A answer"), marked("STATE A"), user("B")];
assert.equal(createPromptHistoryReplayDescriptor(initialUnseeded, initialUnseeded, scope), null);
const initial = seedPromptHistoryReplaySnapshot(initialUnseeded);
assert.equal(initial.filter((m) => m.content === PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE).length, 1);
assert.equal(
  initial.findIndex((m) => m.content === PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE) <
    initial.findIndex((m) => m.content.includes("STATE A")),
  true,
);
const descriptor = createPromptHistoryReplayDescriptor(initial, initial, scope);
assert.ok(descriptor);

const turn2 = seedPromptHistoryReplaySnapshot([
  lore,
  user("A"),
  assistant("A answer"),
  user("B"),
  assistant("B answer"),
  marked("STATE B"),
  user("C"),
]);
const originalTurn2 = structuredClone(turn2);
const replay2 = tryReplayPromptHistory({
  currentMessages: turn2,
  previousPrompt: initial,
  previousDescriptor: descriptor,
  scope,
});
assert.ok(replay2);
assert.deepEqual(turn2, originalTurn2);
assert.deepEqual(replay2.prompt.slice(0, initial.length), initial);
assert.deepEqual(
  replay2.prompt
    .slice(initial.length)
    .map((m) => [
      m.role,
      m.content === PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE
        ? m.content
        : m.content.includes("STATE B")
          ? "STATE B"
          : m.content,
    ]),
  [
    ["assistant", "B answer"],
    ["system", PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE],
    ["system", "STATE B"],
    ["user", "C"],
  ],
);
assert.equal(replay2.prompt.at(-1)?.content, "C");

const turn3 = seedPromptHistoryReplaySnapshot([
  lore,
  user("A"),
  assistant("A answer"),
  user("B"),
  assistant("B answer"),
  user("C"),
  assistant("C answer"),
  marked("STATE C"),
  user("D"),
]);
const replay3 = tryReplayPromptHistory({
  currentMessages: turn3,
  previousPrompt: replay2.prompt,
  previousDescriptor: replay2.descriptor,
  scope,
});
assert.ok(replay3);
assert.equal(replay3.prompt.at(-1)?.content, "D");
assert.equal(replay3.prompt.filter((m) => m.content === PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE).length, 3);
assert.equal(replay3.prompt.at(-2)?.content.includes("STATE C"), true);

const pureInitial = seedPromptHistoryReplaySnapshot([
  lore,
  user("P1"),
  assistant("P1 answer"),
  { role: "user", content: "USER STATE 1", contextKind: "injection" },
  user("P2"),
]);
const pureDescriptor = createPromptHistoryReplayDescriptor(pureInitial, pureInitial, scope);
assert.ok(pureDescriptor);
const pureTurn2 = seedPromptHistoryReplaySnapshot([
  lore,
  user("P1"),
  assistant("P1 answer"),
  user("P2"),
  assistant("P2 answer"),
  { role: "user", content: "USER STATE 2", contextKind: "injection" },
  user("P3"),
]);
const pureReplay = tryReplayPromptHistory({
  currentMessages: pureTurn2,
  previousPrompt: pureInitial,
  previousDescriptor: pureDescriptor,
  scope,
});
assert.ok(pureReplay);
assert.equal(pureReplay.prompt.at(-1)?.content, "P3");

const unmarkedSystem = [
  ...turn2.slice(0, 5),
  { role: "system" as const, content: "runtime", contextKind: "injection" as const },
  marked("STATE B"),
  user("C"),
];
assert.equal(createPromptHistoryReplayDescriptor(unmarkedSystem, unmarkedSystem, scope), null);
for (const contextKind of [undefined, "prompt" as const]) {
  const unmarked = [
    ...turn2.slice(0, 5),
    { role: "system" as const, content: "unmarked", ...(contextKind ? { contextKind } : {}) },
    marked("STATE B"),
    user("C"),
  ];
  assert.equal(createPromptHistoryReplayDescriptor(unmarked, unmarked, scope), null);
}
const genericRuntime = [
  ...turn2.slice(0, 5),
  {
    role: "system" as const,
    content: "runtime",
    contextKind: "injection" as const,
    providerMetadata: { marinaraRuntimeContext: true },
  },
  user("C"),
];
assert.equal(createPromptHistoryReplayDescriptor(genericRuntime, genericRuntime, scope), null);
const leadingStableInjection = [{ ...lore, contextKind: "injection" as const }, ...turn2.slice(1)];
assert.ok(createPromptHistoryReplayDescriptor(leadingStableInjection, leadingStableInjection, scope));
const markedWithoutPrelude = [lore, user("A"), assistant("A answer"), marked("STATE A"), user("B")];
assert.equal(createPromptHistoryReplayDescriptor(markedWithoutPrelude, markedWithoutPrelude, scope), null);
assert.equal(isPromptCacheBoundary(marked("STATE B")), true);
assert.equal(isPromptCacheBoundary({ providerMetadata: { marinaraPromptHistoryReplaySnapshot: true } }), false);
const wrongScope = tryReplayPromptHistory({
  currentMessages: turn2,
  previousPrompt: initial,
  previousDescriptor: descriptor,
  scope: { ...scope, model: "other" },
});
assert.equal(wrongScope, null);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: turn2,
    previousPrompt: initial,
    previousDescriptor: { ...descriptor, scopeVersion: 1 } as never,
    scope,
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: turn2,
    previousPrompt: initial,
    previousDescriptor: descriptor,
    scope,
    maxContext: 1,
    maxTokens: 1,
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: turn2.map((m, i) => (i === 1 ? { ...m, content: "tampered" } : m)),
    previousPrompt: initial,
    previousDescriptor: descriptor,
    scope,
  }),
  null,
);

for (const contextKind of [undefined, "prompt" as const, "injection" as const]) {
  const unknown: ChatMessage = {
    role: "system",
    content: "Unowned runtime policy",
    ...(contextKind ? { contextKind } : {}),
  };
  const invalid = [...turn2.slice(0, -1), unknown, turn2.at(-1)!];
  assert.deepEqual(seedPromptHistoryReplaySnapshot(invalid), invalid);
  assert.equal(createPromptHistoryReplayDescriptor(invalid, invalid, scope), null);
}
const genericOnly = turn2.map((message) =>
  message.content.includes("STATE B") ? { ...message, providerMetadata: { marinaraRuntimeContext: true } } : message,
);
assert.equal(createPromptHistoryReplayDescriptor(genericOnly, genericOnly, scope), null);
assert.deepEqual(seedPromptHistoryReplaySnapshot(initial), initial);

const originalMessages: ChatMessage[] = [lore, user("unchanged input")];
const insertContext = (messages: ChatMessage[]): ChatMessage[] => [
  ...messages,
  { role: "system", content: "Spatial snapshot" },
  { role: "user", content: "Ordinary context", contextKind: "injection" },
];
const genericContext = markNewRuntimeContextMessages(originalMessages, insertContext);
assert.deepEqual(genericContext.slice(0, originalMessages.length), originalMessages);
assert.equal(genericContext[2]?.providerMetadata?.marinaraRuntimeContext, true);
assert.equal(genericContext[2]?.providerMetadata?.marinaraPromptHistoryReplaySnapshot, undefined);
const ownedContext = markNewRuntimeContextMessages(originalMessages, insertContext, true);
assert.deepEqual(ownedContext.slice(0, originalMessages.length), originalMessages);
assert.equal(ownedContext[2]?.providerMetadata?.marinaraPromptHistoryReplaySnapshot, true);
assert.equal(ownedContext[3]?.providerMetadata?.marinaraPromptHistoryReplaySnapshot, undefined);
assert.equal(
  originalMessages.some((message) => message.providerMetadata?.marinaraRuntimeContext),
  false,
);

// Reconstruct only the newest appended snapshot. Finding an old full payload
// elsewhere in the history would not prove that a reference resolves correctly.
const largeSnapshot = (state: string, producer = "continuity"): ChatMessage => ({
  ...marked(`${state}|${"x".repeat(2_000)}`),
  providerMetadata: { ...marked("").providerMetadata, producer },
});
const originalState = '{"present":["guide","visitor"],"temporary":true}';
const reducedState = '{"present":["guide"]}';
const states = [originalState, originalState, originalState, reducedState, null, originalState, originalState];
const expectedReferences = [0, 1, 1, 0, 0, 1, 0];
// Production replay targets large contexts; leave room for seven appended turns
// without tripping the separately tested 50-percent historical-overhead guard.
const history = [{ ...lore, content: "Stable canon ".repeat(20_000) }, user("opening"), assistant("opening answer")];
const repeatedInstruction: ChatMessage = {
  role: "user",
  content: "Unmarked instruction. ".repeat(50),
  contextKind: "injection",
};
let previousPrompt: ChatMessage[] | undefined;
let previousDescriptor: ReturnType<typeof createPromptHistoryReplayDescriptor> = null;
const snapshots = (messages: readonly ChatMessage[]) =>
  messages.filter((message) => message.providerMetadata?.marinaraPromptHistoryReplaySnapshot === true);
for (let turn = 0; turn < states.length; turn += 1) {
  const state = states[turn];
  const canonical = seedPromptHistoryReplaySnapshot([
    ...history,
    ...(state === null ? [] : [largeSnapshot(state!, turn === 6 ? "other-producer" : "continuity")]),
    marked("Small unchanged section"),
    repeatedInstruction,
    user("Repeated dialogue"),
  ]);
  let prompt = canonical;
  if (previousPrompt && previousDescriptor) {
    const result = tryReplayPromptHistory({ currentMessages: canonical, previousPrompt, previousDescriptor, scope });
    assert.ok(result, `replay turn ${turn}`);
    prompt = result.prompt;
    assert.deepEqual(prompt.slice(0, previousPrompt.length), previousPrompt, "retained prefix must be exact");
    assert.deepEqual(result.appendedMessages, prompt.slice(previousPrompt.length), "result exposes actual sent tail");
    const references = result.appendedMessages.filter(
      (message) => message.providerMetadata?.marinaraPromptHistoryReplaySnapshotReference === true,
    );
    assert.equal(references.length, expectedReferences[turn], `reference count turn ${turn}`);
    const materializedTail = materializeReferences(prompt).slice(previousPrompt.length);
    assert.deepEqual(
      snapshots(materializedTail),
      snapshots(canonical),
      `latest snapshot must reconstruct exactly on turn ${turn}`,
    );
    assert.deepEqual(
      result.appendedMessages.filter((message) => message.role === "user"),
      [repeatedInstruction, user("Repeated dialogue")],
      "unmarked instructions and repeated dialogue are never deduplicated",
    );
    assert.ok(
      result.appendedMessages.some((message) => message.role === "assistant" && message.content === "Repeated answer"),
      "assistant history remains intact",
    );
    if (references.length) {
      const fullTail = canonical.slice(previousDescriptor.tailStart + 1);
      const chars = (messages: readonly ChatMessage[]) =>
        messages.reduce((sum, message) => sum + message.content.length, 0);
      assert.ok(
        chars(fullTail) - chars(result.appendedMessages) > 1_700,
        "large unchanged content actually saves appended characters",
      );
      for (const reference of references) {
        const id = reference.providerMetadata?.marinaraPromptHistoryReplaySnapshotId;
        assert.ok(
          previousPrompt.some(
            (message) =>
              message.providerMetadata?.marinaraPromptHistoryReplaySnapshotFull === true &&
              message.providerMetadata?.marinaraPromptHistoryReplaySnapshotId === id,
          ),
          "reference always targets an earlier full payload, never another reference",
        );
      }
    }
    if (turn === 3)
      assert.ok(
        !snapshots(materializedTail).some(
          (message) => message.content.includes("temporary") || message.content.includes("visitor"),
        ),
        "removed fields are not inherited",
      );
    if (turn === 4) assert.equal(snapshots(materializedTail).length, 1, "omitted large section stays absent");
  }
  previousDescriptor = createPromptHistoryReplayDescriptor(canonical, prompt, scope);
  assert.ok(previousDescriptor);
  previousPrompt = prompt;
  history.push(user("Repeated dialogue"), assistant("Repeated answer"));
}

process.stdout.write("Prompt history replay snapshot regression passed.\n");
