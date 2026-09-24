import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// Retiring a continuity batch archived its "Game continuity N" lore page only in the batch's own session chat. The
// legacy import had copied every Keeper lorebook entry, these batch pages included, into every other session of the
// campaign, so each retirement left orphan pages behind. Retirement now also archives the copies in the campaign's
// other sessions, unless a copy holds live facts of its own; other campaigns are never touched.
const root = mkdtempSync(join(tmpdir(), "marinara-retire-copies-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
let db: any;

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { publishContinuityReceipt } = await import("../../packages/server/src/services/game/continuity-publication.js");
  const { retireContinuityReceipt } = await import("../../packages/server/src/services/game/continuity-retirement.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  db = await createFileNativeDB();
  const now = "2026-09-20T00:00:00.000Z";
  await db.insert(schema.apiConnections).values({ id: "conn", name: "Retire test", provider: "custom", model: "m" });
  const sessionChat = (id: string, gameId: string, session: number) => ({
    id,
    name: `Session ${session}`,
    mode: "game",
    groupId: gameId,
    connectionId: "conn",
    metadata: JSON.stringify({
      gameId,
      gameSessionNumber: session,
      gameContinuity: { mode: "active", extractionInstructions: "fixed" },
    }),
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(schema.chats)
    .values([
      sessionChat("s1", "game-1", 1),
      sessionChat("s2", "game-1", 2),
      sessionChat("s3", "game-1", 3),
      sessionChat("other", "game-2", 1),
    ]);
  await db.insert(schema.lorebooks).values({
    id: "keeper",
    name: "Keeper",
    chatId: "s2",
    enabled: "false",
    sourceAgentId: "game-lorebook-keeper",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.messages).values([
    { id: "m1", chatId: "s2", role: "user", content: "Ask Quenby about the bridge.", createdAt: now },
    {
      id: "m2",
      chatId: "s2",
      role: "assistant",
      content: "Quenby says the bridge washed out in spring.",
      createdAt: "2026-09-20T00:00:01.000Z",
    },
  ]);
  const current = await db.select().from(schema.messages).where(eq(schema.messages.chatId, "s2"));
  const sources = prepareContinuitySources(current, { gameContinuity: { mode: "active" } });
  const config = await readContinuityConfig(db, "s2");
  const record = {
    kind: "event" as const,
    text: "The bridge washed out in spring.",
    subjects: ["Quenby"],
    conditions: [],
    status: "completed" as const,
    evidence: [{ messageId: "m2", quote: "Quenby says the bridge washed out in spring." }],
    keys: ["bridge"],
  };
  const dispositions = sources.map((source) => ({
    messageId: source.messageId,
    status: source.messageId === "m2" ? ("covered" as const) : ("no_durable_facts" as const),
    reason: "test",
  }));
  const id = "gcb-retire";
  const receipt = {
    id,
    chatId: "s2",
    sessionNumber: 2,
    sourceHash: `source-${id}`,
    sources,
    context: [],
    configHash: config.hash,
    config: config.frozen,
    status: "verified",
    attempts: 1,
    repairAttempts: 0,
    records: [{ ...record, id: createGameContinuityRecordId(id, record) }],
    dispositions,
    review: { findings: [], dispositions },
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  } as GameContinuityReceipt;
  await createGameContinuityStorage(db).enqueue(receipt);
  const published = await publishContinuityReceipt(db, id);
  assert.equal(published?.status, "published", published?.errorCode ?? "");
  const entryId = published!.entryIds[0]!;

  // Legacy-import copies of the batch page in the campaign's other sessions, and in an unrelated campaign.
  const copy = (entityId: string, chatId: string) => ({
    entityId,
    chatId,
    kind: "lore",
    owner: JSON.stringify({ type: "existing", store: "lorebook-entries", recordId: entryId }),
    aliases: JSON.stringify(["Game continuity 2"]),
    tags: JSON.stringify(["imported"]),
    attributes: "{}",
    status: "active",
    manualLock: 0,
    provenance: JSON.stringify({ source: "campaign-memory-legacy-v1", sourceRevision: "legacy", actor: "import" }),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(schema.campaignMemoryEntities)
    .values([copy("copy-s1", "s1"), copy("copy-s3", "s3"), copy("copy-other", "other")]);
  // Session 3's copy carries a live fact written in that session.
  await db.insert(schema.campaignMemoryFacts).values({
    factId: "fact-s3",
    chatId: "s3",
    subjectEntityId: "copy-s3",
    predicate: "note",
    value: JSON.stringify({ text: "Aria Vell rebuilt the bridge." }),
    conditions: "[]",
    status: "verified",
    validFromOrder: null,
    validToOrder: null,
    sourceRevision: "s3",
    evidence: "[]",
    author: "user",
    provenance: JSON.stringify({ source: "regression", sourceRevision: "s3", actor: "user" }),
    manualLock: 0,
    supersedesFactId: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });

  const memory = createCampaignMemoryStorage(db);
  const statusOf = async (chatId: string, entityId: string) => (await memory.getEntity({ chatId }, entityId))?.status;
  const ownPage = (await memory.listEntities({ chatId: "s2" })).find(
    (entity) => entity.owner.type === "existing" && entity.owner.recordId === entryId,
  );
  assert.ok(ownPage, "publication created the batch page in its own session");

  const result = await retireContinuityReceipt(db, id, "test retirement");
  assert.ok(result);
  assert.equal(result.removedEntries, 1);
  assert.equal(await statusOf("s2", ownPage.entityId), "archived", "the batch's own page is archived");
  assert.equal(await statusOf("s1", "copy-s1"), "archived", "an imported copy in an earlier session is archived");
  assert.equal(await statusOf("s3", "copy-s3"), "active", "a copy with live facts of its own is kept");
  assert.equal(await statusOf("other", "copy-other"), "active", "another campaign is never touched");
  assert.equal(
    (await memory.getFact({ chatId: "s3" }, "fact-s3"))?.status,
    "verified",
    "the other session's own fact is left alone",
  );
  console.log("continuity-retirement-campaign-copies regression passed");
} finally {
  await db?._fileStore?.close?.();
  rmSync(root, { recursive: true, force: true });
}
