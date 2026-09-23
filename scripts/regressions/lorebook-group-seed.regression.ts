import assert from "node:assert/strict";
import { createLorebookEntrySchema } from "../../packages/shared/src/schemas/lorebook.schema.js";
import type { LorebookEntry } from "../../packages/shared/src/types/lorebook.js";
import { scanForActivatedEntries } from "../../packages/server/src/services/lorebook/keyword-scanner.js";

// An inclusion group activates one of its matching entries per generation. The winner used to be re-rolled with
// Math.random on every turn, so with several matching entries (one "Threads - <character>" entry per character in a
// shared "threads" group) a different character's lore landed near the top of the prompt each turn and broke prompt
// caching. With a group seed (the chat id), the same candidates must give the same winner on every turn, while other
// chats and other candidate sets can still pick differently.
const entries = ["aeloria", "brynna", "maybelle", "mirah", "poppy", "vigil"].map(
  (id) =>
    ({
      ...createLorebookEntrySchema.parse({ lorebookId: "book", name: `Threads - ${id}`, keys: [id], group: "threads" }),
      id,
      embedding: null,
    }) as LorebookEntry,
);
const scene = [{ role: "user" as const, content: "aeloria brynna maybelle mirah poppy vigil" }];
const winner = (options: Parameters<typeof scanForActivatedEntries>[2]) =>
  scanForActivatedEntries(scene, entries, options)
    .filter((row) => row.entry.group === "threads")
    .map((row) => row.entry.id);

const first = winner({ groupSeed: "chat-a" });
assert.equal(first.length, 1, "a group still activates exactly one entry");
for (let turn = 0; turn < 20; turn += 1) {
  assert.deepEqual(
    winner({ groupSeed: "chat-a" }),
    first,
    `turn ${turn}: same chat and candidates keep the same winner`,
  );
}

const acrossChats = new Set(Array.from({ length: 30 }, (_, index) => winner({ groupSeed: `chat-${index}` })[0]));
assert.ok(acrossChats.size > 1, "different chats still get different winners");

const smaller = scanForActivatedEntries([{ role: "user", content: "mirah poppy" }], entries, { groupSeed: "chat-a" })
  .filter((row) => row.entry.group === "threads")
  .map((row) => row.entry.id);
assert.equal(smaller.length, 1);
assert.ok(["mirah", "poppy"].includes(smaller[0]!), "the winner comes from the activated candidates only");

// An injected random source (tests) keeps its own behaviour and ignores the seed.
assert.deepEqual(winner({ groupSeed: "chat-a", random: () => 0 }), ["aeloria"]);
assert.deepEqual(winner({ groupSeed: "chat-a", random: () => 0.999 }), ["vigil"]);

console.log("lorebook-group-seed regression passed");
