import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-branch-route-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

let app: { close(): Promise<void>; inject(options: Record<string, unknown>): Promise<any> } | null = null;
try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { chats, campaignMemoryFacts } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
  const { formatCampaignMemoryMessageOrder } =
    await import("../../packages/server/src/services/game/campaign-memory-order.js");

  app = await buildApp();
  await app.ready();
  const db = await getDB();
  const memory = createCampaignMemoryStorage(db);

  const createChat = async (name: string, mode: "game" | "conversation" = "game") => {
    const response = await app!.inject({ method: "POST", url: "/api/chats", payload: { name, mode } });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const addMessage = async (chatId: string, content: string) => {
    const response = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      payload: { role: "user", content },
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  };

  const source = await createChat("Campaign memory branch source");
  const first = await addMessage(source.id, "historical evidence");
  await addMessage(source.id, "future evidence");
  const sourceOrder = formatCampaignMemoryMessageOrder(first.id, first.createdAt);
  await memory.createEntity({
    entityId: "route-note",
    chatId: source.id,
    kind: "note",
    owner: { type: "registry", store: "campaign-memory", recordId: "route-note" },
    aliases: ["Route note"],
    tags: [],
    summary: "Copied route note",
    attributes: {},
    status: "active",
    manualLock: false,
    provenance: { source: "regression", sourceRevision: "route-v1", actor: "system" },
  });
  const fact = await memory.createFact({
    chatId: source.id,
    subjectEntityId: "route-note",
    predicate: "hasEvidence",
    value: { value: "historical" },
    conditions: [],
    status: "verified",
    validFromOrder: sourceOrder,
    sourceRevision: "route-v1",
    evidence: [{ messageId: first.id, quote: "historical evidence" }],
    author: "system",
    manualLock: false,
    provenance: { source: "regression", sourceRevision: "route-v1", actor: "system" },
  });

  const branchResponse = await app.inject({
    method: "POST",
    url: `/api/chats/${source.id}/branch`,
    payload: { upToMessageId: first.id },
  });
  assert.equal(branchResponse.statusCode, 200);
  const branch = branchResponse.json();
  assert.equal(branch.metadata.campaignMemoryBranch.sourceChatId, source.id);
  assert.equal(branch.metadata.campaignMemoryBranch.copied.facts, 1);
  assert.equal(branch.metadata.campaignMemoryBranch.held[0].recordId, "route-note");
  assert.match(branch.metadata.campaignMemoryBranch.held[0].reason, /stable identity/);
  assert.equal(branch.metadata.campaignMemoryBranch.operationId, `campaign-memory-branch:${branch.id}`);
  const copiedFacts = await memory.listFacts({ chatId: branch.id });
  assert.equal(copiedFacts.length, 1);
  assert.equal(copiedFacts[0].evidence[0].messageId, branch.metadata.branchMessageId);
  assert.notEqual(copiedFacts[0].factId, fact.factId);
  assert.equal((await memory.listFacts({ chatId: source.id })).length, 1, "source memory remains untouched");

  const empty = await createChat("Empty campaign memory source");
  const emptyBranchResponse = await app.inject({ method: "POST", url: `/api/chats/${empty.id}/branch`, payload: {} });
  assert.equal(emptyBranchResponse.statusCode, 200);
  const emptyBranch = emptyBranchResponse.json();
  assert.deepEqual(emptyBranch.metadata.campaignMemoryBranch.copied, {
    entities: 0,
    facts: 0,
    knowledge: 0,
    events: 0,
    currentState: 0,
    relationships: 0,
  });
  assert.deepEqual(emptyBranch.metadata.campaignMemoryBranch.held, []);
  assert.equal((await memory.listEntities({ chatId: emptyBranch.id })).length, 0);

  const itemSource = await createChat("Item identity branch source");
  const itemMessage = await addMessage(itemSource.id, "item snapshot");
  const gameState = createGameStateStorage(db);
  await gameState.create({
    chatId: itemSource.id,
    messageId: itemMessage.id,
    swipeIndex: 0,
    playerStats: { inventory: [{ name: "Branch token" }] },
  } as any);
  const sourceSnapshot = await gameState.getByMessage(itemMessage.id, 0);
  assert.ok(sourceSnapshot?.id);
  const sourceItemId = JSON.parse(sourceSnapshot.playerStats ?? "{}").inventory?.[0]?.itemId;
  assert.equal(typeof sourceItemId, "string");
  const itemBranchResponse = await app.inject({
    method: "POST",
    url: `/api/chats/${itemSource.id}/branch`,
    payload: { upToMessageId: itemMessage.id },
  });
  assert.equal(itemBranchResponse.statusCode, 200);
  const itemBranch = itemBranchResponse.json();
  const itemBranchMessage = (
    await app.inject({ method: "GET", url: `/api/chats/${itemBranch.id}/messages` })
  ).json()[0];
  const copiedSnapshot = await gameState.getByMessage(itemBranchMessage.id, 0);
  const copiedItemId = JSON.parse(copiedSnapshot?.playerStats ?? "{}").inventory?.[0]?.itemId;
  assert.equal(typeof copiedItemId, "string");
  assert.equal(copiedItemId, sourceItemId);

  const failingSource = await createChat("Failing campaign memory source");
  const failingMessage = await addMessage(failingSource.id, "failure evidence");
  const timestamp = new Date().toISOString();
  await db.insert(campaignMemoryFacts).values({
    factId: "malformed-route-fact",
    chatId: failingSource.id,
    subjectEntityId: "missing-entity",
    predicate: "malformed",
    value: "{}",
    conditions: "[]",
    status: "verified",
    validFromOrder: formatCampaignMemoryMessageOrder(failingMessage.id, failingMessage.createdAt),
    validToOrder: null,
    sourceRevision: "route-failure",
    evidence: "not-json",
    author: "system",
    provenance: JSON.stringify({ source: "regression", sourceRevision: "route-failure", actor: "system" }),
    manualLock: 0,
    supersedesFactId: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const failedBranchResponse = await app.inject({
    method: "POST",
    url: `/api/chats/${failingSource.id}/branch`,
    payload: {},
  });
  assert.equal(failedBranchResponse.statusCode, 500);
  assert.equal(
    (await db.select().from(chats)).filter((chat) => chat.name === "Failing campaign memory source").length,
    1,
  );
  assert.equal(
    (await db.select().from(campaignMemoryFacts)).filter((factRow) => factRow.chatId === failingSource.id).length,
    1,
    "failed branch leaves source memory intact",
  );
  console.log("campaign-memory-branch-route regression: ok");
} finally {
  if (app) await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
