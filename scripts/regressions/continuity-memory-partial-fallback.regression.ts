import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// Publication kept a fallback copy of a record on the batch's "Game continuity N" lore page whenever ANY subject was
// unresolved, so a record naming one known and one unknown person was stored twice (about 93% of batch-page facts
// repeated a fact on a real page). The fallback is now written, or kept by relink, only when NO subject resolves;
// otherwise each per-subject fact carries the unresolved names in value.unresolvedSubjects.
const root = mkdtempSync(join(tmpdir(), "marinara-partial-fallback-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let db: any;

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { publishContinuityReceipt, relinkPublishedContinuityMemory } =
    await import("../../packages/server/src/services/game/continuity-publication.js");
  const { publishContinuityMemory } =
    await import("../../packages/server/src/services/game/continuity-memory-publication.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  db = await createFileNativeDB();
  const now = "2026-09-20T00:00:00.000Z";
  await db.insert(schema.apiConnections).values({ id: "conn", name: "Fallback test", provider: "custom", model: "m" });
  await db.insert(schema.chats).values({
    id: "chat",
    name: "Session 1",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify({
      gameContinuity: { mode: "active" },
      gameNpcs: [
        { id: "npc-mira", name: "Mira" },
        { id: "npc-aria", name: "Aria Vell" },
      ],
    }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.messages).values([
    { id: "m1", chatId: "chat", role: "user", content: "Mira asks Aria Vell to guard the gate.", createdAt: now },
    {
      id: "m2",
      chatId: "chat",
      role: "assistant",
      content: "Aria Vell takes the watch; Oswin and Aria Vell split the lantern oil.",
      createdAt: "2026-09-20T00:00:01.000Z",
    },
  ]);
  await db.insert(schema.lorebooks).values({
    id: "keeper",
    name: "Keeper",
    chatId: "chat",
    enabled: "false",
    sourceAgentId: "game-lorebook-keeper",
    createdAt: now,
    updatedAt: now,
  });
  const entity = (entityId: string, recordId: string, alias: string) => ({
    entityId,
    chatId: "chat",
    kind: "character",
    owner: JSON.stringify({ type: "existing", store: "game-npcs", recordId }),
    aliases: JSON.stringify([alias]),
    tags: JSON.stringify(["npc"]),
    attributes: "{}",
    status: "active",
    manualLock: 0,
    provenance: JSON.stringify({ source: "regression", sourceRevision: entityId, actor: "user" }),
    createdAt: now,
    updatedAt: now,
  });
  // Only Mira is registered at first.
  await db.insert(schema.campaignMemoryEntities).values(entity("ent-mira", "npc-mira", "Mira"));

  const messages = await db.select().from(schema.messages);
  const prepared = prepareContinuitySources(messages, { gameContinuity: { mode: "active" } });
  const config = await readContinuityConfig(db, "chat");
  const raw = [
    {
      kind: "promise" as const,
      text: "Mira asked Aria Vell to guard the gate.",
      subjects: ["Mira", "Aria Vell"],
      conditions: [],
      status: "proposed" as const,
      keys: ["gate"],
      evidence: [{ messageId: "m1", quote: "Mira asks Aria Vell to guard the gate." }],
      knowledge: { scope: "world" as const, holders: ["Mira"] },
    },
    {
      kind: "event" as const,
      text: "Aria Vell took the watch.",
      subjects: ["Aria Vell"],
      conditions: [],
      status: "completed" as const,
      keys: ["watch"],
      evidence: [{ messageId: "m2", quote: "Aria Vell takes the watch" }],
    },
    {
      kind: "event" as const,
      text: "Oswin and Aria Vell split the lantern oil.",
      subjects: ["Oswin", "Aria Vell"],
      conditions: [],
      status: "completed" as const,
      keys: ["oil"],
      evidence: [{ messageId: "m2", quote: "Oswin and Aria Vell split the lantern oil." }],
    },
  ];
  const id = "receipt-partial";
  const records = raw.map((record) => ({ ...record, id: createGameContinuityRecordId(id, record) }));
  const [askRecord, watchRecord, oilRecord] = records as [
    (typeof records)[number],
    (typeof records)[number],
    (typeof records)[number],
  ];
  const receipt: GameContinuityReceipt = {
    id,
    chatId: "chat",
    sessionNumber: 1,
    sourceHash: hash({ source: id }),
    sources: prepared,
    context: [],
    configHash: config.hash,
    config: config.frozen,
    status: "verified",
    attempts: 1,
    repairAttempts: 0,
    records,
    dispositions: prepared.map((item) => ({ messageId: item.messageId, status: "covered" as const, reason: "test" })),
    review: {
      findings: [],
      dispositions: prepared.map((item) => ({ messageId: item.messageId, status: "covered" as const, reason: "test" })),
    },
    knowledgeHolders: [{ entityId: "ent-mira", kind: "character", store: "game-npcs", recordId: "npc-mira", name: "Mira" }],
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await createGameContinuityStorage(db).enqueue(receipt);
  assert.equal((await publishContinuityReceipt(db, id))?.status, "published");

  const facts = async () => (await db.select().from(schema.campaignMemoryFacts)) as any[];
  const of = (rows: any[], recordId: string) => rows.filter((row) => JSON.parse(row.value).recordId === recordId);
  const live = (rows: any[]) => rows.filter((row) => row.status === "verified");
  const isFallback = (row: any) => String(row.predicate).startsWith("continuity.");

  // One resolved (Mira) and one unresolved (Aria Vell) subject: one fact, on Mira, naming Aria; no fallback.
  let rows = await facts();
  const ask = of(rows, askRecord.id);
  assert.equal(ask.length, 1, "a partly resolved record publishes exactly one fact");
  assert.equal(ask[0].subjectEntityId, "ent-mira");
  assert.equal(ask[0].predicate, "promise");
  assert.deepEqual(JSON.parse(ask[0].value).unresolvedSubjects, [{ name: "Aria Vell", reason: "no-candidate" }]);
  // Knowledge attaches to the primary per-subject fact when there is no fallback.
  const knowledge = await db.select().from(schema.campaignMemoryKnowledge);
  assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0].factId, ask[0].factId);
  assert.equal(knowledge[0].holderEntityId, "ent-mira");

  // No subject resolves: the record still gets the lore fallback.
  const watch = of(rows, watchRecord.id);
  assert.equal(watch.length, 1);
  assert.ok(isFallback(watch[0]), "a record with no resolved subject keeps the fallback");
  const oil = of(rows, oilRecord.id);
  assert.equal(oil.length, 1);
  assert.ok(isFallback(oil[0]));
  assert.deepEqual(JSON.parse(oil[0].value).unresolvedSubjects, [
    { name: "Oswin", reason: "no-candidate" },
    { name: "Aria Vell", reason: "no-candidate" },
  ]);
  assert.equal(rows.length, 3);

  // Republishing the same receipt is idempotent: same ids, no conflict, nothing new.
  const entryId = `gce_${hash(id).slice(0, 32)}`;
  const entry = (await db.select().from(schema.lorebookEntries).where(eq(schema.lorebookEntries.id, entryId)))[0];
  assert.ok(entry);
  const snapshot = JSON.stringify(rows.map((row) => [row.factId, row.status, row.value]).sort());
  await db.transaction((tx: any) => publishContinuityMemory(tx, receipt, entry, messages, prepared));
  rows = await facts();
  assert.equal(JSON.stringify(rows.map((row) => [row.factId, row.status, row.value]).sort()), snapshot);
  assert.equal((await db.select().from(schema.campaignMemoryKnowledge)).length, 1);

  // Aria Vell is registered; relink moves her records onto her and retires both fallbacks, including the one
  // whose other subject (Oswin) is still unknown.
  await db.insert(schema.campaignMemoryEntities).values(entity("ent-aria", "npc-aria", "Aria Vell"));
  const relinked = await relinkPublishedContinuityMemory(db, "chat");
  assert.deepEqual(relinked.skipped, {}, JSON.stringify(relinked));
  assert.equal(relinked.relinked, 1);
  rows = await facts();
  assert.equal(live(of(rows, watchRecord.id)).length, 1);
  assert.equal(live(of(rows, watchRecord.id))[0].subjectEntityId, "ent-aria");
  const oilLive = live(of(rows, oilRecord.id));
  assert.equal(oilLive.length, 1, "a partly resolved record keeps no live fallback after relink");
  assert.equal(oilLive[0].subjectEntityId, "ent-aria");
  assert.deepEqual(JSON.parse(oilLive[0].value).unresolvedSubjects, [{ name: "Oswin", reason: "no-candidate" }]);
  assert.equal(
    rows.find((row) => row.factId === oil[0].factId)?.status,
    "superseded",
    "the partial record's old fallback is superseded",
  );
  assert.equal(rows.find((row) => row.factId === watch[0].factId)?.status, "superseded");
  const askLive = live(of(rows, askRecord.id));
  assert.deepEqual(askLive.map((row) => row.subjectEntityId).sort(), ["ent-aria", "ent-mira"]);
  assert.equal(live(rows).filter(isFallback).length, 0, "no live fallback remains beside per-subject facts");

  // Relinking again is stable.
  const before = JSON.stringify(rows.map((row) => [row.factId, row.status, row.revision]).sort());
  const again = await relinkPublishedContinuityMemory(db, "chat");
  assert.deepEqual(again.skipped, {});
  assert.equal(again.relinked, 1);
  rows = await facts();
  assert.equal(JSON.stringify(rows.map((row) => [row.factId, row.status, row.revision]).sort()), before);

  console.log("continuity-memory-partial-fallback regression passed");
} finally {
  await db?._fileStore?.close?.();
  rmSync(root, { recursive: true, force: true });
}
