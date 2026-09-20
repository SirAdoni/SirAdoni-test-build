import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { GameContinuityReceipt, GameContinuityRecord } from "@marinara-engine/shared";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-game-continuity-context-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
let app: { close(): Promise<void>; inject(options: Record<string, unknown>): Promise<any> } | null = null;

try {
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { buildGameContinuityPromptContext } =
    await import("../../packages/server/src/services/game/continuity-context.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { lorebookEntries, lorebooks } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  app = await buildApp();
  await app.ready();
  const db = await getDB();
  const chats = createChatsStorage(db);
  const continuity = createGameContinuityStorage(db);
  const created = await app.inject({
    method: "POST",
    url: "/api/chats",
    payload: { name: "Continuity context", mode: "game", characterIds: [] },
  });
  assert.equal(created.statusCode, 200);
  const chat = created.json();
  const lorebookId = `${chat.id}-continuity-book`;
  await db.insert(lorebooks).values({ id: lorebookId, name: "Continuity context book", chatId: chat.id });
  const add = async (role: "user" | "assistant", content: string) => {
    const response = await app!.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/messages`,
      payload: { role, content },
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const firstUser = await add("user", "We should keep the lantern lit.");
  const firstAssistant = await add("assistant", "The promise is recorded.");
  await chats.updateMetadata(chat.id, { gameContinuity: { mode: "shadow", activationMessageId: firstAssistant.id } });
  assert.equal((await buildGameContinuityPromptContext(db, chat.id)).text, "");

  await chats.updateMetadata(chat.id, { gameContinuity: { mode: "active", activationMessageId: firstAssistant.id } });
  const prepared = prepareContinuitySources(await chats.listMessages(chat.id), {
    gameContinuity: { mode: "active", activationMessageId: firstAssistant.id },
  });
  const source = prepared.find((item) => item.messageId === firstAssistant.id)!;
  const record = (kind: GameContinuityRecord["kind"], id: string, text: string): GameContinuityRecord => ({
    id,
    kind,
    text,
    subjects: [],
    conditions: kind === "promise" ? ["before dawn"] : [],
    status: "accepted",
    knowledge: { scope: "world", holders: [] },
    evidence: [{ messageId: firstAssistant.id, quote: firstAssistant.content }],
    keys: [],
  });
  const makeReceipt = (
    id: string,
    status: GameContinuityReceipt["status"],
    records: GameContinuityRecord[],
    sources = [source],
  ): GameContinuityReceipt => {
    const normalized = records.map((item) => {
      const withEvidence = {
        ...item,
        evidence: item.evidence.map((evidence) => ({
          ...evidence,
          quote: sources.find((candidate) => candidate.messageId === evidence.messageId)?.content ?? evidence.quote,
        })),
      };
      return { ...withEvidence, id: createGameContinuityRecordId(id, withEvidence) };
    });
    return {
      id,
      chatId: chat.id,
      sessionNumber: 1,
      sourceHash: id,
      sources,
      context: [],
      configHash: "config",
      config: {},
      status,
      attempts: 1,
      repairAttempts: 0,
      records: normalized,
      dispositions: sources.map((item) => ({
        messageId: item.messageId,
        status: "covered" as const,
        reason: "recorded",
      })),
      review: {
        findings: [],
        dispositions: sources.map((item) => ({
          messageId: item.messageId,
          status: "covered" as const,
          reason: "reviewed",
        })),
      },
      entryIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  };
  const enqueueReceipt = async (receipt: GameContinuityReceipt) => {
    if (!receipt.records.length) return continuity.enqueue(receipt);
    const entryId = `entry-${receipt.id}`;
    const content = receipt.records.map((item) => item.text).join("\n");
    await db.insert(lorebookEntries).values({
      id: entryId,
      lorebookId,
      name: receipt.id,
      content,
      dynamicState: JSON.stringify({
        source: "incremental-game-continuity",
        receiptId: receipt.id,
        publishedContentHash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
      }),
    });
    return continuity.enqueue({ ...receipt, entryIds: [entryId] });
  };
  await enqueueReceipt(
    makeReceipt("published-facts", "published", [record("event", "fact-1", "The lantern was kept lit.")]),
  );
  await enqueueReceipt(
    makeReceipt("published-promise", "published", [
      record("promise", "promise-1", "Keep the lantern lit before dawn."),
    ]),
  );
  await enqueueReceipt(
    makeReceipt(
      "stale-facts",
      "published",
      [record("event", "stale-1", "Stale record must not appear.")],
      [{ ...source, content: "altered source" }],
    ),
  );

  // A receipt covering only the first slice of a long message must not mark
  // the whole message covered: the remaining text must appear as unreviewed
  // fallback evidence.
  const partialMessage = await add("assistant", `PARTIAL-LONG-NEWEST ${"unreviewed tail ".repeat(500)}`);
  const preparedWithPartial = prepareContinuitySources(await chats.listMessages(chat.id), {
    gameContinuity: { mode: "active", activationMessageId: firstAssistant.id },
  });
  const partialPrepared = preparedWithPartial.find((item) => item.messageId === partialMessage.id)!;
  const partialContent = Array.from(partialPrepared.content).slice(0, 80).join("");
  const partialSource = {
    ...partialPrepared,
    content: partialContent,
    start: 0,
    end: Array.from(partialContent).length,
  };
  await enqueueReceipt(
    makeReceipt(
      "partial-long",
      "published",
      [
        {
          ...record("event", "partial-fact", "The partial long source was recorded."),
          evidence: [{ messageId: partialMessage.id, quote: partialContent }],
        },
      ],
      [partialSource],
    ),
  );

  const newestMessage = await add("assistant", `UNPROCESSED-LONG-NEWEST ${"newest tail ".repeat(600)}`);
  const partialContext = await buildGameContinuityPromptContext(db, chat.id, { maxChars: 5_000 });
  assert(
    partialContext.text.includes("UNREVIEWED SOURCE"),
    "partial coverage must retain unreviewed fallback evidence",
  );
  assert(
    partialContext.metadata.unreviewedSourceMessageIds.includes(partialMessage.id),
    "partial source must be reported as unreviewed",
  );

  const clippedNewest = await buildGameContinuityPromptContext(db, chat.id, { maxChars: 1_200 });
  assert(
    clippedNewest.text.includes("UNPROCESSED-LONG-NEWEST"),
    "newest unprocessed source must win bounded fallback selection",
  );
  assert(
    clippedNewest.metadata.unreviewedSourceMessageIds.includes(newestMessage.id),
    "newest source must be reflected in metadata",
  );
  assert(clippedNewest.metadata.unreviewedCodepoints > 0, "included clipped source must report codepoints");
  assert(clippedNewest.metadata.clippedCodepoints > 0, "long source must report clipped codepoints");

  const context = await buildGameContinuityPromptContext(db, chat.id, { maxChars: 2_000 });
  assert.equal(context.metadata.mode, "active");
  assert(context.text.includes("Keep the lantern lit before dawn."));
  assert(context.text.includes("The lantern was kept lit."));
  assert(context.text.includes('knowledge={"scope":"world","holders":[]}'));
  assert(!context.text.includes("stale-1"));
  assert(
    !context.metadata.unresolvedSourceMessageIds.includes(firstAssistant.id),
    "a fully replaced stale receipt must not keep its source unresolved",
  );
  assert(context.text.includes("UNREVIEWED SOURCE") || context.metadata.unreviewedSourceMessageIds.length === 0);
  assert(context.text.length <= 2_000);
  const again = await buildGameContinuityPromptContext(db, chat.id, { maxChars: 2_000 });
  assert.equal(again.text, context.text, "context ordering must be deterministic");
  const compact = await buildGameContinuityPromptContext(db, chat.id, { maxChars: 256 });
  assert(compact.text.length <= 256);
  const missingCutoff = await buildGameContinuityPromptContext(db, chat.id, { throughMessageId: "missing-message" });
  assert(!missingCutoff.text.includes("The lantern was kept lit."), "an unknown cutoff must fail closed");
  assert.equal(
    missingCutoff.metadata.unresolvedSourceMessageIds.length,
    0,
    "historical cutoff must not leak future gaps",
  );
  assert.equal(firstUser.role, "user");
} finally {
  if (app) await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
