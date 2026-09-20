import assert from "node:assert/strict";
import type { GameNpc } from "../../packages/shared/src/index.js";
import {
  buildGameNpcJournalRemovalPatch,
  createJournal,
  type Journal,
} from "../../packages/server/src/services/game/journal.service.js";

function npc(id: string, name: string): GameNpc {
  return {
    id,
    name,
    emoji: "👤",
    description: "",
    location: "",
    reputation: 0,
    notes: [],
  };
}

const journal: Journal = {
  ...createJournal(),
  npcLog: [
    { npcName: "Alex", interactions: ["Spoke at the gate."] },
    { npcName: "Elara", interactions: ["Arrived later."] },
  ],
  entries: [
    { timestamp: "2026-01-01T00:00:00.000Z", type: "npc", title: "👤 Alex", content: "Spoke." },
    { timestamp: "2026-01-01T00:01:00.000Z", type: "npc", title: "👤 Elara", content: "Arrived." },
  ],
};

const firstRemoval = buildGameNpcJournalRemovalPatch(
  {
    gameNpcs: [npc("npc:alex-one", "Alex"), npc("npc:alex-two", "Alex"), npc("npc:elara", "Elara")],
    gameJournal: journal,
    gameIgnoredNpcIds: ["npc:previously-removed"],
  },
  "npc:alex-one",
);

assert.deepEqual(
  firstRemoval.gameNpcs.map((entry) => entry.id),
  ["npc:alex-two", "npc:elara"],
  "an atomic removal must preserve a concurrently added NPC and a distinct same-name identity",
);
assert.deepEqual(firstRemoval.gameIgnoredNpcIds, ["npc:previously-removed", "npc:alex-one"]);
assert.equal(
  firstRemoval.gameJournal.npcLog.some((entry) => entry.npcName === "Alex"),
  true,
  "name-keyed journal history must remain while another same-name NPC is tracked",
);

const secondRemoval = buildGameNpcJournalRemovalPatch(firstRemoval, "npc:alex-two");
assert.deepEqual(
  secondRemoval.gameNpcs.map((entry) => entry.id),
  ["npc:elara"],
  "the second exact same-name identity must be independently removable",
);
assert.equal(
  secondRemoval.gameJournal.npcLog.some((entry) => entry.npcName === "Alex"),
  false,
);
assert.equal(
  secondRemoval.gameJournal.entries.some((entry) => entry.title.includes("Alex")),
  false,
);
assert.equal(
  secondRemoval.gameJournal.npcLog.some((entry) => entry.npcName === "Elara"),
  true,
);

const staleRemoval = buildGameNpcJournalRemovalPatch(
  {
    gameNpcs: [npc("npc:elara", "Elara")],
    gameJournal: journal,
  },
  "npc:already-removed",
);
assert.deepEqual(
  staleRemoval.gameJournal,
  journal,
  "a stale or unknown id must not use client-supplied identity data to prune journal history",
);

const unicodeAliasJournal: Journal = {
  ...createJournal(),
  npcLog: [{ npcName: "Jose", interactions: ["Spoke in the square."] }],
  entries: [
    {
      timestamp: "2026-01-01T00:02:00.000Z",
      type: "npc",
      title: "👤 José",
      content: "Spoke in the square.",
    },
  ],
};
const unicodeAliasRemoval = buildGameNpcJournalRemovalPatch(
  {
    gameNpcs: [npc("npc:jose", "José")],
    gameJournal: unicodeAliasJournal,
  },
  "npc:jose",
);
assert.equal(unicodeAliasRemoval.gameJournal.npcLog.length, 0);
assert.equal(
  unicodeAliasRemoval.gameJournal.entries.length,
  0,
  "server-normalized Unicode aliases must be pruned from the canonical response",
);

console.log("Game NPC journal removal regression passed.");
