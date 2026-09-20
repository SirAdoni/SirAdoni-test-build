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

const canonical = { id: "library:dame-honoria", name: "Dame Honoria Stell" };
const shortAlias = { id: "npc:honoria", name: "Honoria" };

assert.equal(resolve([canonical, shortAlias], "Honoria Stell"), canonical);
assert.equal(resolve([shortAlias, canonical], "Honoria Stell"), canonical, "specific match must beat input order");
assert.equal(resolve([shortAlias, canonical], "HONÓRIA STELL"), canonical, "case and accents normalize");
assert.equal(resolve([shortAlias, canonical], "Honoria"), shortAlias, "exact alias beats longer title");
assert.equal(
  resolve(
    [
      { id: "a", name: "Dame Honoria Stell" },
      { id: "b", name: "Lady Honoria Stell" },
    ],
    "Honoria Stell",
  ),
  undefined,
  "equal canonical matches stay ambiguous",
);
assert.equal(resolve([{ id: "a", name: "Honoria" }], "Unknown Person"), undefined, "unknown names remain unresolved");
assert.equal(resolve([{ id: "a", name: "Honoria" }], "Stell"), undefined, "single unrelated token does not match");
assert.equal(
  resolve([{ id: "a", name: "Dame Honoria Stell" }, { name: "Lady Honoria Stell" }], "Honoria Stell"),
  undefined,
  "a missing identity cannot collapse a tie",
);
assert.equal(
  resolve(
    [
      { id: "same", name: "Dame Honoria Stell" },
      { id: "same", name: "Lady Honoria Stell" },
    ],
    "Honoria Stell",
  )?.id,
  "same",
  "equivalent aliases for one identity may resolve",
);

console.info("Game character name matching regressions passed.");
