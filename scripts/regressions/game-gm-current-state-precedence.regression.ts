import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Pulse 3 exit criterion: current state overrides stale biography text where they conflict.
// A card says the character lives in Dunmere; a current-state row says she is in the capital.
const root = mkdtempSync(join(tmpdir(), "marinara-gm-state-precedence-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

let db: any;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, campaignMemoryEntities, campaignMemoryFacts, campaignMemoryKnowledge, campaignMemoryEvents, campaignMemoryCurrentState } =
    await import("../../packages/server/src/db/schema/index.js");
  const { buildCampaignMemoryContextFromStorage } =
    await import("../../packages/server/src/services/game/campaign-memory-context.js");
  const { injectGameGmPromptRuntime, GAME_GM_CAMPAIGN_MEMORY_PRECEDENCE } =
    await import("../../packages/server/src/services/generation/game-gm-prompt-runtime.js");
  db = await createFileNativeDB();
  const chatId = "precedence-chat";
  const now = "2026-01-01T00:00:00.000Z";
  const order = (index: number) => `m${index}|2026-01-01T00:00:0${index}.000Z|m${index}`;
  const provenance = JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "user" });
  await db.insert(chats).values({ id: chatId, name: "Precedence", mode: "game", characterIds: "[]", metadata: "{}", createdAt: now, updatedAt: now });
  const entity = (entityId: string, kind: string, recordId: string, alias: string) => ({
    entityId, chatId, kind, owner: JSON.stringify({ type: "existing", store: "characters", recordId }), aliases: JSON.stringify([alias]),
    tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance, revision: 1, createdAt: now, updatedAt: now,
  });
  await db.insert(campaignMemoryEntities).values([
    entity("char-mira", "character", "card-mira", "Mira"),
    entity("char-scout", "character", "card-scout", "Scout"),
    entity("char-stranger", "character", "card-stranger", "Stranger"),
    { ...entity("lore-weather", "lore", "unused", "Weather"), owner: JSON.stringify({ type: "registry", store: "campaign-memory", recordId: "lore-weather" }) },
  ]);
  const event = (eventId: string, participant: string, index: number) => ({
    eventId, chatId, occurrenceOrder: order(index), campaignTime: null, participantEntityIds: JSON.stringify([participant]), locationEntityId: null,
    sourceRevision: "r1", transitions: JSON.stringify([`${participant} moved`]), evidence: "[]", provenance, immutable: 1, createdAt: now,
  });
  await db.insert(campaignMemoryEvents).values([
    event("event-mira", "char-mira", 1),
    event("event-stranger", "char-stranger", 2),
    event("event-weather", "lore-weather", 3),
  ]);
  const state = (stateId: string, entityId: string, property: string, value: unknown, sourceEventId: string, index: number) => ({
    stateId, chatId, entityId, property, value: JSON.stringify(value), sourceEventId, validAtOrder: order(index), protected: 0, provenance,
    manualLock: 0, revision: 1, createdAt: now, updatedAt: now,
  });
  await db.insert(campaignMemoryCurrentState).values([
    state("state-mira", "char-mira", "location", "the capital", "event-mira", 1),
    state("state-stranger", "char-stranger", "location", "the hidden camp", "event-stranger", 2),
    state("state-weather", "lore-weather", "sky", { text: "storm", knowledge: { scope: "world", holders: [] } }, "event-weather", 3),
  ]);
  // Scout has verified knowledge about the stranger; Mira has none.
  await db.insert(campaignMemoryFacts).values({
    factId: "fact-stranger", chatId, subjectEntityId: "char-stranger", predicate: "role", value: JSON.stringify("smuggler"), conditions: "[]",
    status: "verified", validFromOrder: order(2), sourceRevision: "r1", evidence: "[]", author: "user", provenance, manualLock: 0, revision: 1, createdAt: now, updatedAt: now,
  });
  await db.insert(campaignMemoryKnowledge).values({
    knowledgeId: "know-scout", chatId, holderEntityId: "char-scout", factId: "fact-stranger", epistemicState: "knows", learnedFrom: "[]",
    learnedAtOrder: order(2), provenance, manualLock: 0, revision: 1, createdAt: now, updatedAt: now,
  });

  // 1. GM block: stable prefix hash is identical with and without campaign memory.
  const runtime = async (withMemory: boolean) => {
    const messages: any[] = [];
    await injectGameGmPromptRuntime({
      ...(withMemory ? { db, campaignMemoryRequestMode: "live-current" as const } : {}),
      messages,
      chatId,
      chat: {},
      chatMetadata: { gamePartyCharacterIds: ["card-mira"], gameSetupConfig: { genre: "fantasy" } },
      characterIds: [],
      chars: {
        getById: async (id: string) =>
          id === "card-mira" ? { data: { name: "Mira", description: "Mira lives in Dunmere and has never left it." } } : null,
        getPersona: async () => null,
      },
      chats: { getById: async () => null, updateMetadata: async () => null },
      selectedGameStateSnapshotPromise: Promise.resolve({ presentCharacters: JSON.stringify([{ characterId: "card-mira", name: "Mira" }]) }),
      mappedMessages: [{ role: "user", content: "Where is Mira?" }],
      personaName: "Player",
      resolvePromptMacros: (value: string) => value,
      resolveCharacterPromptMacros: (value: string) => value,
      cacheFriendlyLayout: true,
    });
    return messages;
  };
  const stableHash = (messages: any[]) =>
    createHash("sha256").update(messages.find((message) => message.providerMetadata?.marinaraGmStable === true).content).digest("hex");
  const without = await runtime(false);
  const withMemory = await runtime(true);
  assert.equal(stableHash(withMemory), stableHash(without), "campaign memory never changes the stable cache prefix");
  assert.match(without.map((message) => message.content).join("\n"), /lives in Dunmere/u, "the stale card is still in the prompt");
  assert.equal(without.some((message) => message.providerMetadata?.marinaraCampaignMemory), false);
  const block = withMemory.at(-1);
  assert.equal(block.contextKind, "injection");
  const lines: string[] = block.content.split("\n");
  assert.equal(lines[0], '<campaign_memory audience="gm">');
  assert.equal(lines[1], GAME_GM_CAMPAIGN_MEMORY_PRECEDENCE, "the precedence sentence heads the runtime block");
  assert.match(GAME_GM_CAMPAIGN_MEMORY_PRECEDENCE, /override any conflicting character card, persona, or lore text; when they conflict, use this block/u);
  const header = lines.indexOf("[current_state]");
  assert.ok(header > 1, "a dedicated [current_state] section is present");
  assert.equal(
    lines[header + 1],
    "Mira: location = the capital",
    "the current-state line names the new location, not Dunmere",
  );
  const firstFact = lines.findIndex((line) => line.startsWith("[fact "));
  assert.ok(firstFact > header, "current state renders ahead of facts");
  assert.doesNotMatch(block.content.slice(0, block.content.indexOf("[fact ")), /Dunmere/u);
  const metadata = block.providerMetadata.marinaraCampaignMemory;
  assert.equal(metadata.precedence, "campaign-memory-over-cards");
  assert.equal(metadata.currentStateCount, 3, "GM sees state for present and event-referenced entities");
  assert.ok(metadata.includedIds.includes("state-mira") && metadata.includedIds.includes("state-stranger"));

  // 2. Character audience: only its own state, state of entities its knowledge names, and world-scope state.
  const mira = await buildCampaignMemoryContextFromStorage(db, { chatId, audience: { kind: "character", entityId: "char-mira" }, maxCharacters: 6_000 });
  assert.match(mira.text, /^\[current_state\]\n(?:.*\n)?Mira: location = the capital$/mu, "a character knows its own current state");
  assert.match(mira.text, /Weather: sky = storm/u, "world-scope state reaches every character");
  assert.doesNotMatch(mira.text, /Stranger|hidden camp/u, "Mira has no knowledge of the stranger");
  assert.equal(mira.exclusions.find((item) => item.id === "state-stranger")?.reason, "current state entity is not present, referenced, or known");
  assert.equal(mira.currentStateCount, 2);
  const scout = await buildCampaignMemoryContextFromStorage(db, { chatId, audience: { kind: "character", entityId: "char-scout" }, maxCharacters: 6_000 });
  assert.match(scout.text, /Stranger: location = the hidden camp/u, "knowledge about an entity unlocks its current state");
  assert.doesNotMatch(scout.text, /Mira: location/u, "Scout has no knowledge of Mira");
  assert.ok(scout.text.indexOf("[current_state]") < scout.text.indexOf("[knowledge "), "current state precedes knowledge lines");

  // 3. Budget: the header is charged with its first row, so a tiny budget drops the section rather than overflowing.
  const tiny = await buildCampaignMemoryContextFromStorage(db, { chatId, audience: { kind: "character", entityId: "char-mira" }, maxCharacters: 20 });
  assert.equal(tiny.text, "");
  assert.equal(tiny.currentStateCount, 0);
  assert.ok(tiny.text.length <= 20);

  await db._fileStore.close();
  db = undefined;
  console.log("game-gm-current-state-precedence regression passed");
} finally {
  if (db) await db._fileStore.close();
  rmSync(root, { recursive: true, force: true });
}
