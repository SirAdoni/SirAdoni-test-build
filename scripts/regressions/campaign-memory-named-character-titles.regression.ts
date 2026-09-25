import assert from "node:assert/strict";

// Short-name aliases skipped only the titles on a fixed list, so "Sergeant Holt" kept "Sergeant" as its first-name
// alias and every sergeant in prose matched that one card. Chaplain, marshal, serjeant, sergeant, founder, madam,
// commandant, lamp-master and under-gardener are now titles, hyphenated ones whether written joined or apart, and a
// title is never kept as a short name on its own.
const { countNamedCharacterFirstNames, namedCharacterAliases, selectNamedCharacterIds } =
  await import("../../packages/server/src/services/game/named-characters.js");

const names = [
  "Sergeant Holt",
  "Serjeant Pellow Ames",
  "Chaplain Oswin Reade",
  "Marshal Idony Crane",
  "Founder Aldith",
  "Madam Quenby",
  "Commandant Rhosyn Vale",
  "Lamp-Master Tobin",
  "Under-Gardener Wynn Hale",
  "Lamp Master Esker Moss",
  "Sergeant",
];
const counts = countNamedCharacterFirstNames(names);
const aliases = (name: string) => namedCharacterAliases(name, counts);

assert.deepEqual(aliases("Sergeant Holt"), ["Sergeant Holt", "Holt"]);
assert.deepEqual(aliases("Serjeant Pellow Ames"), ["Serjeant Pellow Ames", "Pellow Ames", "Pellow"]);
assert.deepEqual(aliases("Chaplain Oswin Reade"), ["Chaplain Oswin Reade", "Oswin Reade", "Oswin"]);
assert.deepEqual(aliases("Marshal Idony Crane"), ["Marshal Idony Crane", "Idony Crane", "Idony"]);
assert.deepEqual(aliases("Founder Aldith"), ["Founder Aldith", "Aldith"]);
assert.deepEqual(aliases("Madam Quenby"), ["Madam Quenby", "Quenby"]);
assert.deepEqual(aliases("Commandant Rhosyn Vale"), ["Commandant Rhosyn Vale", "Rhosyn Vale", "Rhosyn"]);
assert.deepEqual(aliases("Lamp-Master Tobin"), ["Lamp-Master Tobin", "Tobin"], "a hyphenated title is skipped whole");
assert.deepEqual(aliases("Under-Gardener Wynn Hale"), ["Under-Gardener Wynn Hale", "Wynn Hale", "Wynn"]);
assert.deepEqual(aliases("Lamp Master Esker Moss"), ["Lamp Master Esker Moss", "Esker Moss", "Esker"], "a hyphenated title written apart is skipped too");
// A card named only by a title keeps its full name but never a bare title as a short name.
assert.deepEqual(aliases("Sergeant"), ["Sergeant"]);
assert.deepEqual(aliases("Madam Sergeant"), ["Madam Sergeant"], "all-title names keep only the full name");
for (const name of names)
  for (const alias of aliases(name))
    if (alias !== name)
      assert.ok(
        !["sergeant", "serjeant", "chaplain", "marshal", "founder", "madam", "commandant", "lamp-master", "under-gardener", "master", "lamp"].includes(alias.toLowerCase()),
        `${name} must not alias to the title ${alias}`,
      );

// In prose: a bare "the sergeant" names nobody; "Holt" names the sergeant.
const library = [
  { id: "c-holt", name: "Sergeant Holt" },
  { id: "c-tobin", name: "Lamp-Master Tobin" },
];
assert.deepEqual(selectNamedCharacterIds({ library, texts: ["The Sergeant waves. A Lamp-Master passes."] }), []);
assert.deepEqual(selectNamedCharacterIds({ library, texts: ["Tobin trims the wick while Holt watches."] }), ["c-tobin", "c-holt"]);

console.log("campaign-memory-named-character-titles regression passed");
