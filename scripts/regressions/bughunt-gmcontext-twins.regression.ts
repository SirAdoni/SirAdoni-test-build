import assert from "node:assert/strict";
import type {
  CampaignMemoryCurrentState,
  CampaignMemoryEntity,
  CampaignMemoryEvent,
  CampaignMemoryFact,
  CampaignMemoryKnowledge,
} from "@marinara-engine/shared";
import { buildCampaignMemoryContext } from "../../packages/server/src/services/game/campaign-memory-context.js";

// Continuity publishes one fact per resolved subject plus a lore-entity fallback (`continuity.*`) and attaches
// knowledge to the FALLBACK when it exists (continuity-memory-publication.ts primaryFact). The context builder
// renders the subject copy and treats the fallback as its twin. These checks cover the twin paths.
const provenance = { source: "regression", sourceRevision: "1", actor: "system" as const };
const order = "m1|2026-01-01T00:00:00.000Z|m1";
const entity = (entityId: string, alias: string, kind: CampaignMemoryEntity["kind"] = "character"): CampaignMemoryEntity => ({
  entityId, chatId: "c", kind, owner: { type: "existing", store: "characters", recordId: `card-${entityId}` },
  aliases: [alias], tags: [], attributes: {}, status: "active", manualLock: false, provenance,
  revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01",
});
const evidence = [{ messageId: "m1", quote: "q" }];
const subjectCopy = (over: Partial<CampaignMemoryFact> = {}): CampaignMemoryFact => ({
  factId: "f-subject", chatId: "c", subjectEntityId: "mira", predicate: "secret",
  value: { text: "Mira hid the key.", receiptId: "r1", recordId: "rec1", keys: [] },
  conditions: [], status: "verified", validFromOrder: order, sourceRevision: "1", evidence,
  author: "system", provenance, manualLock: false, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01", ...over,
});
const fallback = (over: Partial<CampaignMemoryFact> = {}, scope = "private"): CampaignMemoryFact => ({
  ...subjectCopy(), factId: "f-fallback", subjectEntityId: "lore", predicate: "continuity.secret",
  value: { text: "Mira hid the key.", receiptId: "r1", recordId: "rec1", keys: [], knowledge: { scope, holders: ["Bran"] } },
  ...over,
});
const knows = (factId: string): CampaignMemoryKnowledge => ({
  knowledgeId: "k-bran", chatId: "c", holderEntityId: "bran", factId, epistemicState: "knows", learnedFrom: evidence,
  learnedAtOrder: order, provenance, manualLock: false, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01",
});
const base = {
  chatId: "c",
  entities: [entity("mira", "Mira"), entity("bran", "Bran"), entity("tove", "Tove"), entity("lore", "Key lore", "lore")],
  events: [] as CampaignMemoryEvent[], currentState: [] as CampaignMemoryCurrentState[], relationships: [],
  maxCharacters: 10_000,
};
const failures: string[] = [];
const check = (name: string, fn: () => void) => {
  try { fn(); } catch (error) { failures.push(`${name}: ${(error as Error).message}`); }
};

check("A knowledge on a superseded fallback is dropped although its twin is rendered", () => {
  const r = buildCampaignMemoryContext({ ...base, audience: { kind: "gm" },
    facts: [subjectCopy(), fallback({ status: "superseded" })], knowledge: [knows("f-fallback")] });
  assert.match(r.text, /\[fact f-subject\]/);
  assert.ok(r.includedIds.includes("k-bran"), `k-bran excluded: ${JSON.stringify(r.exclusions.find((e) => e.id === "k-bran"))}`);
});

check("A2 character audience loses its own knowledge after the fallback is superseded", () => {
  const r = buildCampaignMemoryContext({ ...base, audience: { kind: "character", entityId: "bran" },
    facts: [subjectCopy(), fallback({ status: "superseded" })], knowledge: [knows("f-fallback")] });
  assert.match(r.text, /Mira hid the key/);
});

check("B holder's may-use list omits the rendered fact its knowledge cites (knowledge on the fallback twin)", () => {
  const r = buildCampaignMemoryContext({ ...base, audience: { kind: "gm" }, presentEntityIds: ["bran"],
    facts: [subjectCopy(), fallback()], knowledge: [knows("f-fallback")] });
  assert.match(r.text, /Bran knows: fact f-subject/);
  const bran = r.characterBoundaries!.find((b) => b.entityId === "bran")!;
  assert.ok(bran.mayUseIds.includes("f-subject"), `mayUseIds=${JSON.stringify(bran.mayUseIds)}`);
});

check("C world-scope record: the rendered subject copy never reaches any character's may-use list", () => {
  const r = buildCampaignMemoryContext({ ...base, audience: { kind: "gm" }, presentEntityIds: ["tove"],
    facts: [subjectCopy(), fallback({}, "world")], knowledge: [] });
  const tove = r.characterBoundaries!.find((b) => b.entityId === "tove")!;
  assert.ok(tove.mayUseIds.includes("f-subject"), `mayUseIds=${JSON.stringify(tove.mayUseIds)}`);
});

check("D twin whose representative is unreadable is dropped from both the block and the budget count", () => {
  const r = buildCampaignMemoryContext({ ...base, audience: { kind: "gm" },
    facts: [subjectCopy({ status: "held" }), fallback()], knowledge: [] });
  assert.match(r.text, /Mira hid the key/, `text=${JSON.stringify(r.text)} exclusions=${JSON.stringify(r.exclusions)}`);
});

check("E pinned canon renders inside the [current_state] section and splits it", () => {
  const events: CampaignMemoryEvent[] = [{ eventId: "e1", chatId: "c", occurrenceOrder: order, participantEntityIds: ["mira", "tove"],
    sourceRevision: "1", transitions: [], evidence: [], provenance, immutable: true, createdAt: "2026-01-01" }];
  const state = (stateId: string, entityId: string, value: string): CampaignMemoryCurrentState => ({
    stateId, chatId: "c", entityId, property: "mood", value, sourceEventId: "e1", validAtOrder: order,
    protected: false, provenance, manualLock: false, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
  const pinned = { ...subjectCopy(), factId: "f-pin", subjectEntityId: "bran", manualLock: true,
    value: { text: "Bran is the heir.", pinned: true } };
  const r = buildCampaignMemoryContext({ ...base, audience: { kind: "gm" }, presentEntityIds: ["mira"], focusEntityIds: ["bran"],
    events, currentState: [state("s-mira", "mira", "calm"), state("s-tove", "tove", "angry")], facts: [pinned], knowledge: [] });
  const lines = r.text.split("\n");
  const header = lines.indexOf("[current_state]");
  const pin = lines.findIndex((line) => line.startsWith("[fact f-pin"));
  const lastState = Math.max(lines.findIndex((l) => l.includes("mood = calm")), lines.findIndex((l) => l.includes("mood = angry")));
  assert.ok(!(pin > header && pin < lastState), `canon fact sits inside the current_state rows:\n${r.text}`);
});

check("F GM knowledge line cites a fact merged into a receipt, which never renders under that id", () => {
  const r = buildCampaignMemoryContext({ ...base, audience: { kind: "gm" },
    facts: [subjectCopy()], knowledge: [knows("f-subject")],
    continuityReceiptRecords: [{ receiptId: "r1", recordId: "rec1", evidenceMessageIds: ["m1"], subjects: ["Mira"] }] });
  const cited = /fact (f-[a-z]+)/.exec(r.text.split("\n").find((l) => l.startsWith("[knowledge")) ?? "")?.[1];
  assert.ok(!cited || r.includedIds.includes(cited), `knowledge cites ${cited}, not rendered:\n${r.text}`);
});

if (failures.length) {
  console.error(`bughunt-gmcontext-twins: ${failures.length} failing check(s)\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("bughunt-gmcontext-twins regression passed");
