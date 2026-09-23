import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// Campaign memory could only attach facts to party members: a library character named in play (a candidate, an
// NPC with a card) had no registered entity, so everything about her fell back to an anonymous lore record. In the
// real campaign only 587 of 2,015 record subjects resolved; Countess Maritza alone was named 201 times with no
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
  const counts = countNamedCharacterFirstNames(["Lady Ismene Varrow", "Nimue of the Linden Host", "Nimue Brightwater", "Una Tansley"]);
  assert.deepEqual(namedCharacterAliases("Lady Ismene Varrow", counts), [
    "Lady Ismene Varrow",
    "Ismene Varrow",
    "Ismene",
  ]);
  assert.deepEqual(namedCharacterAliases("Nimue Brightwater", counts), ["Nimue Brightwater"], "shared first names are not aliases");
  assert.deepEqual(namedCharacterAliases("Una Tansley", counts), ["Una Tansley"], "short first names need the full name");

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  const metadata = JSON.stringify({ gameContinuity: { mode: "active", extractionInstructions: "fixed" } });
  await db.insert(apiConnections).values({ id: "conn", name: "Named test", provider: "custom", model: "m" });
  await db.insert(characters).values([
    { id: "ismene", data: JSON.stringify({ name: "Lady Ismene Varrow" }), createdAt: now, updatedAt: now },
    { id: "liesel", data: JSON.stringify({ name: "Liesel Pike" }), createdAt: now, updatedAt: now },
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
    { id: "m1", chatId: "chat", role: "user", content: "Send for Ismene.", createdAt: "2026-09-16T00:00:01.000Z" },
    {
      id: "m2",
      chatId: "chat",
      role: "assistant",
      content: "Ismene signs the contract in perpetuity.",
      createdAt: "2026-09-16T00:00:02.000Z",
    },
  ]);
  forgetNamedCharacterIds();

  const scope = await createCampaignMemoryOwnerReader(db).readChatScope("chat");
  assert.deepEqual(scope?.namedCharacterIds, ["ismene"], "a character named in the chat is in its owner scope; one never named is not");

  // A receipt is published before she is registered: the record falls back to the anonymous lore entity.
  const current = await db.select().from(messages).where(eq(messages.chatId, "chat"));
  const sources = prepareContinuitySources(current, { gameContinuity: { mode: "active" } });
  const config = await readContinuityConfig(db, "chat");
  const record = {
    kind: "decision" as const,
    text: "Ismene signed a contract in perpetuity.",
    subjects: ["Ismene"],
    conditions: [],
    status: "completed" as const,
    evidence: [{ messageId: "m2", quote: "Ismene signs the contract in perpetuity." }],
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
  const ismene = (await memory.listEntities({ chatId: "chat" })).find(
    (entity) => entity.owner.type === "existing" && entity.owner.recordId === "ismene",
  );
  assert.ok(ismene, "the named library character is registered as a person");
  assert.equal(ismene.kind, "character");
  assert.ok(ismene.aliases.includes("Ismene"));
  assert.ok(
    !(await memory.listEntities({ chatId: "chat" })).some(
      (entity) => entity.owner.type === "existing" && entity.owner.recordId === "liesel",
    ),
    "a library character never named in this chat is not registered",
  );

  // Relink attaches the published record to her and retires the fallback.
  const relinked = await relinkPublishedContinuityMemory(db, "chat");
  assert.equal(relinked.relinked, 1, JSON.stringify(relinked));
  const factsAfter = await memory.listFacts({ chatId: "chat" });
  const live = factsAfter.filter((fact) => fact.status === "verified");
  assert.equal(live.length, 1, "exactly one live fact carries the record");
  assert.equal(live[0]!.subjectEntityId, ismene.entityId, "the live fact is about Ismene herself");
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
  await db.insert(characters).values({ id: "beatrix-card", data: JSON.stringify({ name: "Beatrix Hallam" }), createdAt: now, updatedAt: now });
  await db
    .update(chats)
    .set({ metadata: JSON.stringify({ ...JSON.parse(metadata), gameNpcs: [{ id: "npc-beatrix", name: "Beatrix Hallam" }] }) })
    .where(eq(chats.id, "chat"));
  await db.insert(messages).values({
    id: "m3",
    chatId: "chat",
    role: "user",
    content: "Beatrix Hallam reads the register.",
    createdAt: "2026-09-16T00:00:03.000Z",
  });
  forgetNamedCharacterIds();
  await ensureContinuityHolderReferences(db, "chat");
  const beatrixes = (await memory.listEntities({ chatId: "chat" })).filter((entity) =>
    entity.aliases.includes("Beatrix Hallam"),
  );
  assert.equal(beatrixes.length, 1, "one person, one entity");
  assert.equal(beatrixes[0]!.owner.type === "existing" && beatrixes[0]!.owner.store, "game-npcs");

  // Her entity is archived, so the record's subject no longer resolves: the next relink brings the superseded
  // fallback back instead of failing the whole receipt with a fact conflict on every relink after.
  const { applyCampaignMemoryMutation } =
    await import("../../packages/server/src/services/game/campaign-memory-mutations.js");
  const ismeneNow = (await memory.getEntity({ chatId: "chat" }, ismene.entityId))!;
  await applyCampaignMemoryMutation(db, {
    chatId: "chat",
    operationId: "archive-ismene",
    actor: "user",
    reason: "test",
    recordType: "entity",
    action: "update",
    recordId: ismene.entityId,
    expectedRevision: ismeneNow.revision,
    patch: { status: "archived" },
  });
  const afterArchive = await relinkPublishedContinuityMemory(db, "chat");
  assert.deepEqual(afterArchive.skipped, {}, JSON.stringify(afterArchive));
  assert.equal(afterArchive.relinked, 1);
  assert.equal(
    (await memory.getFact({ chatId: "chat" }, factsBefore[0]!.factId))?.status,
    "verified",
    "the fallback carries the record again",
  );
  assert.equal((await relinkPublishedContinuityMemory(db, "chat")).relinked, 1, "and relinking stays stable");

  await db._fileStore.close();
  console.log("campaign-memory-named-characters regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
