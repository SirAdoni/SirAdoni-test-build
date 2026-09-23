import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// Work already paid for must survive a config-hash change and a failed publication:
// 1. A verified receipt whose config hash changed is published at startup (publication does not depend on the
//    extraction config) instead of being marked stale CONTINUITY_CONFIG_CHANGED and read again.
// 2. A queued receipt with no model work under an old config is re-frozen onto the current one and read.
// 3. retry() on a receipt that only failed to publish (clean review, memory/publication/lorebook error code)
//    publishes it again with no model call; any other failed receipt is still re-queued for a fresh read.
// 4. A receipt that publishes after an earlier failure does not keep the old errorCode/error.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-refreeze-"));
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
  const { publishContinuityReceipt } = await import("../../packages/server/src/services/game/continuity-publication.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Refreeze test", provider: "custom", model: "m" });
  await db.insert(chats).values({
    id: "chat",
    name: "Refreeze",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify({ gameContinuity: { mode: "active", extractionInstructions: "current" } }),
    createdAt: now,
    updatedAt: now,
  });
  const lines: Record<string, string> = {
    a1: "Mira swears to guard the vault until spring.",
    a2: "Tomas sells the grey mare to the innkeeper.",
    a3: "The bridge at Holloway collapses in the storm.",
    a4: "Ines pays the ferryman three silver.",
    a5: "The abbot names Corin his heir.",
  };
  const rows = [];
  let second = 1;
  for (const [index, id] of Object.keys(lines).entries()) {
    rows.push({ id: `u${index + 1}`, chatId: "chat", role: "user", content: `Turn ${index + 1}.`, createdAt: `2026-09-16T00:00:${String(second++).padStart(2, "0")}.000Z` });
    rows.push({ id, chatId: "chat", role: "assistant", content: lines[id]!, createdAt: `2026-09-16T00:00:${String(second++).padStart(2, "0")}.000Z` });
  }
  await db.insert(messages).values(rows);
  const prepared = prepareContinuitySources(await db.select().from(messages).where(eq(messages.chatId, "chat")), {
    gameContinuity: { mode: "active" },
  });
  const config = await readContinuityConfig(db, "chat");
  const recordFor = (assistantId: string) => ({
    kind: "event" as const,
    text: lines[assistantId]!,
    subjects: [],
    conditions: [],
    status: "completed" as const,
    evidence: [{ messageId: assistantId, quote: lines[assistantId]! }],
    keys: [],
  });
  const dispositionsFor = (userId: string, assistantId: string) => [
    { messageId: userId, status: "no_durable_facts" as const, reason: "a request" },
    { messageId: assistantId, status: "covered" as const, reason: "event" },
  ];
  const receiptFor = (
    id: string,
    userId: string,
    assistantId: string,
    overrides: Partial<GameContinuityReceipt>,
  ): GameContinuityReceipt => {
    const record = recordFor(assistantId);
    const dispositions = dispositionsFor(userId, assistantId);
    return {
      id,
      chatId: "chat",
      sessionNumber: 1,
      sourceHash: `source-${id}`,
      sources: prepared.filter((source) => source.messageId === userId || source.messageId === assistantId),
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
      ...overrides,
    } as GameContinuityReceipt;
  };
  const storage = createGameContinuityStorage(db);
  const oldConfig = { ...config.frozen, extractionInstructions: "an older instruction" };

  // 1. Verified under an older config.
  await storage.enqueue(receiptFor("gcb_verified_old", "u1", "a1", { configHash: "contract-v-old", config: oldConfig }));
  // 2. Queued under an older config with no model work.
  await storage.enqueue(
    receiptFor("gcb_queued_old", "u2", "a2", {
      configHash: "contract-v-old",
      config: oldConfig,
      status: "queued",
      attempts: 0,
      records: [],
      dispositions: [],
      review: null,
    }),
  );

  const calls: string[] = [];
  const runtime = createGameContinuityRuntime(db, {
    complete: async ({ stage, receipt }: { stage: string; receipt: GameContinuityReceipt }) => {
      calls.push(`${receipt.id}:${stage}`);
      const assistant = receipt.sources.find((source) => source.role.startsWith("assistant"))!.messageId;
      const user = receipt.sources.find((source) => source.role === "user")!.messageId;
      const dispositions = dispositionsFor(user, assistant);
      return stage === "extract" ? { records: [recordFor(assistant)], dispositions } : { findings: [], dispositions };
    },
    maxDrainMs: 3000,
  } as any);
  await runtime.start();
  const deadline = Date.now() + 20_000;
  while ((await storage.get("gcb_queued_old"))?.status !== "published") {
    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(await storage.get("gcb_queued_old"))}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const verifiedOld = await storage.get("gcb_verified_old");
  assert.equal(verifiedOld?.status, "published", "a verified receipt is not thrown away because the config changed");
  assert.equal(verifiedOld?.configHash, config.hash);
  assert.ok(!calls.some((call) => call.startsWith("gcb_verified_old")), "publishing it costs no model call");
  const queuedOld = await storage.get("gcb_queued_old");
  assert.equal(queuedOld?.configHash, config.hash, "an empty queued receipt is re-frozen onto the current config");
  assert.ok(calls.includes("gcb_queued_old:extract"), "and read under it");

  // 3a. Publish-only recovery: clean review, failed with a memory error code.
  await storage.enqueue(
    receiptFor("gcb_pubfail", "u3", "a3", {
      status: "failed",
      errorCode: "CONTINUITY_MEMORY_WRITE_FAILED",
      error: "the memory write failed",
    }),
  );
  const callsBeforeRetry = calls.length;
  const recovered = await runtime.retry("chat", "gcb_pubfail");
  assert.equal(recovered?.status, "published", "a receipt that only failed to publish is published again");
  const recoveredRow = await storage.get("gcb_pubfail");
  assert.equal(recoveredRow?.status, "published");
  assert.equal(recoveredRow?.errorCode, undefined, "the old failure is cleared");
  assert.equal(recoveredRow?.error, undefined);
  assert.equal(recoveredRow?.records.length, 1, "the reviewed records are kept, not re-extracted");
  assert.equal(calls.length, callsBeforeRetry, "no model call for a publish-only retry");

  // 3b. Any other failure is still read again from scratch.
  await storage.enqueue(
    receiptFor("gcb_worker_failed", "u4", "a4", {
      status: "failed",
      errorCode: "CONTINUITY_ATTEMPTS_EXCEEDED",
      error: "retry limit",
    }),
  );
  const requeued = await runtime.retry("chat", "gcb_worker_failed");
  assert.equal(requeued?.status, "queued", "a worker failure is re-queued");
  assert.deepEqual(requeued?.records, [], "and its extraction is discarded for a fresh read");
  await runtime.stop();

  // 4. storage.publish clears a leftover error on a receipt that finally publishes.
  await storage.enqueue(
    receiptFor("gcb_late", "u5", "a5", {
      errorCode: "CONTINUITY_PUBLICATION_FAILED",
      error: "an earlier attempt failed",
    }),
  );
  const late = await publishContinuityReceipt(db, "gcb_late");
  assert.equal(late?.status, "published");
  assert.equal(late?.errorCode, undefined, "a late publish drops the old errorCode");
  const lateRow = await storage.get("gcb_late");
  assert.equal(lateRow?.errorCode, undefined);
  assert.equal(lateRow?.error, undefined);

  await db._fileStore.close();
  console.log("continuity-config-refreeze-publish-retry regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
