import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// Every session of a campaign writes continuity into the one Lorebook Keeper book, which is bound to the session
// that created it. Publication then checked that the entry's book belonged to the receipt's own chat, so every
// receipt from Session 2 onward failed with CONTINUITY_MEMORY_ENTRY_CHAT_MISMATCH (Sessions 11 and 12 of the real
// campaign: 14 receipts). The campaign's Keeper book now counts as the session's book.
const root = mkdtempSync(join(tmpdir(), "marinara-keeper-session-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages, lorebookEntries } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { publishContinuityReceipt } = await import("../../packages/server/src/services/game/continuity-publication.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { resolveGameKeeperLorebook } = await import("../../packages/server/src/services/game/game-keeper-lorebook.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Canon test", provider: "custom", model: "m" });
  const sessionChat = (id: string, session: number) => ({
    id,
    name: `Session ${session}`,
    mode: "game",
    groupId: "game-1",
    connectionId: "conn",
    metadata: JSON.stringify({
      gameId: "game-1",
      gameSessionNumber: session,
      gameContinuity: { mode: "active", extractionInstructions: "fixed" },
    }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(chats).values([sessionChat("s1", 1), sessionChat("chat", 2)]);
  // Session 1 created the campaign's Keeper book; Session 2 publishes into the same book.
  const s1 = (await db.select().from(chats).where(eq(chats.id, "s1")))[0];
  const book = await resolveGameKeeperLorebook(db, "s1", JSON.parse(s1.metadata));
  assert.equal(book?.chatId, "s1");
  await db.insert(messages).values([
    { id: "m1", chatId: "chat", role: "user", content: "Ask about her past.", createdAt: "2026-09-16T00:00:01.000Z" },
    {
      id: "m2",
      chatId: "chat",
      role: "assistant",
      content: "She speaks of the husband she buried years ago.",
      createdAt: "2026-09-16T00:00:02.000Z",
    },
  ]);
  const current = await db.select().from(messages).where(eq(messages.chatId, "chat"));
  const sources = prepareContinuitySources(current, { gameContinuity: { mode: "active" } });
  const config = await readContinuityConfig(db, "chat");
  const record = {
    kind: "decision" as const,
    text: "Lisaveta was married and buried her husband.",
    subjects: ["Lisaveta"],
    conditions: [],
    status: "completed" as const,
    evidence: [{ messageId: "m2", quote: "She speaks of the husband she buried years ago." }],
    keys: ["husband"],
  };
  const dispositions = sources.map((source) => ({
    messageId: source.messageId,
    status: source.messageId === "m2" ? "covered" : "no_durable_facts",
    reason: "test",
  }));
  const receiptFor = (id: string): GameContinuityReceipt =>
    ({
      id,
      chatId: "chat",
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
    }) as GameContinuityReceipt;

  const receipt = receiptFor("gcb-s2");
  await createGameContinuityStorage(db).enqueue(receipt);
  const published = await publishContinuityReceipt(db, "gcb-s2");
  assert.equal(published?.status, "published", `a later session publishes into the campaign Keeper: ${published?.errorCode ?? ""}`);
  const entry = (await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, published!.entryIds[0]!)))[0];
  assert.equal(entry?.lorebookId, book!.id, "the entry is in the campaign's Keeper book");
  const facts = await createCampaignMemoryStorage(db).listFacts({ chatId: "chat" });
  assert.ok(facts.some((fact) => JSON.stringify(fact.value).includes("husband")), "its memory is written to Session 2");

  // Republishing (relink, restart) checks the same entry again and still accepts it.
  assert.equal((await publishContinuityReceipt(db, "gcb-s2"))?.status, "published");

  await db._fileStore.close();
  console.log("continuity-keeper-later-session regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
