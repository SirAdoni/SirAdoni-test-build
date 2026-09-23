import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Storage must be isolated before any server module is imported; the runner does not do it.
const dataDir = mkdtempSync(join(tmpdir(), "marinara-peek-prompt-metadata-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

const campaignMemoryMetadata = {
  audience: "gm",
  includedIds: ["cmf_fact1", "cmk_know1", "cme_alice", "550e8400-e29b-41d4-a716-446655440000"],
  exclusions: [
    { id: "cmf_fact2", reason: "omitted by character budget" },
    { id: "cmk_know2", reason: "knowledge is held by another entity" },
  ],
  degraded: true,
  cutoffOrder: "0000000012|2026-09-15T10:00:00.000Z",
  characterBoundaries: [{ entityId: "cme_alice", kind: "character", aliases: ["Alice"], mayUseIds: ["cmk_know1"] }],
  omissions: { budgetOmitted: 1, duplicatesMerged: 1, mergedIds: ["cmf_dup"] },
};
const continuityMetadata = {
  mode: "active",
  includedReceiptIds: ["receipt-1"],
  omittedRecordCount: 2,
  pendingSourceMessageIds: ["msg-pending"],
  unresolvedSourceMessageIds: [],
  unreviewedSourceMessageIds: ["msg-unreviewed"],
  unreviewedCodepoints: 40,
  omittedSourceCount: 1,
  clippedCodepoints: 0,
};

let app: {
  ready(): Promise<void>;
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<any>;
} | null = null;
try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const db = await getDB();
  app = await buildApp();
  await app.ready();
  const chats = createChatsStorage(db);
  const chat = await chats.create({ name: "peek metadata", mode: "game", characterIds: [] } as any);
  await chats.createMessage({ chatId: chat.id, role: "user", content: "I enter the vault." } as any);
  const assistant = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    content: "The vault opens.",
  } as any);
  await chats.updateMessageExtra(assistant.id, {
    cachedPrompt: [
      {
        role: "system",
        content: "You are the GM.",
        providerMetadata: { marinaraGmStable: true, marinaraCacheScope: chat.id, apiKey: "LEAKED_PROVIDER_AUTH" },
      },
      {
        role: "system",
        content: "<continuity>receipt-1</continuity>",
        contextKind: "injection",
        providerMetadata: {
          marinaraRuntimeContext: true,
          marinaraGameContinuity: true,
          marinaraGmDynamic: true,
          continuity: { ...continuityMetadata, rawProviderPayload: { headers: "LEAKED_RAW_PAYLOAD" } },
        },
      },
      {
        role: "system",
        content: '<campaign_memory audience="gm">\n[fact cmf_fact1] The vault holds the crown.\n</campaign_memory>',
        contextKind: "injection",
        providerMetadata: {
          marinaraRuntimeContext: true,
          marinaraCampaignMemory: { ...campaignMemoryMetadata, providerRequest: "LEAKED_RAW_PAYLOAD" },
          authorization: "Bearer LEAKED_PROVIDER_AUTH",
        },
      },
      { role: "user", content: "I enter the vault." },
    ],
    generationInfo: { model: "fake", provider: "custom", tokensPrompt: 12, tokensCompletion: 3 },
  });

  const peek = await app.inject({ method: "POST", url: `/api/chats/${chat.id}/peek-prompt`, payload: {} });
  assert.equal(peek.statusCode, 200, peek.body);
  const body = JSON.parse(peek.body);
  assert.equal(body.source, "cached");
  assert.equal(body.exact, true);
  assert.equal(body.messages.length, 4);
  assert.deepEqual(
    body.messages.map((message: any) => [message.role, message.content]),
    [
      ["system", "You are the GM."],
      ["system", "<continuity>receipt-1</continuity>"],
      ["system", '<campaign_memory audience="gm">\n[fact cmf_fact1] The vault holds the crown.\n</campaign_memory>'],
      ["user", "I enter the vault."],
    ],
    "Cached role/content text stays exact",
  );

  assert.equal(body.messages[0].metadata, undefined, "Stable-prefix cache markers are not inspector metadata");
  assert.equal(body.messages[3].metadata, undefined, "Messages without providerMetadata carry no metadata field");
  assert.deepEqual(
    body.messages[1].metadata,
    { continuity: continuityMetadata },
    "Continuity metadata is projected with exactly its documented keys",
  );
  assert.deepEqual(
    body.messages[2].metadata,
    { campaignMemory: campaignMemoryMetadata },
    "Campaign memory metadata keeps included IDs, exclusions, cutoff, boundaries and omissions only",
  );
  assert.deepEqual(Object.keys(body.messages[2].metadata.campaignMemory).sort(), [
    "audience",
    "characterBoundaries",
    "cutoffOrder",
    "degraded",
    "exclusions",
    "includedIds",
    "omissions",
  ]);
  for (const leak of ["LEAKED_PROVIDER_AUTH", "LEAKED_RAW_PAYLOAD", "providerMetadata", "marinaraGmStable", "apiKey"]) {
    assert.equal(peek.body.includes(leak), false, `Peek response must not contain ${leak}`);
  }

  // Malformed captures degrade to "no metadata" instead of throwing.
  const malformed = await chats.createMessage({ chatId: chat.id, role: "assistant", content: "Again." } as any);
  await chats.updateMessageExtra(malformed.id, {
    cachedPrompt: [
      { role: "system", content: "x", providerMetadata: { marinaraCampaignMemory: { includedIds: "not-a-list" } } },
      { role: "system", content: "y", providerMetadata: { continuity: { includedReceiptIds: ["r"] } } },
      { role: "user", content: "z" },
    ],
  });
  const malformedPeek = await app.inject({
    method: "POST",
    url: `/api/chats/${chat.id}/peek-prompt`,
    payload: { messageId: malformed.id },
  });
  assert.equal(malformedPeek.statusCode, 200, malformedPeek.body);
  assert.ok(
    JSON.parse(malformedPeek.body).messages.every((message: any) => message.metadata === undefined),
    "Metadata without the documented shape is dropped",
  );

  await closeDB();
  console.log("peek-prompt-memory-metadata regression passed");
} finally {
  if (app) await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
