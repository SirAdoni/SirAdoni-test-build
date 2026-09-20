import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

const root = mkdtempSync(join(tmpdir(), "marinara-game-continuity-provider-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, personas } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { completeContinuityStage } = await import("../../packages/server/src/services/game/continuity-provider.js");

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(apiConnections).values([
    {
      id: "extractor",
      name: "Extractor",
      provider: "openai",
      model: "extract-model",
      baseUrl: "https://example.invalid/extract",
      apiKeyEncrypted: "dummy-extractor-secret",
      defaultParameters: JSON.stringify({ temperature: 0.1 }),
      maxContext: 8192,
      maxTokensOverride: 777,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "verifier",
      name: "Verifier",
      provider: "anthropic",
      model: "verify-model",
      baseUrl: "https://example.invalid/verify",
      apiKeyEncrypted: "dummy-verifier-secret",
      defaultParameters: JSON.stringify({ temperature: 0.2 }),
      maxContext: 16384,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "fallback",
      name: "Fallback",
      provider: "openai",
      model: "fallback-model",
      baseUrl: "https://example.invalid/fallback",
      apiKeyEncrypted: "dummy-fallback-secret",
      fallbackForAgents: "true",
      maxContext: 4096,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const metadata = {
    gameSetupConfig: { personaId: "setup-persona" },
    gameContinuity: {
      mode: "active",
      extractorConnectionId: "extractor",
      verifierConnectionId: "verifier",
      extractionInstructions: "extract only explicit commitments",
      verificationInstructions: "require exact evidence",
    },
  };
  await db.insert(personas).values([
    { id: "chat-persona", name: "Chat Player", description: "private card text", createdAt: now, updatedAt: now },
    {
      id: "setup-persona",
      name: "Setup Player",
      description: "other private card text",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(chats).values({
    id: "chat-1",
    name: "Continuity provider test",
    mode: "game",
    connectionId: "extractor",
    personaId: "chat-persona",
    metadata: JSON.stringify(metadata),
    createdAt: now,
    updatedAt: now,
  });

  await db
    .insert(chats)
    .values({ id: "off-chat", name: "Off", mode: "game", metadata: "{}", createdAt: now, updatedAt: now });
  const off = await readContinuityConfig(db, "off-chat");
  assert.equal(off.mode, "off");
  assert.deepEqual(off.frozen, {});

  const first = await readContinuityConfig(db, "chat-1");
  assert.equal(first.mode, "active");
  assert.equal(first.frozen.extractor?.connectionId, "extractor");
  assert.equal(first.frozen.extractor?.model, "extract-model");
  assert.equal(first.frozen.verifier?.connectionId, "verifier");
  assert.equal(first.frozen.verifier?.model, "verify-model");
  assert.notEqual(first.frozen.extractor?.parametersHash, first.frozen.verifier?.parametersHash);
  assert.deepEqual(first.frozen.playerCharacter, { id: "chat-persona", name: "Chat Player" });
  assert.equal(JSON.stringify(first.frozen).includes("private card text"), false);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("dummy-extractor-secret"), false);
  assert.equal(serialized.includes("dummy-verifier-secret"), false);
  assert.equal(serialized.includes("dummy-fallback-secret"), false);

  await db
    .update(chats)
    .set({ metadata: JSON.stringify({ ...metadata, gameContinuity: { ...metadata.gameContinuity, mode: "shadow" } }) })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(chats.id, "chat-1"));
  const shadow = await readContinuityConfig(db, "chat-1");
  assert.equal(shadow.mode, "shadow");
  assert.equal(shadow.hash, first.hash);
  await db
    .update(chats)
    .set({ metadata: JSON.stringify(metadata) })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(chats.id, "chat-1"));

  const changedInstruction = await readContinuityConfig(db, "chat-1");
  await db
    .update(chats)
    .set({
      metadata: JSON.stringify({
        ...metadata,
        gameContinuity: { ...metadata.gameContinuity, extractionInstructions: "changed" },
      }),
    })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(chats.id, "chat-1"));
  assert.notEqual((await readContinuityConfig(db, "chat-1")).hash, changedInstruction.hash);
  await db
    .update(chats)
    .set({ metadata: JSON.stringify(metadata) })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(chats.id, "chat-1"));

  const hashBaseline = await readContinuityConfig(db, "chat-1");
  await db.update(chats).set({ personaId: "setup-persona" }).where(eq(chats.id, "chat-1"));
  const setupFallback = await readContinuityConfig(db, "chat-1");
  assert.deepEqual(setupFallback.frozen.playerCharacter, { id: "setup-persona", name: "Setup Player" });
  assert.notEqual(setupFallback.hash, hashBaseline.hash);
  await db.update(chats).set({ personaId: "chat-persona" }).where(eq(chats.id, "chat-1"));
  assert.equal((await readContinuityConfig(db, "chat-1")).hash, hashBaseline.hash);
  for (const [field, value, restore] of [
    ["model", "extract-model-2", "extract-model"],
    ["defaultParameters", JSON.stringify({ temperature: 0.9 }), JSON.stringify({ temperature: 0.1 })],
    ["maxTokensOverride", 778, 777],
  ] as const) {
    await db
      .update(apiConnections)
      .set({ [field]: value })
      .where(eq(apiConnections.id, "extractor"));
    assert.notEqual(
      (await readContinuityConfig(db, "chat-1")).hash,
      hashBaseline.hash,
      `${field} must affect config hash`,
    );
    await db
      .update(apiConnections)
      .set({ [field]: restore })
      .where(eq(apiConnections.id, "extractor"));
    assert.equal(
      (await readContinuityConfig(db, "chat-1")).hash,
      hashBaseline.hash,
      `${field} restore must restore hash`,
    );
  }
  await db.update(apiConnections).set({ fallbackForAgents: "false" }).where(eq(apiConnections.id, "fallback"));
  assert.notEqual(
    (await readContinuityConfig(db, "chat-1")).hash,
    hashBaseline.hash,
    "fallback selection must affect config hash",
  );
  await db.update(apiConnections).set({ fallbackForAgents: "true" }).where(eq(apiConnections.id, "fallback"));
  assert.equal((await readContinuityConfig(db, "chat-1")).hash, hashBaseline.hash);

  const baseReceipt = {
    chatId: "chat-1",
    sessionNumber: 1,
    sourceHash: "source",
    sources: [],
    context: [],
    configHash: first.hash,
    config: first.frozen,
    status: "queued" as const,
    attempts: 0,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  } satisfies Omit<GameContinuityReceipt, "id">;
  const aborted = { ...baseReceipt, id: "aborted" } satisfies GameContinuityReceipt;
  const signal = new AbortController();
  signal.abort(new Error("stop before provider"));
  await assert.rejects(
    () => completeContinuityStage(db, aborted, "extract", "{}", signal.signal),
    (error: any) =>
      error.message === "CONTINUITY_ABORTED" &&
      error.code === "CONTINUITY_ABORTED" &&
      error.detail === "stop before provider" &&
      error.cause?.message === "stop before provider",
  );

  const unknown = {
    ...baseReceipt,
    id: "unknown",
    config: { ...first.frozen, extractor: { ...first.frozen.extractor!, connectionId: "missing" } },
  } satisfies GameContinuityReceipt;
  await assert.rejects(() => completeContinuityStage(db, unknown, "extract", "{}"), /CONTINUITY_CONFIG_CHANGED/u);
  const missing = {
    ...baseReceipt,
    id: "missing",
    config: { ...first.frozen, extractor: {} },
  } satisfies GameContinuityReceipt;
  await assert.rejects(
    () => completeContinuityStage(db, missing, "extract", "{}"),
    /CONTINUITY_PROVIDER_SNAPSHOT_MISSING/u,
  );
  const changed = {
    ...baseReceipt,
    id: "changed",
    config: { ...first.frozen, extractor: { ...first.frozen.extractor!, model: "changed-model" } },
  } satisfies GameContinuityReceipt;
  await assert.rejects(() => completeContinuityStage(db, changed, "extract", "{}"), /CONTINUITY_CONFIG_CHANGED/u);

  await db._fileStore.close();
  console.log("game continuity provider regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
