import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CampaignMemoryEntity, CampaignMemoryFact } from "@marinara-engine/shared";
import {
  buildCampaignMemoryContext,
  resolveFocusEntityIds,
} from "../../packages/server/src/services/game/campaign-memory-context.js";

// The GM's campaign memory block has a fixed budget. It used to lead with characters marked present in the game
// state (only those linked to a card id) and then whoever took part in the newest events, so a question about an
// NPC who was only being talked about could be crowded out. People and places named in the player's message and
// the latest turns now come right after those present, and their current state is shown to the GM.
const provenance = { source: "regression", sourceRevision: "1", actor: "user" as const };
const order = "m1|2026-01-01T00:00:00.000Z|m1";
const content = "The ledger says Elsevere repaired the ward. Poppy repaired the fittings.";
const sourceHash = createHash("sha256").update(content).digest("hex");
const entity = (entityId: string, alias: string, kind: CampaignMemoryEntity["kind"] = "character"): CampaignMemoryEntity => ({
  entityId,
  chatId: "chat",
  kind,
  owner: { type: "registry", store: "campaign-memory", recordId: entityId },
  aliases: [alias],
  tags: [],
  summary: alias,
  attributes: {},
  status: "active",
  manualLock: false,
  provenance,
  revision: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
const fact = (factId: string, subjectEntityId: string, quote: string): CampaignMemoryFact => ({
  factId,
  chatId: "chat",
  subjectEntityId,
  predicate: "event",
  value: quote,
  conditions: [],
  status: "verified",
  validFromOrder: order,
  sourceRevision: "1",
  evidence: [{ messageId: "m1", quote, sourceHash }],
  author: "user",
  provenance,
  manualLock: false,
  revision: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});

const entities = [
  entity("elsevere", "Lady Elsevere Aldareth"),
  entity("poppy", "Poppy Lark"),
  entity("library", "Moonrise Library", "location"),
  entity("al", "Al"),
];

// Only registered names count, whole words, case and accents ignored; short aliases never match inside prose.
assert.deepEqual(
  resolveFocusEntityIds(entities, ["Where is lady elsevere aldareth now?", "She left the moonrise library."]),
  ["elsevere", "library"],
);
assert.deepEqual(resolveFocusEntityIds(entities, ["Al went to the hall. Always."]), [], "aliases under four letters are ignored");
assert.deepEqual(resolveFocusEntityIds(entities, ["Poppy Larkspur"]), [], "a name inside a longer word is not a mention");

const base = {
  chatId: "chat",
  audience: { kind: "gm" as const },
  entities,
  facts: [fact("poppy-fact", "poppy", "Poppy repaired the fittings."), fact("elsevere-fact", "elsevere", "Elsevere repaired the ward.")],
  knowledge: [],
  events: [],
  currentState: [],
  relationships: [],
  sourceContents: { m1: { chatId: "chat", content, sourceHash, captureOrder: order } },
};
const full = buildCampaignMemoryContext({ ...base, maxCharacters: 10_000 });
const oneFactBudget = Math.max(...full.text.split("\n").map((line) => line.length)) + 5;

const unfocused = buildCampaignMemoryContext({ ...base, maxCharacters: oneFactBudget });
assert.equal(unfocused.includedIds.length, 1, "the budget fits exactly one fact");

for (const [focus, expected] of [
  [["elsevere"], "elsevere-fact"],
  [["poppy"], "poppy-fact"],
] as const) {
  const focused = buildCampaignMemoryContext({ ...base, maxCharacters: oneFactBudget, focusEntityIds: focus });
  assert.deepEqual(focused.includedIds, [expected], `the scene about ${focus[0]} keeps that person's memory`);
}

const presentWins = buildCampaignMemoryContext({
  ...base,
  maxCharacters: oneFactBudget,
  presentEntityIds: ["poppy"],
  focusEntityIds: ["elsevere"],
});
assert.deepEqual(presentWins.includedIds, ["poppy-fact"], "someone physically present still comes first");

const characterAudience = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "character", entityId: "poppy" },
  maxCharacters: 10_000,
  focusEntityIds: ["elsevere"],
});
assert.ok(!characterAudience.text.includes("Elsevere repaired"), "focus never grants a character knowledge");

console.log("campaign-memory-scene-focus regression passed");
