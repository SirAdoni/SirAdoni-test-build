import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Named-character cards sit in the cached prompt ahead of the chat history. In a real session 7 of 25 GM turns fell
// from 94% to 43% cached because that card list changed: Game Mode rewrote its own NPC cards (Mistress Kriva, Roald),
// created cards for people named long ago that a first-mention order slotted into the middle (Roald, Marshal Dita
// Kovar), and dropped two cards when their people changed status. Each change rewrote about 330,000 tokens of cache.
// Cached cards now keep their cached text and order, nothing leaves the cached part, new people and rewritten cards
// ride in a small uncached section, and that section is folded in only once it grows past a limit.
const root = mkdtempSync(join(tmpdir(), "marinara-named-card-cache-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = `${process.env.DATA_DIR}/storage`; // never the live store named in .env

try {
  const { planNamedCardLayout, layoutNamedCards, NAMED_CARD_FOLD_COUNT } = await import(
    "../../packages/server/src/services/game/named-card-cache.js"
  );
  const { buildGmSystemPromptParts } = await import("../../packages/server/src/services/game/gm-prompts.js");

  const card = (id: string, text = `${id} original`) => ({ id, name: id, card: `Name: ${id}\n${text}` });
  const cachedText = (layout: { stable: Array<{ card: string }> }) => layout.stable.map((entry) => entry.card).join("|");

  // First turn: cache what is there.
  const first = planNamedCardLayout(null, [card("kriva"), card("audrey"), card("danica")]);
  assert.equal(first.stable.length, 3);
  assert.equal(first.updates.length, 0);
  assert.equal(first.changed, true);
  const baseline = cachedText(first);

  // Game Mode rewrites a card: the cached text stays, the new text rides uncached.
  const rewritten = planNamedCardLayout(first.snapshot, [card("kriva", "keeps Blackbird on hard work"), card("audrey"), card("danica")]);
  assert.equal(cachedText(rewritten), baseline, "a rewritten card does not touch the cached prompt");
  assert.deepEqual(rewritten.updates.map((entry) => entry.id), ["kriva"]);
  assert.equal(rewritten.changed, false, "nothing to save while the snapshot is unchanged");

  // A card created for someone named long ago would have gone into the middle; it now rides uncached.
  const created = planNamedCardLayout(first.snapshot, [card("roald"), card("kriva"), card("audrey"), card("danica")]);
  assert.equal(cachedText(created), baseline, "a newly named person does not reshuffle the cached cards");
  assert.deepEqual(created.updates.map((entry) => entry.id), ["roald"]);

  // Someone leaving the selection (joining the party) stays cached instead of shifting every card after them.
  const dropped = planNamedCardLayout(first.snapshot, [card("kriva"), card("audrey")]);
  assert.equal(cachedText(dropped), baseline, "a card that leaves the selection is kept, so nothing after it shifts");
  assert.equal(dropped.updates.length, 0);

  // Order of the live selection does not matter.
  const reordered = planNamedCardLayout(first.snapshot, [card("danica"), card("audrey"), card("kriva")]);
  assert.equal(cachedText(reordered), baseline);

  // Enough waiting changes fold in once: rewritten cards replace their cached text in place, new people append.
  const many = [
    card("kriva", "rewritten"),
    card("audrey"),
    card("danica"),
    ...Array.from({ length: NAMED_CARD_FOLD_COUNT - 1 }, (_, i) => card(`new${i}`)),
  ];
  const folded = planNamedCardLayout(first.snapshot, many);
  assert.equal(folded.folded, true);
  assert.equal(folded.updates.length, 0);
  assert.deepEqual(
    folded.stable.map((entry) => entry.id),
    ["kriva", "audrey", "danica", ...Array.from({ length: NAMED_CARD_FOLD_COUNT - 1 }, (_, i) => `new${i}`)],
    "existing cards keep their positions; new people are appended",
  );
  assert.match(folded.stable[0]!.card, /rewritten/u);

  // A long waiting section folds by size too.
  const big = planNamedCardLayout(first.snapshot, [card("kriva", "x".repeat(40_000)), card("audrey"), card("danica")]);
  assert.equal(big.folded, true);

  // Persistence: the snapshot survives between turns, so the cached part is identical on the next request.
  const turnOne = await layoutNamedCards("chat-1", [card("kriva"), card("audrey")]);
  const turnTwo = await layoutNamedCards("chat-1", [card("kriva", "rewritten"), card("audrey"), card("roald")]);
  assert.equal(cachedText(turnTwo), cachedText(turnOne));
  assert.deepEqual(turnTwo.updates.map((entry) => entry.id).sort(), ["kriva", "roald"]);

  // Prompt placement: cached cards go to reference blocks; updates go to the uncached per-turn section only.
  const ctx = {
    gameActiveState: "exploration",
    storyArc: null,
    plotTwists: null,
    map: null,
    npcs: [],
    sessionSummaries: [],
    sessionNumber: 10,
    partyNames: [],
    partyCards: [],
    playerName: "Rowan Mercer",
    gmCharacterCard: null,
    difficulty: "normal",
    genre: "fantasy",
    setting: "original",
    tone: "balanced",
    rating: "nsfw",
    sceneCharacterCards: [{ name: "kriva", card: "Name: kriva\nold text" }],
    sceneCharacterCardUpdates: [{ name: "kriva", card: "Name: kriva\nnew text" }],
  } as any;
  const parts = buildGmSystemPromptParts(ctx, { cacheFriendly: true });
  const references = (parts.referenceBlocks ?? []).join("\n");
  assert.match(references, /old text/u);
  assert.ok(!references.includes("new text"), "updates never enter the cached reference blocks");
  assert.match(parts.dynamic, /<named_character_updates>[\s\S]*new text/u);

  console.log("game-named-card-cache regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
