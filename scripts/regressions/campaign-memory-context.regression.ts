import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  CampaignMemoryEntity,
  CampaignMemoryEvent,
  CampaignMemoryFact,
  CampaignMemoryKnowledge,
  CampaignMemoryCurrentState,
} from "@marinara-engine/shared";
import {
  buildCampaignMemoryContext,
  normalizeCampaignMemoryMaxCharacters,
} from "../../packages/server/src/services/game/campaign-memory-context.js";
import { appendGameGmCampaignMemory } from "../../packages/server/src/services/generation/game-gm-prompt-runtime.js";

const provenance = { source: "regression", sourceRevision: "1", actor: "user" as const };
const orderBefore = "m1|2026-01-01T00:00:00.000Z|m0";
const orderCurrent = "m1|2026-01-01T00:00:00.000Z|m1";
const orderFuture = "m1|2026-01-01T00:00:00.000Z|m2";
const source = (content: string) => ({
  chatId: "chat-a",
  content,
  sourceHash: createHash("sha256").update(content).digest("hex"),
  captureOrder: orderCurrent,
});
const sourceHash = createHash("sha256").update("The source says blue-room secret").digest("hex");
const entity = (entityId: string, summary = entityId): CampaignMemoryEntity => ({
  entityId,
  chatId: "chat-a",
  kind: "character",
  owner: { type: "registry", store: "campaign-memory", recordId: entityId },
  aliases: [summary],
  tags: [],
  summary,
  attributes: {},
  status: "active",
  manualLock: false,
  provenance,
  revision: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
const fact = (
  factId: string,
  subjectEntityId: string,
  text: string,
  validFromOrder = orderCurrent,
): CampaignMemoryFact => ({
  factId,
  chatId: "chat-a",
  subjectEntityId,
  predicate: "secret",
  value: text,
  conditions: [{ kind: "when", value: "dawn" }],
  status: "verified" as CampaignMemoryFact["status"],
  ...(validFromOrder ? { validFromOrder } : {}),
  sourceRevision: "1",
  evidence: [{ messageId: "m1", quote: "The source says " + text, sourceHash }],
  author: "user",
  provenance,
  manualLock: false,
  revision: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
const knowledge = (
  knowledgeId: string,
  holderEntityId: string,
  factId: string,
  learnedAtOrder = orderCurrent,
): CampaignMemoryKnowledge => ({
  knowledgeId,
  chatId: "chat-a",
  holderEntityId,
  factId,
  epistemicState: "knows",
  learnedFrom: [{ messageId: "m1", quote: factId, sourceHash }],
  learnedAtOrder,
  provenance,
  manualLock: false,
  revision: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
const base = {
  chatId: "chat-a",
  entities: [
    entity("alice", "Alice"),
    entity("alice-renamed", "Alice Renamed"),
    entity("bob", "Bob"),
    entity("same-a", "Same"),
    entity("same-b", "Same"),
  ],
  facts: [
    fact("secret", "alice", "blue-room"),
    fact("future", "alice", "tomorrow", orderFuture),
    { ...fact("held", "alice", "held"), status: "held" as const },
  ],
  knowledge: [
    knowledge("alice-knows", "alice", "secret"),
    { ...knowledge("unknown-order", "alice", "secret"), learnedAtOrder: undefined },
    knowledge("future-knows", "alice", "future", orderFuture),
  ],
  events: [],
  currentState: [],
  relationships: [],
  maxCharacters: 1000,
  sourceContents: { m1: source("The source says blue-room secret") },
};

const beforeLearning = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "character", entityId: "alice" },
  cutoffOrder: orderBefore,
});
assert.equal(beforeLearning.text, "");
assert.ok(beforeLearning.exclusions.some((item) => item.id === "alice-knows"));
const alice = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "character", entityId: "alice" },
  cutoffOrder: orderCurrent,
});
assert.match(alice.text, /blue-room/);
assert.match(alice.text, /\(if when: dawn\)/, "conditions render as a readable if-clause");
assert.match(
  alice.text,
  /\[knowledge alice-knows\] Alice knows: Alice, secret: blue-room/,
  "knowledge names its holder and subject, never a raw entity id",
);
assert.ok(alice.exclusions.some((item) => item.id === "unknown-order"));
assert.doesNotMatch(alice.text, /holder=|aliases=/, "raw id attributes are gone from the rendered block");
const wrongHolder = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "character", entityId: "alice" },
  knowledge: [...base.knowledge, knowledge("bob-knows", "bob", "secret")],
});
assert.match(wrongHolder.text, /alice-knows/);
assert.doesNotMatch(wrongHolder.text, /bob-knows/, "character audience cannot use knowledge held by another character");
const gmSeesAttributedKnowledge = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  presentEntityIds: ["bob"],
});
assert.match(
  gmSeesAttributedKnowledge.text,
  /alice-knows/,
  "GM may retain private knowledge with its holder attribution",
);
assert.ok(
  gmSeesAttributedKnowledge.characterBoundaries
    ?.find((boundary) => boundary.entityId === "bob")
    ?.mayUseIds.includes("alice-knows") === false,
  "GM context does not grant Alice's private knowledge to Bob",
);
const stateEvent: CampaignMemoryEvent = {
  eventId: "world-state-event",
  chatId: "chat-a",
  occurrenceOrder: orderBefore,
  participantEntityIds: ["alice"],
  sourceRevision: "1",
  transitions: [],
  evidence: [],
  provenance,
  immutable: true,
  createdAt: "2026-01-01",
};
const worldState: CampaignMemoryCurrentState = {
  stateId: "world-location",
  chatId: "chat-a",
  entityId: "alice",
  property: "location",
  value: { text: "at the public fountain", knowledge: { scope: "world" } },
  sourceEventId: stateEvent.eventId,
  validAtOrder: orderCurrent,
  protected: false,
  provenance,
  manualLock: false,
  revision: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const privateState: CampaignMemoryCurrentState = {
  ...worldState,
  stateId: "alice-private-state",
  property: "private thought",
  value: { text: "Alice's private thought" },
};
const overBudgetWorldState: CampaignMemoryCurrentState = {
  ...worldState,
  stateId: "over-budget-world-state",
  property: "public notice",
  value: { text: "x".repeat(1200), knowledge: { scope: "world" } },
};
const worldStateProjection = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  presentEntityIds: ["bob"],
  events: [stateEvent],
  currentState: [worldState, privateState, overBudgetWorldState],
  cutoffOrder: orderFuture,
});
assert.ok(worldStateProjection.includedIds.includes("world-location"), "world-scoped current state is rendered");
const bobBoundary = worldStateProjection.characterBoundaries?.find((boundary) => boundary.entityId === "bob");
assert.ok(
  bobBoundary?.mayUseIds.includes("world-location"),
  "world-scoped current state is authorized at the character boundary",
);
assert.equal(
  bobBoundary?.mayUseIds.includes("alice-private-state"),
  false,
  "private current state is not authorized to another character",
);
assert.equal(
  bobBoundary?.mayUseIds.includes("over-budget-world-state"),
  false,
  "omitted state is not authorized beyond the character budget",
);
const beforeWorldState = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  presentEntityIds: ["bob"],
  events: [stateEvent],
  currentState: [worldState],
  cutoffOrder: orderBefore,
});
assert.equal(beforeWorldState.includedIds.includes("world-location"), false, "state after cutoff is not authorized");
const wrongChatFact = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  facts: [{ ...fact("wrong-chat", "alice", "cross-chat"), chatId: "chat-b" }],
  knowledge: [],
  sourceContents: undefined,
});
assert.equal(wrongChatFact.text, "", "pure projection rejects facts from another chat");
const wrongChatSource = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  knowledge: [],
  sourceContents: { m1: { ...source("The source says blue-room secret"), chatId: "chat-b" } },
});
assert.equal(wrongChatSource.text, "", "evidence sources from another chat cannot validate this projection");
const laterSource = source("The later source says green-room secret");
const laterEvidenceHash = createHash("sha256").update(laterSource.content).digest("hex");
const laterFact = {
  ...fact("later-evidence", "alice", "green-room", orderBefore),
  evidence: [{ messageId: "m2", quote: laterSource.content, sourceHash: laterEvidenceHash }],
};
const laterKnowledge = {
  ...knowledge("later-knowledge", "alice", "secret", orderBefore),
  learnedFrom: [{ messageId: "m2", quote: laterSource.content, sourceHash: laterEvidenceHash }],
};
const laterContext = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  facts: [laterFact],
  knowledge: [],
  sourceContents: { m1: source("The source says blue-room secret"), m2: { ...laterSource, captureOrder: orderFuture } },
  cutoffOrder: orderCurrent,
});
assert.equal(laterContext.text, "", "backdated facts cannot cite a later source at cutoff");
const laterKnowledgeContext = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  facts: [fact("secret", "alice", "blue-room")],
  knowledge: [laterKnowledge],
  sourceContents: { m1: source("The source says blue-room secret"), m2: { ...laterSource, captureOrder: orderFuture } },
  cutoffOrder: orderCurrent,
});
assert.equal(
  laterKnowledgeContext.text.includes("later-knowledge"),
  false,
  "knowledge learned from a later source is held",
);
const unknownOrder = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  facts: [laterFact],
  knowledge: [],
  sourceContents: { m2: { ...laterSource, captureOrder: undefined } },
  cutoffOrder: orderCurrent,
});
assert.equal(unknownOrder.text, "", "unknown source order is held when a cutoff is supplied");
const missingSourceMap = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  facts: [fact("missing-map", "alice", "blue-room")],
  knowledge: [],
  sourceContents: undefined,
  cutoffOrder: orderCurrent,
});
assert.equal(missingSourceMap.text, "", "nonempty evidence is held when source contents are unavailable at cutoff");
const noCutoff = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  facts: [laterFact],
  knowledge: [],
  sourceContents: { m2: laterSource },
});
assert.match(noCutoff.text, /green-room/, "without a cutoff current freshness behavior is preserved");
const bob = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "character", entityId: "bob" },
  cutoffOrder: orderCurrent,
});
assert.equal(bob.text, "");
const other = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "character", entityId: "char-other" },
  cutoffOrder: orderCurrent,
});
assert.equal(other.text, "");

const stale = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "character", entityId: "alice" },
  sourceContents: { m1: { chatId: "chat-a", content: "changed" } },
});
assert.equal(stale.text, "");
assert.ok(stale.exclusions.some((item) => item.reason.includes("stale")));
const staleFactFreshLearning = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "character", entityId: "alice" },
  facts: [{ ...base.facts[0]!, evidence: [{ messageId: "m1", quote: "old secret" }] }],
});
assert.equal(staleFactFreshLearning.text, "");
const changedAroundQuote = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "character", entityId: "alice" },
  sourceContents: { m1: { chatId: "chat-a", content: "The source says blue-room secret but this was a lie." } },
});
assert.equal(changedAroundQuote.text, "");
assert.ok(changedAroundQuote.exclusions.some((item) => item.reason === "stale source revision"));
const invalidAudience = buildCampaignMemoryContext({ ...base, audience: { kind: "character", entityId: "missing" } });
assert.equal(invalidAudience.text, "");
const proposed = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  facts: [{ ...base.facts[0]!, status: "proposed" as CampaignMemoryFact["status"] }],
});
assert.equal(proposed.text.includes("blue-room"), false);

const collision = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "character", entityId: "same-b" },
  knowledge: [knowledge("wrong-holder", "same-a", "secret")],
});
assert.equal(collision.text, "");
const renamed = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "character", entityId: "alice-renamed" },
  knowledge: [knowledge("alice-knows", "alice-renamed", "secret")],
});
assert.match(renamed.text, /blue-room/);

const largeFacts = [
  { ...fact("long-a", "alice", "a".repeat(700)), evidence: [] },
  { ...fact("long-b", "bob", "b".repeat(700)), evidence: [] },
];
const deterministicA = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  facts: largeFacts,
  knowledge: [],
  sourceContents: undefined,
  maxCharacters: 1_000,
});
const deterministicB = buildCampaignMemoryContext({
  ...base,
  audience: { kind: "gm" },
  facts: [...largeFacts].reverse(),
  knowledge: [],
  sourceContents: undefined,
  maxCharacters: 1_000,
});
assert.deepEqual(deterministicA, deterministicB);
assert.ok(deterministicA.exclusions.some((item) => item.reason.includes("budget")));
assert.ok(deterministicA.text.length <= 1_000);
assert.ok(deterministicA.includedIds.some((id) => id === "long-a" || id === "long-b"));
assert.ok(deterministicA.exclusions.some((item) => item.id === "long-a" || item.id === "long-b"));
assert.equal(deterministicA.text.includes("[state"), false);
assert.equal(normalizeCampaignMemoryMaxCharacters(1_000), 1_000);
assert.equal(normalizeCampaignMemoryMaxCharacters(100_000), 100_000);
for (const invalid of [
  null,
  "10000",
  -1,
  0,
  999,
  100_001,
  1_000.5,
  Number.MAX_VALUE,
  Number.NaN,
  Number.POSITIVE_INFINITY,
]) {
  assert.equal(
    normalizeCampaignMemoryMaxCharacters(invalid),
    10_000,
    `invalid budget falls back to default: ${String(invalid)}`,
  );
}
const priorSystemMessage = {
  role: "system" as const,
  content: "unrelated system instruction",
  providerMetadata: { preserve: true },
};
const priorSystemSnapshot = structuredClone(priorSystemMessage);
const cutoffMessages: Array<{ role: "system"; content: string; providerMetadata?: Record<string, unknown> }> = [
  priorSystemMessage,
];
appendGameGmCampaignMemory(cutoffMessages, deterministicA, orderBefore);
assert.deepEqual(
  cutoffMessages[0],
  priorSystemSnapshot,
  "historical memory cutoff never mutates a preexisting system message",
);
assert.equal(
  (cutoffMessages[1].providerMetadata?.marinaraCampaignMemory as { cutoffOrder?: string }).cutoffOrder,
  orderBefore,
  "the cutoff is attached to the newly created memory injection",
);

// Storage integration: the wrapper reads one transaction snapshot and rejects a source
// after its active message content changes, even when a fresh knowledge row points at it.
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dataDir = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-context-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
let integrationApp: {
  ready(): Promise<void>;
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<any>;
} | null = null;
try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
  const { characters, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { buildCampaignMemoryContextFromStorage: fromStorage } =
    await import("../../packages/server/src/services/game/campaign-memory-context.js");
  const { formatCampaignMemoryMessageOrder } =
    await import("../../packages/server/src/services/game/campaign-memory-order.js");
  integrationApp = await buildApp();
  await integrationApp.ready();
  const db = await getDB();
  const characterId = "integration-character";
  await db.insert(characters).values({
    id: characterId,
    data: JSON.stringify({ name: "Integration" }),
    comment: "",
    avatarPath: null,
    spriteFolderPath: null,
    embedding: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  });
  const chatResponse = await integrationApp.inject({
    method: "POST",
    url: "/api/chats",
    payload: { name: "Memory integration", mode: "game", characterIds: [characterId] },
  });
  assert.equal(chatResponse.statusCode, 200);
  const chat = chatResponse.json();
  const messageResponse = await integrationApp.inject({
    method: "POST",
    url: `/api/chats/${chat.id}/messages`,
    payload: { role: "user", content: "The source says blue-room" },
  });
  assert.equal(messageResponse.statusCode, 200);
  const message = messageResponse.json();
  const storage = createCampaignMemoryStorage(db);
  const entity = await storage.createEntity({
    entityId: "integration-entity",
    chatId: chat.id,
    kind: "character",
    owner: { type: "existing", store: "characters", recordId: characterId },
    aliases: ["Integration"],
    tags: [],
    attributes: {},
    status: "active",
    manualLock: false,
    provenance,
    summary: "",
  });
  const sourceHash = createHash("sha256").update(message.content).digest("hex");
  const sourceCutoff = formatCampaignMemoryMessageOrder(message.id, message.createdAt);
  const storedFact = await storage.createFact({
    factId: "integration-fact",
    chatId: chat.id,
    subjectEntityId: entity.entityId,
    predicate: "knows",
    value: "blue-room",
    conditions: [{ kind: "when", value: "dawn" }],
    status: "verified" as any,
    validFromOrder: sourceCutoff,
    sourceRevision: sourceHash,
    evidence: [{ messageId: message.id, quote: message.content, sourceHash } as any],
    author: "user",
    provenance,
    manualLock: false,
  });
  await storage.createKnowledge({
    knowledgeId: "integration-knowledge",
    chatId: chat.id,
    holderEntityId: entity.entityId,
    factId: storedFact.factId,
    epistemicState: "knows",
    learnedFrom: [{ messageId: message.id, quote: message.content, sourceHash } as any],
    learnedAtOrder: sourceCutoff,
    provenance,
    manualLock: false,
  });
  const freshContext = await fromStorage(db, {
    chatId: chat.id,
    audience: { kind: "character", entityId: entity.entityId },
    maxCharacters: 1000,
    cutoffOrder: sourceCutoff,
  });
  assert.match(freshContext.text, /blue-room/);
  // Use the same storage edit path as the UI so the active swipe is updated too.
  await createChatsStorage(db).updateMessageContent(message.id, "The source changed");
  const staleContext = await fromStorage(db, {
    chatId: chat.id,
    audience: { kind: "character", entityId: entity.entityId },
    maxCharacters: 1000,
    cutoffOrder: sourceCutoff,
  });
  assert.equal(staleContext.text, "");
  assert.ok(staleContext.exclusions.some((item) => item.reason.includes("stale source revision")));
} finally {
  await integrationApp?.close();
  const { closeDB } = await import("../../packages/server/src/db/connection.js");
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log("campaign-memory-context regression: ok");
