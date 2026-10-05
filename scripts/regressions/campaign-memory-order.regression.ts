import assert from "node:assert/strict";
import {
  buildCampaignMemoryMessageOrderMap,
  compareCampaignMemoryMessageOrder,
  deriveCampaignMemoryCaptureOrder,
  formatCampaignMemoryMessageOrder,
  parseCampaignMemoryMessageOrder,
  remapCampaignMemoryMessageOrder,
} from "../../packages/server/src/services/game/campaign-memory-order.js";

const timestamp = "2026-09-13T10:00:00.000Z";
const sameTimestamp = buildCampaignMemoryMessageOrderMap([
  { id: "b|message", createdAt: timestamp },
  { id: "a-message", createdAt: timestamp },
]);
assert.ok(compareCampaignMemoryMessageOrder(sameTimestamp.get("a-message")!, sameTimestamp.get("b|message")!) < 0);
assert.deepEqual(parseCampaignMemoryMessageOrder(sameTimestamp.get("b|message")!), {
  createdAt: timestamp,
  messageId: "b|message",
});

assert.throws(() => formatCampaignMemoryMessageOrder("id", "2026-09-13T10:00:00Z"));
assert.throws(() => formatCampaignMemoryMessageOrder("id", "2026-02-30T10:00:00.000Z"));
assert.equal(parseCampaignMemoryMessageOrder("legacy-order"), null);
assert.equal(parseCampaignMemoryMessageOrder("m1|2026-13-13T10:00:00.000Z|id"), null);
assert.equal(parseCampaignMemoryMessageOrder("m1|2026-09-13T10:00:00.000Z|"), null);

const first = sameTimestamp.get("a-message")!;
const second = formatCampaignMemoryMessageOrder("later", "2026-09-13T10:01:00.000Z");
assert.equal(
  deriveCampaignMemoryCaptureOrder(
    [{ messageId: "a-message" }, { messageId: "later" }],
    new Map([...sameTimestamp, ["later", second]]),
  ),
  second,
);
assert.equal(deriveCampaignMemoryCaptureOrder([{ messageId: "missing" }], sameTimestamp), null);
assert.equal(deriveCampaignMemoryCaptureOrder([], sameTimestamp), null);
assert.ok(compareCampaignMemoryMessageOrder(first, second) < 0);

const remapped = remapCampaignMemoryMessageOrder(
  first,
  new Map([["a-message", { id: "target|a", createdAt: "2026-09-14T10:00:00.000Z" }]]),
);
assert.equal(remapped, "m1|2026-09-14T10:00:00.000Z|target|a");
assert.equal(remapCampaignMemoryMessageOrder("m9|2026-09-13T10:00:00.000Z|a-message", new Map()), null);
assert.equal(remapCampaignMemoryMessageOrder(first, new Map()), null);

// A target's fresh IDs can reverse equal-timestamp order. The helper exposes
// that fact; branch projection must retain the source token in provenance when
// it cannot prove that the target mapping preserves ordering.
const reversedTie = new Map([
  ["a-message", { id: "z-target", createdAt: timestamp }],
  ["b|message", { id: "a-target", createdAt: timestamp }],
]);
assert.ok(
  compareCampaignMemoryMessageOrder(
    remapCampaignMemoryMessageOrder(sameTimestamp.get("a-message")!, reversedTie)!,
    remapCampaignMemoryMessageOrder(sameTimestamp.get("b|message")!, reversedTie)!,
  ) > 0,
  "target IDs may reverse an equal-timestamp source order",
);

process.stdout.write("Campaign memory order regression passed.\n");
