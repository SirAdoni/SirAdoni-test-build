import assert from "node:assert/strict";
import {
  createPromptHistoryReplayDescriptor,
  PROMPT_HISTORY_REPLAY_SCOPE_VERSION,
  PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE,
  seedPromptHistoryReplaySnapshot,
  shouldReplayPromptHistory,
  tryReplayPromptHistory,
  type PromptHistoryReplayScope,
} from "../../packages/server/src/services/generation/prompt-history-replay.js";
import type { ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";

assert.equal(shouldReplayPromptHistory({ promptTokens: 354496, cachedTokens: 150528 }), true);
assert.equal(shouldReplayPromptHistory({ promptTokens: 49392, cachedTokens: 18560 }), true);
assert.equal(shouldReplayPromptHistory({ promptTokens: 32767, cachedTokens: 1000 }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: 260992, cachedTokens: 235264 }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: 260992, cachedTokens: 235264, replayed: true }), true);
assert.equal(shouldReplayPromptHistory({ promptTokens: 14177, cachedTokens: 13952 }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: 300000, cachedTokens: 0, replayed: true }), true);
assert.equal(shouldReplayPromptHistory({ promptTokens: 300000, cachedTokens: 0 }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: 300000 }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: 300000, cachedTokens: Number.NaN, replayed: true }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: 300000, cachedTokens: -1, replayed: true }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: Infinity, cachedTokens: 150528 }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: 300000, cachedTokens: 300001 }), false);

const scope: PromptHistoryReplayScope = { provider: "openai_chatgpt", model: "gpt-5.6-sol", scope: "chat-1" };
const lore: ChatMessage = {
  role: "system",
  content: `Stable canon ${"x".repeat(5000)}`,
  contextKind: "prompt",
  providerMetadata: { marinaraFullLoreContext: true },
};
const historyUserA: ChatMessage = { role: "user", content: "Question A", contextKind: "history" };
const historyAssistantA: ChatMessage = { role: "assistant", content: "Answer A", contextKind: "history" };
const historyUserB: ChatMessage = { role: "user", content: "Question B", contextKind: "history" };
const historyAssistantB: ChatMessage = { role: "assistant", content: "Answer B", contextKind: "history" };
const historyUserC: ChatMessage = { role: "user", content: "Question C", contextKind: "history" };
const stateOld: ChatMessage = { role: "user", content: "STATE_OLD", contextKind: "injection" };
const stateNew: ChatMessage = { role: "user", content: "STATE_NEW", contextKind: "injection" };

const oldCanonical = seedPromptHistoryReplaySnapshot([lore, historyUserA, historyAssistantA, historyUserB, stateOld]);
const currentCanonical = seedPromptHistoryReplaySnapshot([
  lore,
  historyUserA,
  historyAssistantA,
  historyUserB,
  historyAssistantB,
  historyUserC,
  stateNew,
]);
const descriptor = createPromptHistoryReplayDescriptor(oldCanonical, oldCanonical, scope);
assert.ok(descriptor);
const originalCurrent = structuredClone(currentCanonical);
const originalPrompt = structuredClone(oldCanonical);

const replay = tryReplayPromptHistory({
  currentMessages: currentCanonical,
  previousPrompt: oldCanonical,
  previousDescriptor: descriptor,
  scope,
});
assert.ok(replay);
assert.deepEqual(replay.prompt.slice(0, oldCanonical.length), oldCanonical);
assert.deepEqual(
  replay.prompt.slice(oldCanonical.length).map((m) => m.content),
  ["Answer B", "Question C", PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE, "STATE_NEW"],
);
assert.equal(replay.prompt.at(-1)?.content, "STATE_NEW");
assert.equal(currentCanonical[5]?.content, historyUserC.content);
assert.equal(currentCanonical[7]?.content, "STATE_NEW");
assert.deepEqual(currentCanonical, originalCurrent);
assert.deepEqual(oldCanonical, originalPrompt);

const nextCanonical = seedPromptHistoryReplaySnapshot([
  ...currentCanonical.slice(0, 5),
  historyUserC,
  { ...historyAssistantB, content: "Answer C" },
  { role: "user", content: "Question D", contextKind: "history" as const },
  stateOld,
]);
const recursive = tryReplayPromptHistory({
  currentMessages: nextCanonical,
  previousPrompt: replay.prompt,
  previousDescriptor: replay.descriptor,
  scope,
});
assert.ok(recursive);
assert.deepEqual(
  recursive.prompt.slice(replay.prompt.length).map((m) => m.content),
  ["Answer C", "Question D", PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE, "STATE_OLD"],
);

for (const mutate of [
  () => ({ ...historyUserA, content: "Edited A" }),
  () => ({ ...historyAssistantA, role: "user" as const }),
  () => ({ ...historyAssistantA, images: ["data:image/png;base64,AAAA"] }),
]) {
  assert.equal(
    tryReplayPromptHistory({
      currentMessages: seedPromptHistoryReplaySnapshot([
        lore,
        mutate(),
        historyAssistantA,
        historyUserB,
        historyAssistantB,
        stateNew,
        historyUserC,
      ]),
      previousPrompt: oldCanonical,
      previousDescriptor: descriptor,
      scope,
    }),
    null,
  );
}

assert.equal(
  tryReplayPromptHistory({
    currentMessages: currentCanonical,
    previousPrompt: [...oldCanonical, { role: "user", content: "tampered" }],
    previousDescriptor: descriptor,
    scope,
  }),
  null,
);

// Trusted runtime state may follow the current history user. Seeding and replay
// preserve every role and position while snapshot markers stay on trusted systems.
const trustedSystemAfterUser: ChatMessage = {
  role: "system",
  content: "RUNTIME_SNAPSHOT",
  contextKind: "injection",
  providerMetadata: { marinaraPromptHistoryReplaySnapshot: true, marinaraRuntimeContext: true },
};
const userRuntimeAfterUser: ChatMessage = { role: "user", content: "PLAYER_STATE", contextKind: "injection" };
const afterUser = seedPromptHistoryReplaySnapshot([
  lore,
  historyUserA,
  historyAssistantA,
  historyUserB,
  userRuntimeAfterUser,
  trustedSystemAfterUser,
]);
assert.deepEqual(
  afterUser.map(({ role, content }) => [role, content]),
  [
    [lore.role, lore.content],
    [historyUserA.role, historyUserA.content],
    [historyAssistantA.role, historyAssistantA.content],
    [historyUserB.role, historyUserB.content],
    ["system", PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE],
    [userRuntimeAfterUser.role, userRuntimeAfterUser.content],
    ["system", afterUser.at(-1)!.content],
  ],
);
assert.equal(afterUser.at(-1)?.providerMetadata?.marinaraPromptHistoryReplaySnapshotFull, true);
const afterUserDescriptor = createPromptHistoryReplayDescriptor(afterUser, afterUser, scope);
assert.ok(afterUserDescriptor);
const afterUserNext = seedPromptHistoryReplaySnapshot([
  lore,
  historyUserA,
  historyAssistantA,
  historyUserB,
  historyAssistantB,
  historyUserC,
  userRuntimeAfterUser,
  trustedSystemAfterUser,
]);
const afterUserReplay = tryReplayPromptHistory({
  currentMessages: afterUserNext,
  previousPrompt: afterUser,
  previousDescriptor: afterUserDescriptor,
  scope,
});
assert.ok(afterUserReplay);
assert.deepEqual(
  afterUserReplay.prompt.slice(afterUser.length).map(({ role, content }) => [role, content]),
  [
    [historyAssistantB.role, historyAssistantB.content],
    [historyUserC.role, historyUserC.content],
    ["system", PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE],
    [userRuntimeAfterUser.role, userRuntimeAfterUser.content],
    ["system", afterUserNext.at(-1)!.content],
  ],
);

// Only explicitly marked runtime user injections may be archived or compacted.
const formatReminder: ChatMessage = {
  role: "user",
  content: `Format reminder ${"Keep the established output format exactly. ".repeat(20)}`,
  contextKind: "injection",
  providerMetadata: { marinaraRuntimeContext: true, marinaraPromptHistoryReplaySnapshot: true },
};
const markedUserSnapshot = seedPromptHistoryReplaySnapshot([
  lore,
  historyUserA,
  historyAssistantA,
  historyUserB,
  formatReminder,
]);
const storedFormatReminder = markedUserSnapshot.at(-1)!;
assert.equal(storedFormatReminder.role, "user");
assert.equal(storedFormatReminder.providerMetadata?.marinaraPromptHistoryReplaySnapshotFull, true);
assert.ok(storedFormatReminder.content.startsWith('<marinara_replay_snapshot id="'));
const formatDescriptor = createPromptHistoryReplayDescriptor(markedUserSnapshot, markedUserSnapshot, scope);
assert.ok(formatDescriptor);
const markedUserNext = seedPromptHistoryReplaySnapshot([
  lore,
  historyUserA,
  historyAssistantA,
  historyUserB,
  historyAssistantB,
  historyUserC,
  formatReminder,
]);
const formatReplay = tryReplayPromptHistory({
  currentMessages: markedUserNext,
  previousPrompt: markedUserSnapshot,
  previousDescriptor: formatDescriptor,
  scope,
});
assert.ok(formatReplay);
const replayedFormatReminder = formatReplay.appendedMessages.at(-1)!;
assert.equal(replayedFormatReminder.role, "user");
assert.equal(replayedFormatReminder.contextKind, "injection");
assert.equal(replayedFormatReminder.providerMetadata?.marinaraPromptHistoryReplaySnapshotReference, true);
assert.equal(
  replayedFormatReminder.providerMetadata?.marinaraPromptHistoryReplaySnapshotId,
  storedFormatReminder.providerMetadata?.marinaraPromptHistoryReplaySnapshotId,
);
assert.ok(replayedFormatReminder.content.startsWith('<marinara_replay_snapshot_ref id="'));
assert.ok(formatReplay.prompt.some((message) => message.role === "user" && message.content === historyUserC.content));

const compactLore: ChatMessage = { ...lore, content: "Lore" };
const memoryLore: ChatMessage = { ...compactLore, content: `Lore ${"l".repeat(20_000)}` };

// Changed large snapshots reuse only matching literal chunks from the prior
// full snapshot; current metadata and exact reconstructed text remain bound.
const memoryLines = Array.from(
  { length: 48 },
  (_, index) => `Campaign fact ${index}: ${"stable evidence ".repeat(9)}\n`,
);
const memoryOld: ChatMessage = {
  role: "system",
  content: memoryLines.join(""),
  contextKind: "injection",
  providerMetadata: {
    marinaraRuntimeContext: true,
    marinaraPromptHistoryReplaySnapshot: true,
    marinaraCampaignMemory: { diagnostics: "old" },
    continuity: { turn: 1 },
  },
};
const memoryNew: ChatMessage = {
  ...memoryOld,
  content: memoryLines
    .filter((_line, index) => index !== 14)
    .map((line, index) => (index === 25 ? `Campaign fact 26: UPDATED ${"stable evidence ".repeat(9)}\n` : line))
    .join(""),
  providerMetadata: {
    ...memoryOld.providerMetadata,
    marinaraCampaignMemory: { diagnostics: "new and very large".repeat(100) },
    continuity: { turn: 2, diagnostics: "changed" },
  },
};
const memoryOldCanonical = seedPromptHistoryReplaySnapshot([
  memoryLore,
  historyUserA,
  historyAssistantA,
  historyUserB,
  memoryOld,
]);
const memoryDescriptor = createPromptHistoryReplayDescriptor(memoryOldCanonical, memoryOldCanonical, scope);
assert.ok(memoryDescriptor);
const memoryCurrentCanonical = seedPromptHistoryReplaySnapshot([
  memoryLore,
  historyUserA,
  historyAssistantA,
  historyUserB,
  historyAssistantB,
  historyUserC,
  memoryNew,
]);
const memoryReplay = tryReplayPromptHistory({
  currentMessages: memoryCurrentCanonical,
  previousPrompt: memoryOldCanonical,
  previousDescriptor: memoryDescriptor,
  scope,
});
assert.ok(memoryReplay);
const replayedMemory = memoryReplay.appendedMessages.at(-1)!;
assert.equal(replayedMemory.role, "system");
assert.equal(replayedMemory.providerMetadata?.marinaraCampaignMemory !== undefined, true);
assert.equal(replayedMemory.providerMetadata?.continuity !== undefined, true);
assert.match(replayedMemory.content, /marinara_replay_snapshot_chunk_ref/);
const chunkContents = new Map<string, string>();
const chunkPattern =
  /<marinara_replay_snapshot_chunk id="([0-9a-f]{64})">\n([\s\S]*?)<\/marinara_replay_snapshot_chunk>/g;
for (const match of memoryOldCanonical.at(-1)!.content.matchAll(chunkPattern)) chunkContents.set(match[1]!, match[2]!);
const replayBody = replayedMemory.content
  .replace(/^<marinara_replay_snapshot id="[0-9a-f]{64}">\n/, "")
  .replace(/\n<\/marinara_replay_snapshot>$/, "");
const reconstructedMemory = replayBody
  .replace(
    /<marinara_replay_snapshot_chunk_ref id="([0-9a-f]{64})">\n<\/marinara_replay_snapshot_chunk_ref>/g,
    (_whole, id: string) => {
      const source = chunkContents.get(id);
      assert.notEqual(source, undefined, "fragment references resolve to an earlier full literal chunk");
      return source!;
    },
  )
  .replace(/<marinara_replay_snapshot_chunk id="[0-9a-f]{64}">\n([\s\S]*?)<\/marinara_replay_snapshot_chunk>/g, "$1");
assert.equal(reconstructedMemory, memoryNew.content);
assert.ok(memoryReplay.prompt.length < replay.prompt.length + memoryCurrentCanonical.length);

for (const mutation of [
  (message: ChatMessage): ChatMessage => ({ ...message, role: "user" }),
  (message: ChatMessage): ChatMessage => ({
    ...message,
    providerMetadata: { ...message.providerMetadata, stableProducerSetting: "changed" },
  }),
  (message: ChatMessage): ChatMessage => {
    const metadata = { ...message.providerMetadata };
    delete metadata.continuity;
    return { ...message, providerMetadata: metadata };
  },
]) {
  const incompatible = mutation(memoryNew);
  const incompatibleCanonical = seedPromptHistoryReplaySnapshot([
    memoryLore,
    historyUserA,
    historyAssistantA,
    historyUserB,
    historyAssistantB,
    historyUserC,
    incompatible,
  ]);
  const incompatibleReplay = tryReplayPromptHistory({
    currentMessages: incompatibleCanonical,
    previousPrompt: memoryOldCanonical,
    previousDescriptor: memoryDescriptor,
    scope,
  });
  assert.ok(incompatibleReplay);
  assert.doesNotMatch(incompatibleReplay.appendedMessages.at(-1)!.content, /marinara_replay_snapshot_chunk_ref/);
}

// Self-references, malformed blocks and missing source chunks fail closed.
const selfReference = structuredClone(memoryCurrentCanonical);
const selfSnapshot = selfReference.at(-1)!;
const selfMatch = selfSnapshot.content.match(chunkPattern);
assert.ok(selfMatch);
const oldChunkIds = new Set(Array.from(memoryOldCanonical.at(-1)!.content.matchAll(chunkPattern), (match) => match[1]));
const newOnlyChunk = Array.from(selfSnapshot.content.matchAll(chunkPattern)).find(
  (match) => !oldChunkIds.has(match[1]!),
);
assert.ok(newOnlyChunk, "changed snapshot contains a chunk unavailable from prior snapshots");
selfSnapshot.content = selfSnapshot.content.replace(
  newOnlyChunk[0]!,
  `<marinara_replay_snapshot_chunk_ref id="${newOnlyChunk[1]}"></marinara_replay_snapshot_chunk_ref>`,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: selfReference,
    previousPrompt: memoryOldCanonical,
    previousDescriptor: memoryDescriptor,
    scope,
  }),
  null,
);
const malformedOld = structuredClone(memoryOldCanonical);
malformedOld.at(-1)!.content += "<malformed-fragment>";
const malformedDescriptor = createPromptHistoryReplayDescriptor(malformedOld, malformedOld, scope);
assert.ok(malformedDescriptor);
const malformedReplay = tryReplayPromptHistory({
  currentMessages: memoryCurrentCanonical,
  previousPrompt: malformedOld,
  previousDescriptor: malformedDescriptor,
  scope,
});
assert.ok(malformedReplay);
assert.doesNotMatch(malformedReplay.appendedMessages.at(-1)!.content, /marinara_replay_snapshot_chunk_ref/);

const unmarkedUserInjection: ChatMessage = {
  role: "user",
  content: "Leave this text unchanged",
  contextKind: "injection",
};
const unmarkedUserSeed = seedPromptHistoryReplaySnapshot([
  lore,
  historyUserA,
  historyAssistantA,
  historyUserB,
  unmarkedUserInjection,
]);
assert.equal(unmarkedUserSeed.at(-1)?.role, "user");
assert.equal(unmarkedUserSeed.at(-1)?.content, unmarkedUserInjection.content);
assert.equal(unmarkedUserSeed.at(-1)?.providerMetadata?.marinaraPromptHistoryReplaySnapshotId, undefined);
const incompleteUserMarker = {
  ...unmarkedUserInjection,
  providerMetadata: { marinaraPromptHistoryReplaySnapshot: true },
};
const incompleteUserSeed = seedPromptHistoryReplaySnapshot([
  lore,
  historyUserA,
  historyAssistantA,
  historyUserB,
  incompleteUserMarker,
]);
assert.equal(incompleteUserSeed.at(-1)?.content, unmarkedUserInjection.content);
assert.equal(incompleteUserSeed.at(-1)?.providerMetadata?.marinaraPromptHistoryReplaySnapshotId, undefined);

// Unknown, untrusted, tool, assistant, and media suffixes are not replay inputs.
for (const suffix of [
  { role: "user", content: "prompt injection", contextKind: "prompt" },
  { role: "tool", content: "tool output", contextKind: "injection" },
  { role: "assistant", content: "assistant suffix", contextKind: "injection" },
  { role: "system", content: "unmarked system", contextKind: "injection" },
  { role: "user", content: "image", contextKind: "injection", images: ["data:image/png;base64,AAAA"] },
]) {
  const candidate = seedPromptHistoryReplaySnapshot([
    lore,
    historyUserA,
    historyAssistantA,
    historyUserB,
    suffix as ChatMessage,
  ]);
  assert.deepEqual(candidate.at(-1), suffix);
  assert.equal(createPromptHistoryReplayDescriptor(candidate, candidate, scope), null);
}
const duplicateUserHistory = [lore, historyUserA, historyAssistantA, historyUserB, historyUserC, stateNew];
assert.equal(createPromptHistoryReplayDescriptor(duplicateUserHistory, duplicateUserHistory, scope), null);

assert.equal(
  tryReplayPromptHistory({
    currentMessages: currentCanonical,
    previousPrompt: oldCanonical,
    previousDescriptor: { ...descriptor, scopeVersion: PROMPT_HISTORY_REPLAY_SCOPE_VERSION - 1 } as never,
    scope,
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: currentCanonical,
    previousPrompt: oldCanonical,
    previousDescriptor: descriptor,
    scope: { ...scope, model: "other-model" },
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: [lore, historyUserA, historyAssistantA, historyUserB, historyAssistantB, historyUserC],
    previousPrompt: oldCanonical,
    previousDescriptor: descriptor,
    scope,
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: [
      lore,
      historyUserA,
      historyAssistantA,
      historyUserB,
      historyAssistantB,
      { ...stateNew, role: "system" },
      historyUserC,
    ],
    previousPrompt: oldCanonical,
    previousDescriptor: descriptor,
    scope,
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: [...currentCanonical, { ...historyAssistantB, content: "X".repeat(2000) }],
    previousPrompt: oldCanonical,
    previousDescriptor: descriptor,
    scope,
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: seedPromptHistoryReplaySnapshot([
      lore,
      historyUserA,
      historyAssistantA,
      historyUserB,
      historyUserC,
      stateNew,
    ]),
    previousPrompt: oldCanonical,
    previousDescriptor: descriptor,
    scope,
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: seedPromptHistoryReplaySnapshot([
      lore,
      historyUserA,
      historyAssistantA,
      historyUserB,
      { role: "tool", content: "untrusted tool", contextKind: "injection" },
      historyAssistantB,
      historyUserC,
      stateNew,
    ]),
    previousPrompt: oldCanonical,
    previousDescriptor: descriptor,
    scope,
  }),
  null,
);
const hugeStateOld: ChatMessage = {
  ...stateOld,
  content: "STATE_OLD",
  providerMetadata: {
    marinaraPromptHistoryReplaySnapshot: true,
    marinaraRuntimeContext: true,
    largeExcludedDiagnostics: "x".repeat(681_318),
  },
};
const hugeOld = seedPromptHistoryReplaySnapshot([
  compactLore,
  historyUserA,
  historyAssistantA,
  hugeStateOld,
  historyUserB,
]);
const hugeDescriptor = createPromptHistoryReplayDescriptor(hugeOld, hugeOld, scope);
assert.ok(hugeDescriptor);
const compactCurrent = seedPromptHistoryReplaySnapshot(
  currentCanonical.map((message) => (message === lore ? compactLore : message)),
);
const metadataOnlyExpansion = tryReplayPromptHistory({
  currentMessages: seedPromptHistoryReplaySnapshot([
    { ...compactLore, content: `Lore ${"y".repeat(5000)}` },
    historyUserA,
    historyAssistantA,
    historyUserB,
    historyAssistantB,
    historyUserC,
    stateNew,
  ]),
  previousPrompt: seedPromptHistoryReplaySnapshot([
    { ...compactLore, content: `Lore ${"y".repeat(5000)}` },
    historyUserA,
    historyAssistantA,
    historyUserB,
    { ...hugeStateOld, role: "system" },
  ]),
  previousDescriptor: createPromptHistoryReplayDescriptor(
    seedPromptHistoryReplaySnapshot([
      { ...compactLore, content: `Lore ${"y".repeat(5000)}` },
      historyUserA,
      historyAssistantA,
      historyUserB,
      { ...hugeStateOld, role: "system" },
    ]),
    seedPromptHistoryReplaySnapshot([
      { ...compactLore, content: `Lore ${"y".repeat(5000)}` },
      historyUserA,
      historyAssistantA,
      historyUserB,
      { ...hugeStateOld, role: "system" },
    ]),
    scope,
  )!,
  scope,
});
assert.ok(metadataOnlyExpansion);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: compactCurrent,
    previousPrompt: hugeOld,
    previousDescriptor: hugeDescriptor,
    scope,
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: compactCurrent,
    previousPrompt: hugeOld,
    previousDescriptor: hugeDescriptor,
    scope,
    maxContext: 512,
    maxTokens: 32,
  }),
  null,
);
assert.equal(
  createPromptHistoryReplayDescriptor([historyUserA, historyAssistantA, stateOld, historyUserB], [historyUserA], scope),
  null,
);
for (const malformed of [null, undefined, {}]) {
  assert.doesNotThrow(() =>
    tryReplayPromptHistory({
      currentMessages: currentCanonical,
      previousPrompt: oldCanonical,
      previousDescriptor: malformed as never,
      scope,
    }),
  );
}
assert.doesNotThrow(() =>
  tryReplayPromptHistory({
    currentMessages: currentCanonical,
    previousPrompt: [null as never],
    previousDescriptor: { ...descriptor, descriptorVersion: 99 } as never,
    scope,
  }),
);

process.stdout.write("Prompt history replay regression passed.\n");
