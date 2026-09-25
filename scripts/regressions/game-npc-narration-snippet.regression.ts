// Narration-derived NPC descriptions: speaker-tag residue, vocatives and
// per-game exclusions must never become stored NPC descriptions or new NPCs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "marinara-npc-snippet-"));
process.env.DATA_DIR ??= join(tempRoot, "data");
process.env.FILE_STORAGE_DIR ??= join(tempRoot, "storage");
process.env.LOG_DIR ??= join(tempRoot, "logs");

try {
  const { extractNarrationNpcCandidates } = await import("../../packages/server/src/routes/game.routes.js");
  const { cleanNarrationNpcDescription, mergeNarrationNpcObservations } =
    await import("../../packages/server/src/services/game/npc-character-sync.js");
  const { gameNpcSanitizationOptionsFromMetadata } =
    await import("../../packages/server/src/services/game/npc-avatar-utils.js");

  const describe = (narration: string, name: string, known: string[] = []) =>
    extractNarrationNpcCandidates(narration, [], known).find((candidate) => candidate.name === name)?.description;

  // A speaker-label line is dropped whole: no `" : "Ada.` residue, no vocative description.
  const tagged = '[Older Woman] [side]: "Ada. He\'s sitting down."';
  assert.equal(describe(tagged, "Ada", ["Ada"]), "Ada appears in the current scene.");
  for (const candidate of extractNarrationNpcCandidates(tagged, [], ["Ada"])) {
    assert.doesNotMatch(candidate.description, /^[\s:;,."']/u, "no leading residue");
    assert.doesNotMatch(candidate.description, /"/u, "no quote fragment");
  }
  assert.equal(
    describe(`${tagged}\nAda looks up from the ledger.`, "Ada", ["Ada"]),
    "Ada looks up from the ledger.",
    "a later narration sentence is still used",
  );
  assert.equal(
    describe('Borin: "Come here, Ada."\nThe lamp gutters.', "Ada", ["Ada"]),
    "Ada appears in the current scene.",
    "a plain Name: speaker line is dropped too",
  );

  // Multi-line narration: a quote closing one line never glues onto the next sentence.
  assert.equal(
    describe('Borin shouts, "Come here."\nAda nods and crosses the deck.', "Ada", ["Ada"]),
    "Ada nods and crosses the deck.",
  );

  // The name only inside quoted speech, or a vocative, is never a description.
  assert.equal(describe('"Ada, sit down," Borin said.', "Ada", ["Ada"]), "Ada appears in the current scene.");
  assert.equal(describe("Sit down, Ada.", "Ada", ["Ada"]), "Ada appears in the current scene.");
  assert.equal(describe('"Hello," she said to Ada.', "Ada", ["Ada"]), '"Hello," she said to Ada.');
  assert.equal(
    describe("Ada, the quartermaster, counts the crates.", "Ada", ["Ada"]),
    "Ada, the quartermaster, counts the crates.",
    "an appositive opening is not a vocative",
  );

  // Description writer guard.
  assert.equal(cleanNarrationNpcDescription('" : "Ada.'), "");
  assert.equal(cleanNarrationNpcDescription(': "Ada. He is'), "");
  assert.equal(cleanNarrationNpcDescription("Elara enters."), "Elara enters.");
  const merged = mergeNarrationNpcObservations(
    [
      {
        id: "npc:ada",
        name: "Ada",
        emoji: "x",
        description: "",
        location: "",
        reputation: 0,
        notes: [],
      },
    ],
    [
      { name: "Ada", description: '" : "Ada.' },
      { name: "Borin Hale", description: ': "Ada.' },
    ],
  );
  assert.equal(merged.length, 2, "the guard changes stored text only, never which NPCs exist");
  assert.equal(merged[0]!.observedDescription, undefined, "residue is not stored on an existing NPC");
  assert.equal(merged[1]!.description, "Borin Hale appears in the current scene.");

  // Companions and onboard AIs listed per game never become narration NPCs.
  const policy = gameNpcSanitizationOptionsFromMetadata({ gameNarrationExcludedNpcNames: ["Halcyon", " ", 7] });
  assert.deepEqual(policy.narrationExcludedNames, ["Halcyon"]);
  const aiNarration = '"Hull integrity is holding," Halcyon says.\nOrla Venn says nothing and checks the console.';
  assert.deepEqual(
    extractNarrationNpcCandidates(aiNarration, []).map((candidate) => candidate.name),
    ["Halcyon", "Orla Venn"],
    "without the exclusion the speech-verb pattern picks the AI up",
  );
  assert.deepEqual(
    extractNarrationNpcCandidates(aiNarration, [...(policy.narrationExcludedNames ?? [])]).map(
      (candidate) => candidate.name,
    ),
    ["Orla Venn"],
  );
  assert.deepEqual(gameNpcSanitizationOptionsFromMetadata({}).narrationExcludedNames, []);
  console.log("game-npc-narration-snippet regression passed");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
