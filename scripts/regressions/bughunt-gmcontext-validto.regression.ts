import assert from "node:assert/strict";
import type { CampaignMemoryEntity, CampaignMemoryFact } from "@marinara-engine/shared";
import { buildCampaignMemoryContext } from "../../packages/server/src/services/game/campaign-memory-context.js";

// A fact whose validity ended (validToOrder, settable through the memory write route) is dropped at a historical
// cutoff but still rendered as a current verified fact on every live turn, where no cutoff is supplied.
const provenance = { source: "regression", sourceRevision: "1", actor: "user" as const };
const mira: CampaignMemoryEntity = { entityId: "mira", chatId: "c", kind: "character", owner: { type: "registry", store: "campaign-memory", recordId: "mira" },
  aliases: ["Mira"], tags: [], attributes: {}, status: "active", manualLock: false, provenance, revision: 1, createdAt: "x", updatedAt: "x" };
const ended: CampaignMemoryFact = { factId: "f-ended", chatId: "c", subjectEntityId: "mira", predicate: "role", value: "captain of the guard",
  conditions: [], status: "verified", validFromOrder: "m1|2026-01-01T00:00:00.000Z|m1", validToOrder: "m1|2026-01-02T00:00:00.000Z|m2",
  sourceRevision: "1", evidence: [], author: "user", provenance, manualLock: false, revision: 1, createdAt: "x", updatedAt: "x" };
const input = { chatId: "c", audience: { kind: "gm" } as const, entities: [mira], facts: [ended], knowledge: [], events: [], currentState: [], relationships: [], maxCharacters: 5000 };
const atLaterCutoff = buildCampaignMemoryContext({ ...input, cutoffOrder: "m1|2026-01-03T00:00:00.000Z|m3" });
assert.equal(atLaterCutoff.text, "", "historical projection after the end drops it");
const live = buildCampaignMemoryContext(input);
assert.equal(live.text, "", `live turn still renders an ended fact: ${JSON.stringify(live.text)}`);
console.log("bughunt-gmcontext-validto regression passed");
