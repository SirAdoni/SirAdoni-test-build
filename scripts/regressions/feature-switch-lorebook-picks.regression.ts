import assert from "node:assert/strict";
import { createLorebookEntrySchema } from "../../packages/shared/src/schemas/lorebook.schema.js";
import type { LorebookEntry } from "../../packages/shared/src/types/lorebook.js";
import { scanForActivatedEntries } from "../../packages/server/src/services/lorebook/keyword-scanner.js";
import { resetFeatureSettingsForTests } from "../../packages/server/src/services/features/feature-settings.js";
import { lorebookGroupPickRandom } from "../../packages/server/src/services/lorebook/group-pick-policy.js";

// Settings > Features "Stable lorebook picks" (stableLorebookGroupPicks). Every processLorebooks
// caller passes `random: lorebookGroupPickRandom()` next to the chat id (which processLorebooks turns
// into the group seed). ON (default): undefined, so the seeded winner is kept, as today. OFF: Math.random,
// which disables the seed, so the winner re-rolls every scan, as upstream. LOREBOOK_STABLE_GROUP_WINNERS
// wins when set.
delete process.env.LOREBOOK_STABLE_GROUP_WINNERS;
const entries = ["alder", "birch", "cedar", "hazel", "larch", "rowan"].map(
  (id) =>
    ({
      ...createLorebookEntrySchema.parse({ lorebookId: "book", name: `Grove - ${id}`, keys: [id], group: "grove" }),
      id,
      embedding: null,
    }) as LorebookEntry,
);
const scene = [{ role: "user" as const, content: "alder birch cedar hazel larch rowan" }];
// Mirrors processLorebooks: the chat id becomes groupSeed and the caller's random is forwarded when set.
const scan = () => {
  const random = lorebookGroupPickRandom();
  return scanForActivatedEntries(scene, entries, { groupSeed: "chat-grove", ...(random ? { random } : {}) })
    .filter((row) => row.entry.group === "grove")
    .map((row) => row.entry.id)[0];
};
const winners = (runs: number) => new Set(Array.from({ length: runs }, scan));

try {
  resetFeatureSettingsForTests();
  assert.equal(lorebookGroupPickRandom(), undefined, "ON: callers pass no random source");
  const seeded = scanForActivatedEntries(scene, entries, { groupSeed: "chat-grove" })
    .filter((row) => row.entry.group === "grove")
    .map((row) => row.entry.id)[0];
  assert.deepEqual([...winners(25)], [seeded], "ON: the same winner as today's seeded scan, every turn");

  resetFeatureSettingsForTests({ stableLorebookGroupPicks: false });
  assert.equal(lorebookGroupPickRandom(), Math.random, "OFF: Math.random, as upstream");
  assert.ok(winners(60).size > 1, "OFF: the winner re-rolls between scans");

  process.env.LOREBOOK_STABLE_GROUP_WINNERS = "true";
  assert.equal(lorebookGroupPickRandom(), undefined, "env on wins over a saved off");
  resetFeatureSettingsForTests();
  process.env.LOREBOOK_STABLE_GROUP_WINNERS = "false";
  assert.equal(lorebookGroupPickRandom(), Math.random, "env off wins over the default");
} finally {
  delete process.env.LOREBOOK_STABLE_GROUP_WINNERS;
  resetFeatureSettingsForTests();
}

console.log("feature-switch-lorebook-picks regression passed");
