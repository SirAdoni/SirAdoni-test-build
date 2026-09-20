import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CampaignMemoryEntity, CampaignMemoryFact, CampaignMemoryKnowledge } from "@marinara-engine/shared";
import {
  appendCanonicalPartySpeakerMemory,
  buildCanonicalPartySpeakerPublicCard,
  buildPartySpeakerProviderRequest,
  resolveCanonicalPartyMemoryEntity,
} from "../../packages/server/src/routes/game.routes.js";
import { buildCampaignMemoryContext } from "../../packages/server/src/services/game/campaign-memory-context.js";
import { formatCampaignMemoryMessageOrder } from "../../packages/server/src/services/game/campaign-memory-order.js";
const sourceOrder = formatCampaignMemoryMessageOrder("gm-message-7", "2026-01-01T00:00:07.000Z");

const chatId = "party-memory-final-request";
const provenance = { source: "regression", sourceRevision: "1", actor: "user" as const };
const sourceText = "GM narration: Alice learned the seven-day secret.";
const sourceHash = createHash("sha256").update(sourceText).digest("hex");
const entity = (entityId: string, name: string): CampaignMemoryEntity => ({
  entityId,
  chatId,
  kind: "character",
  owner: { type: "existing", store: "characters", recordId: entityId },
  aliases: [name],
  tags: [],
  attributes: {},
  status: "active",
  manualLock: false,
  provenance,
  revision: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
const alice = entity("alice-id", "Same Name");
const bob = entity("bob-id", "Same Name");
const invalidRegistryOwner = {
  ...alice,
  entityId: "invalid-registry-owner",
  owner: { type: "registry" as const, store: "campaign-memory" as const, recordId: "invalid-registry-owner" },
};
assert.equal(
  resolveCanonicalPartyMemoryEntity([invalidRegistryOwner], chatId, invalidRegistryOwner.entityId).entity,
  null,
);
assert.equal(resolveCanonicalPartyMemoryEntity([alice, bob], chatId, alice.entityId).entity?.entityId, alice.entityId);
assert.equal(
  resolveCanonicalPartyMemoryEntity([alice, { ...alice, entityId: "alice-duplicate" }], chatId, alice.entityId).entity,
  null,
);
const fact: CampaignMemoryFact = {
  factId: "seven-day-secret",
  chatId,
  subjectEntityId: alice.entityId,
  predicate: "knows",
  value: "seven-day-secret",
  conditions: [],
  status: "verified",
  validFromOrder: sourceOrder,
  sourceRevision: "1",
  evidence: [{ messageId: "gm-message-7", quote: sourceText, sourceHash }],
  author: "user",
  provenance,
  manualLock: false,
  revision: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const aliceKnowledge: CampaignMemoryKnowledge = {
  knowledgeId: "alice-knows-secret",
  chatId,
  holderEntityId: alice.entityId,
  factId: fact.factId,
  epistemicState: "knows",
  learnedAtOrder: sourceOrder,
  learnedFrom: [{ messageId: "gm-message-7", quote: sourceText, sourceHash }],
  provenance,
  manualLock: false,
  revision: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const base = {
  chatId,
  entities: [alice, bob],
  facts: [fact],
  knowledge: [aliceKnowledge],
  events: [],
  currentState: [],
  relationships: [],
  maxCharacters: 2000,
  cutoffOrder: sourceOrder,
  sourceContents: { "gm-message-7": { chatId, content: sourceText, sourceHash, captureOrder: sourceOrder } },
};

const aliceRequest = buildCampaignMemoryContext({ ...base, audience: { kind: "character", entityId: alice.entityId } });
assert.match(aliceRequest.text, /seven-day-secret/u, "the final Alice request receives her held seven-day fact");
const publicCard = buildCanonicalPartySpeakerPublicCard({
  name: "Same Name",
  personality: "guarded but kind\nwith a coherent second line",
  appearance: "dark hair and a blue coat\nwith a visible scar",
  className: "ranger",
});
const aliceProviderRequest = appendCanonicalPartySpeakerMemory("base speaker system prompt", {
  entityId: alice.entityId,
  ...aliceRequest,
});
assert.match(aliceProviderRequest, /<campaign_memory audience="alice-id">/u);
assert.match(aliceProviderRequest, /seven-day-secret/u);
const canonicalFinalRequest = buildPartySpeakerProviderRequest({
  prompt: { partyRoster: ["Same Name"], playerName: "Player", gameActiveState: "exploration" },
  speaker: { name: "Same Name", card: publicCard },
  ownContinuityEvidence: "legacy own secret must be absent",
  sharedContinuityEvidence: "legacy shared secret must be absent",
  canonicalMemory: { entityId: alice.entityId, ...aliceRequest },
});
assert.match(canonicalFinalRequest, /seven-day-secret/u);
assert.doesNotMatch(canonicalFinalRequest, /legacy own secret|legacy shared secret/u);
const legacyFinalRequest = buildPartySpeakerProviderRequest({
  prompt: { partyRoster: ["Same Name"], playerName: "Player", gameActiveState: "exploration" },
  speaker: { name: "Same Name", card: publicCard },
  ownContinuityEvidence: "legacy own secret retained",
  sharedContinuityEvidence: "legacy shared secret retained",
  canonicalMemory: null,
});
assert.match(legacyFinalRequest, /legacy own secret retained|legacy shared secret retained/u);
const bobRequest = buildCampaignMemoryContext({ ...base, audience: { kind: "character", entityId: bob.entityId } });
assert.doesNotMatch(bobRequest.text, /seven-day-secret/u, "same-name Bob cannot receive Alice's held fact");
const bobProviderRequest = appendCanonicalPartySpeakerMemory("base speaker system prompt", {
  entityId: bob.entityId,
  ...bobRequest,
});
assert.doesNotMatch(bobProviderRequest, /seven-day-secret/u);

assert.match(publicCard, /Personality: guarded but kind/u);
assert.match(publicCard, /Appearance: dark hair/u);
assert.match(publicCard, /with a coherent second line|with a visible scar/u);
assert.doesNotMatch(publicCard, /Backstory|Notes|Secret Arc|hidden biography secret/u);

const storageRoot = mkdtempSync(join(tmpdir(), "marinara-party-memory-final-request-"));
process.env.DATA_DIR = storageRoot;
process.env.FILE_STORAGE_DIR = join(storageRoot, "storage");
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, characters } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db
    .insert(characters)
    .values({ id: "char-a", data: JSON.stringify({ name: "Same Name" }), createdAt: now, updatedAt: now });
  await db
    .insert(characters)
    .values({ id: "char-b", data: JSON.stringify({ name: "Same Name" }), createdAt: now, updatedAt: now });
  await db.insert(chats).values({
    id: chatId,
    name: "Party memory final request",
    mode: "game",
    characterIds: JSON.stringify(["char-a", "char-b"]),
    metadata: "{}",
    createdAt: now,
    updatedAt: now,
  });
  const storage = createCampaignMemoryStorage(db);
  await storage.createEntity({
    entityId: "stored-alice",
    chatId,
    kind: "character",
    owner: { type: "existing", store: "characters", recordId: "char-a" },
    aliases: ["Same Name"],
    tags: [],
    attributes: {},
    status: "active",
    manualLock: false,
    provenance,
  });
  const storedEntities = await storage.listEntities({ chatId });
  assert.equal(resolveCanonicalPartyMemoryEntity(storedEntities, chatId, "char-a").entity?.entityId, "stored-alice");
  assert.equal(resolveCanonicalPartyMemoryEntity(storedEntities, chatId, "char-b").entity, null);
  await db._fileStore.close();
} finally {
  rmSync(storageRoot, { recursive: true, force: true });
}

console.log("game party memory final request regression: ok");
