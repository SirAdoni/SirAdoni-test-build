import assert from "node:assert/strict";
import { validateGeneratedGameMap } from "../../packages/server/src/services/game/game-map-validate.js";
import {
  journalEntryExpectedFromQuery,
  journalEntryMatchesExpected,
  mergeJournalEntryExpected,
} from "../../packages/server/src/services/game/journal-entry-guard.js";

// Good grid map, with string numbers coerced and malformed cells dropped.
{
  const result = validateGeneratedGameMap({
    type: "grid",
    name: "Harbor",
    description: "Docks",
    width: "3",
    height: 2,
    cells: [
      { x: 0, y: 0, emoji: "A", label: "Pier", discovered: true, terrain: "dock" },
      { x: "1", y: "1", emoji: "B", label: "Market", discovered: "true", terrain: "city" },
      { x: 9, y: 0, label: "Out of bounds" },
      { x: 0, y: 0, label: "Duplicate" },
      "garbage",
      { y: 1 },
    ],
    partyPosition: { x: "1", y: 1 },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.map.type, "grid");
    assert.equal(result.map.width, 3);
    assert.equal(result.map.cells?.length, 2);
    assert.deepEqual(result.map.cells?.[1], {
      x: 1,
      y: 1,
      emoji: "B",
      label: "Market",
      discovered: true,
      terrain: "city",
    });
    assert.deepEqual(result.map.partyPosition, { x: 1, y: 1 });
  }
}

// Wrapped node map: single "map" key is unwrapped, bad nodes and dangling edges dropped.
{
  const result = validateGeneratedGameMap({
    map: {
      type: "node",
      name: "Crypt",
      description: "Cold",
      nodes: [
        { id: "a", emoji: "1", label: "Entry", x: "10", y: 20, discovered: true },
        { id: "b", emoji: "2", label: "Hall", x: 50, y: 50 },
        { id: "", x: 1, y: 1 },
        { id: "c", x: "nope", y: 1 },
        { id: "a", x: 5, y: 5 },
      ],
      edges: [{ from: "a", to: "b", label: "stairs" }, { from: "a", to: "zzz" }, null],
      partyPosition: "missing",
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.map.type, "node");
    assert.deepEqual(
      result.map.nodes?.map((n) => [n.id, n.x]),
      [
        ["a", 10],
        ["b", 50],
      ],
    );
    assert.deepEqual(result.map.edges, [{ from: "a", to: "b", label: "stairs" }]);
    assert.equal(result.map.partyPosition, "a");
  }
}

// Malformed inputs are rejected with a message.
const bad: unknown[] = [
  null,
  "a string",
  [],
  { type: "hex", cells: [] },
  { type: "grid", width: 3, cells: [] },
  { type: "grid", width: 3, height: 3 },
  { type: "grid", width: 3, height: 3, cells: [{ x: 10, y: 10 }] },
  { type: "grid", width: 0, height: 3, cells: [{ x: 0, y: 0 }] },
  { type: "node", nodes: [{ id: "a", x: 1, y: 1 }] },
  { type: "node", edges: [] },
  { type: "node", nodes: [{ id: "a" }], edges: [] },
  { map: { type: "grid" }, extra: true },
];
for (const input of bad) {
  const result = validateGeneratedGameMap(input);
  assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
  if (!result.ok) assert.ok(result.error.length > 0);
}

// Journal entry guard.
{
  const entry = { timestamp: "t1", type: "note", title: "Hello", content: "x" };
  assert.equal(journalEntryMatchesExpected(entry, undefined), true);
  assert.equal(journalEntryMatchesExpected(entry, {}), true);
  assert.equal(journalEntryMatchesExpected(entry, { timestamp: "t1", title: "Hello" }), true);
  assert.equal(journalEntryMatchesExpected(entry, { timestamp: "t2" }), false);
  assert.equal(journalEntryMatchesExpected(entry, { type: "quest" }), false);
  assert.equal(journalEntryExpectedFromQuery({}), undefined);
  assert.deepEqual(journalEntryExpectedFromQuery({ expectedTitle: "Hello", other: "x" }), {
    timestamp: undefined,
    type: undefined,
    title: "Hello",
  });
  assert.deepEqual(mergeJournalEntryExpected({ title: "Body" }, { title: "Query", type: "note" }), {
    title: "Body",
    type: "note",
  });
  assert.equal(mergeJournalEntryExpected(undefined, undefined), undefined);
}

console.log("game-map-validate regression passed");
