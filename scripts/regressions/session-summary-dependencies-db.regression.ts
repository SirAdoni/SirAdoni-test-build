import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-session-summary-dependencies-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const {
    buildSessionSummaryRefreshDescriptor,
    evaluateSessionSummaryRefresh,
  } = await import("../../packages/server/src/services/game/session-summary-dependencies.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityStorage } = await import("../../packages/server/src/services/storage/game-continuity.storage.js");

  const db = await createFileNativeDB();
  const chats = createChatsStorage(db);
  const chat = await chats.create({ name: "Summary dependency fixture", mode: "game", characterIds: [] });
  assert.ok(chat);
  const first = await chats.createMessage({ chatId: chat!.id, role: "user", characterId: null, content: "Old turn" });
  const target = await chats.createMessage({
    chatId: chat!.id,
    role: "assistant",
    characterId: null,
    content: "Narration: Target turn",
  });
  const summary = { sessionNumber: 1, summary: "Target", timestamp: "2026-09-13T00:00:00.000Z" };
  const sourceMessages = await chats.listMessages(chat!.id);
  const descriptor = buildSessionSummaryRefreshDescriptor({
    messages: sourceMessages,
    metadata: {},
    sessionNumber: 1,
    summary,
    continuityRequired: false,
  });

  await chats.createMessage({ chatId: chat!.id, role: "user", characterId: null, content: "Later roleplay" });
  assert.equal((await evaluateSessionSummaryRefresh(db, chat!.id, descriptor, summary)).status, "ready");
  assert.equal(
    (await evaluateSessionSummaryRefresh(db, chat!.id, descriptor, { ...summary, summary: "Manual edit" })).status,
    "conflict",
  );

  await chats.updateMessageContent(target!.id, "Narration: Changed target");
  assert.equal((await evaluateSessionSummaryRefresh(db, chat!.id, descriptor, summary)).status, "stale");

  const activeChat = await chats.create({ name: "Pending summary fixture", mode: "game", characterIds: [] });
  assert.ok(activeChat);
  await chats.updateMetadata(activeChat!.id, { gameContinuity: { mode: "active" } });
  const activeMessage = await chats.createMessage({
    chatId: activeChat!.id,
    role: "assistant",
    characterId: null,
    content: "Narration: Awaiting continuity",
  });
  const activeMessages = await chats.listMessages(activeChat!.id);
  const activeDescriptor = buildSessionSummaryRefreshDescriptor({
    messages: activeMessages,
    metadata: JSON.stringify({ gameContinuity: { mode: "active" } }),
    sessionNumber: 1,
    summary,
    continuityRequired: true,
  });
  assert.equal((await evaluateSessionSummaryRefresh(db, activeChat!.id, activeDescriptor, summary)).status, "pending");

  const activeSource = prepareContinuitySources(activeMessages, { gameContinuity: { mode: "active" } });
  await createGameContinuityStorage(db).enqueue({
    id: "one-codepoint-hole",
    chatId: activeChat!.id,
    sessionNumber: 1,
    sourceHash: "complete-coverage-source",
    sources: activeSource.map((source) => ({ ...source, end: Math.max(source.start ?? 0, (source.end ?? 0) - 1) })),
    context: [],
    configHash: "complete-coverage-config",
    config: {},
    status: "published",
    attempts: 1,
    repairAttempts: 0,
    records: [],
    dispositions: activeSource.map((source) => ({
      messageId: source.messageId,
      status: "no_durable_facts" as const,
      reason: "fixture",
    })),
    review: {
      findings: [],
      dispositions: activeSource.map((source) => ({
        messageId: source.messageId,
        status: "no_durable_facts" as const,
        reason: "fixture",
      })),
    },
    entryIds: [],
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  });
  assert.equal((await evaluateSessionSummaryRefresh(db, activeChat!.id, activeDescriptor, summary)).status, "pending");

  await createGameContinuityStorage(db).enqueue({
    id: "complete-coverage",
    chatId: activeChat!.id,
    sessionNumber: 1,
    sourceHash: "complete-coverage-source",
    sources: activeSource,
    context: [],
    configHash: "complete-coverage-config",
    config: {},
    status: "published",
    attempts: 1,
    repairAttempts: 0,
    records: [],
    dispositions: activeSource.map((source) => ({ messageId: source.messageId, status: "no_durable_facts" as const, reason: "fixture" })),
    review: {
      findings: [],
      dispositions: activeSource.map((source) => ({
        messageId: source.messageId,
        status: "no_durable_facts" as const,
        reason: "fixture",
      })),
    },
    entryIds: [],
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  });
  assert.equal((await evaluateSessionSummaryRefresh(db, activeChat!.id, activeDescriptor, summary)).status, "ready");

  await chats.updateMetadata(activeChat!.id, { [`segmentEdit:${activeMessage!.id}:0`]: { content: "Edited" } });
  assert.equal((await evaluateSessionSummaryRefresh(db, activeChat!.id, activeDescriptor, summary)).status, "stale");
  await db._fileStore.close();
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write("Session summary dependency database regression passed.\n");
