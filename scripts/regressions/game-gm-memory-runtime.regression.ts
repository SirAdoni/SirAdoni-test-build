import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendGameGmCampaignMemory,
  injectGameGmPromptRuntime,
  limitGameGmSessionSummaries,
  selectFocusedGamePartyIds,
} from "../../packages/server/src/services/generation/game-gm-prompt-runtime.js";
import { buildCampaignMemoryContext } from "../../packages/server/src/services/game/campaign-memory-context.js";

const provenance = { source: "regression", sourceRevision: "1", actor: "user" as const };
const entity = {
  entityId: "char-ari",
  chatId: "gm-memory-regression",
  kind: "character" as const,
  owner: { type: "registry" as const, store: "campaign-memory" as const, recordId: "char-ari" },
  aliases: ["Ari"],
  tags: [],
  attributes: {},
  status: "active" as const,
  manualLock: false,
  provenance,
  revision: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const fact = {
  factId: "fact-verified",
  chatId: entity.chatId,
  subjectEntityId: entity.entityId,
  predicate: "has_key",
  value: "observatory-key",
  conditions: [],
  status: "verified" as const,
  sourceRevision: "1",
  evidence: [],
  author: "user" as const,
  provenance,
  manualLock: false,
  revision: 1,
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
};

function memory(stableFact = fact) {
  return buildCampaignMemoryContext({
    chatId: entity.chatId,
    audience: { kind: "gm" },
    entities: [entity],
    facts: [stableFact],
    knowledge: [],
    events: [],
    currentState: [],
    relationships: [],
    maxCharacters: 2000,
  });
}

const messages: any[] = [
  {
    role: "system",
    content: "Stable GM rules",
    providerMetadata: { marinaraGmStable: true },
  },
  {
    role: "system",
    content: "Current GM state",
    contextKind: "injection",
    providerMetadata: { marinaraGmDynamic: true },
  },
];
const stableHash = () => createHash("sha256").update(messages[0].content).digest("hex");
const before = stableHash();
appendGameGmCampaignMemory(messages, memory());
assert.equal(stableHash(), before, "campaign memory must not alter the stable cache prefix");
assert.equal(messages.at(-1)?.contextKind, "injection");
assert.equal(messages.at(-1)?.providerMetadata?.marinaraRuntimeContext, true);
assert.match(messages.at(-1)?.content ?? "", /fact-verified/u);
assert.equal(messages.at(-1)?.providerMetadata?.marinaraCampaignMemory?.audience, "gm");
const emptyMessages: any[] = [{ role: "system", content: "Stable GM rules" }];
appendGameGmCampaignMemory(
  emptyMessages,
  buildCampaignMemoryContext({
    chatId: entity.chatId,
    audience: { kind: "gm" },
    entities: [],
    facts: [],
    knowledge: [],
    events: [],
    currentState: [],
    relationships: [],
    maxCharacters: 2000,
  }),
);
assert.equal(emptyMessages.length, 1, "empty campaign memory adds no prompt block");

const held = { ...fact, factId: "fact-held", status: "held" as const, value: "held-secret" };
const proposed = { ...fact, factId: "fact-proposed", status: "proposed" as const, value: "proposed-secret" };
const filtered = buildCampaignMemoryContext({
  chatId: entity.chatId,
  audience: { kind: "gm" },
  entities: [entity],
  facts: [held, proposed],
  knowledge: [],
  events: [],
  currentState: [],
  relationships: [],
  maxCharacters: 2000,
});
assert.doesNotMatch(filtered.text, /held-secret|proposed-secret/u, "held/proposed memory is not GM truth");

const characterBoundary = buildCampaignMemoryContext({
  chatId: entity.chatId,
  audience: { kind: "character", entityId: entity.entityId },
  entities: [entity],
  facts: [fact],
  knowledge: [],
  events: [],
  currentState: [],
  relationships: [],
  maxCharacters: 2000,
});
assert.equal(characterBoundary.text, "", "facts are not character knowledge without an explicit grant");

const currentState = buildCampaignMemoryContext({
  chatId: entity.chatId,
  audience: { kind: "gm" },
  entities: [entity],
  facts: [fact],
  knowledge: [],
  events: [
    {
      eventId: "event-current",
      chatId: entity.chatId,
      occurrenceOrder: "message-1",
      participantEntityIds: [entity.entityId],
      sourceRevision: "1",
      transitions: ["key moved to Ari"],
      evidence: [],
      provenance,
      immutable: true,
      createdAt: entity.createdAt,
    },
  ],
  currentState: [
    {
      stateId: "state-current",
      chatId: entity.chatId,
      entityId: entity.entityId,
      property: "inventory.key",
      value: "observatory-key",
      sourceEventId: "event-current",
      validAtOrder: "message-1",
      protected: false,
      provenance,
      manualLock: false,
      revision: 1,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    },
  ],
  relationships: [],
  maxCharacters: 2000,
});
assert.match(
  currentState.text,
  /^\[current_state\]\nchar-ari\.inventory\.key = observatory-key \(since message-1, source event event-current\)\n\[fact /u,
  "current state renders in its own section ahead of facts",
);
assert.equal(currentState.currentStateCount, 1);

console.log("Game GM memory runtime regression passed.");

const summaries = [
  { sessionNumber: 3, summary: "third", resumePoint: "third" },
  { sessionNumber: 1, summary: "first", resumePoint: "first" },
  { sessionNumber: 2, summary: "second", resumePoint: "second" },
];
const limited = limitGameGmSessionSummaries(summaries, 2);
assert.deepEqual(
  limited.map((summary) => summary.sessionNumber),
  [2, 3],
);
assert.deepEqual(
  summaries.map((summary) => summary.sessionNumber),
  [3, 1, 2],
);
assert.deepEqual(limitGameGmSessionSummaries(summaries, undefined), summaries);

const focusedIds = selectFocusedGamePartyIds({
  party: [
    { id: "char-ari", name: "Maybelle Meadowsweet" },
    { id: "char-bex", name: "Bex" },
    { id: "npc-lyra", name: "Lyra" },
    { id: "char-princess", name: "Princess Ysolde" },
    { id: "char-countess", name: "Countess Vey" },
  ],
  presentCharacters: [{ characterId: "npc-lyra", name: "Lyra" }],
  mappedMessages: [
    { role: "assistant", content: "An older turn mentioning Maybelle." },
    ...Array.from({ length: 8 }, () => ({ role: "assistant", content: "A quiet beat." })),
    { role: "user", content: "Maybelle checks the map while Bex watches. The banner is torn; a princess passes." },
  ],
});
assert.deepEqual(
  [...focusedIds].sort(),
  ["char-ari", "char-bex", "npc-lyra"],
  "focus uses aliases and current presence",
);
assert.deepEqual(
  [
    ...selectFocusedGamePartyIds({
      party: [{ id: "char-ari", name: "Ari" }],
      presentCharacters: [],
      mappedMessages: [{ role: "user" }],
    }),
  ],
  [],
  "missing evidence requests the runtime fallback to full detail",
);

const runtimeMetadata: Record<string, unknown> = {
  gamePromptFocusedCharacterReferences: true,
  gamePartyCharacterIds: ["char-maybelle", "char-anna"],
  gameSetupConfig: { genre: "fantasy", setting: "original", tone: "balanced" },
};
const runtimeMessages: any[] = [];
const runtimeResult = await injectGameGmPromptRuntime({
  messages: runtimeMessages,
  chatId: "focused-gm-regression",
  chat: {},
  chatMetadata: runtimeMetadata,
  characterIds: [],
  chars: {
    getById: async (id: string) =>
      id === "char-maybelle"
        ? { data: { name: "Maybelle Meadowsweet", description: "The relevant party member" } }
        : id === "char-anna"
          ? { data: { name: "Anna", description: "The quiet party member" } }
          : null,
    getPersona: async () => null,
  },
  chats: { getById: async () => null, updateMetadata: async () => null },
  selectedGameStateSnapshotPromise: Promise.resolve({ presentCharacters: JSON.stringify([]) }),
  mappedMessages: [
    { role: "system", contextKind: "injection", content: "Anna appears in an unrelated runtime block." },
    { role: "user", content: "Maybelle steps forward; the banner falls." },
  ],
  personaName: "Rowan",
  resolvePromptMacros: (value: string) => value,
  resolveCharacterPromptMacros: (value: string) => value,
});
assert.deepEqual(runtimeResult.gmCtx.partyNames, ["Maybelle Meadowsweet", "Anna"]);
assert.deepEqual(
  runtimeResult.gmCtx.partyCards?.map((card) => card.name),
  ["Maybelle Meadowsweet"],
);
