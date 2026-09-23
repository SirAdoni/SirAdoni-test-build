import assert from "node:assert/strict";
import { findBestNamedEntry } from "../../packages/client/src/lib/game-character-name-match";

type Candidate = { id?: string; name: string };
const resolve = (entries: Candidate[], target: string) =>
  findBestNamedEntry(
    entries,
    target,
    (entry) => entry.name,
    (entry) => entry.id,
  );

const canonical = { id: "library:dame-wynne", name: "Dame Wynne Brack" };
const shortAlias = { id: "npc:wynne", name: "Wynne" };

assert.equal(resolve([canonical, shortAlias], "Wynne Brack"), canonical);
assert.equal(resolve([shortAlias, canonical], "Wynne Brack"), canonical, "specific match must beat input order");
assert.equal(resolve([shortAlias, canonical], "WÝNNE BRÁCK"), canonical, "case and accents normalize");
assert.equal(resolve([shortAlias, canonical], "Wynne"), shortAlias, "exact alias beats longer title");
assert.equal(
  resolve(
    [
      { id: "a", name: "Dame Wynne Brack" },
      { id: "b", name: "Lady Wynne Brack" },
    ],
    "Wynne Brack",
  ),
  undefined,
  "equal canonical matches stay ambiguous",
);
assert.equal(resolve([{ id: "a", name: "Wynne" }], "Unknown Person"), undefined, "unknown names remain unresolved");
assert.equal(resolve([{ id: "a", name: "Wynne" }], "Brack"), undefined, "single unrelated token does not match");
assert.equal(
  resolve([{ id: "a", name: "Dame Wynne Brack" }, { name: "Lady Wynne Brack" }], "Wynne Brack"),
  undefined,
  "a missing identity cannot collapse a tie",
);
assert.equal(
  resolve(
    [
      { id: "same", name: "Dame Wynne Brack" },
      { id: "same", name: "Lady Wynne Brack" },
    ],
    "Wynne Brack",
  )?.id,
  "same",
  "equivalent aliases for one identity may resolve",
);

console.info("Game character name matching regressions passed.");
