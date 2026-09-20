import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";
import { createHash } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "marinara-continuity-state-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages, lorebooks, lorebookEntries, gameContinuityBatches } =
    await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { readGameContinuityState } = await import("../../packages/server/src/services/game/continuity-state.js");
  const { processLorebooks } = await import("../../packages/server/src/services/lorebook/index.js");
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db
    .insert(chats)
    .values({ id: "chat", name: "Game", mode: "game", metadata: "{}", createdAt: now, updatedAt: now });
  await db
    .insert(messages)
    .values({ id: "m1", chatId: "chat", role: "user", content: "I promise to return.", createdAt: now });
  await db.insert(lorebooks).values({ id: "book", name: "Book", chatId: "chat", createdAt: now, updatedAt: now });
  await db.insert(lorebookEntries).values([
    { id: "manual", lorebookId: "book", name: "Manual", content: "Manual canon." },
    {
      id: "generated",
      lorebookId: "book",
      name: "Generated",
      content: "Generated canon.",
      dynamicState: JSON.stringify({
        source: "incremental-game-continuity",
        receiptId: "batch",
        publishedContentHash: createHash("sha256").update(JSON.stringify("Generated canon.")).digest("hex"),
      }),
    },
    {
      id: "stale-generated",
      lorebookId: "book",
      name: "Stale",
      content: "Stale canon.",
      dynamicState: JSON.stringify({ source: "incremental-game-continuity", receiptId: "batch" }),
    },
    {
      id: "foreign",
      lorebookId: "book",
      name: "Foreign",
      content: "Foreign canon.",
      dynamicState: JSON.stringify({ source: "incremental-game-continuity", receiptId: "other-chat" }),
    },
    {
      id: "ordered-generated",
      lorebookId: "book",
      name: "Ordered generated",
      content: "The gate was confirmed open.",
      dynamicState: JSON.stringify({
        source: "incremental-game-continuity",
        receiptId: "ordered-batch",
        publishedContentHash: createHash("sha256").update(JSON.stringify("The gate was confirmed open.")).digest("hex"),
      }),
    },
  ]);
  const source = prepareContinuitySources(await db.select().from(messages), {}).find(
    (item) => item.messageId === "m1",
  )!;
  const record = {
    kind: "promise" as const,
    text: "The player promises to return.",
    subjects: ["player"],
    conditions: [],
    status: "proposed" as const,
    evidence: [{ messageId: "m1", quote: "I promise to return." }],
    keys: ["return"],
  };
  const receipt: GameContinuityReceipt = {
    id: "batch",
    chatId: "chat",
    sessionNumber: 1,
    sourceHash: "source",
    sources: [source],
    context: [],
    configHash: "config",
    config: {},
    status: "published",
    attempts: 1,
    repairAttempts: 0,
    records: [{ ...record, id: createGameContinuityRecordId("batch", record) }],
    dispositions: [{ messageId: "m1", status: "covered", reason: "explicit" }],
    review: { findings: [], dispositions: [{ messageId: "m1", status: "covered", reason: "clean" }] },
    entryIds: ["generated"],
    createdAt: now,
    updatedAt: now,
  };
  await createGameContinuityStorage(db).enqueue(receipt);
  await db.insert(chats).values({
    id: "ordered-chat",
    name: "Ordered game",
    mode: "game",
    metadata: JSON.stringify({ gameContinuity: { mode: "active" } }),
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  });
  // Insert the newest assistant first and the older OOC user message second.
  // State validation must use transcript chronology, matching listMessages.
  await db.insert(messages).values([
    {
      id: "ordered-assistant",
      chatId: "ordered-chat",
      role: "assistant",
      content: "Understood; the correction is accepted.",
      createdAt: "2026-09-13T00:00:02.000Z",
    },
    {
      id: "ordered-user",
      chatId: "ordered-chat",
      role: "user",
      content: "[To the GM] The gate is open.",
      createdAt: "2026-09-13T00:00:01.000Z",
    },
  ]);
  const orderedSources = prepareContinuitySources(
    await db
      .select()
      .from(messages)
      .where(eq(messages.chatId, "ordered-chat"))
      .orderBy(messages.createdAt, messages.id),
    { gameContinuity: { mode: "active" } },
  );
  const orderedReceipt: GameContinuityReceipt = {
    id: "ordered-batch",
    chatId: "ordered-chat",
    sessionNumber: 1,
    sourceHash: "ordered-source",
    sources: orderedSources,
    context: [],
    configHash: "config",
    config: {},
    status: "published",
    attempts: 1,
    repairAttempts: 0,
    records: [
      {
        kind: "event",
        text: "The gate was confirmed open.",
        subjects: [],
        conditions: [],
        status: "accepted",
        evidence: [{ messageId: "ordered-user", quote: "[To the GM] The gate is open." }],
        keys: [],
        id: createGameContinuityRecordId("ordered-batch", {
          kind: "event",
          text: "The gate was confirmed open.",
          subjects: [],
          conditions: [],
          status: "accepted",
          evidence: [{ messageId: "ordered-user", quote: "[To the GM] The gate is open." }],
          keys: [],
        }),
      },
    ],
    dispositions: orderedSources.map((item) => ({
      messageId: item.messageId,
      status: item.messageId === "ordered-user" ? ("covered" as const) : ("no_durable_facts" as const),
      reason: "ordered",
    })),
    review: {
      findings: [],
      dispositions: orderedSources.map((item) => ({
        messageId: item.messageId,
        status: item.messageId === "ordered-user" ? ("covered" as const) : ("no_durable_facts" as const),
        reason: "ordered",
      })),
    },
    entryIds: ["ordered-generated"],
    createdAt: now,
    updatedAt: now,
  };
  await createGameContinuityStorage(db).enqueue(orderedReceipt);
  const invalidProjection = {
    ...orderedReceipt,
    id: "invalid-projection",
    entryIds: [],
    records: orderedReceipt.records.map((item) => ({
      ...item,
      id: createGameContinuityRecordId("invalid-projection", item),
    })),
  };
  await createGameContinuityStorage(db).enqueue(invalidProjection);
  const orderedState = await readGameContinuityState(db, "ordered-chat");
  assert.equal(orderedState.receipts.find((item) => item.receipt.id === "ordered-batch")?.sourceCurrent, true);
  assert.equal(orderedState.records.filter((item) => item.receiptId === "ordered-batch").length, 1);
  assert.equal(orderedState.records.filter((item) => item.receiptId === "invalid-projection").length, 0);
  assert.ok(orderedState.gaps.some((gap) => gap.batchId === "invalid-projection"));
  const generatedRow = (await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, "generated")))[0]!;
  await db
    .update(lorebookEntries)
    .set({
      dynamicState: JSON.stringify({
        source: "incremental-game-continuity",
        receiptId: "batch",
        publishedContentHash: createHash("sha256").update(JSON.stringify(generatedRow.content)).digest("hex"),
      }),
    })
    .where(eq(lorebookEntries.id, "generated"));
  const raw = (await db.select().from(gameContinuityBatches).where(eq(gameContinuityBatches.id, "batch")))[0]!;
  await db.insert(gameContinuityBatches).values({ ...raw, id: "broken", sources: "not-json" });
  const initial = await readGameContinuityState(db, "chat");
  assert.ok(initial.gaps.some((gap) => gap.batchId === "broken" && gap.reason === "CONTINUITY_INVALID_RECEIPT"));
  assert.deepEqual(initial.excludedEntryIds.sort(), ["foreign", "ordered-generated", "stale-generated"]);
  assert.deepEqual(
    initial.records.map((item) => item.receiptId),
    ["batch"],
  );
  const initialPrompt = await processLorebooks(db, [{ role: "user", content: "return" }], null, {
    fullContext: true,
    chatId: "chat",
  });
  // Generated continuity lore stays out of the prompt by default: its facts reach the GM through the budgeted
  // campaign-memory block, and injecting every entry rewrote a growing uncached block on each turn.
  assert.doesNotMatch(initialPrompt.fullContext ?? "", /Generated canon/u);
  assert.match(initialPrompt.fullContext ?? "", /Manual canon/u);
  // A chat can opt back in, which restores the previous injection of verified generated entries.
  await db
    .update(chats)
    .set({ metadata: JSON.stringify({ gameContinuity: { injectGeneratedLore: true } }) })
    .where(eq(chats.id, "chat"));
  const optedInPrompt = await processLorebooks(db, [{ role: "user", content: "return" }], null, {
    fullContext: true,
    chatId: "chat",
  });
  assert.match(optedInPrompt.fullContext ?? "", /Generated canon/u);
  assert.match(optedInPrompt.fullContext ?? "", /Manual canon/u);
  await db.update(chats).set({ metadata: "{}" }).where(eq(chats.id, "chat"));

  await db.update(messages).set({ content: "I changed my mind." }).where(eq(messages.id, "m1"));
  await db.update(lorebookEntries).set({ content: "User edited canon." }).where(eq(lorebookEntries.id, "generated"));
  const edited = await readGameContinuityState(db, "chat");
  assert.ok(edited.manualOverrideEntryIds.includes("generated"));
  assert(
    !edited.currentPublishedReceiptIds.includes("batch"),
    "manual-edited generated output cannot count as replacement proof",
  );
  const editedPrompt = await processLorebooks(db, [{ role: "user", content: "changed" }], null, {
    fullContext: true,
    chatId: "chat",
  });
  assert.match(editedPrompt.fullContext ?? "", /User edited canon/u);
  assert.doesNotMatch(editedPrompt.fullContext ?? "", /Stale canon/u);
  assert.match(editedPrompt.fullContext ?? "", /Manual canon/u);
  await db.update(messages).set({ content: "I promise to return." }).where(eq(messages.id, "m1"));
  await db.delete(lorebookEntries).where(eq(lorebookEntries.id, "generated"));
  const missingEntry = await readGameContinuityState(db, "chat");
  assert(
    !missingEntry.currentPublishedReceiptIds.includes("batch"),
    "missing generated output cannot count as replacement proof",
  );
  assert(!missingEntry.records.some((item) => item.receiptId === "batch"));
  assert.ok(
    missingEntry.gaps.some((gap) => gap.batchId === "batch" && gap.reason === "CONTINUITY_PUBLICATION_INVALID"),
  );

  const makeFixtureReceipt = (
    id: string,
    chatId: string,
    status: GameContinuityReceipt["status"],
    sources: GameContinuityReceipt["sources"],
  ): GameContinuityReceipt => ({
    id,
    chatId,
    sessionNumber: 1,
    sourceHash: `${id}-source`,
    sources,
    context: [],
    configHash: "config",
    config: {},
    status,
    attempts: 1,
    repairAttempts: 0,
    records: [],
    dispositions: [...new Set(sources.map((source) => source.messageId))].map((messageId) => ({
      messageId,
      status: "no_durable_facts" as const,
      reason: "fixture",
    })),
    review: {
      findings: [],
      dispositions: [...new Set(sources.map((source) => source.messageId))].map((messageId) => ({
        messageId,
        status: "no_durable_facts" as const,
        reason: "fixture",
      })),
    },
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  });

  const addSupersessionFixture = async (fixture: {
    chatId: string;
    oldMessageId: string;
    oldContent: string;
    currentContent: string;
    oldStatus: Extract<GameContinuityReceipt["status"], "stale" | "failed">;
    replacementSources: (current: ReturnType<typeof prepareContinuitySources>) => GameContinuityReceipt["sources"];
    replacementMessage?: { id: string; content: string };
  }) => {
    await db.insert(chats).values({
      id: fixture.chatId,
      name: fixture.chatId,
      mode: "game",
      metadata: "{}",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(messages).values({
      id: fixture.oldMessageId,
      chatId: fixture.chatId,
      role: "user",
      content: fixture.oldContent,
      createdAt: now,
    });
    const oldSources = prepareContinuitySources(
      await db.select().from(messages).where(eq(messages.chatId, fixture.chatId)),
      {},
    );
    await createGameContinuityStorage(db).enqueue(
      makeFixtureReceipt(`${fixture.chatId}-old`, fixture.chatId, fixture.oldStatus, oldSources),
    );
    await db.update(messages).set({ content: fixture.currentContent }).where(eq(messages.id, fixture.oldMessageId));
    if (fixture.replacementMessage) {
      await db.insert(messages).values({
        id: fixture.replacementMessage.id,
        chatId: fixture.chatId,
        role: "user",
        content: fixture.replacementMessage.content,
        createdAt: now,
      });
    }
    const currentSources = prepareContinuitySources(
      await db.select().from(messages).where(eq(messages.chatId, fixture.chatId)),
      {},
    );
    await createGameContinuityStorage(db).enqueue(
      makeFixtureReceipt(
        `${fixture.chatId}-replacement`,
        fixture.chatId,
        "published",
        fixture.replacementSources(currentSources),
      ),
    );
    return readGameContinuityState(db, fixture.chatId);
  };

  const holeState = await addSupersessionFixture({
    chatId: "supersession-hole",
    oldMessageId: "supersession-hole-message",
    oldContent: "abcdefghij",
    currentContent: "ABCDEFGHIJ",
    oldStatus: "stale",
    replacementSources: (current) => {
      const source = current.find((item) => item.messageId === "supersession-hole-message")!;
      return [
        { ...source, start: 0, end: 4, content: source.content.slice(0, 4) },
        { ...source, start: 6, end: 10, content: source.content.slice(6, 10) },
      ];
    },
  });
  assert(
    !holeState.supersededReceiptIds.includes("supersession-hole-old"),
    "stale predecessor remains active when replacement ranges leave a hole",
  );

  const adjacentState = await addSupersessionFixture({
    chatId: "supersession-adjacent",
    oldMessageId: "supersession-adjacent-message",
    oldContent: "abcdefghij",
    currentContent: "ABCDEFGHIJ",
    oldStatus: "stale",
    replacementSources: (current) => {
      const source = current.find((item) => item.messageId === "supersession-adjacent-message")!;
      return [
        { ...source, start: 0, end: 5, content: source.content.slice(0, 5) },
        { ...source, start: 5, end: 10, content: source.content.slice(5, 10) },
      ];
    },
  });
  assert(
    adjacentState.supersededReceiptIds.includes("supersession-adjacent-old"),
    "adjacent current published ranges fully covering the old message supersede the predecessor",
  );

  await addSupersessionFixture({
    chatId: "supersession-failed",
    oldMessageId: "supersession-failed-message",
    oldContent: "abcdefghij",
    currentContent: "ABCDEFGHIJ",
    oldStatus: "stale",
    replacementSources: (current) => [current.find((item) => item.messageId === "supersession-failed-message")!],
  });
  await db
    .update(gameContinuityBatches)
    .set({ status: "failed" })
    .where(eq(gameContinuityBatches.id, "supersession-failed-replacement"));
  const failedReplacementState = await readGameContinuityState(db, "supersession-failed");
  assert(
    !failedReplacementState.supersededReceiptIds.includes("supersession-failed-old"),
    "stale predecessor remains active when the full-range replacement fails",
  );

  const differentMessageState = await addSupersessionFixture({
    chatId: "supersession-different-message",
    oldMessageId: "supersession-different-old-message",
    oldContent: "abcdefghij",
    currentContent: "ABCDEFGHIJ",
    oldStatus: "stale",
    replacementMessage: { id: "supersession-different-new-message", content: "replacement" },
    replacementSources: (current) => [current.find((item) => item.messageId === "supersession-different-new-message")!],
  });
  assert(
    !differentMessageState.supersededReceiptIds.includes("supersession-different-message-old"),
    "stale predecessor remains active when replacement covers a different message",
  );

  // Continuous verified watermark: three accepted turns, the middle one never enqueued.
  const { planContinuityTurnBatches } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const watermarkMeta = { gameContinuity: { mode: "active", activationMessageId: "wm-a1" } };
  await db.insert(chats).values({
    id: "watermark",
    name: "Watermark",
    mode: "game",
    metadata: JSON.stringify(watermarkMeta),
    createdAt: now,
    updatedAt: now,
  });
  const watermarkTurns = [
    ["wm-u1", "user", "We enter the hall."],
    ["wm-a1", "assistant", "The hall is silent."],
    ["wm-u2", "user", "I light a torch."],
    ["wm-a2", "assistant", "Shadows retreat from the flame."],
    ["wm-u3", "user", "I search the altar."],
    ["wm-a3", "assistant", "A silver key rests there."],
    ["wm-u4", "user", "I take it."],
  ] as const;
  await db.insert(messages).values(
    watermarkTurns.map(([id, role, content], index) => ({
      id,
      chatId: "watermark",
      role,
      content,
      createdAt: `2026-09-13T00:00:${String(index).padStart(2, "0")}.000Z`,
    })),
  );
  const watermarkPrepared = prepareContinuitySources(
    await db.select().from(messages).where(eq(messages.chatId, "watermark")).orderBy(messages.createdAt, messages.id),
    watermarkMeta,
  );
  const turnSources = (assistantId: string) => planContinuityTurnBatches(watermarkPrepared, assistantId)[0]!.sources;
  await createGameContinuityStorage(db).enqueue(
    makeFixtureReceipt("wm-batch-1", "watermark", "published", turnSources("wm-a1")),
  );
  await createGameContinuityStorage(db).enqueue(
    makeFixtureReceipt("wm-batch-3", "watermark", "published", turnSources("wm-a3")),
  );
  const watermarkState = await readGameContinuityState(db, "watermark");
  assert.equal(watermarkState.verifiedThroughMessageId, "wm-a1", "watermark stops before the receipt-less turn");
  const missingTurn = watermarkState.gaps.find((gap) => gap.reason === "CONTINUITY_TURN_NOT_ENQUEUED");
  assert.equal(missingTurn?.messageId, "wm-a2", "the receipt-less accepted turn is named as a gap");
  assert.equal(
    watermarkState.gaps.filter((gap) => gap.reason === "CONTINUITY_TURN_NOT_ENQUEUED").length,
    1,
    "turns with receipts are not reported as missing",
  );
  await createGameContinuityStorage(db).enqueue(
    makeFixtureReceipt("wm-batch-2", "watermark", "verified", turnSources("wm-a2")),
  );
  const filledState = await readGameContinuityState(db, "watermark");
  assert.equal(filledState.verifiedThroughMessageId, "wm-a3", "verified receipts extend the watermark");
  assert(!filledState.gaps.some((gap) => gap.reason === "CONTINUITY_TURN_NOT_ENQUEUED"));
  await db
    .update(chats)
    .set({ metadata: JSON.stringify({ gameContinuity: { mode: "off" } }) })
    .where(eq(chats.id, "watermark"));
  const offState = await readGameContinuityState(db, "watermark");
  assert.equal(offState.verifiedThroughMessageId, null, "no eligible turns while continuity is off");
  assert(!offState.gaps.some((gap) => gap.reason === "CONTINUITY_TURN_NOT_ENQUEUED"));

  await db._fileStore.close();
  console.log("game continuity state regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
