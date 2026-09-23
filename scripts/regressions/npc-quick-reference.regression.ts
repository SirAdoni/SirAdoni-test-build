import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCharacterMatcher, type CharacterReference } from "../../packages/client/src/lib/character-references.ts";
import {
  NPC_PEEK_TAG_LIMIT,
  placeNpcPeek,
  readNpcPeekSummary,
  shortenPeekDescription,
} from "../../packages/client/src/lib/npc-quick-reference.ts";

const linked = (text: string, characters: CharacterReference[]) =>
  createCharacterMatcher(characters)(text)
    .filter((part) => part.character)
    .map((part) => [part.text, part.character!.id]);
const joined = (text: string, characters: CharacterReference[]) =>
  createCharacterMatcher(characters)(text)
    .map((part) => part.text)
    .join("");

const tamsin = { id: "tamsin", name: "Tamsin Holloway" };
const ysolde = { id: "ysolde", name: "Ysolde" };
const corvin = { id: "corvin", name: "Captain Corvin Ashe", aliases: ["The Grey Hawk"] };
const roster = [tamsin, ysolde, corvin];

// Whole names, first names, titles stripped, aliases and any casing are matched.
assert.deepEqual(linked("tamsin holloway waved. Ysolde nodded to Corvin Ashe and the grey hawk.", roster), [
  ["tamsin holloway", "tamsin"],
  ["Ysolde", "ysolde"],
  ["Corvin Ashe", "corvin"],
  ["the grey hawk", "corvin"],
]);
// Names inside other words never match; punctuation and line edges are word boundaries.
assert.deepEqual(linked("Ysoldes and Tamsinly, but (Ysolde)! and\nTamsin.", roster), [
  ["Ysolde", "ysolde"],
  ["Tamsin", "tamsin"],
]);
assert.deepEqual(linked("café Ysolde_ x2Ysolde Ysolde2 éYsolde", roster), []);
// Longest name wins over a shorter first-name alias at the same position.
assert.deepEqual(linked("Tamsin Holloway and Tamsin", roster), [
  ["Tamsin Holloway", "tamsin"],
  ["Tamsin", "tamsin"],
]);
// Ambiguous shared first names are left unlinked instead of guessed.
assert.deepEqual(linked("Tamsin arrived.", [tamsin, { id: "other", name: "Tamsin Reed" }]), []);
// Emoji and other astral characters next to names keep boundaries correct.
assert.deepEqual(linked("🗡️Ysolde 𝒜Ysolde Ysolde😀", roster), [
  ["Ysolde", "ysolde"],
  ["Ysolde", "ysolde"],
]);
// Empty inputs.
assert.deepEqual(createCharacterMatcher([])("Ysolde"), [{ text: "Ysolde" }]);
assert.deepEqual(createCharacterMatcher(roster)(""), [{ text: "" }]);

// The message text is never altered: the parts always join back to the input exactly.
for (const text of [
  "Tamsin Holloway, Ysolde and CORVIN ASHE met at dawn.",
  "No names at all here.",
  "İstanbul Ysolde ǅ Tamsin", // case mappings that change string length use the regex fallback
  "Ysolde",
  "  Ysolde  ",
]) {
  assert.equal(joined(text, roster), text);
}
assert.deepEqual(linked("İstanbul Ysolde met Tamsin", roster), [
  ["Ysolde", "ysolde"],
  ["Tamsin", "tamsin"],
]);

// A mixed sentence: full titled name, alias, lower-case first name; a bare surname is not an alias.
assert.deepEqual(
  linked(
    "Captain Corvin Ashe drew his blade. Ysolde laughed; tamsin did not. The Grey Hawk circled while Holloway kept watch.",
    roster,
  ),
  [
    ["Captain Corvin Ashe", "corvin"],
    ["Ysolde", "ysolde"],
    ["tamsin", "tamsin"],
    ["The Grey Hawk", "corvin"],
  ],
);

// Precomputed matching stays fast for a large library and a long message.
const library = Array.from({ length: 1500 }, (_, index) => ({ id: `npc-${index}`, name: `Fenrow${index} Marsh${index}` }));
const matcher = createCharacterMatcher([...library, ...roster]);
const longMessage = `${"The caravan rolled on through dust and rain while Ysolde counted coins. ".repeat(600)}Fenrow1499 Marsh1499`;
const started = performance.now();
for (let run = 0; run < 5; run++) {
  const parts = matcher(longMessage);
  assert.equal(parts.map((part) => part.text).join(""), longMessage);
  assert.equal(parts.filter((part) => part.character?.id === "ysolde").length, 600);
  assert.equal(parts.at(-1)?.character?.id, "npc-1499");
}
assert.ok(performance.now() - started < 2000, "matching a long message against a large library should be quick");

// Card summaries: description shortened at a word boundary, tags deduplicated and capped.
const summary = readNpcPeekSummary({
  id: "x",
  data: JSON.stringify({
    description: `A quiet   cartographer\nfrom the salt flats. ${"Keeps careful notes. ".repeat(40)}`,
    tags: [" scout ", "scout", "", 3, ...Array.from({ length: 12 }, (_, index) => `tag${index}`)],
  }),
});
assert.ok(summary.description.startsWith("A quiet cartographer from the salt flats."));
assert.ok(summary.description.length <= 301 && summary.description.endsWith("…"));
assert.equal(summary.tags[0], "scout");
assert.equal(summary.tags.length, NPC_PEEK_TAG_LIMIT);
assert.deepEqual(readNpcPeekSummary({ data: "{broken" }), { description: "", tags: [] });
assert.deepEqual(readNpcPeekSummary(null), { description: "", tags: [] });
assert.deepEqual(readNpcPeekSummary({ description: "Short.", tags: ["a"] }), { description: "Short.", tags: ["a"] });
assert.equal(shortenPeekDescription("one two three four five", 10), "one two…");
assert.equal(shortenPeekDescription(42), "");

// Popover placement: below when it fits, above near the bottom edge, clamped inside a phone-width viewport.
const viewport = { width: 390, height: 800 };
const size = { width: 288, height: 200 };
assert.deepEqual(placeNpcPeek({ top: 100, bottom: 120, left: 150, width: 60 }, size, viewport), {
  top: 126,
  left: 36,
  above: false,
});
assert.equal(placeNpcPeek({ top: 700, bottom: 720, left: 150, width: 60 }, size, viewport).above, true);
const edge = placeNpcPeek({ top: 100, bottom: 120, left: 360, width: 20 }, size, viewport);
assert.equal(edge.left, 390 - 8 - 288);
assert.equal(placeNpcPeek({ top: 100, bottom: 120, left: 0, width: 20 }, size, viewport).left, 8);

// The popover is portaled, but React still bubbles its events to the message that rendered it.
// Clicks and double-clicks in the card must not reach message tap or double-click-to-edit handlers,
// and Escape from the chat input must not pull focus onto the linked name.
{
  const source = readFileSync(
    fileURLToPath(new URL("../../packages/client/src/components/characters/NpcQuickReference.tsx", import.meta.url)),
    "utf8",
  );
  for (const handler of ["onClick", "onDoubleClick", "onPointerDown", "onPointerUp", "onTouchEnd"]) {
    assert.match(source, new RegExp(`${handler}=\\{stopReactBubbling\\}`), `${handler} must stop React bubbling`);
  }
  assert.doesNotMatch(source, /onClose\(true\);\s*\};\s*const onDown/u, "Escape must not always restore focus");
}

console.info("NPC quick reference regression passed.");
