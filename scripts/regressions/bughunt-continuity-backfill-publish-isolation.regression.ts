import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// publishHistoricalBackfill publishes a manifest's verified receipts in a plain loop with no per-receipt error
// handling. One receipt that cannot publish (its source was edited, a fact conflicts, a Keeper mismatch) throws out
// of the loop: every later verified receipt of the manifest stays unpublished, the failing one keeps status
// "verified" with no errorCode, and the campaign index job (publishChat -> advanceJob) re-throws on every 30 s tick
// without ever advancing past that session.
const root = mkdtempSync(join(tmpdir(), "marinara-bughunt-backfill-publish-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Backfill test", provider: "custom", model: "m" });
  await db.insert(chats).values({
    id: "chat",
    name: "Backfill",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify({ gameSessionNumber: 1, gameContinuity: { mode: "off" } }),
    createdAt: now,
    updatedAt: now,
  });
  const lines = {
    m2: "Mira swears to guard the vault until spring.",
    m4: "Tomas sells the grey mare to the innkeeper.",
  };
  await db.insert(messages).values([
    { id: "m1", chatId: "chat", role: "user", content: "Ask Mira.", createdAt: "2026-09-16T00:00:01.000Z" },
    { id: "m2", chatId: "chat", role: "assistant", content: lines.m2, createdAt: "2026-09-16T00:00:02.000Z" },
    { id: "m3", chatId: "chat", role: "user", content: "Ask Tomas.", createdAt: "2026-09-16T00:00:03.000Z" },
    { id: "m4", chatId: "chat", role: "assistant", content: lines.m4, createdAt: "2026-09-16T00:00:04.000Z" },
  ]);
  const prepared = prepareContinuitySources(await db.select().from(messages).where(eq(messages.chatId, "chat")), {});
  const config = await readContinuityConfig(db, "chat", { allowHistoricalBackfill: true });
  const receiptFor = (id: string, userId: string, assistantId: "m2" | "m4", text: string): GameContinuityReceipt => {
    const sources = prepared.filter((source) => source.messageId === userId || source.messageId === assistantId);
    const record = {
      kind: "promise" as const,
      text,
      subjects: [],
      conditions: [],
      status: "accepted" as const,
      evidence: [{ messageId: assistantId, quote: lines[assistantId] }],
      keys: [],
    };
    const dispositions = sources.map((source) => ({
      messageId: source.messageId,
      status: source.messageId === assistantId ? ("covered" as const) : ("no_durable_facts" as const),
      reason: "test",
    }));
    return {
      id,
      chatId: "chat",
      sessionNumber: 1,
      sourceHash: `source-${id}`,
      sources,
      context: [],
      configHash: config.hash,
      config: { ...config.frozen, historicalBackfill: { id: "bf", fromMessageId: "m1", toMessageId: "m4", sessionNumber: 1 } },
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
  };
  const storage = createGameContinuityStorage(db);
  await storage.enqueue(receiptFor("gch_a_bad", "m1", "m2", "Mira swore to guard the vault."));
  await storage.enqueue(receiptFor("gch_b_good", "m3", "m4", "Tomas sold the grey mare."));

  // The first receipt's source text is edited afterwards, so it can no longer publish (CONTINUITY_SOURCE_CHANGED).
  await db.update(messages).set({ content: "Mira refuses to guard anything." }).where(eq(messages.id, "m2"));

  const runtime = createGameContinuityRuntime(db, { complete: async () => ({}) });
  let thrown: unknown = null;
  try {
    await runtime.publishHistoricalBackfill("chat", "bf", ["gch_a_bad", "gch_b_good"]);
  } catch (error) {
    thrown = error;
  }
  const good = await storage.get("gch_b_good");
  const bad = await storage.get("gch_a_bad");
  await runtime.stop();
  await db._fileStore.close();
  assert.equal(
    good?.status,
    "published",
    `one unpublishable receipt must not block the rest of the manifest (threw: ${thrown instanceof Error ? thrown.message : String(thrown)})`,
  );
  assert.ok(bad?.errorCode, "the receipt that could not publish records why");
  console.log("bughunt-continuity-backfill-publish-isolation regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
