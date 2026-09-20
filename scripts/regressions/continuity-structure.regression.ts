import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// Current state ("who is where") and relationships stayed nearly empty because transitions were guessed from record
// wording: across ten sessions only 10 current-state rows and 0 relationships existed. The structure pass asks the
// continuity model which published records state a movement or a relationship, resolves every name against the
// registered people and places, applies what resolves to exactly one entity, drops the rest, and marks each receipt
// so it is never paid for twice.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-structure-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages, characters, lorebookEntries, campaignMemoryCurrentState, campaignMemoryRelationships } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { publishContinuityReceipt } = await import("../../packages/server/src/services/game/continuity-publication.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { ensureContinuityHolderReferences } =
    await import("../../packages/server/src/services/game/continuity-holder-snapshot.js");
  const { forgetNamedCharacterIds } = await import("../../packages/server/src/services/game/named-characters.js");
  const { structurePublishedContinuity, parseContinuityStructure, createContinuityEntityResolver } =
    await import("../../packages/server/src/services/game/continuity-structure.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  // Untrusted model output is filtered: unknown record ids, unknown relationship types and empty names are dropped.
  const parsed = parseContinuityStructure(
    {
      movements: [
        { recordId: "r1", who: ["Elsevere"], to: "Library", presence: "present" },
        { recordId: "nope", who: ["Elsevere"], to: "Library" },
      ],
      relationships: [
        { recordId: "r1", source: "A", target: "B", type: "employs", status: "active" },
        { recordId: "r1", source: "A", target: "B", type: "adores", status: "active" },
      ],
    },
    new Set(["r1"]),
  );
  assert.equal(parsed.movements.length, 1);
  assert.equal(parsed.relationships.length, 1);

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  const metadata = {
    gameContinuity: { mode: "active", extractionInstructions: "fixed" },
    spatialContext: {
      schemaVersion: 1,
      ownerMode: "game",
      enabled: true,
      revision: 1,
      startingLocationId: "library",
      locations: [
        { id: "library", parentId: null, name: "Moonrise Hall Library", kind: "room", description: "", lorebookEntryIds: [], childPresentation: "list", links: [], status: "active", sortOrder: 0 },
        { id: "drive", parentId: null, name: "The Drive", kind: "place", description: "", lorebookEntryIds: [], childPresentation: "list", links: [], status: "active", sortOrder: 1 },
      ],
    },
  };
  await db.insert(apiConnections).values({ id: "conn", name: "Structure test", provider: "custom", model: "m" });
  await db.insert(characters).values([
    { id: "elsevere", data: JSON.stringify({ name: "Lady Elsevere Aldareth" }), createdAt: now, updatedAt: now },
    { id: "audrey", data: JSON.stringify({ name: "Audrey Justinia" }), createdAt: now, updatedAt: now },
  ]);
  await db.insert(chats).values({
    id: "chat",
    name: "Structure",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify(metadata),
    createdAt: now,
    updatedAt: now,
  });
  const text = "Elsevere comes into the library, and Audrey hires her on a perpetual contract.";
  await db.insert(messages).values([
    { id: "m1", chatId: "chat", role: "user", content: "Bring Elsevere and Audrey in.", createdAt: "2026-09-16T00:00:01.000Z" },
    { id: "m2", chatId: "chat", role: "assistant", content: text, createdAt: "2026-09-16T00:00:02.000Z" },
  ]);
  forgetNamedCharacterIds();
  // Register owners the way the campaign index does: people and places.
  const { collectCampaignMemoryLegacySource, planCampaignMemoryLegacyImport, applyCampaignMemoryLegacyImport } =
    await import("../../packages/server/src/services/game/campaign-memory-import.js");
  await applyCampaignMemoryLegacyImport(
    db,
    await planCampaignMemoryLegacyImport(db, await collectCampaignMemoryLegacySource(db, "chat")),
  );
  await ensureContinuityHolderReferences(db, "chat");

  const current = await db.select().from(messages).where(eq(messages.chatId, "chat"));
  const sources = prepareContinuitySources(current, metadata);
  const config = await readContinuityConfig(db, "chat");
  const recordOf = (kind: "event" | "decision", recordText: string) => ({
    kind,
    text: recordText,
    subjects: ["Elsevere", "Audrey"],
    conditions: [],
    status: "completed" as const,
    evidence: [{ messageId: "m2", quote: text }],
    keys: [],
  });
  const id = "gcb-structure";
  const rawRecords = [
    recordOf("event", "Elsevere came into the library."),
    recordOf("decision", "Audrey hired Elsevere on a perpetual contract."),
  ];
  const records = rawRecords.map((record) => ({ ...record, id: createGameContinuityRecordId(id, record) }));
  const disposition = (messageId: string) => ({
    messageId,
    status: messageId === "m2" ? ("covered" as const) : ("no_durable_facts" as const),
    reason: "test",
  });
  const receipt: GameContinuityReceipt = {
    id,
    chatId: "chat",
    sessionNumber: 1,
    sourceHash: "source",
    sources,
    context: [],
    configHash: config.hash,
    config: config.frozen,
    status: "verified",
    attempts: 1,
    repairAttempts: 0,
    records,
    dispositions: sources.map((source) => disposition(source.messageId)),
    review: { findings: [], dispositions: sources.map((source) => disposition(source.messageId)) },
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await createGameContinuityStorage(db).enqueue(receipt);
  assert.equal((await publishContinuityReceipt(db, id))?.status, "published");

  const entities = await createCampaignMemoryStorage(db).listEntities({ chatId: "chat" });
  const resolve = createContinuityEntityResolver(entities);
  const elsevere = resolve("Elsevere", ["character"]);
  const audrey = resolve("Audrey Justinia", ["character"]);
  const library = resolve("library", ["location"]);
  assert.ok(elsevere, "a person resolves by a registered alias");
  assert.ok(audrey, "a person resolves by full name");
  assert.ok(library, "a shortened place name resolves to the one registered place containing it");
  assert.equal(resolve("Rowan", ["character"]), null, "an unknown name resolves to nothing");

  const prompts: string[] = [];
  const stub = async (_chatId: string, prompt: string) => {
    prompts.push(prompt);
    return {
      movements: [
        { recordId: records[0]!.id, who: ["Elsevere"], to: "library", presence: "present" },
        { recordId: records[0]!.id, who: ["Someone Unknown"], to: "library", presence: "present" },
      ],
      relationships: [
        { recordId: records[1]!.id, source: "Audrey Justinia", target: "Elsevere", type: "employs", status: "active" },
        { recordId: records[1]!.id, source: "Audrey Justinia", target: "Nobody", type: "friend-of", status: "active" },
      ],
    };
  };
  const first = await structurePublishedContinuity(db, "chat", { complete: stub });
  assert.equal(first.calls, 1);
  assert.equal(first.movementsApplied, 1, JSON.stringify(first));
  assert.equal(first.relationshipsApplied, 1, JSON.stringify(first));
  assert.equal(first.dropped["movement-person-unresolved"], 1);
  assert.equal(first.dropped["relationship-person-unresolved"], 1);
  assert.ok(prompts[0]!.includes("Moonrise Hall Library") && prompts[0]!.includes("Audrey Justinia"), "the model is given the registered names");

  const state = await db.select().from(campaignMemoryCurrentState).where(eq(campaignMemoryCurrentState.chatId, "chat"));
  assert.ok(
    state.some((row) => JSON.stringify(row).includes(elsevere!) && JSON.stringify(row).includes(library!)),
    "Elsevere's current location is the library",
  );
  const relationships = await db
    .select()
    .from(campaignMemoryRelationships)
    .where(eq(campaignMemoryRelationships.chatId, "chat"));
  assert.equal(relationships.length, 1);
  assert.equal(relationships[0]!.type, "employs");
  assert.equal(relationships[0]!.sourceEntityId, audrey);
  assert.equal(relationships[0]!.targetEntityId, elsevere);

  // The receipt is marked; a second run pays for nothing.
  const entry = (await db.select().from(lorebookEntries)).find((row) => row.id.startsWith("gce_"));
  assert.ok(JSON.stringify(entry?.dynamicState).includes("structure"));
  const second = await structurePublishedContinuity(db, "chat", { complete: stub });
  assert.equal(second.calls, 0);
  assert.equal(prompts.length, 1);

  await db._fileStore.close();
  console.log("continuity-structure regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
