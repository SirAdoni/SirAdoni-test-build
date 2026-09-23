import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-game-continuity-branch-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

let app: { close(): Promise<void>; inject(options: Record<string, unknown>): Promise<any> } | null = null;
try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const db = await getDB();
  app = await buildApp();
  await app.ready();
  const chats = createChatsStorage(db);
  const continuity = createGameContinuityStorage(db);

  const createGame = async (name: string) => {
    const response = await app!.inject({
      method: "POST",
      url: "/api/chats",
      payload: { name, mode: "game", characterIds: [] },
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const addMessage = async (chatId: string, role: "user" | "assistant", content: string) => {
    const response = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      payload: { role, content },
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  };

  const root = await createGame("Continuity branch proof");
  const before = await addMessage(root.id, "user", "Before activation.");
  const activation = await addMessage(root.id, "assistant", "Activation turn.");
  const laterUser = await addMessage(root.id, "user", "Later fact must stay out of an early branch.");
  const laterAssistant = await addMessage(root.id, "assistant", "Later accepted fact.");
  await chats.updateMetadata(root.id, {
    gameContinuity: { mode: "off", activationMessageId: activation.id, activationAt: activation.createdAt },
    gameLorebookKeeperEnabled: true,
    gameLorebookKeeperLorebookId: "foreign-keeper-book",
  });
  await continuity.enqueue({
    id: "root-receipt",
    chatId: root.id,
    sessionNumber: 1,
    sourceHash: "root-source",
    sources: [
      {
        messageId: laterAssistant.id,
        swipeIndex: 0,
        hash: "root-message",
        role: "assistant",
        content: laterAssistant.content,
      },
    ],
    context: [],
    configHash: "root-config",
    config: {},
    status: "queued",
    attempts: 0,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    entryIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const fullBranchResponse = await app.inject({
    method: "POST",
    url: `/api/chats/${root.id}/branch`,
    payload: { upToMessageId: laterAssistant.id },
  });
  assert.equal(fullBranchResponse.statusCode, 200);
  const fullBranch = fullBranchResponse.json();
  const fullMeta = typeof fullBranch.metadata === "string" ? JSON.parse(fullBranch.metadata) : fullBranch.metadata;
  assert.equal(
    fullMeta.gameContinuity.activationMessageId,
    fullMeta.branchMessageId === undefined
      ? undefined
      : (await chats.listMessages(fullBranch.id)).find((message: any) => message.content === activation.content)?.id,
  );
  assert.equal(
    fullMeta.gameLorebookKeeperLorebookId,
    undefined,
    "foreign Keeper book must not cross a branch boundary",
  );
  assert.equal((await continuity.list(fullBranch.id)).length, 0, "source receipts must never be copied to a branch");

  const earlyBranchResponse = await app.inject({
    method: "POST",
    url: `/api/chats/${root.id}/branch`,
    payload: { upToMessageId: before.id },
  });
  assert.equal(earlyBranchResponse.statusCode, 200);
  const earlyBranch = earlyBranchResponse.json();
  const earlyMeta = typeof earlyBranch.metadata === "string" ? JSON.parse(earlyBranch.metadata) : earlyBranch.metadata;
  assert.equal(
    earlyMeta.gameContinuity.activationMessageId,
    undefined,
    "pre-activation branch must not inherit a foreign message boundary",
  );
  assert.equal(
    typeof earlyMeta.gameContinuity.activationAt,
    "string",
    "pre-activation branch receives a fresh boundary timestamp",
  );
  assert.ok(
    Date.parse(earlyMeta.gameContinuity.activationAt) >=
      Date.parse(earlyBranch.createdAt ?? earlyMeta.updatedAt ?? new Date().toISOString()),
  );
  const earlyMessages = await chats.listMessages(earlyBranch.id);
  assert.deepEqual(
    earlyMessages.map((message: any) => message.content),
    [before.content],
  );
  assert.equal(
    earlyMessages.some((message: any) => message.id === laterUser.id || message.id === laterAssistant.id),
    false,
  );
  assert.equal((await continuity.list(earlyBranch.id)).length, 0);
  console.log("game continuity branch regression passed");
} finally {
  if (app) await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
