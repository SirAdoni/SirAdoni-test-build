import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-continuity-holders-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, characters } = await import("../../packages/server/src/db/schema/index.js");
  const {
    captureContinuityHolderSnapshot,
    ensureContinuityHolderReferences,
    resolveSnapshotHolder,
  } = await import("../../packages/server/src/services/game/continuity-holder-snapshot.js");
  const { createGameContinuityStorage } = await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { normalizeGameContinuityExtraction } =
    await import("../../packages/server/src/services/game/continuity-review.js");
  const db = await createFileNativeDB();
  const timestamp = new Date("2026-09-13T00:00:00.000Z").toISOString();
  await db.insert(chats).values({
    id: "chat",
    name: "Snapshot test",
    mode: "game",
    characterIds: JSON.stringify(["char-1"]),
    metadata: "{}",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await db.insert(characters).values({
    id: "char-1",
    data: JSON.stringify({ name: "Alice" }),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await ensureContinuityHolderReferences(db, "chat");
  await ensureContinuityHolderReferences(db, "chat");
  const first = await captureContinuityHolderSnapshot(db, "chat");
  assert.equal(first.holders.length, 1);
  assert.equal(first.holders[0]?.name, "Alice");

  const receipt = {
    id: "receipt-1",
    chatId: "chat",
    sessionNumber: 1,
    sourceHash: "source",
    sources: [
      {
        messageId: "source-1",
        swipeIndex: 0,
        hash: "source-hash",
        role: "user",
        content: "Alice returned safely.",
        start: 0,
        end: 22,
      },
    ],
    context: [],
    configHash: "config",
    config: {},
    status: "queued" as const,
    attempts: 0,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    knowledgeHolders: first.holders,
    knowledgeHoldersHash: first.hash,
    entryIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const storage = createGameContinuityStorage(db);
  await storage.enqueue(receipt);
  await db.update(characters).set({ data: JSON.stringify({ name: "Alicia" }) }).where(eq(characters.id, "char-1"));
  const renamed = await captureContinuityHolderSnapshot(db, "chat");
  assert.equal(renamed.holders[0]?.name, "Alicia");
  assert.equal((await storage.enqueue({ ...receipt, knowledgeHolders: renamed.holders, knowledgeHoldersHash: renamed.hash })).receipt.knowledgeHolders?.[0]?.name, "Alice");
  assert.equal((await resolveSnapshotHolder(db, "chat", first.holders[0]!))?.entityId, first.holders[0]?.entityId);
  const disposition = { messageId: "source-1", status: "covered" as const, reason: "source" };
  const modelRecord = normalizeGameContinuityExtraction(
    {
      records: [
        {
          id: "ignored-by-server",
          kind: "event",
          text: "Alice returned safely.",
          subjects: ["Alice"],
          conditions: [],
          status: "asserted",
          evidence: [{ messageId: "source-1", quote: "Alice returned safely." }],
          keys: ["Alice"],
          knowledge: { scope: "private", holders: ["Alice"], holderRefs: [first.holders[0]!.entityId] },
        },
      ],
      dispositions: [disposition],
    },
    receipt.sources,
    receipt.id,
    receipt.context,
    first.holders,
  );
  await storage.save({ ...receipt, status: "reviewing", ...modelRecord });
  const changedModel = normalizeGameContinuityExtraction(
    {
      records: [
        {
          id: "ignored-by-server",
          kind: "event",
          text: "Alice returned safely",
          subjects: ["Alice"],
          conditions: [],
          status: "asserted",
          evidence: [{ messageId: "source-1", quote: "Alice returned safely." }],
          keys: ["Alice"],
          knowledge: { scope: "private", holders: ["Alice"], holderRefs: [first.holders[0]!.entityId] },
        },
      ],
      dispositions: [disposition],
    },
    receipt.sources,
    receipt.id,
    receipt.context,
    first.holders,
  );
  await storage.save({
    ...receipt,
    status: "reviewing",
    ...changedModel,
  });
  assert.equal((await storage.get("receipt-1"))?.knowledgeHolders?.[0]?.entityId, first.holders[0]?.entityId);

  await db.insert(characters).values({
    id: "char-2",
    data: JSON.stringify({ name: "Alicia" }),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await db.update(chats).set({ characterIds: JSON.stringify(["char-1", "char-2"]) });
  await ensureContinuityHolderReferences(db, "chat");
  assert.equal((await captureContinuityHolderSnapshot(db, "chat")).holders.length, 0);

  await db.delete(characters).where(eq(characters.id, "char-1"));
  assert.equal(await resolveSnapshotHolder(db, "chat", first.holders[0]!), null);
  assert.equal((await captureContinuityHolderSnapshot(db, "chat")).holders.length, 1);
  const legacy = { ...receipt, id: "legacy", knowledgeHolders: undefined, knowledgeHoldersHash: undefined };
  await storage.enqueue(legacy);
  const legacyRead = await storage.get("legacy");
  assert.equal(legacyRead?.knowledgeHolders, undefined);
  await db._fileStore.close();
  process.stdout.write("game continuity holder snapshot regression passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
