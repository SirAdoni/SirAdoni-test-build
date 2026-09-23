import assert from "node:assert/strict";
import type {
  CampaignMemoryCurrentState,
  CampaignMemoryEntity,
  CampaignMemoryEvent,
  CampaignMemoryFact,
  CampaignMemoryKnowledge,
} from "@marinara-engine/shared";

// Campaign codex size: a long campaign holds tens of thousands of memory records, most of them
// the same long statement re-read in later sessions or known by many characters. The codex writes
// each statement once, lists who holds it under it instead of repeating it under every holder,
// and cuts long values, so a campaign shaped like a real 12-session one (about 1,400 entities,
// 14k facts with long values, 18k knowledge rows over 7.4k distinct statements, 1,500 events)
// exports a Markdown file of a few MB instead of tens of MB.

const provenance = { source: "fixture", sourceRevision: "r1", actor: "system" as const };
const stamp = "2026-09-01T10:00:00.000Z";

let seed = 20260923;
// mulberry32: small, deterministic, and exact in 32-bit integer math.
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const WORDS = ["the", "gate", "courier", "vault", "oath", "river", "ash", "guild", "night", "blade", "letter", "crow"];
const prose = (length: number) => {
  const words: string[] = [];
  let size = 0;
  while (size < length) {
    const word = pick(WORDS);
    words.push(word);
    size += word.length + 1;
  }
  return words.join(" ");
};

const SESSIONS = 12;
const ENTITIES = 1_400;
const DISTINCT_FACTS = 7_000;
const DISTINCT_CLAIMS = 7_400;
const KNOWLEDGE_ROWS = 18_000;
const EVENTS = 1_500;
const PREDICATES = ["decision", "history", "goal", "trait", "secret", "promise"];
const KINDS: CampaignMemoryEntity["kind"][] = ["character", "location", "organization", "item", "quest", "lore"];

const chatOf = (session: number) => `s${session}`;
const entities: CampaignMemoryEntity[] = Array.from({ length: ENTITIES }, (_, index) => ({
  entityId: `e${index}`,
  chatId: chatOf(1),
  kind: index < 900 ? "character" : pick(KINDS),
  owner: { type: "registry", store: "campaign-memory", recordId: `e${index}` },
  aliases: [`Name ${index}`],
  tags: [],
  attributes: {},
  status: "active",
  summary: prose(160),
  manualLock: false,
  provenance,
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
}));

const factsBySession = Array.from({ length: SESSIONS }, () => [] as CampaignMemoryFact[]);
const fact = (session: number, id: string, subject: number, predicate: string, text: string, status = "verified") =>
  factsBySession[session - 1]!.push({
    factId: id,
    chatId: chatOf(session),
    subjectEntityId: `e${subject}`,
    predicate,
    value: { text },
    conditions: [],
    status: status as CampaignMemoryFact["status"],
    sourceRevision: "r1",
    evidence: [],
    author: "system",
    provenance,
    manualLock: false,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  });
const distinct: Array<{ id: string; subject: number; predicate: string; text: string }> = [];
for (let index = 0; index < DISTINCT_FACTS; index += 1) {
  const item = { id: `f${index}`, subject: Math.floor(random() * ENTITIES), predicate: pick(PREDICATES), text: prose(1_234) };
  distinct.push(item);
  const first = 1 + Math.floor(random() * (SESSIONS - 1));
  fact(first, item.id, item.subject, item.predicate, item.text);
  // Re-read in a later session: the same statement under a new record id.
  fact(first + 1, `${item.id}-again`, item.subject, item.predicate, item.text);
}
// The same statement recorded under a second subject.
for (let index = 0; index < 1_000; index += 1) {
  const item = distinct[index]!;
  fact(SESSIONS, `f-other-${index}`, (item.subject + 1) % ENTITIES, item.predicate, item.text);
}
// Unverified statements characters hold.
for (let index = DISTINCT_FACTS; index < DISTINCT_CLAIMS; index += 1) {
  distinct.push({ id: `f${index}`, subject: Math.floor(random() * ENTITIES), predicate: "rumor", text: prose(1_234) });
  fact(SESSIONS, `f${index}`, distinct[index]!.subject, "rumor", distinct[index]!.text, "proposed");
}

const knowledgeBySession = Array.from({ length: SESSIONS }, () => [] as CampaignMemoryKnowledge[]);
const STATES: CampaignMemoryKnowledge["epistemicState"][] = ["knows", "believes", "rumor"];
for (let index = 0; index < KNOWLEDGE_ROWS; index += 1) {
  const session = 1 + Math.floor(random() * SESSIONS);
  knowledgeBySession[session - 1]!.push({
    knowledgeId: `k${index}`,
    chatId: chatOf(session),
    // One character holds about a third of everything, as in the real campaign.
    holderEntityId: index % 3 === 0 ? "e0" : `e${Math.floor(random() * ENTITIES)}`,
    factId: distinct[index % DISTINCT_CLAIMS]!.id,
    epistemicState: pick(STATES),
    learnedFrom: [],
    provenance,
    manualLock: false,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  });
}

const eventsBySession = Array.from({ length: SESSIONS }, () => [] as CampaignMemoryEvent[]);
for (let index = 0; index < EVENTS; index += 1) {
  const session = 1 + (index % SESSIONS);
  eventsBySession[session - 1]!.push({
    eventId: `ev${index}`,
    chatId: chatOf(session),
    occurrenceOrder: `m|${String(index).padStart(6, "0")}`,
    participantEntityIds: [`e${index % ENTITIES}`, `e${(index * 7) % ENTITIES}`],
    locationEntityId: `e${900 + (index % 500)}`,
    sourceRevision: "r1",
    transitions: [prose(260)],
    evidence: [],
    provenance,
    immutable: true,
    createdAt: stamp,
  });
}
const stateRows: CampaignMemoryCurrentState[] = entities.slice(0, 900).map((item, index) => ({
  stateId: `st${index}`,
  chatId: chatOf(SESSIONS),
  entityId: item.entityId,
  property: "location",
  value: `e${900 + (index % 500)}`,
  sourceEventId: `ev${index}`,
  validAtOrder: `m|${index}`,
  protected: false,
  provenance,
  manualLock: false,
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
}));

const { buildCampaignCodex, renderCampaignCodexMarkdown, CODEX_JSON_VALUE_MAX, CODEX_MARKDOWN_VALUE_MAX } =
  await import("../../packages/server/src/services/game/campaign-codex.js");

const startedAt = Date.now();
const codex = buildCampaignCodex({
  gameId: "game-long",
  gameName: "The Long Road",
  generatedAt: stamp,
  entitiesMerged: true,
  sessions: Array.from({ length: SESSIONS }, (_, index) => ({
    chatId: chatOf(index + 1),
    sessionNumber: index + 1,
    name: `Session ${index + 1}`,
    entities: index === 0 ? entities : [],
    facts: factsBySession[index]!,
    knowledge: knowledgeBySession[index]!,
    events: eventsBySession[index]!,
    currentState: index === SESSIONS - 1 ? stateRows : [],
    relationships: [],
  })),
});
const markdown = renderCampaignCodexMarkdown(codex);
const json = JSON.stringify(codex, null, 2);
const elapsed = Date.now() - startedAt;
const mb = (value: string) => (Buffer.byteLength(value) / 1_048_576).toFixed(1);
console.log(`campaign-codex-size: markdown ${mb(markdown)} MB, json ${mb(json)} MB, ${elapsed} ms`);

const facts = codex.entities.flatMap((item) => item.facts);
assert.equal(facts.length, DISTINCT_FACTS + 1_000, "a fact re-read in a later session is one entry");
assert.equal(
  facts.filter((item) => item.sameAs).length,
  1_000,
  "the same statement under a second subject points at the first instead of repeating it",
);
assert.ok(facts.every((item) => item.value.length <= CODEX_JSON_VALUE_MAX + 1));
const claims = codex.entities.flatMap((item) => item.claims);
assert.equal(claims.length, DISTINCT_CLAIMS - DISTINCT_FACTS, "each unverified statement is listed once");
const holderMentions = [...facts, ...claims].reduce(
  (sum, item) => sum + (item.heldBy ?? []).reduce((count, entry) => count + entry.names.length, 0),
  0,
);
assert.ok(holderMentions > 7_000 && holderMentions <= KNOWLEDGE_ROWS, "holders are listed under the statement");
assert.ok(
  markdown.split("\n").every((line) => !line.startsWith("- ") || line.length < CODEX_MARKDOWN_VALUE_MAX * 5),
  "no list item carries a full long value",
);
assert.ok(Buffer.byteLength(markdown) < 6 * 1_048_576, `the Markdown stays a readable size (${mb(markdown)} MB)`);
assert.ok(Buffer.byteLength(json) < 16 * 1_048_576, `the JSON stays a reasonable size (${mb(json)} MB)`);
