import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// Campaign memory could only attach facts to party members: a library character named in play (a candidate, an
// NPC with a card) had no registered entity, so everything about her fell back to an anonymous lore record. In the
// real campaign only 587 of 2,015 record subjects resolved; Countess Lisaveta alone was named 201 times with no
// entity. Named library characters are now visible owners in the chat, registered with the names prose uses, and a
// relink attaches already-published records to them without re-reading anything.
const root = mkdtempSync(join(tmpdir(), "marinara-named-characters-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages, characters } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { publishContinuityReceipt, relinkPublishedContinuityMemory } =
    await import("../../packages/server/src/services/game/continuity-publication.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { ensureContinuityHolderReferences } =
    await import("../../packages/server/src/services/game/continuity-holder-snapshot.js");
  const { createCampaignMemoryOwnerReader } =
    await import("../../packages/server/src/services/game/campaign-memory-owners.js");
  const { countNamedCharacterFirstNames, namedCharacterAliases, forgetNamedCharacterIds } =
    await import("../../packages/server/src/services/game/named-characters.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  // Aliases: full name, name without titles, and a first name only when no other card shares it.
  const counts = countNamedCharacterFirstNames(["Lady Elsevere Aldareth", "Seliel of the Orchard Host", "Seliel Brightwater", "Ivy Undertree"]);
  assert.deepEqual(namedCharacterAliases("Lady Elsevere Aldareth", counts), [
    "Lady Elsevere Aldareth",
    "Elsevere Aldareth",
    "Elsevere",
  ]);
  assert.deepEqual(namedCharacterAliases("Seliel Brightwater", counts), ["Seliel Brightwater"], "shared first names are not aliases");
  assert.deepEqual(namedCharacterAliases("Ivy Undertree", counts), ["Ivy Undertree"], "short first names need the full name");

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  const metadata = JSON.stringify({ gameContinuity: { mode: "active", extractionInstructions: "fixed" } });
  await db.insert(apiConnections).values({ id: "conn", name: "Named test", provider: "custom", model: "m" });
  await db.insert(characters).values([
    { id: "elsevere", data: JSON.stringify({ name: "Lady Elsevere Aldareth" }), createdAt: now, updatedAt: now },
    { id: "hesper", data: JSON.stringify({ name: "Hesper Coyle" }), createdAt: now, updatedAt: now },
  ]);
  await db.insert(chats).values({
    id: "chat",
    name: "Named",
    mode: "game",
    connectionId: "conn",
    metadata,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values([
    { id: "m1", chatId: "chat", role: "user", content: "Send for Elsevere.", createdAt: "2026-09-16T00:00:01.000Z" },
    {
      id: "m2",
      chatId: "chat",
      role: "assistant",
      content: "Elsevere signs the contract in perpetuity.",
      createdAt: "2026-09-16T00:00:02.000Z",
    },
  ]);
  forgetNamedCharacterIds();

  const scope = await createCampaignMemoryOwnerReader(db).readChatScope("chat");
  assert.deepEqual(scope?.namedCharacterIds, ["elsevere"], "a character named in the chat is in its owner scope; one never named is not");

  // A receipt is published before she is registered: the record falls back to the anonymous lore entity.
  const current = await db.select().from(messages).where(eq(messages.chatId, "chat"));
  const sources = prepareContinuitySources(current, { gameContinuity: { mode: "active" } });
  const config = await readContinuityConfig(db, "chat");
  const record = {
    kind: "decision" as const,
    text: "Elsevere signed a contract in perpetuity.",
    subjects: ["Elsevere"],
    conditions: [],
    status: "completed" as const,
    evidence: [{ messageId: "m2", quote: "Elsevere signs the contract in perpetuity." }],
    keys: ["contract"],
  };
  const id = "gcb-named";
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
    records: [{ ...record, id: createGameContinuityRecordId(id, record) }],
    dispositions: sources.map((source) => ({
      messageId: source.messageId,
      status: source.messageId === "m2" ? "covered" : "no_durable_facts",
      reason: "test",
    })),
    review: {
      findings: [],
      dispositions: sources.map((source) => ({
        messageId: source.messageId,
        status: source.messageId === "m2" ? "covered" : "no_durable_facts",
        reason: "test",
      })),
    },
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await createGameContinuityStorage(db).enqueue(receipt);
  assert.equal((await publishContinuityReceipt(db, id))?.status, "published");
  const memory = createCampaignMemoryStorage(db);
  const factsBefore = (await memory.listFacts({ chatId: "chat" })).filter((fact) => fact.status === "verified");
  assert.equal(factsBefore.length, 1);
  assert.ok(factsBefore[0]!.predicate.startsWith("continuity."), "before registration the record only has the fallback fact");

  // Registration gives her an entity with the names prose uses.
  await ensureContinuityHolderReferences(db, "chat");
  const elsevere = (await memory.listEntities({ chatId: "chat" })).find(
    (entity) => entity.owner.type === "existing" && entity.owner.recordId === "elsevere",
  );
  assert.ok(elsevere, "the named library character is registered as a person");
  assert.equal(elsevere.kind, "character");
  assert.ok(elsevere.aliases.includes("Elsevere"));
  assert.ok(
    !(await memory.listEntities({ chatId: "chat" })).some(
      (entity) => entity.owner.type === "existing" && entity.owner.recordId === "hesper",
    ),
    "a library character never named in this chat is not registered",
  );

  // Relink attaches the published record to her and retires the fallback.
  const relinked = await relinkPublishedContinuityMemory(db, "chat");
  assert.equal(relinked.relinked, 1, JSON.stringify(relinked));
  const factsAfter = await memory.listFacts({ chatId: "chat" });
  const live = factsAfter.filter((fact) => fact.status === "verified");
  assert.equal(live.length, 1, "exactly one live fact carries the record");
  assert.equal(live[0]!.subjectEntityId, elsevere.entityId, "the live fact is about Elsevere herself");
  assert.equal(
    factsAfter.find((fact) => fact.factId === factsBefore[0]!.factId)?.status,
    "superseded",
    "the fallback fact is kept as superseded",
  );

  // Relinking again changes nothing.
  const again = await relinkPublishedContinuityMemory(db, "chat");
  assert.equal(again.relinked, 1);
  assert.equal((await memory.listFacts({ chatId: "chat" })).filter((fact) => fact.status === "verified").length, 1);

  // A card whose person is already tracked as an NPC of the same name is not registered a second time.
  await db.insert(characters).values({ id: "audrey-card", data: JSON.stringify({ name: "Audrey Justinia" }), createdAt: now, updatedAt: now });
  await db
    .update(chats)
    .set({ metadata: JSON.stringify({ ...JSON.parse(metadata), gameNpcs: [{ id: "npc-audrey", name: "Audrey Justinia" }] }) })
    .where(eq(chats.id, "chat"));
  await db.insert(messages).values({
    id: "m3",
    chatId: "chat",
    role: "user",
    content: "Audrey Justinia reads the register.",
    createdAt: "2026-09-16T00:00:03.000Z",
  });
  forgetNamedCharacterIds();
  await ensureContinuityHolderReferences(db, "chat");
  const audreys = (await memory.listEntities({ chatId: "chat" })).filter((entity) =>
    entity.aliases.includes("Audrey Justinia"),
  );
  assert.equal(audreys.length, 1, "one person, one entity");
  assert.equal(audreys[0]!.owner.type === "existing" && audreys[0]!.owner.store, "game-npcs");

  await db._fileStore.close();
  console.log("campaign-memory-named-characters regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
