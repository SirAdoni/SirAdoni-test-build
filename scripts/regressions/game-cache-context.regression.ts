import assert from "node:assert/strict";
import {
  buildGmSystemPrompt,
  buildGmSystemPromptParts,
  type GmPromptContext,
} from "../../packages/server/src/services/game/gm-prompts.js";
import {
  hasUnstableReferenceMacroSyntax,
  injectGameGmPromptRuntime,
} from "../../packages/server/src/services/generation/game-gm-prompt-runtime.js";
import { normalizePromptCacheLayout } from "../../packages/server/src/services/generation/prompt-cache-layout.js";
import { appendNonLeadingSystemMessagesToLastUser } from "../../packages/server/src/routes/generate/generate-route-utils.js";

const base: GmPromptContext = {
  gameActiveState: "exploration",
  storyArc: "The sealed observatory is waking.",
  plotTwists: ["The observatory serves an older star god."],
  campaignPlan: null,
  map: {
    name: "North Road",
    description: "A wind cut road.",
    type: "node",
    nodes: [{ id: "road", label: "North Road", description: "A road." }],
    edges: [],
    partyPosition: "road",
  } as any,
  npcs: [
    {
      name: "Mara",
      description: "A wary guide",
      location: "North Road",
      notes: ["Owes a favor"],
      reputation: 2,
    } as any,
  ],
  sessionSummaries: [
    {
      sessionNumber: 1,
      summary: "LATEST_DISTINCTIVE_SESSION_SUMMARY",
      resumePoint: "They stand at the sealed door.",
      partyDynamics: "Trust improved.",
      partyState: "Tired but ready.",
      keyDiscoveries: [],
      characterMoments: [],
      littleDetails: [],
      npcUpdates: [],
      statsSnapshot: {},
    } as any,
  ],
  sessionNumber: 2,
  partyNames: ["Ari"],
  partyCards: [{ name: "Ari", card: "Name: Ari\nPersonality: Resolute" }],
  partyCardReferences: [{ name: "Ari", card: "Name: Ari\nPersonality: Resolute" }],
  playerName: "Edmund",
  playerCard: "Name: Edmund\nPersonality: Careful",
  gmCharacterCard: null,
  difficulty: "normal",
  combatStyle: "classic",
  genre: "fantasy",
  setting: "original",
  tone: "balanced",
  rating: "sfw",
  gameSystemPrompt: "Custom system rules: preserve authorial canon.",
  gameSpecialInstructions: "Keep consequences grounded.",
  weatherContext: "Current weather: clear",
  playerNotes: "The key is in Edmund's pack.",
};

const first = buildGmSystemPromptParts(base);
const changed = buildGmSystemPromptParts({
  ...base,
  turnNumber: 9,
  map: { ...base.map, partyPosition: "road-2" } as any,
  partyNames: ["Ari", "Bea"],
  npcs: [{ ...(base.npcs[0] as any), reputation: -4, location: "Observatory" }],
});

assert.equal(first.stable, changed.stable, "stable GM instructions must not vary with runtime state");
assert.notEqual(first.dynamic, changed.dynamic, "dynamic GM context must reflect runtime state");
for (const marker of [
  "<story_arc_secret>",
  "<plot_twists_secret>",
  "<map_state>",
  "<gm_only_tracked_npcs>",
  "<previous_sessions>",
  "<party>",
  "Custom system rules: preserve authorial canon.",
]) {
  assert.match(`${first.stable}\n${first.dynamic}`, new RegExp(marker.replace(/[<>]/g, "\\$&")));
}

assert.equal(buildGmSystemPrompt(base), `${first.stable}\n${first.dynamic}`);

const cachedFirst = buildGmSystemPromptParts(base, { cacheFriendly: true });
const cachedChanged = buildGmSystemPromptParts(
  {
    ...base,
    weatherContext: "Current weather: storm",
    partyNames: ["Ari", "Bea"],
    partyCardRuntime: [{ name: "Ari", card: "Name: Ari\nHP: 3/10" }],
  },
  { cacheFriendly: true },
);
assert.equal(cachedFirst.stable, cachedChanged.stable, "cache-friendly rules stay stable across live state changes");
assert.equal(cachedFirst.reference, cachedChanged.reference, "historical and biography reference stays stable");
assert.notEqual(cachedFirst.dynamic, cachedChanged.dynamic, "weather and membership remain dynamic");
assert.match(cachedFirst.reference ?? "", /Personality: Resolute/u);
assert.match(cachedFirst.reference ?? "", /LATEST_DISTINCTIVE_SESSION_SUMMARY/u);
assert.equal((cachedFirst.reference?.match(/LATEST_DISTINCTIVE_SESSION_SUMMARY/gu) ?? []).length, 1);
assert.doesNotMatch(cachedFirst.reference ?? "", /Current weather:|HP:|Party members accompanying/u);
assert.match(cachedChanged.dynamic, /Current weather: storm/u);
assert.match(cachedChanged.dynamic, /Bea/u);
const editedCard = buildGmSystemPromptParts(
  { ...base, partyCardReferences: [{ name: "Ari", card: "Name: Ari\nPersonality: Cautious" }] },
  { cacheFriendly: true },
);
assert.notEqual(cachedFirst.reference, editedCard.reference, "edited library biography refreshes the reference region");
assert.equal(hasUnstableReferenceMacroSyntax("Name: Ari, greeting {{user}}"), false);
assert.equal(hasUnstableReferenceMacroSyntax("Current time {{time}}"), true);

const runtimeArgs = {
  chatId: "cache-regression",
  chat: {},
  chatMetadata: {
    gameSystemPrompt: "Runtime rules",
    customGmPrompt: "Custom tail {{charName}}",
    gameActiveState: "exploration",
    gameSessionNumber: 1,
    gameSetupConfig: { genre: "fantasy", setting: "original", tone: "balanced" },
  },
  characterIds: [],
  chars: { getById: async () => null, getPersona: async () => null },
  chats: { getById: async () => null, updateMetadata: async () => null },
  selectedGameStateSnapshotPromise: Promise.resolve(null),
  mappedMessages: [{ role: "user" }],
  personaName: "Edmund",
  resolvePromptMacros: (value: string) => value,
  resolveCharacterPromptMacros: (value: string) => value,
};

const legacyMessages: any[] = [{ role: "system", content: "Existing prompt" }];
await injectGameGmPromptRuntime({ ...runtimeArgs, messages: legacyMessages });
assert.equal(legacyMessages.length, 1, "legacy layout keeps one replaced system message");
assert.equal(legacyMessages[0].providerMetadata, undefined);
assert.match(legacyMessages[0].content, /Custom tail/u);

const runtimeMemory = {
  role: "system",
  content: "Preserve this runtime memory",
  contextKind: "injection",
  providerMetadata: { marinaraRuntimeContext: true },
};
const unrelatedSystem = { role: "system", content: "Preserve this unrelated system" };
const historyMessage = { role: "user", content: "Hi" };
const cacheMessages: any[] = [
  runtimeMemory,
  { role: "system", content: "Existing prompt" },
  unrelatedSystem,
  historyMessage,
];
await injectGameGmPromptRuntime({ ...runtimeArgs, messages: cacheMessages, cacheFriendlyLayout: true });
assert.equal(cacheMessages[0].providerMetadata?.marinaraGmStable, true, "cache layout prefixes the stable GM block");
const stableMessage = cacheMessages.find((message) => message.providerMetadata?.marinaraGmStable === true);
const dynamicMessage = cacheMessages.find((message) => message.providerMetadata?.marinaraGmDynamic === true);
assert.ok(stableMessage);
assert.ok(dynamicMessage);
assert.equal(cacheMessages.includes(runtimeMemory), true, "cache layout preserves marked runtime context");
assert.equal(cacheMessages.includes(unrelatedSystem), true, "cache layout preserves unrelated system context");
assert.equal(cacheMessages.includes(historyMessage), true, "cache layout preserves history");
assert.doesNotMatch(stableMessage.content, /Custom tail/u);
assert.match(dynamicMessage.content, /Custom tail/u);

await injectGameGmPromptRuntime({ ...runtimeArgs, messages: cacheMessages, cacheFriendlyLayout: true });
assert.equal(cacheMessages.filter((message) => message.providerMetadata?.marinaraGmStable === true).length, 1);
assert.equal(cacheMessages.filter((message) => message.providerMetadata?.marinaraGmDynamic === true).length, 1);
assert.equal(cacheMessages.includes(runtimeMemory), true, "repeat cache layout preserves marked runtime context");
assert.equal(cacheMessages.includes(unrelatedSystem), true, "repeat cache layout preserves unrelated system context");
assert.equal(cacheMessages.includes(historyMessage), true, "repeat cache layout preserves history");

const macroMessages: any[] = [
  { role: "system", content: "Existing prompt" },
  { role: "system", content: "Unrelated system that must survive" },
  { role: "user", content: "Current turn" },
];
const firstMacroResolveInputs: string[] = [];
await injectGameGmPromptRuntime({
  ...runtimeArgs,
  messages: macroMessages,
  cacheFriendlyLayout: true,
  chatMetadata: {
    ...runtimeArgs.chatMetadata,
    gameSystemPrompt: "Rules with {{time}} and {{random:1:9}}",
  },
  resolvePromptMacros: (value: string) => {
    firstMacroResolveInputs.push(value);
    return value.replace("{{time}}", "12:34").replace("{{random:1:9}}", "7");
  },
});
const macroGm = macroMessages.find((message) => message.content.includes("Rules with 12:34 and 7"));
assert.ok(macroGm, "macro-bearing GM block is still present after one resolution");
assert.equal(macroGm.providerMetadata?.marinaraGmStable, undefined, "macro-bearing GM block is not cache-stable");
assert.equal(
  macroGm.providerMetadata?.marinaraGmDynamic,
  true,
  "macro-bearing GM block is marked GM-owned runtime context",
);
assert.equal(macroGm.contextKind, "prompt");
assert.equal(
  appendNonLeadingSystemMessagesToLastUser(normalizePromptCacheLayout(macroMessages)).find((message) =>
    message.content.includes("Rules with 12:34 and 7"),
  )?.role,
  "system",
  "macro-bearing GM rules retain system authority, including when no static lore exists",
);
assert.equal(macroMessages.filter((message) => message.content.includes("Rules with 12:34 and 7")).length, 1);
assert.equal(firstMacroResolveInputs.filter((value) => value.includes("{{time}}")).length, 1);
assert.equal(
  macroMessages.some((message) => message.content === "Unrelated system that must survive"),
  true,
);

const secondMacroResolveInputs: string[] = [];
await injectGameGmPromptRuntime({
  ...runtimeArgs,
  messages: macroMessages,
  cacheFriendlyLayout: true,
  chatMetadata: {
    ...runtimeArgs.chatMetadata,
    gameSystemPrompt: "Rules with {{time}} and {{random:1:9}}",
  },
  resolvePromptMacros: (value: string) => {
    secondMacroResolveInputs.push(value);
    return value.replace("{{time}}", "12:35").replace("{{random:1:9}}", "8");
  },
});
assert.equal(secondMacroResolveInputs.filter((value) => value.includes("{{time}}")).length, 1);
assert.equal(macroMessages.filter((message) => message.content.includes("Rules with 12:34 and 7")).length, 0);
assert.equal(macroMessages.filter((message) => message.content.includes("Rules with 12:35 and 8")).length, 1);
assert.equal(macroMessages.filter((message) => message.content === "Unrelated system that must survive").length, 1);

// Exercise the real runtime split, including macro expansion before final layout.
const makeReferencePrompt = async (clock: string, hitPoints: number) => {
  const prompt: any[] = [
    { role: "system", content: "Existing prompt" },
    { role: "system", content: "Unrelated system rule", contextKind: "prompt" },
    { role: "assistant", content: "Prior scene", contextKind: "history" },
    { role: "user", content: "Current action", contextKind: "history" },
  ];
  await injectGameGmPromptRuntime({
    ...runtimeArgs,
    messages: prompt,
    cacheFriendlyLayout: true,
    chat: { personaId: "player" },
    chatMetadata: {
      ...runtimeArgs.chatMetadata,
      customGmPrompt: "",
      gameGmCharacterId: "gm",
      gamePartyCharacterIds: ["guide", "clockkeeper"],
      gameCharacterCards: [{ name: "Guide", class: "Ranger", extra: { HP: String(hitPoints) } }],
      gamePreviousSessionSummaries: base.sessionSummaries,
    },
    chars: {
      getById: async (id: string) => ({
        data: {
          name: id === "guide" ? "Guide" : id === "gm" ? "GM" : "Clockkeeper",
          description:
            id === "guide"
              ? "Keeps faith with {{user}}."
              : id === "gm"
                ? "GM authority sentinel"
                : "The hour is {{time}}.",
        },
      }),
      getPersona: async () => ({ name: "Edmund", description: "Player authority sentinel" }),
    },
    resolvePromptMacros: (value: string) => value.replaceAll("{{user}}", "Edmund").replaceAll("{{time}}", clock),
  });
  const normalized = normalizePromptCacheLayout(prompt);
  assert.deepEqual(normalizePromptCacheLayout(normalized), normalized, "reference layout is idempotent");
  return appendNonLeadingSystemMessagesToLastUser(normalized);
};
const referenceBefore = await makeReferencePrompt("12:34", 10);
const referenceAfter = await makeReferencePrompt("12:35", 3);
const historyStart = referenceBefore.findIndex((m) => m.contextKind === "history");
assert.deepEqual(referenceBefore.slice(0, historyStart), referenceAfter.slice(0, historyStart));
for (const needle of ["GM authority sentinel", "Player authority sentinel", "Unrelated system rule"]) {
  assert.equal(referenceBefore.find((m) => m.content.includes(needle))?.role, "system", needle);
}
for (const needle of ["LATEST_DISTINCTIVE_SESSION_SUMMARY", "Keeps faith with Edmund."]) {
  const index = referenceBefore.findIndex((m) => m.content.includes(needle));
  assert.ok(index >= 0 && index < historyStart, `${needle} belongs before history`);
  assert.equal(referenceBefore[index].role, "user", "reference never promotes data to system instructions");
}
const clockIndex = referenceBefore.findIndex((m) => m.content.includes("The hour is 12:34."));
assert.ok(clockIndex > historyStart && clockIndex < referenceBefore.length - 1);
assert.equal(referenceBefore[clockIndex].role, "user");
assert.equal(referenceBefore.filter((m) => m.content.includes("Keeps faith with Edmund.")).length, 1);
assert.match(referenceAfter.find((m) => m.providerMetadata?.marinaraGmDynamic)?.content ?? "", /HP: 3/u);
assert.equal(referenceAfter.at(-1)?.content, "Current action");

console.log("Game cache context regression passed.");
