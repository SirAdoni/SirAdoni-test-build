import assert from "node:assert/strict";
import {
  deriveEntryStatus,
  entryStatusToFlags,
} from "../../packages/client/src/components/lorebooks/LorebookEntryRow.tsx";

const flags = (alwaysLoaded: boolean, constant: boolean, selective: boolean) => ({
  alwaysLoaded,
  constant,
  selective,
});

assert.equal(deriveEntryStatus(flags(false, false, false)), "normal");
assert.equal(deriveEntryStatus(flags(false, false, true)), "selective");
assert.equal(deriveEntryStatus(flags(false, true, false)), "constant");
assert.equal(deriveEntryStatus(flags(true, true, true)), "always_loaded");

assert.deepEqual(entryStatusToFlags("normal"), flags(false, false, false));
assert.deepEqual(entryStatusToFlags("selective"), flags(false, false, true));
assert.deepEqual(entryStatusToFlags("constant"), flags(false, true, false));
assert.deepEqual(entryStatusToFlags("always_loaded"), flags(true, false, false));

console.info("Lorebook entry status transitions passed.");
