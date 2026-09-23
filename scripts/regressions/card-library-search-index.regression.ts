// The prebuilt card search index (normalized once per loaded list) must answer exactly
// like the per-keystroke matcher it replaced, for characters and plain documents.
import assert from "node:assert/strict";
import {
  buildCardLibrarySearchIndex,
  matchesCardLibrarySearch,
  matchesCardLibrarySearchIndex,
  parseCardLibrarySearchQuery,
  type CardLibrarySearchDocument,
} from "../../packages/client/src/lib/card-library-search.js";
import {
  buildCharacterSearchIndex,
  getCharacterSearchDocument,
} from "../../packages/client/src/components/panels/library/character-search-index.js";

const characters = [
  {
    comment: "The Keeper",
    parsed: {
      name: "Hero A",
      creator: "  someone ",
      character_version: "2.1",
      description: "Keeps the ＲＥＣＯＲＤＳ of the  old   city.",
      personality: "Patient",
      scenario: "A flooded library",
      first_mes: "Welcome back.",
    },
    tags: ["Scholar", "Fantasy"],
  },
  {
    comment: null,
    parsed: { name: "Hero B", creator_notes: "Built for salvage work", description: 42, scenario: undefined },
    tags: ["Sci-Fi", "robot"],
  },
  { comment: "", parsed: {}, tags: [] },
];

const documents: CardLibrarySearchDocument[] = [
  { name: "Only a name" },
  { name: "Tagged", tags: ["Horror", "Slow Burn"], sections: [{ content: "A cabin in the woods" }, { content: null }] },
  { title: "  ", summary: "No creator notes yet.", meta: "someone · v1" },
];

const queries = [
  "",
  "   ",
  "hero a",
  "records",
  "old city",
  "OLD   CITY",
  "keeper",
  "v2.1",
  "someone",
  "salvage",
  "robot",
  "-robot",
  "hero -robot",
  "!#fantasy",
  '-tag:"slow burn"',
  "cabin -horror",
  "no creator notes",
  "welcome",
  "nothing matches this",
];

let checks = 0;
for (const query of queries.map(parseCardLibrarySearchQuery)) {
  for (const character of characters) {
    const document = getCharacterSearchDocument(character, character.tags);
    const index = buildCharacterSearchIndex(character, character.tags);
    assert.equal(
      matchesCardLibrarySearchIndex(index, query),
      matchesCardLibrarySearch(document, query),
      `${character.parsed.name ?? "(unnamed)"} / ${JSON.stringify(query)}`,
    );
    checks += 1;
  }
  for (const document of documents) {
    assert.equal(
      matchesCardLibrarySearchIndex(buildCardLibrarySearchIndex(document), query),
      matchesCardLibrarySearch(document, query),
      `${String(document.name ?? document.title)} / ${JSON.stringify(query)}`,
    );
    checks += 1;
  }
}

// Spot checks so the equivalence cannot pass by both sides being wrong.
const heroA = buildCharacterSearchIndex(characters[0]!, characters[0]!.tags);
assert.equal(matchesCardLibrarySearchIndex(heroA, parseCardLibrarySearchQuery("old city")), true);
assert.equal(matchesCardLibrarySearchIndex(heroA, parseCardLibrarySearchQuery("records -scholar")), false);
assert.equal(matchesCardLibrarySearchIndex(heroA, parseCardLibrarySearchQuery("salvage")), false);

console.log(`card-library-search-index regression passed (${checks} comparisons)`);
