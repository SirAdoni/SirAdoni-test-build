import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-game-continuity-source-change-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

const waitFor = async (label: string, check: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`source change regression timed out waiting for ${label}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let app: { close(): Promise<void>; inject(options: Record<string, unknown>): Promise<any>; [key: string]: any } | null =
  null;

try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { readGameContinuityState } = await import("../../packages/server/src/services/game/continuity-state.js");
  const { buildSessionSummaryRefreshDescriptor, evaluateSessionSummaryRefresh } =
    await import("../../packages/server/src/services/game/session-summary-dependencies.js");

  app = await buildApp();
  await app.ready();
  const db = await getDB();
  const chats = createChatsStorage(db);
  const continuityStorage = createGameContinuityStorage(db);

  // Spy on the runtime hooks the notifier must reach; nothing else in this
  // regression calls them (no generation, no conclude, no manual reconcile).
  const reconciled: string[] = [];
  const dependencyChanged: string[] = [];
  const runtime = app.gameContinuity;
  const originalReconcile = runtime.reconcileChat.bind(runtime);
  runtime.reconcileChat = async (chatId: string) => {
    reconciled.push(chatId);
    return originalReconcile(chatId);
  };
  const refresh = app.sessionSummaryRefresh;
  assert.ok(refresh, "session summary refresh service is registered by game routes");
  const originalDependencyChanged = refresh.onDependencyChanged.bind(refresh);
  refresh.onDependencyChanged = async (chatId: string) => {
    dependencyChanged.push(chatId);
    return originalDependencyChanged(chatId);
  };

  const createChat = async (name: string, mode: string) => {
    const response = await app!.inject({ method: "POST", url: "/api/chats", payload: { name, mode, characterIds: [] } });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const addMessage = async (chatId: string, role: "user" | "assistant", content: string) => {
    const response = await app!.inject({ method: "POST", url: `/api/chats/${chatId}/messages`, payload: { role, content } });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const refreshDescriptor = async (chatId: string) => {
    const chat = await chats.getById(chatId);
    const metadata = typeof chat?.metadata === "string" ? JSON.parse(chat.metadata) : (chat?.metadata ?? {});
    return metadata.gameSessionSummaryRefreshes?.["1"];
  };

  // ── Game chat: a published receipt and a provisional summary cover the assistant turn ──
  const game = await createChat("Continuity source change", "game");
  const user = await addMessage(game.id, "user", "We enter the old hall.");
  const assistant = await addMessage(game.id, "assistant", "Edmund promises to return before dawn.");
  const continuityMetadata = { gameContinuity: { mode: "shadow", activationMessageId: assistant.id } };
  const messages = await chats.listMessages(game.id);
  const prepared = prepareContinuitySources(messages, continuityMetadata);
  assert.ok(prepared.some((item) => item.messageId === assistant.id), "assistant turn is a continuity source");
  const now = new Date().toISOString();
  const dispositions = prepared.map((item) => ({
    messageId: item.messageId,
    status: "no_durable_facts" as const,
    reason: "fixture",
  }));
  const receipt: GameContinuityReceipt = {
    id: "source-change-receipt",
    chatId: game.id,
    sessionNumber: 1,
    sourceHash: "source-change-hash",
    sources: prepared,
    context: [],
    configHash: "source-change-config",
    config: {},
    status: "published",
    attempts: 1,
    repairAttempts: 0,
    records: [],
    dispositions,
    review: { findings: [], dispositions },
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await continuityStorage.enqueue(receipt);
  const summary = {
    sessionNumber: 1,
    summary: "Edmund promised to return.",
    resumePoint: "At the hall.",
    partyDynamics: "Together.",
    partyState: "Ready.",
    keyDiscoveries: [],
    characterMoments: [],
    littleDetails: [],
    statsSnapshot: {},
    npcUpdates: [],
    nextSessionRequest: null,
    timestamp: now,
  };
  const descriptor = buildSessionSummaryRefreshDescriptor({
    messages,
    metadata: continuityMetadata,
    sessionNumber: 1,
    summary,
    continuityReceiptIds: [receipt.id],
    continuityRequired: true,
  });
  assert.equal(descriptor.status, "provisional");
  await chats.updateMetadata(game.id, {
    ...continuityMetadata,
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": descriptor },
  });

  const before = await readGameContinuityState(db, game.id);
  assert.deepEqual(before.gaps, [], "seeded receipt is current before the source changes");
  assert.deepEqual(before.currentPublishedReceiptIds, [receipt.id]);
  assert.equal((await evaluateSessionSummaryRefresh(db, game.id, descriptor, summary)).status, "ready");
  assert.equal((await refreshDescriptor(game.id)).status, "provisional");
  assert.deepEqual(reconciled, []);
  assert.deepEqual(dependencyChanged, []);

  // ── DELETE the source message: the notification is scheduled, never awaited ──
  const deleted = await app.inject({ method: "DELETE", url: `/api/chats/${game.id}/messages/${assistant.id}` });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json(), { trashed: false, trashedCount: 0 }, "Game source deletion stays permanent");
  assert.deepEqual(reconciled, [], "reconcile runs off the request path, not before the response");
  await waitFor("reconcile after delete", () => reconciled.includes(game.id));
  await waitFor("dependency change after delete", () => dependencyChanged.includes(game.id));
  await waitFor("summary descriptor marked stale", async () => (await refreshDescriptor(game.id))?.status === "stale");
  const staleDescriptor = await refreshDescriptor(game.id);
  assert.equal(staleDescriptor.reason, "source_changed");
  assert.equal(staleDescriptor.attempts, 0, "no refresh attempt is spent on a stale descriptor");
  assert.equal((await evaluateSessionSummaryRefresh(db, game.id, descriptor, summary)).status, "stale");

  const after = await readGameContinuityState(db, game.id);
  assert.deepEqual(after.gaps, [{ batchId: receipt.id, status: "published", reason: "CONTINUITY_SOURCE_CHANGED" }]);
  assert.deepEqual(after.currentPublishedReceiptIds, []);
  assert.equal(after.receipts.find((item) => item.receipt.id === receipt.id)?.sourceCurrent, false);
  const view = await app.inject({ method: "GET", url: `/api/game/${game.id}/continuity` });
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().batches.find((batch: { id: string }) => batch.id === receipt.id)?.status, "stale");
  assert.deepEqual(view.json().gaps, after.gaps);
  assert.equal((await continuityStorage.list(game.id)).length, 1, "reconcile enqueued no provider work");

  // ── A burst of edits on the same chat collapses into one reconcile ──
  const reconcilesBefore = reconciled.length;
  const dependencyBefore = dependencyChanged.length;
  for (const content of ["We enter the old hall, quietly.", "We enter the old hall, slowly."]) {
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/chats/${game.id}/messages/${user.id}`,
      payload: { content },
    });
    assert.equal(edited.statusCode, 200);
  }
  const hidden = await app.inject({
    method: "PATCH",
    url: `/api/chats/${game.id}/messages/${user.id}/extra`,
    payload: { hiddenFromAI: true },
  });
  assert.equal(hidden.statusCode, 200);
  await waitFor("reconcile after edit burst", () => reconciled.length > reconcilesBefore);
  await sleep(600);
  assert.equal(reconciled.length, reconcilesBefore + 1, "edit burst is debounced per chat");
  assert.equal(dependencyChanged.length, dependencyBefore + 1);

  // ── Non-game chat: the same mutations trigger nothing ──
  const roleplay = await createChat("Roleplay source change", "roleplay");
  const roleplayMessage = await addMessage(roleplay.id, "assistant", "A quiet evening.");
  const reconcilesAtRoleplay = reconciled.length;
  const dependencyAtRoleplay = dependencyChanged.length;
  const edited = await app.inject({
    method: "PATCH",
    url: `/api/chats/${roleplay.id}/messages/${roleplayMessage.id}`,
    payload: { content: "A loud evening." },
  });
  assert.equal(edited.statusCode, 200);
  const removed = await app.inject({ method: "DELETE", url: `/api/chats/${roleplay.id}/messages/${roleplayMessage.id}` });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.json(), { trashed: true, trashedCount: 1 }, "Roleplay deletion uses enabled message trash");
  await sleep(700);
  assert.equal(reconciled.length, reconcilesAtRoleplay, "non-game chat never reconciles continuity");
  assert.equal(dependencyChanged.length, dependencyAtRoleplay, "non-game chat never wakes summary refresh");
  assert.ok(!reconciled.includes(roleplay.id));
} finally {
  if (app) await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("game continuity source change regression passed");
