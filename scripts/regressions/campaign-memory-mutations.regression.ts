import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-mutations-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { resetFeatureSettingsForTests } =
    await import("../../packages/server/src/services/features/feature-settings.js");
  resetFeatureSettingsForTests({ campaignMemory: true });
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages, characters, campaignMemoryMutationJournal } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { applyCampaignMemoryMutation, compensateCampaignMemoryMutation, previewCampaignMemoryMutation } =
    await import("../../packages/server/src/services/game/campaign-memory-mutations.js");
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(chats).values({
    id: "mutation-chat",
    name: "Mutation test",
    mode: "game",
    characterIds: JSON.stringify(["char-1"]),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(characters).values({ id: "char-1", data: "{}", createdAt: now, updatedAt: now });
  await db.insert(messages).values({
    id: "mutation-message",
    chatId: "mutation-chat",
    role: "user",
    content: "Alice arrived at the tower and trusts it.",
  });
  const ownerReader = {
    async readChatScope(chatId: string) {
      return { chatId, characterIds: ["char-1"], spatialDefinition: { locations: [{ id: "tower" }] } } as never;
    },
    async readExistingOwner(owner: { store: string; recordId: string }) {
      return owner.store === "characters" && owner.recordId === "char-1"
        ? { store: owner.store, recordId: owner.recordId, kind: "character" as const }
        : null;
    },
  };
  const storage = createCampaignMemoryStorage(db, ownerReader);
  const provenance = { source: "regression", sourceRevision: "r1", actor: "user" as const };
  const baseInput = {
    chatId: "mutation-chat",
    kind: "character" as const,
    owner: { type: "existing" as const, store: "characters", recordId: "char-1" },
    aliases: ["Alice"],
    tags: [],
    attributes: {},
    status: "active" as const,
    manualLock: false,
    provenance,
  };
  resetFeatureSettingsForTests();
  await assert.rejects(
    () =>
      applyCampaignMemoryMutation(db, {
        chatId: "mutation-chat",
        operationId: "disabled",
        actor: "user",
        reason: "OFF proof",
        recordType: "entity",
        action: "create",
        input: baseInput,
      }),
    (error) => error?.code === "FEATURE_DISABLED",
  );
  resetFeatureSettingsForTests({ campaignMemory: true });
  await assert.rejects(
    () =>
      applyCampaignMemoryMutation(db, {
        chatId: "mutation-chat",
        operationId: "bad-action",
        actor: "user",
        reason: "bad",
        recordType: "entity",
        action: "replace",
        input: baseInput,
      } as never),
    (e) => e?.code === "CAMPAIGN_MEMORY_INVALID_VALUE",
  );
  await assert.rejects(
    () =>
      applyCampaignMemoryMutation(db, {
        chatId: "mutation-chat",
        operationId: "bad-input",
        actor: "user",
        reason: "bad",
        recordType: "entity",
        action: "create",
        input: null,
      } as never),
    (e) => e?.code === "CAMPAIGN_MEMORY_INVALID_VALUE",
  );
  await assert.rejects(
    () =>
      applyCampaignMemoryMutation(db, {
        chatId: "mutation-chat",
        operationId: "bad-top-level",
        actor: "user",
        reason: "bad",
        recordType: "entity",
        action: "create",
        input: baseInput,
        extra: true,
      } as never),
    (e) => e?.code === "CAMPAIGN_MEMORY_INVALID_VALUE",
  );

  let failedInsertCount = 0;
  const failedDb = new Proxy(db, {
    get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return (fn: (tx: typeof db) => Promise<unknown>, options?: { durable?: boolean }) =>
        target.transaction(
          (tx) =>
            fn(
              new Proxy(tx, {
                get(inner, innerKey, innerReceiver) {
                  if (innerKey !== "insert") return Reflect.get(inner, innerKey, innerReceiver);
                  return (table: any) => {
                    const builder = (inner as any).insert(table);
                    return {
                      values: (values: unknown) => {
                        failedInsertCount += 1;
                        if (failedInsertCount === 2) return Promise.reject(new Error("injected journal failure"));
                        return builder.values(values);
                      },
                    };
                  };
                },
              }) as typeof db,
            ),
          options,
        );
    },
  }) as typeof db;
  await assert.rejects(
    () =>
      applyCampaignMemoryMutation(failedDb, {
        chatId: "mutation-chat",
        operationId: "failed-op",
        actor: "user",
        reason: "failure proof",
        recordType: "entity",
        action: "create",
        input: { ...baseInput, entityId: "failed-entity" },
      }),
    /injected journal failure/u,
  );
  assert.equal(await storage.getEntity({ chatId: "mutation-chat" }, "failed-entity"), null);

  const created = await applyCampaignMemoryMutation(db, {
    chatId: "mutation-chat",
    operationId: "create-1",
    actor: "user",
    reason: "register Alice",
    recordType: "entity",
    action: "create",
    input: { ...baseInput, entityId: "alice" },
  });
  const replay = await applyCampaignMemoryMutation(db, {
    chatId: "mutation-chat",
    operationId: "create-1",
    actor: "user",
    reason: "register Alice",
    recordType: "entity",
    action: "create",
    input: { ...baseInput, entityId: "alice" },
  });
  assert.deepEqual(replay, created);
  await assert.rejects(
    () =>
      applyCampaignMemoryMutation(db, {
        chatId: "mutation-chat",
        operationId: "create-1",
        actor: "user",
        reason: "different",
        recordType: "entity",
        action: "create",
        input: { ...baseInput, entityId: "alice" },
      }),
    (e) => e?.code === "CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT",
  );

  const fact = await applyCampaignMemoryMutation(db, {
    chatId: "mutation-chat",
    operationId: "fact-1",
    actor: "user",
    reason: "record trust",
    recordType: "fact",
    action: "create",
    input: {
      chatId: "mutation-chat",
      subjectEntityId: "alice",
      predicate: "trusts",
      value: "tower",
      conditions: [],
      status: "verified",
      sourceRevision: "r1",
      evidence: [{ messageId: "mutation-message", quote: "trusts it" }],
      author: "user",
      provenance,
      manualLock: false,
    },
  });
  const concurrent = await Promise.allSettled([
    applyCampaignMemoryMutation(db, {
      chatId: "mutation-chat",
      operationId: "cas-a",
      actor: "user",
      reason: "accept A",
      evidence: [{ messageId: "mutation-message", quote: "Alice arrived" }],
      recordType: "fact",
      action: "update",
      recordId: fact.factId,
      expectedRevision: 1,
      patch: { status: "held" },
    }),
    applyCampaignMemoryMutation(db, {
      chatId: "mutation-chat",
      operationId: "cas-b",
      actor: "user",
      reason: "accept B",
      evidence: [{ messageId: "mutation-message", quote: "Alice arrived" }],
      recordType: "fact",
      action: "update",
      recordId: fact.factId,
      expectedRevision: 1,
      patch: { status: "retracted" },
    }),
  ]);
  assert.equal(concurrent.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((x) => x.status === "rejected").length, 1);

  const current = await storage.getFact({ chatId: "mutation-chat" }, fact.factId);
  assert.ok(current);
  const changed = await applyCampaignMemoryMutation(db, {
    chatId: "mutation-chat",
    operationId: "later-update",
    actor: "user",
    reason: "change predicate",
    recordType: "fact",
    action: "update",
    recordId: fact.factId,
    expectedRevision: current.revision,
    patch: { predicate: "relies-on" },
  });
  assert.deepEqual(
    await applyCampaignMemoryMutation(db, {
      chatId: "mutation-chat",
      operationId: "cas-a",
      actor: "user",
      reason: "accept A",
      evidence: [{ messageId: "mutation-message", quote: "Alice arrived" }],
      recordType: "fact",
      action: "update",
      recordId: fact.factId,
      expectedRevision: 1,
      patch: { status: "held" },
    }),
    concurrent.find((x) => x.status === "fulfilled")!.value,
  );
  const originalUpdate = await storage.listMutationJournal({ chatId: "mutation-chat" });
  const originalOperation = originalUpdate.find((row) => row.operationId === "cas-a" || row.operationId === "cas-b");
  assert.ok(originalOperation);
  await assert.rejects(
    () =>
      compensateCampaignMemoryMutation(db, {
        chatId: "mutation-chat",
        operationId: "comp-forged",
        originalOperationId: originalOperation.operationId,
        actor: "user",
        reason: "forged evidence",
        evidence: [{ messageId: "mutation-message", quote: "forged quote" }],
      }),
    (e) => e?.code === "CAMPAIGN_MEMORY_INVALID_REFERENCE",
  );
  await assert.rejects(
    () =>
      compensateCampaignMemoryMutation(db, {
        chatId: "mutation-chat",
        operationId: "comp-stale",
        originalOperationId: originalOperation.operationId,
        actor: "user",
        reason: "stale undo",
      }),
    (e) => e?.code === "CAMPAIGN_MEMORY_CAS_MISMATCH",
  );
  const undoable = await applyCampaignMemoryMutation(db, {
    chatId: "mutation-chat",
    operationId: "undoable",
    actor: "user",
    reason: "rename Alice",
    evidence: [{ messageId: "mutation-message", quote: "Alice arrived" }],
    recordType: "entity",
    action: "update",
    recordId: "alice",
    expectedRevision: 1,
    patch: { aliases: ["Alice II"] },
  });
  const compensated = await (async () => {
    const RealDate = Date;
    let clock = Date.now() + 1000;
    globalThis.Date = class extends RealDate {
      constructor(value?: string | number) {
        super(value ?? (clock += 10));
      }
      static now() {
        return clock;
      }
    } as DateConstructor;
    try {
      return await compensateCampaignMemoryMutation(db, {
        chatId: "mutation-chat",
        operationId: "comp-1",
        originalOperationId: "undoable",
        actor: "user",
        reason: "undo rename",
        evidence: [{ messageId: "mutation-message", quote: "Alice arrived" }],
      });
    } finally {
      globalThis.Date = RealDate;
    }
  })();
  const compensationJournal = (await storage.listMutationJournal({ chatId: "mutation-chat" })).find(
    (row) => row.operationId === "comp-1",
  );
  assert.ok(compensationJournal);
  assert.equal(
    compensationJournal.createdAt,
    "updatedAt" in compensated ? compensated.updatedAt : undefined,
    "compensation journal timestamp matches the persisted snapshot used by branch validation",
  );
  await db
    .update(messages)
    .set({ content: "The source was edited after the commit." })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(messages.id, "mutation-message"));
  assert.deepEqual(
    await compensateCampaignMemoryMutation(db, {
      chatId: "mutation-chat",
      operationId: "comp-1",
      originalOperationId: "undoable",
      actor: "user",
      reason: "undo rename",
      evidence: [{ messageId: "mutation-message", quote: "Alice arrived" }],
    }),
    compensated,
  );
  assert.deepEqual(
    await applyCampaignMemoryMutation(db, {
      chatId: "mutation-chat",
      operationId: "undoable",
      actor: "user",
      reason: "rename Alice",
      evidence: [{ messageId: "mutation-message", quote: "Alice arrived" }],
      recordType: "entity",
      action: "update",
      recordId: "alice",
      expectedRevision: 1,
      patch: { aliases: ["Alice II"] },
    }),
    undoable,
  );
  await db
    .update(messages)
    .set({ content: "Alice arrived at the tower and trusts it." })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(messages.id, "mutation-message"));
  await applyCampaignMemoryMutation(db, {
    chatId: "mutation-chat",
    operationId: "lock-fact",
    actor: "user",
    reason: "lock",
    recordType: "fact",
    action: "update",
    recordId: fact.factId,
    expectedRevision: changed.revision,
    patch: { manualLock: true, value: { label: "tower", pinned: true, lockedBeforePin: true } },
  });
  await assert.rejects(
    () =>
      applyCampaignMemoryMutation(db, {
        chatId: "mutation-chat",
        operationId: "locked-system",
        actor: "system",
        reason: "automatic",
        recordType: "fact",
        action: "update",
        recordId: fact.factId,
        expectedRevision: changed.revision + 1,
        patch: { predicate: "blocked" },
      }),
    (e) => e?.code === "CAMPAIGN_MEMORY_LOCKED",
  );
  const userUnlocked = await applyCampaignMemoryMutation(db, {
    chatId: "mutation-chat",
    operationId: "user-unlock-fact",
    actor: "user",
    reason: "unlock without rewriting authored value",
    recordType: "fact",
    action: "update",
    recordId: fact.factId,
    expectedRevision: changed.revision + 1,
    patch: { manualLock: false },
  });
  assert.equal(userUnlocked.manualLock, false);
  assert.deepEqual(userUnlocked.value, { label: "tower", pinned: true, lockedBeforePin: true });
  assert.deepEqual(await storage.getFact({ chatId: "mutation-chat" }, fact.factId), userUnlocked);
  const authoredMetadataFact = await applyCampaignMemoryMutation(db, {
    chatId: "mutation-chat",
    operationId: "authored-metadata-fact",
    actor: "user",
    reason: "preserve non-boolean authored metadata",
    recordType: "fact",
    action: "create",
    input: {
      chatId: "mutation-chat",
      subjectEntityId: "alice",
      predicate: "remembers",
      value: { lockedBeforePin: "authored metadata", note: "keep verbatim" },
      conditions: [],
      status: "verified",
      sourceRevision: "r1",
      evidence: [],
      author: "user",
      manualLock: true,
      provenance,
    },
  });
  const metadataUnlocked = await applyCampaignMemoryMutation(db, {
    chatId: "mutation-chat",
    operationId: "unlock-authored-metadata-fact",
    actor: "user",
    reason: "unlock without rewriting authored value",
    recordType: "fact",
    action: "update",
    recordId: authoredMetadataFact.factId,
    expectedRevision: authoredMetadataFact.revision,
    patch: { manualLock: false },
  });
  assert.equal(metadataUnlocked.manualLock, false);
  assert.deepEqual(metadataUnlocked.value, { lockedBeforePin: "authored metadata", note: "keep verbatim" });
  const preview = await previewCampaignMemoryMutation(db, {
    chatId: "mutation-chat",
    operationId: "preview",
    actor: "user",
    reason: "preview",
    recordType: "entity",
    action: "create",
    input: { ...baseInput, entityId: "preview-only" },
  });
  assert.equal(preview.validated, true);
  assert.equal(await storage.getEntity({ chatId: "mutation-chat" }, "preview-only"), null);
  const journals = await db
    .select()
    .from(campaignMemoryMutationJournal)
    .where(
      (await import("../../packages/server/src/db/file-query.js")).eq(
        campaignMemoryMutationJournal.chatId,
        "mutation-chat",
      ),
    );
  assert.ok(journals.length >= 5);
  assert.equal(journals.filter((row) => row.operationId === "failed-op").length, 0);
  await db._fileStore.close();
  console.log("campaign memory mutations regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
