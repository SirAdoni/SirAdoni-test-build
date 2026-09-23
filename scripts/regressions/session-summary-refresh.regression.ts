import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-session-summary-refresh-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 60; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("refresh regression timed out");
};

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { buildSessionSummaryRefreshDescriptor, evaluateSessionSummaryRefresh } =
    await import("../../packages/server/src/services/game/session-summary-dependencies.js");
  const { createSessionSummaryRefreshService } =
    await import("../../packages/server/src/services/game/session-summary-refresh.js");
  let failMessageWrite = false;
  const db = await createFileNativeDB({
    beforeTableWrite: (table) => {
      if (failMessageWrite && table.startsWith("messages")) {
        failMessageWrite = false;
        throw new Error("injected summary message write failure");
      }
    },
  });
  const chats = createChatsStorage(db);
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
  const chat = await chats.create({ name: "Refresh", mode: "game", characterIds: [] });
  await chats.createMessage({ chatId: chat!.id, role: "user", characterId: null, content: "Turn." });
  const assistant = await chats.createMessage({
    chatId: chat!.id,
    role: "assistant",
    characterId: null,
    content: "The gate.",
  });
  const source = await chats.listMessages(chat!.id);
  const descriptor = {
    ...buildSessionSummaryRefreshDescriptor({ messages: source, metadata: {}, sessionNumber: 1, summary }),
    status: "queued" as const,
  };
  await chats.updateMetadata(chat!.id, {
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": descriptor },
  });
  let calls = 0;
  const service = createSessionSummaryRefreshService(db, {
    generate: async ({ savedSummary }) => {
      calls += 1;
      return { ...savedSummary, summary: "Refreshed." };
    },
  });
  await service.start();
  await waitFor(async () => (await chats.getById(chat!.id))?.metadata.includes('"completed"') === true);
  assert.equal(calls, 1);

  const retryChat = await chats.create({ name: "Transient refresh", mode: "game", characterIds: [] });
  await chats.createMessage({ chatId: retryChat!.id, role: "assistant", characterId: null, content: "Retry source." });
  const retrySource = await chats.listMessages(retryChat!.id);
  const retryDescriptor = {
    ...buildSessionSummaryRefreshDescriptor({ messages: retrySource, metadata: {}, sessionNumber: 1, summary }),
    status: "queued" as const,
    maxAttempts: 2,
  };
  await chats.updateMetadata(retryChat!.id, {
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": retryDescriptor },
  });
  let retryCalls = 0;
  const retryService = createSessionSummaryRefreshService(db, {
    retryDelayMs: 10,
    generate: async ({ savedSummary }) => {
      retryCalls += 1;
      if (retryCalls === 1) throw new Error("transient retry failure");
      return { ...savedSummary, summary: "Retried." };
    },
  });
  await retryService.start();
  await waitFor(async () => (await chats.getById(retryChat!.id))?.metadata.includes('"completed"') === true);
  assert.equal(retryCalls, 2);
  await retryService.stop();

  const rollbackChat = await chats.create({ name: "Atomic rollback", mode: "game", characterIds: [] });
  await chats.createMessage({
    chatId: rollbackChat!.id,
    role: "assistant",
    characterId: null,
    content: "Rollback source.",
  });
  const rollbackConclusion = await chats.createMessage({
    chatId: rollbackChat!.id,
    role: "narrator",
    characterId: null,
    content: "**Session 1 Concluded**\n\nOriginal.",
    extra: { continuitySource: "derived_session_summary" },
  });
  const rollbackSource = await chats.listMessages(rollbackChat!.id);
  const rollbackDescriptor = {
    ...buildSessionSummaryRefreshDescriptor({ messages: rollbackSource, metadata: {}, sessionNumber: 1, summary }),
    status: "queued" as const,
  };
  await chats.updateMetadata(rollbackChat!.id, {
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": rollbackDescriptor },
  });
  const rollbackService = createSessionSummaryRefreshService(db, {
    generate: async ({ savedSummary }) => {
      failMessageWrite = true;
      return { ...savedSummary, summary: "Must roll back." };
    },
  });
  await rollbackService.start();
  await waitFor(async () => (await chats.getById(rollbackChat!.id))?.metadata.includes('"pending"') === true);
  const rollbackAfter = await chats.getById(rollbackChat!.id);
  const rollbackMessages = await chats.listMessages(rollbackChat!.id);
  assert.equal(JSON.parse(String(rollbackAfter?.metadata)).gamePreviousSessionSummaries[0].summary, "Original.");
  assert.equal(
    rollbackMessages.find((message) => message.id === rollbackConclusion!.id)?.content,
    "**Session 1 Concluded**\n\nOriginal.",
  );
  await rollbackService.stop();
  await chats.createMessage({ chatId: chat!.id, role: "user", characterId: null, content: "Later roleplay." });
  await service.onDependencyChanged(chat!.id);
  await service.onDependencyChanged(chat!.id);
  await service.stop();
  assert.equal(calls, 1);

  const conflict = await chats.create({ name: "Conflict", mode: "game", characterIds: [] });
  await chats.createMessage({ chatId: conflict!.id, role: "assistant", characterId: null, content: "Source." });
  const conflictSource = await chats.listMessages(conflict!.id);
  const conflictDescriptor = {
    ...buildSessionSummaryRefreshDescriptor({ messages: conflictSource, metadata: {}, sessionNumber: 1, summary }),
    status: "queued" as const,
  };
  await chats.updateMetadata(conflict!.id, {
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": conflictDescriptor },
  });
  const conflictService = createSessionSummaryRefreshService(db, {
    generate: async ({ savedSummary }) => {
      await chats.updateMetadata(conflict!.id, {
        gamePreviousSessionSummaries: [{ ...savedSummary, summary: "Manual." }],
      });
      return {
        summary: "Provider.",
        resumePoint: savedSummary.resumePoint,
        partyDynamics: savedSummary.partyDynamics,
        partyState: savedSummary.partyState,
        keyDiscoveries: savedSummary.keyDiscoveries,
        characterMoments: savedSummary.characterMoments,
        littleDetails: savedSummary.littleDetails,
        statsSnapshot: savedSummary.statsSnapshot,
        npcUpdates: savedSummary.npcUpdates,
      };
    },
  });
  await conflictService.start();
  await waitFor(async () => (await chats.getById(conflict!.id))?.metadata.includes("Manual.") === true);
  await conflictService.stop();
  assert.equal((await chats.getById(conflict!.id))?.metadata.includes("Manual."), true);
  assert.equal(
    (await evaluateSessionSummaryRefresh(db, conflict!.id, conflictDescriptor, { ...summary, summary: "Manual." }))
      .status,
    "conflict",
  );

  const swipeChat = await chats.create({ name: "Active swipe", mode: "game", characterIds: [] });
  await chats.createMessage({ chatId: swipeChat!.id, role: "assistant", characterId: null, content: "Source." });
  const swipeConclusion = await chats.createMessage({
    chatId: swipeChat!.id,
    role: "narrator",
    characterId: null,
    content: "**Session 1 Concluded**\n\nOriginal.",
    extra: { continuitySource: "derived_session_summary", hiddenFromAI: true },
  });
  const swipeSource = await chats.listMessages(swipeChat!.id);
  const swipeDescriptor = {
    ...buildSessionSummaryRefreshDescriptor({ messages: swipeSource, metadata: {}, sessionNumber: 1, summary }),
    status: "queued" as const,
  };
  await chats.updateMetadata(swipeChat!.id, {
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": swipeDescriptor },
  });
  const swipeService = createSessionSummaryRefreshService(db, {
    generate: async ({ savedSummary }) => ({ ...savedSummary, summary: "Swipe refreshed." }),
  });
  await swipeService.start();
  await waitFor(async () => (await chats.getById(swipeChat!.id))?.metadata.includes('"completed"') === true);
  const swipeRows = await chats.getSwipes(swipeConclusion!.id);
  assert.equal(swipeRows[0]?.content.includes("Swipe refreshed."), true);

  const abortChat = await chats.create({ name: "Abort", mode: "game", characterIds: [] });
  await chats.createMessage({ chatId: abortChat!.id, role: "assistant", characterId: null, content: "Source." });
  const abortSource = await chats.listMessages(abortChat!.id);
  const abortDescriptor = {
    ...buildSessionSummaryRefreshDescriptor({ messages: abortSource, metadata: {}, sessionNumber: 1, summary }),
    status: "queued" as const,
  };
  await chats.updateMetadata(abortChat!.id, {
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": abortDescriptor },
  });
  let providerStarted!: () => void;
  let releaseProvider!: () => void;
  const providerReady = new Promise<void>((resolve) => {
    providerStarted = resolve;
  });
  const providerRelease = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const abortService = createSessionSummaryRefreshService(db, {
    generate: async ({ signal, savedSummary }) => {
      providerStarted();
      await providerRelease;
      assert.equal(signal.aborted, true);
      return { ...savedSummary, summary: "Should not save." };
    },
  });
  await abortService.start();
  await providerReady;
  const stopping = abortService.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseProvider();
  await stopping;
  const abortAfterStop = await chats.getById(abortChat!.id);
  assert.equal(abortAfterStop?.metadata.includes("Should not save."), false);

  const replacementChat = await chats.create({ name: "Replacement descriptor", mode: "game", characterIds: [] });
  await chats.createMessage({
    chatId: replacementChat!.id,
    role: "assistant",
    characterId: null,
    content: "Replacement source.",
  });
  const replacementSource = await chats.listMessages(replacementChat!.id);
  const replacementDescriptor = {
    ...buildSessionSummaryRefreshDescriptor({ messages: replacementSource, metadata: {}, sessionNumber: 1, summary }),
    status: "queued" as const,
  };
  await chats.updateMetadata(replacementChat!.id, {
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": replacementDescriptor },
  });
  let replacementRelease!: () => void;
  let replacementStarted!: () => void;
  const replacementReady = new Promise<void>((resolve) => {
    replacementStarted = resolve;
  });
  const replacementGate = new Promise<void>((resolve) => {
    replacementRelease = resolve;
  });
  const replacementService = createSessionSummaryRefreshService(db, {
    generate: async ({ savedSummary }) => {
      replacementStarted();
      await replacementGate;
      return { ...savedSummary, summary: "Must not replace." };
    },
  });
  await replacementService.start();
  await replacementReady;
  const replacement = {
    ...replacementDescriptor,
    status: "queued" as const,
    expectedSummaryHash: "replacement-summary-hash",
  };
  await chats.updateMetadata(replacementChat!.id, { gameSessionSummaryRefreshes: { "1": replacement } });
  replacementRelease();
  await replacementService.stop();
  assert.equal((await chats.getById(replacementChat!.id))?.metadata.includes("replacement-summary-hash"), true);

  const malformedChat = await chats.create({ name: "Malformed", mode: "game", characterIds: [] });
  await chats.createMessage({ chatId: malformedChat!.id, role: "assistant", characterId: null, content: "Source." });
  const malformedSource = await chats.listMessages(malformedChat!.id);
  const malformedDescriptor = {
    ...buildSessionSummaryRefreshDescriptor({ messages: malformedSource, metadata: {}, sessionNumber: 1, summary }),
    status: "queued" as const,
    maxAttempts: 1,
  };
  await chats.updateMetadata(malformedChat!.id, {
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": malformedDescriptor },
  });
  const malformedService = createSessionSummaryRefreshService(db, {
    generate: async ({ savedSummary }) => ({ ...savedSummary, unknownField: "reject" }),
  });
  await malformedService.start();
  await waitFor(async () => (await chats.getById(malformedChat!.id))?.metadata.includes('"failed"') === true);
  assert.equal((await chats.getById(malformedChat!.id))?.metadata.includes('"attempts":1'), true);
  const restartedMalformed = createSessionSummaryRefreshService(db, {
    generate: async () => {
      throw new Error("must not retry capped descriptor");
    },
  });
  await restartedMalformed.start();
  await restartedMalformed.stop();
  await malformedService.stop();

  const sourceChangedChat = await chats.create({ name: "Source changed", mode: "game", characterIds: [] });
  const sourceChangedMessage = await chats.createMessage({
    chatId: sourceChangedChat!.id,
    role: "assistant",
    characterId: null,
    content: "Original source.",
  });
  const sourceChangedSource = await chats.listMessages(sourceChangedChat!.id);
  const sourceChangedDescriptor = {
    ...buildSessionSummaryRefreshDescriptor({ messages: sourceChangedSource, metadata: {}, sessionNumber: 1, summary }),
    status: "queued" as const,
  };
  await chats.updateMetadata(sourceChangedChat!.id, {
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": sourceChangedDescriptor },
  });
  await chats.updateMessageContent(sourceChangedMessage!.id, "Changed before claim.");
  let sourceChangedCalls = 0;
  const sourceChangedService = createSessionSummaryRefreshService(db, {
    generate: async ({ savedSummary }) => {
      sourceChangedCalls += 1;
      return { ...savedSummary, summary: "Must not run." };
    },
  });
  await sourceChangedService.start();
  await sourceChangedService.stop();
  assert.equal(sourceChangedCalls, 0);
  assert.equal(
    (await evaluateSessionSummaryRefresh(db, sourceChangedChat!.id, sourceChangedDescriptor, summary)).status,
    "stale",
  );
  await swipeService.stop();
  await db._fileStore.close();
  void assistant;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.stdout.write("Session summary refresh regression passed.\n");
