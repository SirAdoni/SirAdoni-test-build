import assert from "node:assert/strict";
import type { GameNpc } from "@marinara-engine/shared";
import { buildPartySpeakerSystemPrompt, extractPartyReputationActions, rejectCrossSpeakerPartyLines } from "../../packages/server/src/services/game/party-prompts.js";
import {
  isSupportedReputationAction,
  processReputationActions,
  REPUTATION_ACTIONS,
} from "../../packages/server/src/services/game/reputation.service.js";

const npc = (id: string, name: string): GameNpc => ({
  id,
  name,
  emoji: "👤",
  description: "",
  location: "",
  reputation: 0,
  notes: [],
});

assert.ok(REPUTATION_ACTIONS.includes("helped"));
assert.equal(isSupportedReputationAction("helped"), true);
assert.equal(isSupportedReputationAction("helped the player"), false);
assert.equal(isSupportedReputationAction("custom", 0), true);
assert.equal(isSupportedReputationAction("custom", Number.NaN), false);

const partyPrompt = buildPartySpeakerSystemPrompt({
  speaker: { name: "Alice", card: "A thoughtful companion." },
  partyRoster: ["Alice", "Bob"],
  playerName: "Player",
  gameActiveState: "dialogue",
});
assert.ok(REPUTATION_ACTIONS.every((action) => partyPrompt.includes(action)));
assert.match(partyPrompt, /optional modifier from -100 to 100/u);
const partyTag = `[reputation: npc="Alice" action="helped"]`;
const partyActions = extractPartyReputationActions(partyTag);
assert.deepEqual(partyActions, [{ npcId: "Alice", action: "helped" }]);
assert.equal(processReputationActions([npc("alice", "Alice")], partyActions).npcs[0]?.reputation, 15);
assert.deepEqual(
  processReputationActions([npc("alice", "Alice")], extractPartyReputationActions(`[reputation: npc="Alice" action="manual" modifier="101"]`)).changes,
  [],
  "party custom modifiers above the reputation scale are rejected",
);
assert.throws(
  () => rejectCrossSpeakerPartyLines(`[reputation: npc="Bob" action="helped"]`, "Alice", ["Alice", "Bob"]),
  /another character's reputation/u,
);
const original = [npc("alice", "Alice")];
const unsupported = processReputationActions(original, [{ npcId: "Alice", action: "Alice smiled warmly" }]);
assert.deepEqual(unsupported.changes, [], "free-text model output cannot silently become a zero-score event");
assert.equal(unsupported.npcs[0]?.reputationObserved, undefined);
assert.equal(original[0]?.reputationObserved, undefined, "rejected events do not mutate saved NPCs");

const observedNeutral = processReputationActions(original, [{ npcId: "alice", action: "questioned" }]);
assert.equal(observedNeutral.npcs[0]?.reputation, 0);
assert.equal(observedNeutral.npcs[0]?.reputationObserved, true, "a supported explicit-zero event is observed");

const changed = processReputationActions(original, [{ npcId: "Alice", action: "helped" }]);
assert.equal(changed.npcs[0]?.reputation, 15);
assert.equal(changed.npcs[0]?.reputationObserved, true);
assert.equal(changed.changes.length, 1);

const ambiguous = processReputationActions(
  [npc("alice-1", "Alice"), npc("alice-2", "Alice")],
  [{ npcId: "Alice", action: "helped" }],
);
assert.deepEqual(ambiguous.changes, [], "name collisions cannot credit an arbitrary NPC");
assert.equal(
  processReputationActions([npc("alice-1", "Alice"), npc("alice-2", "Alice")], [{ npcId: "alice-2", action: "helped" }])
    .changes[0]?.npcId,
  "alice-2",
  "stable NPC IDs remain accepted when names collide",
);

const custom = processReputationActions(original, [{ npcId: "alice", action: "manual", modifier: -40 }]);
assert.equal(custom.npcs[0]?.reputation, -40);
assert.equal(custom.npcs[0]?.reputationObserved, true);
