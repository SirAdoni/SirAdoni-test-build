import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

const root = mkdtempSync(join(tmpdir(), "marinara-continuity-review-withheld-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, lorebooks, lorebookEntries, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { readGameContinuityState } = await import("../../packages/server/src/services/game/continuity-state.js");
  const { buildGameContinuityPromptContext } =
    await import("../../packages/server/src/services/game/continuity-context.js");
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(chats).values({
    id: "withheld-chat",
    name: "Withheld coverage",
    mode: "game",
    metadata: JSON.stringify({
      gameContinuity: { mode: "active", activationMessageId: "source-message" },
    }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values([
    {
      id: "source-message",
      chatId: "withheld-chat",
      role: "assistant",
      content: "The intimate encounter happened. 🌙",
      createdAt: now,
    },
    {
      id: "follow-up",
      chatId: "withheld-chat",
      role: "user",
      content: "Continue.",
      createdAt: new Date(Date.now() + 1).toISOString(),
    },
  ]);
  await db
    .insert(lorebooks)
    .values({ id: "withheld-book", name: "Withheld book", chatId: "withheld-chat", createdAt: now, updatedAt: now });
  const generatedContent = "The valid portion remains canon.";
  await db.insert(lorebookEntries).values({
    id: "withheld-entry",
    lorebookId: "withheld-book",
    name: "Valid record",
    content: generatedContent,
    dynamicState: JSON.stringify({
      source: "incremental-game-continuity",
      receiptId: "withheld-batch",
      publishedContentHash: createHash("sha256").update(JSON.stringify(generatedContent)).digest("hex"),
    }),
  });
  await db.insert(lorebookEntries).values({
    id: "clean-entry",
    lorebookId: "withheld-book",
    name: "Clean replacement",
    content: generatedContent,
    dynamicState: JSON.stringify({
      source: "incremental-game-continuity",
      receiptId: "clean-batch",
      publishedContentHash: createHash("sha256").update(JSON.stringify(generatedContent)).digest("hex"),
    }),
  });
  const source = prepareContinuitySources(await db.select().from(messages), {}).find(
    (item) => item.messageId === "source-message",
  )!;
  const validRecord = {
    kind: "event" as const,
    text: "The valid portion remains canon.",
    subjects: [],
    conditions: [],
    status: "accepted" as const,
    evidence: [{ messageId: "source-message", quote: "The intimate encounter happened. 🌙" }],
    keys: [],
  };
  const withheldRecord = {
    ...validRecord,
    text: "The omitted intimate detail must not be treated as verified.",
    id: "withheld-record",
  };
  const receipt: GameContinuityReceipt = {
    id: "withheld-batch",
    chatId: "withheld-chat",
    sessionNumber: 1,
    sourceHash: "withheld-source",
    sources: [source],
    context: [],
    configHash: "config",
    config: {},
    status: "published",
    attempts: 1,
    repairAttempts: 0,
    records: [{ ...validRecord, id: createGameContinuityRecordId("withheld-batch", validRecord) }],
    dispositions: [{ messageId: "source-message", status: "covered", reason: "partial" }],
    review: {
      findings: [],
      dispositions: [{ messageId: "source-message", status: "covered", reason: "partial" }],
      withheld: {
        records: [withheldRecord],
        findings: [
          {
            kind: "omission",
            messageId: "source-message",
            quote: "The intimate encounter happened. 🌙",
            recordIds: [withheldRecord.id],
            detail: "The intimate encounter detail was withheld.",
          },
        ],
      },
    },
    entryIds: ["withheld-entry"],
    createdAt: now,
    updatedAt: now,
  };
  const storage = createGameContinuityStorage(db);
  await storage.enqueue({ ...receipt, status: "verified", entryIds: [] });
  const prepublication = await readGameContinuityState(db, "withheld-chat");
  assert.equal(
    prepublication.verifiedThroughMessageId,
    null,
    "partial verified review must not claim complete coverage before publication",
  );
  const prepublicationContext = await buildGameContinuityPromptContext(db, "withheld-chat", { maxChars: 8_000 });
  assert.deepEqual(prepublicationContext.metadata.unresolvedSourceMessageIds, ["source-message"]);
  // Stored legacy receipts may preserve withheld records without reviewer findings.
  receipt.review!.withheld!.findings = [];
  await storage.save(receipt);

  const state = await readGameContinuityState(db, "withheld-chat");
  assert.equal(state.records.length, 1, "valid published records remain readable");
  assert.ok(
    state.gaps.some((gap) => gap.reason === "CONTINUITY_REVIEW_WITHHELD" && gap.messageId === "source-message"),
  );
  assert.equal(state.verifiedThroughMessageId, null, "withheld source coverage stops the verified watermark");

  const context = await buildGameContinuityPromptContext(db, "withheld-chat", { maxChars: 8_000 });
  assert.match(context.text, /The valid portion remains canon/u, "valid record remains in continuity context");
  assert.deepEqual(context.metadata.unresolvedSourceMessageIds, ["source-message"]);
  assert.match(context.text, /unresolved=1/u, "prompt exposes the withheld source as unresolved");

  const points = Array.from(source.content);
  const split = 10;
  const cleanSlice = (id: string, start: number, end?: number): GameContinuityReceipt => ({
    ...receipt,
    id,
    sessionNumber: 2,
    sources: [{ ...source, start, end, content: points.slice(start, end).join("") }],
    records: [],
    entryIds: [],
    dispositions: [{ messageId: source.messageId, status: "no_durable_facts", reason: "clean slice" }],
    review: {
      findings: [],
      dispositions: [{ messageId: source.messageId, status: "no_durable_facts", reason: "clean slice" }],
    },
  });
  await storage.enqueue(cleanSlice("clean-prefix", 0, split));
  const partlyRepaired = await readGameContinuityState(db, "withheld-chat");
  assert.equal(partlyRepaired.verifiedThroughMessageId, null, "a clean prefix is not a fully reviewed message");
  assert(partlyRepaired.gaps.some((gap) => gap.reason === "CONTINUITY_REVIEW_WITHHELD"));
  const partialContext = await buildGameContinuityPromptContext(db, "withheld-chat", { maxChars: 8_000 });
  assert.deepEqual(partialContext.metadata.unresolvedSourceMessageIds, ["source-message"]);
  await storage.enqueue(cleanSlice("clean-tail", split));
  const slicesRepaired = await readGameContinuityState(db, "withheld-chat");
  assert.equal(
    slicesRepaired.verifiedThroughMessageId,
    "source-message",
    "implicit tail end uses start plus codepoint length",
  );
  assert(!slicesRepaired.gaps.some((gap) => gap.reason === "CONTINUITY_REVIEW_WITHHELD"));
  const slicesContext = await buildGameContinuityPromptContext(db, "withheld-chat", { maxChars: 8_000 });
  assert.deepEqual(slicesContext.metadata.unresolvedSourceMessageIds, [], "clean union removes obsolete warnings");
  const earlierSessionContext = await buildGameContinuityPromptContext(db, "withheld-chat", {
    maxChars: 8_000,
    sessionNumber: 1,
  });
  assert.deepEqual(
    earlierSessionContext.metadata.unresolvedSourceMessageIds,
    ["source-message"],
    "future session coverage must not clear an earlier scoped warning",
  );

  const cleanReceipt: GameContinuityReceipt = {
    ...receipt,
    id: "clean-batch",
    records: [{ ...validRecord, id: createGameContinuityRecordId("clean-batch", validRecord) }],
    review: { findings: [], dispositions: [{ messageId: "source-message", status: "covered", reason: "clean" }] },
    entryIds: ["clean-entry"],
  };
  await createGameContinuityStorage(db).enqueue(cleanReceipt);
  const repaired = await readGameContinuityState(db, "withheld-chat");
  assert(!repaired.gaps.some((gap) => gap.reason === "CONTINUITY_REVIEW_WITHHELD"));
  assert.equal(repaired.verifiedThroughMessageId, "source-message", "clean replacement restores source coverage");
  const repairedContext = await buildGameContinuityPromptContext(db, "withheld-chat", {
    maxChars: 8_000,
    sessionNumber: 1,
  });
  assert.deepEqual(repairedContext.metadata.unresolvedSourceMessageIds, []);
  assert.match(repairedContext.text, /unresolved=0/u, "clean replacement clears prompt warning too");
  assert.match(repairedContext.text, /The valid portion remains canon/u, "safe facts survive correction of coverage");
  await db._fileStore.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("continuity-review-withheld-coverage regression passed");
