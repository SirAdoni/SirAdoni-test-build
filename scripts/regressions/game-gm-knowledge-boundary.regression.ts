import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CampaignMemoryEntity, CampaignMemoryFact, CampaignMemoryKnowledge } from "@marinara-engine/shared";
import {
  buildCampaignMemoryContext,
  resolvePresentEntityIds,
} from "../../packages/server/src/services/game/campaign-memory-context.js";
import { appendGameGmCampaignMemory } from "../../packages/server/src/services/generation/game-gm-prompt-runtime.js";

// Pure projection checks for the ordinary GM turn: explicit per-character boundary,
// relevance ranking, receipt deduplication, exact omission accounting, cache prefix.
const chatId = "boundary-chat";
const provenance = { source: "regression", sourceRevision: "1", actor: "user" as const };
const order = (index: number) => `m1|2026-01-01T00:00:0${index}.000Z|m${index}`;
const entity = (
  entityId: string,
  alias: string,
  owner: CampaignMemoryEntity["owner"] = { type: "registry", store: "campaign-memory", recordId: entityId },
  kind: CampaignMemoryEntity["kind"] = "character",
): CampaignMemoryEntity => ({
  entityId, chatId, kind, owner, aliases: [alias], tags: [], summary: alias, attributes: {}, status: "active",
  manualLock: false, provenance, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01",
});
const fact = (
  factId: string,
  subjectEntityId: string,
  value: CampaignMemoryFact["value"],
  messageId: string,
  validFromOrder: string,
): CampaignMemoryFact => ({
  factId, chatId, subjectEntityId, predicate: "note", value, conditions: [], status: "verified", validFromOrder,
  sourceRevision: "1", evidence: [{ messageId, quote: "quote", sourceHash: "hash" }], author: "user", provenance,
  manualLock: false, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01",
});
const knowledge = (knowledgeId: string, holderEntityId: string, factId: string, learnedAtOrder: string): CampaignMemoryKnowledge => ({
  knowledgeId, chatId, holderEntityId, factId, epistemicState: "knows", learnedFrom: [], learnedAtOrder, provenance,
  manualLock: false, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01",
});

const entities = [
  entity("char-a", "Ari", { type: "existing", store: "characters", recordId: "card-a" }),
  entity("char-b", "Bex", { type: "existing", store: "characters", recordId: "card-b" }),
  entity("char-c", "Cass", { type: "existing", store: "game-npcs", recordId: "npc-c" }),
  entity("persona-p", "Player", { type: "existing", store: "personas", recordId: "persona-1" }, "persona"),
  entity("lore-1", "Receipt owner", { type: "existing", store: "lorebook-entries", recordId: "entry-1" }, "lore"),
];
const facts = [
  fact("fact-private", "char-a", "seven-day-secret", "m1", order(1)),
  fact("fact-world", "lore-1", { text: "The bridge is closed", knowledge: { scope: "world", holders: [] } }, "m1", order(1)),
  fact("fact-dup", "lore-1", { text: "Ari owes a debt", subjects: ["Ari"], receiptId: "rcpt-1", recordId: "rec-1" }, "m2", order(2)),
  fact("fact-dup-subject", "char-a", "Ari owes a debt (legacy row)", "m2", order(2)),
  fact("fact-a-old", "char-a", "old-note", "m1", order(1)),
  fact("fact-a-new", "char-a", "new-note", "m3", order(3)),
  fact("fact-c", "char-c", "absent-note", "m3", order(3)),
];
const knowledgeRows = [
  knowledge("k-a", "char-a", "fact-private", order(1)),
  knowledge("k-c", "char-c", "fact-c", order(3)),
];
const receiptRecords = [{ receiptId: "rcpt-1", recordId: "rec-1", evidenceMessageIds: ["m2"], subjects: ["Ari"] }];
const base = { chatId, audience: { kind: "gm" } as const, entities, facts, knowledge: knowledgeRows, events: [], currentState: [], relationships: [] };

// 1. Per-character boundary: a private fact held by A never reaches B's may-use list; world facts reach every present character.
const full = buildCampaignMemoryContext({ ...base, maxCharacters: 10_000, presentEntityIds: ["char-a", "char-b", "persona-p"], continuityReceiptRecords: receiptRecords });
const boundary = (entityId: string) => full.characterBoundaries!.find((item) => item.entityId === entityId)!;
assert.deepEqual(full.characterBoundaries!.map((item) => item.entityId), ["char-a", "char-b", "persona-p"], "only present character/persona entities get a boundary");
assert.ok(boundary("char-a").mayUseIds.includes("k-a") && boundary("char-a").mayUseIds.includes("fact-private"), "holder may use its own knowledge and the cited fact");
assert.ok(!boundary("char-b").mayUseIds.includes("fact-private") && !boundary("char-b").mayUseIds.includes("k-a"), "private fact held by A is not in B's may-use list");
assert.ok(!boundary("char-b").mayUseIds.includes("fact-a-new"), "a fact about a present subject is not automatically that subject's or anyone's knowledge");
for (const id of ["char-a", "char-b", "persona-p"]) assert.ok(boundary(id).mayUseIds.includes("fact-world"), `world-scope fact is usable by present ${id}`);
assert.equal(full.characterBoundaries!.some((item) => item.entityId === "char-c"), false, "absent characters get no may-use list");

// 2. Receipt dedup: only an exact provenance link (same receipt and record, evidence cited by it) merges, exactly once,
// without degrading. A same-subject fact from the same message is a different statement and stays in the block.
assert.equal(full.omissions?.duplicatesMerged, 1);
assert.deepEqual(full.omissions?.mergedIds, ["fact-dup"]);
assert.equal(full.exclusions.filter((item) => item.id === "fact-dup").length, 1, "merged once");
assert.match(full.exclusions.find((item) => item.id === "fact-dup")!.reason, /merged with continuity receipt rcpt-1 record rec-1/u);
assert.doesNotMatch(full.text, /\[fact fact-dup\]/u, "the merged fact is not repeated in the memory block");
assert.match(full.text, /\[fact fact-dup-subject\]/u, "a same-subject fact without a provenance link is kept");
assert.equal(full.degraded, false, "merging is not degradation");
assert.equal(full.omissions?.budgetOmitted, 0);
const noReceipts = buildCampaignMemoryContext({ ...base, maxCharacters: 10_000, presentEntityIds: ["char-a"] });
assert.match(noReceipts.text, /\[fact fact-dup\]/u, "without receipts on the request the fact is rendered");
assert.equal(noReceipts.omissions?.duplicatesMerged, 0);

// 3. Relevance ranking: present holders first, then recency by order, before absent entities.
const ids = full.includedIds;
assert.ok(ids.indexOf("k-a") < ids.indexOf("k-c"), "present holder knowledge ranks before absent holder knowledge");
assert.ok(ids.indexOf("fact-a-new") < ids.indexOf("fact-a-old"), "newer source order ranks first inside a relevance tier");
assert.ok(ids.indexOf("fact-a-old") < ids.indexOf("fact-c"), "absent-entity facts rank after present-entity facts");
const tiny = buildCampaignMemoryContext({ ...base, maxCharacters: 60, presentEntityIds: ["char-a"], continuityReceiptRecords: receiptRecords });
assert.deepEqual(tiny.includedIds, ["fact-a-new"], "the single line that fits is the newest present-entity record");

// 4. Exact omission accounting under budget pressure.
const limited = buildCampaignMemoryContext({ ...base, maxCharacters: 260, presentEntityIds: ["char-a", "char-b"], continuityReceiptRecords: receiptRecords });
const budgetExclusions = limited.exclusions.filter((item) => item.reason === "omitted by character budget").length;
assert.equal(limited.omissions?.budgetOmitted, budgetExclusions);
assert.equal(limited.omissions?.budgetOmitted, full.includedIds.length - limited.includedIds.length, "omitted count equals the records that no longer fit");
assert.ok(limited.omissions!.budgetOmitted > 0);
assert.equal(limited.omissions?.duplicatesMerged, 1);
assert.ok(limited.text.length <= 260);

// 5. Prompt rendering keeps the stable prefix byte-identical and states the boundary and trailer explicitly.
const messages: any[] = [
  { role: "system", content: "Stable GM rules", providerMetadata: { marinaraGmStable: true } },
  { role: "system", content: "Current GM state", contextKind: "injection", providerMetadata: { marinaraGmDynamic: true } },
];
const stableHash = () => createHash("sha256").update(messages[0].content).digest("hex");
const before = stableHash();
appendGameGmCampaignMemory(messages, limited);
assert.equal(stableHash(), before, "boundary and trailer never alter the stable cache prefix");
assert.equal(messages[0].providerMetadata.marinaraGmStable, true);
const block = messages.at(-1);
assert.equal(block.contextKind, "injection");
assert.equal(block.providerMetadata.marinaraRuntimeContext, true);
const lineFor = (holder: string) => block.content.split("\n").find((line: string) => line.startsWith(`[may-use holder=${holder}`)) ?? "";
assert.match(lineFor("char-a"), /k-a/u);
assert.doesNotMatch(lineFor("char-b"), /fact-private|k-a/u, "B's rendered may-use line never names A's private fact");
assert.match(block.content, /Everything else above is GM-only: no character may reference it unless they learn it on-screen\./u);
assert.equal(
  block.content.split("\n").find((line: string) => line.startsWith("[memory_omissions]")),
  `[memory_omissions] ${limited.omissions!.budgetOmitted} records omitted for budget; 1 duplicates merged into continuity receipts`,
);
assert.deepEqual(block.providerMetadata.marinaraCampaignMemory.omissions, limited.omissions);
assert.equal(block.providerMetadata.marinaraCampaignMemory.characterBoundaries.length, 2);

// 6. Unknown presence fails closed: no may-use list, everything is GM-only.
const unknownPresence = buildCampaignMemoryContext({ ...base, maxCharacters: 10_000 });
assert.equal(unknownPresence.characterBoundaries, undefined);
const closed: any[] = [{ role: "system", content: "Stable GM rules" }];
appendGameGmCampaignMemory(closed, unknownPresence);
assert.match(closed.at(-1).content, /Scene presence was unavailable for this request\. Every record above is GM-only/u);
assert.doesNotMatch(closed.at(-1).content, /\[may-use/u);

// 7. Presence maps through exact owner references only; names and registry owners never count.
assert.deepEqual(
  resolvePresentEntityIds(entities, { characterIds: ["card-a", "npc-c", "Bex"], personaId: "persona-1" }),
  ["char-a", "char-c", "persona-p"],
);
assert.deepEqual(resolvePresentEntityIds(entities, { characterIds: [], personaId: null }), []);

console.log("Game GM knowledge boundary regression passed.");
