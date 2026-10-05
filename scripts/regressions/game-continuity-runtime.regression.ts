import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-continuity-runtime-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages, lorebooks, lorebookEntries, characters } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true, campaignMemory: true, campaignIndex: true }));
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const db = await createFileNativeDB();
  const now = new Date("2026-09-12T00:00:00.000Z").toISOString();
  const later = new Date("2026-09-12T00:00:01.000Z").toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Runtime test", provider: "custom", model: "test-model" });
  await db.insert(lorebooks).values({ id: "book", name: "Runtime book", createdAt: now, updatedAt: now });
  const chatsStorage = createChatsStorage(db);
  const addChat = async (
    id: string,
    mode: "active" | "shadow" | "off",
    assistantExtra: Record<string, unknown> | null = null,
  ) => {
    await db.insert(chats).values({
      id,
      name: id,
      mode: "game",
      connectionId: "conn",
      metadata: JSON.stringify({
        gameContinuity: { mode, extractionInstructions: "extract", verificationInstructions: "verify" },
      }),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(messages).values([
      { id: `${id}-u`, chatId: id, role: "user", content: "I promise to return.", createdAt: now },
      {
        id: `${id}-a`,
        chatId: id,
        role: "assistant",
        content: "Acknowledged.",
        extra: assistantExtra ? JSON.stringify(assistantExtra) : null,
        createdAt: later,
      },
    ]);
    return `${id}-a`;
  };
  const activeAssistant = await addChat("active", "active");
  await db.insert(characters).values({
    id: "runtime-holder-card",
    data: JSON.stringify({ name: "Runtime Holder" }),
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(chats)
    .set({ characterIds: JSON.stringify(["runtime-holder-card"]) })
    .where(eq(chats.id, "active"));
  await createCampaignMemoryStorage(db).createEntity({
    entityId: "runtime-holder-entity",
    chatId: "active",
    kind: "character",
    owner: { type: "existing", store: "characters", recordId: "runtime-holder-card" },
    aliases: ["Runtime Holder"],
    tags: [],
    attributes: {},
    status: "active",
    manualLock: false,
    provenance: { source: "test", sourceRevision: "runtime", actor: "user" },
  });
  const shadowAssistant = await addChat("shadow", "shadow");
  const offAssistant = await addChat("off", "off");
  const restartAssistant = await addChat("restart", "active");
  const recoveryAssistant = await addChat("recovery", "shadow");
  const callbackFailureAssistant = await addChat("callback-failure", "active");
  const excludedAssistant = await addChat("excluded", "active", { hiddenFromAI: true });
  let calls = 0;
  const publishedIds: string[] = [];
  const extractionPrompts: string[] = [];
  const reviewPrompts: string[] = [];
  let blockReview = false;
  let releaseReview!: () => void;
  let reviewGate = Promise.resolve();
  const complete = async ({
    stage,
    receipt,
    prompt,
  }: {
    stage: "extract" | "review" | "repair";
    receipt: any;
    prompt: string;
  }) => {
    calls += 1;
    if (stage === "extract") extractionPrompts.push(prompt);
    if (stage === "review") reviewPrompts.push(prompt);
    if (stage === "review" && blockReview) await reviewGate;
    if (stage === "extract") {
      const source =
        receipt.sources.find((item: any) => item.content.includes("I promise to return.")) ??
        receipt.sources.find((item: any) => item.role.startsWith("user")) ??
        receipt.sources[0];
      const quote = source.content.slice(0, Math.min(80, source.content.length));
      return {
        records: [
          {
            id: "model-id",
            kind: "promise",
            text: "Return promise",
            subjects: ["player"],
            conditions: [],
            status: "proposed",
            evidence: [{ messageId: source.messageId, quote }],
            keys: ["return"],
          },
        ],
        dispositions: receipt.sources.map((item: any) => ({
          messageId: item.messageId,
          status: item.role.startsWith("user") ? "covered" : "no_durable_facts",
          reason: "source",
        })),
      };
    }
    return {
      findings: [],
      dispositions: receipt.sources.map((source: any) => ({
        messageId: source.messageId,
        status: source.role.startsWith("assistant") ? "no_durable_facts" : "covered",
        reason: "review",
      })),
    };
  };
  const runtime = createGameContinuityRuntime(db, {
    complete,
    maxDrainMs: 3000,
    onPublished: async (receipt: any) => {
      publishedIds.push(receipt.chatId);
      if (receipt.chatId === "callback-failure") throw new Error("derived summary failed");
    },
  });
  const waitUntil = async (predicate: () => Promise<boolean>, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("timed out waiting for runtime state");
  };
  await runtime.enqueueCommittedTurn({ chatId: "active", assistantMessageId: activeAssistant, sessionNumber: 1 });
  await runtime.enqueueCommittedTurn({ chatId: "shadow", assistantMessageId: shadowAssistant, sessionNumber: 1 });
  assert.equal(
    await runtime.enqueueCommittedTurn({ chatId: "excluded", assistantMessageId: excludedAssistant, sessionNumber: 1 }),
    null,
    "an accepted assistant excluded from continuity sources is a no-op",
  );
  assert.deepEqual(await runtime.reconcileChat("excluded"), [], "reconcile also skips excluded accepted assistants");
  await assert.rejects(
    () =>
      runtime.enqueueCommittedTurn({ chatId: "excluded", assistantMessageId: "missing-assistant", sessionNumber: 1 }),
    /CONTINUITY_ASSISTANT_NOT_FOUND/,
  );
  await runtime.enqueueCommittedTurn({ chatId: "recovery", assistantMessageId: recoveryAssistant, sessionNumber: 1 });
  await runtime.enqueueCommittedTurn({
    chatId: "callback-failure",
    assistantMessageId: callbackFailureAssistant,
    sessionNumber: 1,
  });
  assert.equal(
    await runtime.enqueueCommittedTurn({ chatId: "off", assistantMessageId: offAssistant, sessionNumber: 1 }),
    null,
  );
  await waitUntil(async () => (await runtime.list("active"))[0]?.status === "published");
  await waitUntil(async () => (await runtime.list("shadow"))[0]?.status === "verified");
  await waitUntil(async () => (await runtime.list("recovery"))[0]?.status === "verified");
  await waitUntil(async () => (await runtime.list("callback-failure"))[0]?.status === "published");
  await waitUntil(async () => publishedIds.includes("callback-failure"));
  assert.ok(publishedIds.includes("active"), "normal publication should notify");
  assert.ok(publishedIds.includes("callback-failure"), "callback failure still follows publication");
  assert.equal(publishedIds.filter((chatId) => chatId === "active").length, 1);
  assert.equal(publishedIds.filter((chatId) => chatId === "callback-failure").length, 1);
  assert.ok(!publishedIds.includes("shadow"), "shadow verification should not notify");
  assert.ok(extractionPrompts.some((prompt) => prompt.includes("runtime-holder-entity")));
  assert.ok(reviewPrompts.some((prompt) => prompt.includes("runtime-holder-entity")));
  blockReview = true;
  reviewGate = new Promise<void>((resolve) => {
    releaseReview = resolve;
  });
  await runtime.enqueueCommittedTurn({ chatId: "restart", assistantMessageId: restartAssistant, sessionNumber: 1 });
  await waitUntil(async () => (await runtime.list("restart"))[0]?.status === "reviewing");
  await runtime.stop();
  releaseReview();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const activeReceipts = await runtime.list("active");
  const shadowReceipts = await runtime.list("shadow");
  assert.equal(activeReceipts[0]?.status, "published");
  assert.equal(shadowReceipts[0]?.status, "verified");
  assert.ok(calls >= 4);
  assert.equal((await db.select().from(messages).where(eq(messages.chatId, "active"))).length, 2);

  await db
    .update(chats)
    .set({
      metadata: JSON.stringify({
        gameContinuity: { mode: "active", extractionInstructions: "extract", verificationInstructions: "verify" },
      }),
    })
    .where(eq(chats.id, "recovery"));
  const recoveryPublished: string[] = [];
  const recoveryRuntime = createGameContinuityRuntime(db, {
    complete,
    maxDrainMs: 3000,
    onPublished: (receipt: any) => recoveryPublished.push(receipt.chatId),
  });
  await recoveryRuntime.start();
  await waitUntil(async () => (await recoveryRuntime.list("recovery"))[0]?.status === "published");
  assert.deepEqual(recoveryPublished, ["recovery"], "startup recovery publication should notify once");
  await recoveryRuntime.stop();

  const shadowReceipt = shadowReceipts[0]!;
  await db
    .update(chats)
    .set({
      metadata: JSON.stringify({
        gameContinuity: { mode: "active", extractionInstructions: "extract", verificationInstructions: "verify" },
      }),
    })
    .where(eq(chats.id, "shadow"));
  const collisionId = `gce_${createHash("sha256").update(JSON.stringify(shadowReceipt.id)).digest("hex").slice(0, 32)}`;
  await db.insert(lorebookEntries).values({
    id: collisionId,
    lorebookId: "book",
    name: "collision",
    content: "collision",
    keys: "[]",
    dynamicState: JSON.stringify({ receiptId: "other-receipt" }),
    createdAt: now,
    updatedAt: now,
  });
  const failedPublicationRuntime = createGameContinuityRuntime(db, { maxDrainMs: 3000, complete });
  await failedPublicationRuntime.start();
  const failedPublication = (await failedPublicationRuntime.list("shadow"))[0]!;
  assert.equal(failedPublication.status, "failed");
  assert.equal(failedPublication.errorCode, "CONTINUITY_ENTRY_ID_COLLISION");
  assert.ok(failedPublication.records.length > 0);
  await failedPublicationRuntime.stop();

  let resumedStages: string[] = [];
  const resumed = createGameContinuityRuntime(db, {
    complete: async ({ stage, receipt }: { stage: "extract" | "review" | "repair"; receipt: any }) => {
      resumedStages.push(stage);
      return {
        findings: [],
        dispositions: receipt.sources.map((source: any) => ({
          messageId: source.messageId,
          status: source.role.startsWith("assistant") ? "no_durable_facts" : "covered",
          reason: "resume",
        })),
      };
    },
    maxDrainMs: 3000,
  });
  await resumed.start();
  await waitUntil(async () => (await resumed.list("restart"))[0]?.status === "published");
  assert.deepEqual(resumedStages, ["review"]);
  await resumed.stop();

  const queuedAssistant = await addChat("queued", "active");
  const heldTwoAssistant = await addChat("held-two", "active");
  const heldThreeAssistant = await addChat("held-three", "active");
  let activeCalls = 0;
  let maxActiveCalls = 0;
  const activeByChat = new Map<string, number>();
  let releaseHeld!: () => void;
  const heldGate = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const heldRuntime = createGameContinuityRuntime(db, {
    maxDrainMs: 100,
    complete: async ({ stage, receipt }: { stage: "extract" | "review" | "repair"; receipt: any }) => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      activeByChat.set(receipt.chatId, (activeByChat.get(receipt.chatId) ?? 0) + 1);
      try {
        await heldGate;
        if (stage === "extract") {
          const source = receipt.sources.find((item: any) => item.role.startsWith("user")) ?? receipt.sources[0];
          return {
            records: [
              {
                id: "held",
                kind: "fact",
                text: "held fact",
                subjects: ["player"],
                conditions: [],
                status: "proposed",
                evidence: [{ messageId: source.messageId, quote: source.content.slice(0, 20) }],
                keys: ["held"],
              },
            ],
            dispositions: receipt.sources.map((item: any) => ({
              messageId: item.messageId,
              status: item.role.startsWith("assistant") ? "no_durable_facts" : "covered",
              reason: "held",
            })),
          };
        }
        return {
          findings: [],
          dispositions: receipt.sources.map((source: any) => ({
            messageId: source.messageId,
            status: source.role.startsWith("assistant") ? "no_durable_facts" : "covered",
            reason: "held",
          })),
        };
      } finally {
        activeCalls -= 1;
        activeByChat.set(receipt.chatId, (activeByChat.get(receipt.chatId) ?? 1) - 1);
      }
    },
  });
  await heldRuntime.enqueueCommittedTurn({ chatId: "queued", assistantMessageId: queuedAssistant, sessionNumber: 1 });
  await heldRuntime.enqueueCommittedTurn({
    chatId: "held-two",
    assistantMessageId: heldTwoAssistant,
    sessionNumber: 1,
  });
  await heldRuntime.enqueueCommittedTurn({
    chatId: "held-three",
    assistantMessageId: heldThreeAssistant,
    sessionNumber: 1,
  });
  await waitUntil(async () => maxActiveCalls === 2);
  assert.equal(maxActiveCalls, 2);
  assert.ok([...activeByChat.values()].every((count) => count <= 1));
  assert.ok((await heldRuntime.list("held-three"))[0]?.status === "queued");
  const heldBeforeStop = await heldRuntime.list();
  await heldRuntime.stop();
  releaseHeld();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    (await heldRuntime.list()).map((receipt) => [receipt.id, receipt.status, receipt.updatedAt]),
    heldBeforeStop.map((receipt) => [receipt.id, receipt.status, receipt.updatedAt]),
  );
  assert.equal((await heldRuntime.list("held-two"))[0]?.attempts, 1);

  const shadowOverlapAssistant = await addChat("shadow-overlap", "shadow");
  await db.insert(messages).values([
    {
      id: "shadow-overlap-u2",
      chatId: "shadow-overlap",
      role: "user",
      content: "I promise to return again.",
      createdAt: new Date("2026-09-12T00:00:04.000Z").toISOString(),
    },
    {
      id: "shadow-overlap-a2",
      chatId: "shadow-overlap",
      role: "assistant",
      content: "Acknowledged again.",
      createdAt: new Date("2026-09-12T00:00:05.000Z").toISOString(),
    },
  ]);
  let shadowOverlapActive = 0;
  let shadowOverlapMax = 0;
  const shadowPublished: string[] = [];
  let releaseShadowOverlap!: () => void;
  const shadowOverlapGate = new Promise<void>((resolve) => {
    releaseShadowOverlap = resolve;
  });
  const shadowOverlapRuntime = createGameContinuityRuntime(db, {
    maxDrainMs: 100,
    onPublished: (receipt: any) => shadowPublished.push(receipt.id),
    complete: async (args: any) => {
      shadowOverlapActive += 1;
      shadowOverlapMax = Math.max(shadowOverlapMax, shadowOverlapActive);
      try {
        await shadowOverlapGate;
        return complete(args);
      } finally {
        shadowOverlapActive -= 1;
      }
    },
  });
  await shadowOverlapRuntime.enqueueCommittedTurn({
    chatId: "shadow-overlap",
    assistantMessageId: shadowOverlapAssistant,
    sessionNumber: 1,
  });
  await shadowOverlapRuntime.enqueueCommittedTurn({
    chatId: "shadow-overlap",
    assistantMessageId: "shadow-overlap-a2",
    sessionNumber: 1,
  });
  await waitUntil(async () => shadowOverlapMax === 2);
  assert.equal(shadowOverlapMax, 2);
  await db
    .update(chats)
    .set({
      metadata: JSON.stringify({
        gameContinuity: { mode: "active", extractionInstructions: "extract", verificationInstructions: "verify" },
      }),
    })
    .where(eq(chats.id, "shadow-overlap"));
  releaseShadowOverlap();
  await waitUntil(async () =>
    (await shadowOverlapRuntime.list("shadow-overlap")).every((receipt) => receipt.status === "verified"),
  );
  assert.deepEqual(shadowPublished, [], "shadow-admitted work must not publish after promotion");
  await shadowOverlapRuntime.resumeChat("shadow-overlap");
  await waitUntil(async () =>
    (await shadowOverlapRuntime.list("shadow-overlap")).every((receipt) => receipt.status === "published"),
  );
  assert.equal(shadowPublished.length, 2, "promoted receipts publish during serialized resume");
  await shadowOverlapRuntime.stop();

  const activeOverlapAssistant = await addChat("active-overlap", "active");
  await db.insert(messages).values([
    {
      id: "active-overlap-u2",
      chatId: "active-overlap",
      role: "user",
      content: "I promise to return again.",
      createdAt: new Date("2026-09-12T00:00:06.000Z").toISOString(),
    },
    {
      id: "active-overlap-a2",
      chatId: "active-overlap",
      role: "assistant",
      content: "Acknowledged again.",
      createdAt: new Date("2026-09-12T00:00:07.000Z").toISOString(),
    },
  ]);
  let activeOverlapActive = 0;
  let activeOverlapMax = 0;
  let releaseActiveOverlap!: () => void;
  const activeOverlapGate = new Promise<void>((resolve) => {
    releaseActiveOverlap = resolve;
  });
  const activeOverlapRuntime = createGameContinuityRuntime(db, {
    maxDrainMs: 100,
    complete: async (args: any) => {
      activeOverlapActive += 1;
      activeOverlapMax = Math.max(activeOverlapMax, activeOverlapActive);
      try {
        await activeOverlapGate;
        return complete(args);
      } finally {
        activeOverlapActive -= 1;
      }
    },
  });
  await activeOverlapRuntime.enqueueCommittedTurn({
    chatId: "active-overlap",
    assistantMessageId: activeOverlapAssistant,
    sessionNumber: 1,
  });
  await activeOverlapRuntime.enqueueCommittedTurn({
    chatId: "active-overlap",
    assistantMessageId: "active-overlap-a2",
    sessionNumber: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(activeOverlapMax, 1);
  releaseActiveOverlap();
  await waitUntil(async () =>
    (await activeOverlapRuntime.list("active-overlap")).every((receipt) => receipt.status === "published"),
  );
  await activeOverlapRuntime.stop();

  const cleanResumeRuntime = createGameContinuityRuntime(db, { complete, maxDrainMs: 3000 });
  await cleanResumeRuntime.start();
  // Startup publishes a verified receipt once it is re-read, so the resumed batch may already be past "verified".
  await waitUntil(async () =>
    ["verified", "published"].includes((await cleanResumeRuntime.list("held-two"))[0]?.status ?? ""),
  );
  assert.equal((await cleanResumeRuntime.list("held-two"))[0]?.attempts, 1);
  await cleanResumeRuntime.stop();

  await db.insert(chats).values({
    id: "reconcile",
    name: "reconcile",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify({
      gameContinuity: {
        mode: "shadow",
        activationAt: later,
        extractionInstructions: "extract",
        verificationInstructions: "verify",
      },
    }),
    createdAt: now,
    updatedAt: later,
  });
  await db.insert(messages).values([
    { id: "reconcile-before", chatId: "reconcile", role: "assistant", content: "old", createdAt: now },
    { id: "reconcile-user", chatId: "reconcile", role: "user", content: "continue", createdAt: later },
    {
      id: "reconcile-accepted",
      chatId: "reconcile",
      role: "assistant",
      content: "accepted",
      createdAt: new Date("2026-09-12T00:00:02.000Z").toISOString(),
    },
    {
      id: "reconcile-followup",
      chatId: "reconcile",
      role: "user",
      content: "acknowledged",
      createdAt: new Date("2026-09-12T00:00:02.500Z").toISOString(),
    },
    {
      id: "reconcile-trailing",
      chatId: "reconcile",
      role: "assistant",
      content: "unaccepted",
      createdAt: new Date("2026-09-12T00:00:03.000Z").toISOString(),
    },
  ]);
  const restarted = createGameContinuityRuntime(db, { complete, maxDrainMs: 3000 });
  await restarted.reconcileChat("reconcile");
  await waitUntil(async () => (await restarted.list("reconcile")).some((receipt) => receipt.status === "verified"));
  const reconciled = await restarted.list("reconcile");
  assert.equal(reconciled.length, 1);
  assert.ok(reconciled[0]?.sources.some((source) => source.messageId === "reconcile-accepted"));
  assert.ok(!reconciled[0]?.sources.some((source) => source.messageId === "reconcile-trailing"));
  await restarted.stop();

  const protocolAssistant = await addChat("protocol-retry", "shadow");
  let protocolExtractCalls = 0;
  const protocolRuntime = createGameContinuityRuntime(db, {
    maxDrainMs: 3000,
    complete: async ({ stage, receipt }: { stage: "extract" | "review" | "repair"; receipt: any }) => {
      if (stage === "extract") {
        protocolExtractCalls += 1;
        if (protocolExtractCalls === 1) throw new Error("simulated transient provider failure");
        if (protocolExtractCalls === 2)
          return {
            records: [
              {
                id: "model-id",
                kind: "belief",
                text: "invalid kind",
                subjects: [],
                conditions: [],
                status: "proposed",
                evidence: [{ messageId: receipt.sources[0].messageId, quote: receipt.sources[0].content.slice(0, 10) }],
                keys: [],
              },
            ],
            dispositions: receipt.sources.map((source: any) => ({
              messageId: source.messageId,
              status: "no_durable_facts",
              reason: "invalid retry",
            })),
          };
        return {
          records: [],
          dispositions: receipt.sources.map((source: any) => ({
            messageId: source.messageId,
            status: "no_durable_facts",
            reason: "no durable fact",
          })),
        };
      }
      return {
        findings: [],
        dispositions: receipt.sources.map((source: any) => ({
          messageId: source.messageId,
          status: "no_durable_facts",
          reason: "clean",
        })),
      };
    },
  });
  await protocolRuntime.enqueueCommittedTurn({
    chatId: "protocol-retry",
    assistantMessageId: protocolAssistant,
    sessionNumber: 1,
  });
  await waitUntil(async () => (await protocolRuntime.list("protocol-retry"))[0]?.status === "verified");
  assert.equal(protocolExtractCalls, 3);
  const recoveredReceipt = (await protocolRuntime.list("protocol-retry"))[0]!;
  assert.equal(recoveredReceipt.attempts, 2);
  assert.equal(recoveredReceipt.errorCode, undefined, "successful retry must not show the previous execution error");
  assert.equal(recoveredReceipt.error, undefined);
  await protocolRuntime.stop();

  const repairAssistant = await addChat("repair-retry", "shadow");
  let repairCalls = 0;
  let reviewCalls = 0;
  const repairRuntime = createGameContinuityRuntime(db, {
    maxDrainMs: 3000,
    complete: async ({ stage, receipt }: { stage: "extract" | "review" | "repair"; receipt: any }) => {
      const source = receipt.sources[0];
      if (stage === "extract")
        return {
          records: [
            {
              id: "model-id",
              kind: "promise",
              text: "return promise",
              subjects: ["player"],
              conditions: [],
              status: "proposed",
              evidence: [{ messageId: source.messageId, quote: source.content.slice(0, 10) }],
              keys: ["promise"],
            },
          ],
          dispositions: receipt.sources.map((item: any) => ({
            messageId: item.messageId,
            status: item.role.startsWith("user") ? "covered" : "no_durable_facts",
            reason: "promise",
          })),
        };
      if (stage === "review") {
        reviewCalls += 1;
        return reviewCalls === 1
          ? {
              findings: [
                {
                  kind: "condition",
                  messageId: source.messageId,
                  quote: source.content.slice(0, 10),
                  recordIds: ["r1"],
                  detail: "repair",
                },
              ],
              dispositions: receipt.sources.map((item: any) => ({
                messageId: item.messageId,
                status: item.role.startsWith("user") ? "covered" : "no_durable_facts",
                reason: "repair",
              })),
            }
          : {
              findings: [],
              dispositions: receipt.sources.map((item: any) => ({
                messageId: item.messageId,
                status: item.role.startsWith("user") ? "covered" : "no_durable_facts",
                reason: "clean",
              })),
            };
      }
      repairCalls += 1;
      if (repairCalls === 1)
        return {
          replace: [
            {
              recordRef: "r1",
              records: [
                {
                  id: "model-id",
                  kind: "belief",
                  text: "invalid",
                  subjects: [],
                  conditions: [],
                  status: "proposed",
                  evidence: [{ messageId: source.messageId, quote: source.content.slice(0, 10) }],
                  keys: [],
                },
              ],
            },
          ],
          add: [],
          dispositions: receipt.sources.map((item: any) => ({
            messageId: item.messageId,
            status: item.role.startsWith("user") ? "covered" : "no_durable_facts",
            reason: "invalid",
          })),
        };
      return {
        replace: [
          {
            recordRef: "r1",
            records: [
              {
                id: "model-id",
                kind: "promise",
                text: "return promise",
                subjects: ["player"],
                conditions: [],
                status: "proposed",
                evidence: [{ messageId: source.messageId, quote: source.content.slice(0, 10) }],
                keys: ["promise"],
              },
            ],
          },
        ],
        add: [],
        dispositions: receipt.sources.map((item: any) => ({
          messageId: item.messageId,
          status: item.role.startsWith("user") ? "covered" : "no_durable_facts",
          reason: "repaired",
        })),
      };
    },
  });
  await repairRuntime.enqueueCommittedTurn({
    chatId: "repair-retry",
    assistantMessageId: repairAssistant,
    sessionNumber: 1,
  });
  await waitUntil(async () => (await repairRuntime.list("repair-retry"))[0]?.status === "verified");
  assert.equal(repairCalls, 2);
  await repairRuntime.stop();

  let drainStarted = false;
  let releaseDrain!: () => void;
  const drainGate = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });
  const drainRuntime = createGameContinuityRuntime(db, {
    maxDrainMs: 1000,
    complete: async (args: any) => {
      if (args.stage === "extract") {
        drainStarted = true;
        await drainGate;
      }
      return complete(args);
    },
  });
  const drainAssistant = await addChat("drain", "active");
  await drainRuntime.enqueueCommittedTurn({ chatId: "drain", assistantMessageId: drainAssistant, sessionNumber: 1 });
  await waitUntil(async () => drainStarted);
  const timeoutResourcesBeforeActiveStop = process.getActiveResourcesInfo().filter((type) => type === "Timeout");
  const drainStopStarted = Date.now();
  const drainStopping = drainRuntime.stop();
  releaseDrain();
  await drainStopping;
  assert.ok(Date.now() - drainStopStarted < 1000, "stop should resolve when active work drains before its deadline");
  assert.deepEqual(
    process.getActiveResourcesInfo().filter((type) => type === "Timeout"),
    timeoutResourcesBeforeActiveStop,
    "active work draining should clear its referenced drain timer",
  );

  const timeoutResourcesBeforeIdleStop = process.getActiveResourcesInfo().filter((type) => type === "Timeout");
  const idleRuntime = createGameContinuityRuntime(db, { maxDrainMs: 1000, complete });
  const idleStopStarted = Date.now();
  await idleRuntime.stop();
  assert.ok(Date.now() - idleStopStarted < 100, "idle stop should not wait for a drain deadline");
  assert.deepEqual(
    process.getActiveResourcesInfo().filter((type) => type === "Timeout"),
    timeoutResourcesBeforeIdleStop,
    "idle stop should not leave a referenced drain timer",
  );

  await db._fileStore.close();
  console.log("game continuity runtime regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
