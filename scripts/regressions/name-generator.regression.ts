import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NAME_GENDERS,
  createSeededRandom,
  extractTrainingNames,
  generateNameAt,
  generateNames,
  isUsableMarkovModel,
  trainMarkovNameModel,
  type NameStyleId,
} from "../../packages/client/src/lib/name-generator.js";

// The offline name generator is pure and seeded: same seed and options, same names;
// each slot depends only on the seed and its index (which is what lets the UI lock
// slots and regenerate the rest); every style and gender produces readable names.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// ── Seeded randomness ──
const a = createSeededRandom("seed");
const b = createSeededRandom("seed");
const first = Array.from({ length: 5 }, () => a());
assert.deepEqual(
  first,
  Array.from({ length: 5 }, () => b()),
);
assert.ok(first.every((value) => value >= 0 && value < 1));
assert.notDeepEqual(first, Array.from({ length: 5 }, createSeededRandom("other")));

// ── Syllable styles ──
const styles: NameStyleId[] = ["northern", "elvish", "desert", "imperial"];
for (const style of styles) {
  for (const gender of NAME_GENDERS) {
    const options = { style, gender, surname: true, seed: "fixture" } as const;
    const names = generateNames(options, 8);
    assert.equal(names.length, 8, `${style}/${gender} fills the list`);
    assert.deepEqual(generateNames(options, 8), names, `${style}/${gender} is deterministic`);
    assert.equal(new Set(names.map((name) => name.given.toLowerCase())).size, 8, "no duplicate given names");
    for (const name of names) {
      assert.match(name.given, /^\p{Lu}\p{Ll}{2,11}$/u, `${style}/${gender} given name reads as a name: ${name.given}`);
      assert.ok(name.surname && name.surname.length >= 3, `${style} surname present: ${name.full}`);
      assert.equal(name.full, `${name.given} ${name.surname}`);
      assert.doesNotMatch(name.full, /[aeiouy]{3}/i, `no triple vowels: ${name.full}`);
    }
  }
}

const noSurname = generateNames({ style: "elvish", seed: 7, surname: false }, 4);
assert.ok(noSurname.every((name) => name.surname === null && name.full === name.given));

// Changing the seed changes the list.
assert.notDeepEqual(
  generateNames({ style: "northern", seed: "one" }, 6).map((name) => name.full),
  generateNames({ style: "northern", seed: "two" }, 6).map((name) => name.full),
);

// Slot independence: slot 3 is the same whether or not slots 0-2 were generated.
const options = { style: "imperial", gender: "feminine", surname: true, seed: "lock" } as const;
assert.deepEqual(generateNameAt(options, 3), generateNameAt(options, 3));
assert.deepEqual(
  generateNames(options, 4)[3],
  generateNameAt(options, 3, new Set(generateNames(options, 3).map((n) => n.given.toLowerCase()))),
);

// Gender hints change the ending, not just the dice.
const feminineImperial = generateNames({ style: "imperial", gender: "feminine", seed: "g" }, 10);
assert.ok(
  feminineImperial.filter((name) => /(a|ia|ina|illa|essa|ella|ana)$/i.test(name.given)).length >= 8,
  "feminine imperial names mostly end in feminine endings",
);
const masculineNorthern = generateNames({ style: "northern", gender: "masculine", surname: true, seed: "g" }, 10);
assert.ok(
  masculineNorthern.every((name) => !/sdottir$/.test(name.surname ?? "")),
  "no daughter-names for masculine",
);

// ── Learned style ──
const extracted = extractTrainingNames([
  "Seraphine Valdes",
  "The Court of Quennevar",
  "Lady Isolde",
  "celestine lowercase is skipped",
  "Oriane, Maelis; Aurelie",
  "Genevieve (Solenne)",
  "Seraphine",
]);
assert.deepEqual(extracted, [
  "Seraphine",
  "Valdes",
  "Quennevar",
  "Isolde",
  "Oriane",
  "Maelis",
  "Aurelie",
  "Genevieve",
  "Solenne",
]);

const model = trainMarkovNameModel(extracted);
assert.ok(isUsableMarkovModel(model));
assert.ok(!isUsableMarkovModel(trainMarkovNameModel(["Ab"])), "too little material is not usable");
assert.equal(model.known.length, extracted.length);
assert.equal(model.transitions["^^"]?.s, 2, "start context counts first letters (Seraphine, Solenne)");

const learned = generateNames({ style: "learned", seed: "lore", surname: true, model }, 8);
assert.equal(learned.length, 8);
assert.deepEqual(generateNames({ style: "learned", seed: "lore", surname: true, model }, 8), learned);
const known = new Set(model.known);
assert.ok(learned.filter((name) => !known.has(name.given.toLowerCase())).length >= 6, "mostly new names, not copies");
for (const name of learned) {
  const letters = [...name.given.toLowerCase()];
  // Every adjacent pair must exist somewhere in training: that is what a Markov name is.
  for (let index = 1; index < letters.length; index += 1) {
    const pair = letters[index - 1]! + letters[index]!;
    assert.ok(
      model.known.some((word) => word.includes(pair)),
      `${name.given}: "${pair}" came from training`,
    );
  }
}
assert.throws(() => generateNames({ style: "learned", seed: 1 }, 2), /trained name model/);

// ── UI wiring ──
const renderer = read("../../packages/client/src/components/layout/ModalRenderer.tsx");
assert.match(renderer, /case "name-generator":\s*content = <NameGeneratorModal open onClose=\{closeModal\} \/>;/);
assert.match(read("../../packages/client/src/lib/open-name-generator.ts"), /openModal\("name-generator"\)/);
