import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// Publishing a historical backfill receipt never rewrites a newer live fact for the
// same subject/predicate: the live row keeps its revision and value, and the historical
// row is added beside it with import provenance and `historical: true`.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-backfill-newer-live-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let db: any;

try {
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true, campaignMemory: true, campaignIndex: true }));

  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { publishContinuityReceipt } =
    await import("../../packages/server/src/services/game/continuity-publication.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");

  db = await createFileNativeDB();
  const now = "2026-09-13T00:00:00.000Z";
  const later = "2026-09-13T00:00:05.000Z";
  await db
    .insert(schema.apiConnections)
    .values({
      id: "conn",
      name: "Continuity test",
      provider: "custom",
      model: "test-model",
      createdAt: now,
      updatedAt: now,
    });
  await db
    .insert(schema.chats)
    .values({
      id: "chat",
      name: "Backfill vs live",
      mode: "game",
      connectionId: "conn",
      metadata: JSON.stringify({ gameContinuity: { mode: "active" }, gameNpcs: [{ id: "npc-ada", name: "Ada Vale" }] }),
      createdAt: now,
      updatedAt: now,
    });
  await db.insert(schema.messages).values([
    { id: "old-1", chatId: "chat", role: "assistant", content: "Ada swore the pact at the ford.", createdAt: now },
    { id: "new-1", chatId: "chat", role: "assistant", content: "Ada broke the pact at the ford.", createdAt: later },
  ]);
  await db
    .insert(schema.lorebooks)
    .values({
      id: "keeper",
      name: "Keeper",
      chatId: "chat",
      enabled: "false",
      sourceAgentId: "game-lorebook-keeper",
      createdAt: now,
      updatedAt: now,
    });
  await db
    .insert(schema.campaignMemoryEntities)
    .values({
      entityId: "ent-ada",
      chatId: "chat",
      kind: "character",
      owner: JSON.stringify({ type: "existing", store: "game-npcs", recordId: "npc-ada" }),
      aliases: JSON.stringify(["Ada Vale"]),
      tags: "[]",
      attributes: "{}",
      status: "active",
      manualLock: 0,
      provenance: JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "user" }),
      createdAt: now,
      updatedAt: now,
    });

  const messages = await db.select().from(schema.messages);
  const prepared = prepareContinuitySources(messages, { gameContinuity: { mode: "active" } });
  assert.equal(prepared.length, 2);
  const holders = [
    {
      entityId: "ent-ada",
      kind: "character" as const,
      store: "game-npcs" as const,
      recordId: "npc-ada",
      name: "Ada Vale",
    },
  ];
  const buildReceipt = (
    id: string,
    config: { hash: string; frozen: GameContinuityReceipt["config"] },
    raw: any,
  ): GameContinuityReceipt => {
    const cited = new Set<string>(raw.evidence.map((item: { messageId: string }) => item.messageId));
    const dispositions = (reason: string) =>
      prepared.map((item) =>
        cited.has(item.messageId)
          ? { messageId: item.messageId, status: "covered" as const, reason }
          : { messageId: item.messageId, status: "no_durable_facts" as const, reason: "outside this receipt" },
      );
    return {
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
      records: [{ ...raw, id: createGameContinuityRecordId(id, raw) }],
      dispositions: dispositions("explicit source"),
      review: { findings: [], dispositions: dispositions("clean") },
      knowledgeHolders: holders,
      entryIds: [],
      createdAt: now,
      updatedAt: now,
    };
  };

  // 1. The newer live fact: Ada.event from the later message, system-authored.
  const liveConfig = await readContinuityConfig(db, "chat");
  const liveRaw = {
    kind: "event" as const,
    text: "Ada Vale broke the pact at the ford.",
    subjects: ["Ada Vale"],
    conditions: [],
    status: "completed" as const,
    keys: ["pact"],
    evidence: [{ messageId: "new-1", quote: "Ada broke the pact at the ford." }],
  };
  const liveReceipt = buildReceipt("receipt-live", liveConfig, liveRaw);
  await createGameContinuityStorage(db).enqueue(liveReceipt);
  assert.equal((await publishContinuityReceipt(db, liveReceipt.id))?.status, "published");
  const liveRows = (await db.select().from(schema.campaignMemoryFacts)).filter(
    (row: any) => JSON.parse(row.value).receiptId === "receipt-live",
  );
  assert.equal(liveRows.length, 1, "the live receipt publishes one per-subject fact");
  const liveBefore = liveRows[0]!;
  assert.equal(liveBefore.subjectEntityId, "ent-ada");
  assert.equal(liveBefore.predicate, "event");
  assert.equal(liveBefore.author, "system");
  assert.equal(JSON.parse(liveBefore.value).historical, false);
  const liveSnapshot = {
    revision: liveBefore.revision,
    value: liveBefore.value,
    status: liveBefore.status,
    sourceRevision: liveBefore.sourceRevision,
    evidence: liveBefore.evidence,
    provenance: liveBefore.provenance,
    validFromOrder: liveBefore.validFromOrder,
    updatedAt: liveBefore.updatedAt,
    manualLock: liveBefore.manualLock,
  };
  const journalBefore = (await db.select().from(schema.campaignMemoryMutationJournal)).length;

  // 2. A historical backfill receipt for the SAME subject/predicate from the older message.
  const historicalConfig = await readContinuityConfig(db, "chat", { allowHistoricalBackfill: true });
  const historicalRaw = {
    kind: "event" as const,
    text: "Ada Vale swore the pact at the ford.",
    subjects: ["Ada Vale"],
    conditions: ["until the ford floods"],
    status: "completed" as const,
    keys: ["pact"],
    evidence: [{ messageId: "old-1", quote: "Ada swore the pact at the ford." }],
  };
  const historicalReceipt = buildReceipt("gch_receipt-historical", historicalConfig, historicalRaw);
  historicalReceipt.config = {
    ...historicalReceipt.config,
    historicalBackfill: {
      id: "backfill-newer-live-regression",
      fromMessageId: "old-1",
      toMessageId: "old-1",
      sessionNumber: 1,
    },
  } as any;
  await createGameContinuityStorage(db).enqueue(historicalReceipt);
  assert.equal(
    (await publishContinuityReceipt(db, historicalReceipt.id))?.status,
    "verified",
    "historical receipts are not published without allowHistoricalBackfill",
  );
  const published = await publishContinuityReceipt(db, historicalReceipt.id, { allowHistoricalBackfill: true });
  assert.equal(published?.status, "published");

  // 3. The live fact is untouched: same row, same revision, same value, same everything.
  const factsAfter = await db.select().from(schema.campaignMemoryFacts);
  const liveAfter = factsAfter.find((row: any) => row.factId === liveBefore.factId)!;
  assert.ok(liveAfter, "the live fact row still exists");
  assert.equal(liveAfter.revision, liveSnapshot.revision, "live fact revision unchanged");
  assert.equal(liveAfter.value, liveSnapshot.value, "live fact value unchanged");
  assert.deepEqual(
    {
      revision: liveAfter.revision,
      value: liveAfter.value,
      status: liveAfter.status,
      sourceRevision: liveAfter.sourceRevision,
      evidence: liveAfter.evidence,
      provenance: liveAfter.provenance,
      validFromOrder: liveAfter.validFromOrder,
      updatedAt: liveAfter.updatedAt,
      manualLock: liveAfter.manualLock,
    },
    liveSnapshot,
  );
  assert.equal(liveAfter.author, "system");
  assert.equal(JSON.parse(liveAfter.provenance).actor, "system");
  assert.equal(
    JSON.parse(liveAfter.value).text,
    liveRaw.text,
    "live text is not overwritten by the older backfill text",
  );

  // 4. The historical fact is added beside it with import provenance and the historical flag.
  const historicalRows = factsAfter.filter((row: any) => JSON.parse(row.value).receiptId === historicalReceipt.id);
  assert.equal(historicalRows.length, 1, "the historical receipt publishes its own per-subject fact");
  const historical = historicalRows[0]!;
  assert.notEqual(historical.factId, liveBefore.factId);
  assert.equal(historical.subjectEntityId, "ent-ada", "same subject as the live fact");
  assert.equal(historical.predicate, "event", "same predicate as the live fact");
  assert.equal(historical.author, "import");
  assert.equal(JSON.parse(historical.provenance).actor, "import");
  assert.equal(JSON.parse(historical.value).historical, true);
  assert.equal(JSON.parse(historical.value).text, historicalRaw.text);
  assert.ok(
    historical.validFromOrder < liveAfter.validFromOrder,
    "the historical fact is ordered before the newer live fact",
  );
  assert.equal(
    factsAfter.filter((row: any) => row.subjectEntityId === "ent-ada" && row.predicate === "event").length,
    2,
    "both facts coexist on the subject",
  );
  assert.ok(
    (await db.select().from(schema.campaignMemoryMutationJournal)).length > journalBefore,
    "the backfill publication is journaled",
  );
  assert.ok(
    !(await db.select().from(schema.campaignMemoryMutationJournal)).some(
      (row: any) =>
        row.recordType === "fact" &&
        row.recordId === liveBefore.factId &&
        row.operationId.includes("gch_receipt-historical"),
    ),
    "no journal operation touched the live fact",
  );

  await db._fileStore.close();
  db = undefined;
  console.log("game-continuity-backfill-newer-live-fact regression passed");
} finally {
  if (db) await db._fileStore.close();
  rmSync(root, { recursive: true, force: true });
}
