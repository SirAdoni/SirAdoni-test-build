import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-session-summary-refresh-boundary-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 60; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("refresh boundary regression timed out");
};

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { lorebooks, lorebookEntries } = await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { readGameContinuityState } = await import("../../packages/server/src/services/game/continuity-state.js");
  const { buildSessionSummaryRefreshDescriptor } =
    await import("../../packages/server/src/services/game/session-summary-dependencies.js");
  const { createSessionSummaryRefreshService } =
    await import("../../packages/server/src/services/game/session-summary-refresh.js");

  const db = await createFileNativeDB();
  const chats = createChatsStorage(db);
  const now = new Date().toISOString();
  const summary = {
    sessionNumber: 1,
    summary: "Original.",
    resumePoint: "At the gate.",
    partyDynamics: "Together.",
    partyState: "Ready.",
    keyDiscoveries: [],
    characterMoments: [],
    littleDetails: [],
    statsSnapshot: {},
    npcUpdates: [],
    nextSessionRequest: null,
    timestamp: "2026-09-13T00:00:00.000Z",
  };
  const chat = await chats.create({ name: "Refresh boundary", mode: "game", characterIds: [] });
  assert.ok(chat);
  await chats.createMessage({ chatId: chat!.id, role: "user", characterId: null, content: "Turn one." });
  const inRange = await chats.createMessage({
    chatId: chat!.id,
    role: "assistant",
    characterId: null,
    content: "The gate stood open and IN-RANGE-EVIDENCE was noted.",
  });
  const sessionMessages = await chats.listMessages(chat!.id);
  const descriptor = {
    ...buildSessionSummaryRefreshDescriptor({ messages: sessionMessages, metadata: {}, sessionNumber: 1, summary }),
    status: "queued" as const,
  };
  const later = await chats.createMessage({
    chatId: chat!.id,
    role: "user",
    characterId: null,
    content: "LATER-SESSION-SENTINEL happened after the summary range.",
  });
  assert.equal(descriptor.sourceRange.endMessageId, inRange!.id);

  const prepared = prepareContinuitySources(await chats.listMessages(chat!.id), {});
  const inRangeSource = prepared.find((item) => item.messageId === inRange!.id)!;
  const laterSource = prepared.find((item) => item.messageId === later!.id)!;
  const contentHash = (content: string) => createHash("sha256").update(JSON.stringify(content)).digest("hex");
  await db.insert(lorebooks).values({ id: "book", name: "Book", chatId: chat!.id, createdAt: now, updatedAt: now });
  await db.insert(lorebookEntries).values([
    {
      id: "entry-in-range",
      lorebookId: "book",
      name: "In range",
      content: "In-range canon.",
      dynamicState: JSON.stringify({
        source: "incremental-game-continuity",
        receiptId: "receipt-in-range",
        publishedContentHash: contentHash("In-range canon."),
      }),
    },
    {
      id: "entry-later",
      lorebookId: "book",
      name: "Later",
      content: "Later canon.",
      dynamicState: JSON.stringify({
        source: "incremental-game-continuity",
        receiptId: "receipt-later",
        publishedContentHash: contentHash("Later canon."),
      }),
    },
  ]);
  const inRangeRecord = {
    kind: "event" as const,
    text: "IN-RANGE-RECORD: the gate stood open.",
    subjects: ["gate"],
    conditions: [],
    status: "asserted" as const,
    evidence: [{ messageId: inRange!.id, quote: "IN-RANGE-EVIDENCE" }],
    keys: ["gate"],
  };
  const laterRecord = {
    kind: "event" as const,
    text: "OUT-OF-RANGE-RECORD: something happened later.",
    subjects: ["later"],
    conditions: [],
    status: "asserted" as const,
    evidence: [{ messageId: later!.id, quote: "LATER-SESSION-SENTINEL" }],
    keys: ["later"],
  };
  const receipt = (
    id: string,
    source: typeof inRangeSource,
    record: typeof inRangeRecord,
    entryId: string,
  ): GameContinuityReceipt => ({
    id,
    chatId: chat!.id,
    sessionNumber: 1,
    sourceHash: `${id}-source`,
    sources: [source],
    context: [],
    configHash: "config",
    config: {},
    status: "published",
    attempts: 1,
    repairAttempts: 0,
    records: [{ ...record, id: createGameContinuityRecordId(id, record) }],
    dispositions: [{ messageId: source.messageId, status: "covered", reason: "fixture" }],
    review: { findings: [], dispositions: [{ messageId: source.messageId, status: "covered", reason: "fixture" }] },
    entryIds: [entryId],
    createdAt: now,
    updatedAt: now,
  });
  const continuity = createGameContinuityStorage(db);
  await continuity.enqueue(receipt("receipt-in-range", inRangeSource, inRangeRecord, "entry-in-range"));
  await continuity.enqueue(receipt("receipt-later", laterSource, laterRecord, "entry-later"));
  const state = await readGameContinuityState(db, chat!.id);
  assert.deepEqual(
    state.records.map((item) => item.text).sort(),
    ["IN-RANGE-RECORD: the gate stood open.", "OUT-OF-RANGE-RECORD: something happened later."],
    "both receipts must be current and published so the refresh filter, not the state reader, does the bounding",
  );

  await chats.updateMetadata(chat!.id, {
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": descriptor },
  });
  const captured: Array<{ transcript: string; continuityEvidence: string }> = [];
  const service = createSessionSummaryRefreshService(db, {
    generate: async ({ savedSummary, transcript, continuityEvidence }) => {
      captured.push({ transcript, continuityEvidence });
      return { ...savedSummary, summary: "Refreshed." };
    },
  });
  await service.start();
  await waitFor(async () => (await chats.getById(chat!.id))?.metadata.includes('"completed"') === true);
  await service.stop();
  await db._fileStore.close();

  assert.equal(captured.length, 1);
  const { transcript, continuityEvidence } = captured[0]!;
  assert.match(transcript, /Turn one\./u);
  assert.match(transcript, /IN-RANGE-EVIDENCE/u);
  assert.doesNotMatch(transcript, /LATER-SESSION-SENTINEL/u, "transcript leaked a message after the source range");
  assert.match(continuityEvidence, /IN-RANGE-RECORD/u);
  assert.match(continuityEvidence, new RegExp(`${inRange!.id}: IN-RANGE-EVIDENCE`, "u"));
  assert.doesNotMatch(continuityEvidence, /OUT-OF-RANGE-RECORD/u, "evidence leaked a record cited outside the range");
  assert.doesNotMatch(continuityEvidence, /LATER-SESSION-SENTINEL/u);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.stdout.write("Session summary refresh boundary regression passed.\n");
