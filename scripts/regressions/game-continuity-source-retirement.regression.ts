import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Campaign memory is built from each accepted turn. When the player edits, deletes, hides or swipes away a message
// afterwards, the memory read from the old text has to come back out, or the GM keeps "remembering" what the player
// corrected (a high elf of 207 stayed "fifty-one" in memory after both lines were fixed in the chat). The receipt
// read from the old text is retired: its facts are retracted, its generated lore entry is removed, and a fresh read
// of the current text replaces it. Unrelated reconciles never retire anything.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-retirement-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

let runtime: { stop(): Promise<void> } | null = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages, lorebooks, lorebookEntries } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { applyCampaignMemoryMutation } =
    await import("../../packages/server/src/services/game/campaign-memory-mutations.js");
  const { CONTINUITY_SOURCE_RETIRED, continuityReceiptsShareSources, findSourceChangedReceipts } =
    await import("../../packages/server/src/services/game/continuity-retirement.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  const db = await createFileNativeDB();
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 16, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Retirement test", provider: "custom", model: "m" });
  await db.insert(chats).values({
    id: "chat",
    name: "Retirement",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify({
      gameContinuity: {
        mode: "active",
        extractionInstructions: "extract",
        verificationInstructions: "verify",
        activationAt: t(0),
      },
    }),
    createdAt: t(0),
    updatedAt: t(0),
  });
  await db.insert(lorebooks).values({ id: "book", name: "Book", chatId: "chat", createdAt: t(0), updatedAt: t(0) });
  await db.insert(messages).values([
    { id: "u1", chatId: "chat", role: "user", content: "Who is at the door?", createdAt: t(1) },
    { id: "a1", chatId: "chat", role: "assistant", content: "Ismene says she is fifty-one.", createdAt: t(2) },
    { id: "u2", chatId: "chat", role: "user", content: "Let her in.", createdAt: t(3) },
  ]);

  // The stub reads whatever the assistant turn currently says and records it as one fact.
  const extracted: string[] = [];
  const complete = async ({ stage, receipt }: { stage: "extract" | "review" | "repair"; receipt: any }) => {
    const assistant = receipt.sources.find((source: any) => source.role.startsWith("assistant"));
    if (stage === "extract") {
      extracted.push(assistant?.content ?? "");
      return {
        records: assistant
          ? [
              {
                id: "model-id",
                kind: "other",
                text: assistant.content,
                subjects: ["Ismene"],
                conditions: [],
                status: "asserted",
                evidence: [{ messageId: assistant.messageId, quote: assistant.content }],
                keys: ["Ismene"],
              },
            ]
          : [],
        dispositions: receipt.sources.map((source: any) => ({
          messageId: source.messageId,
          status: source.role.startsWith("assistant") ? "covered" : "no_durable_facts",
          reason: "stub",
        })),
      };
    }
    return {
      findings: [],
      dispositions: receipt.sources.map((source: any) => ({
        messageId: source.messageId,
        status: source.role.startsWith("assistant") ? "covered" : "no_durable_facts",
        reason: "stub",
      })),
    };
  };
  const continuity = createGameContinuityRuntime(db, { complete, maxDrainMs: 3000 } as any);
  runtime = continuity;
  const storage = createGameContinuityStorage(db);
  const memory = createCampaignMemoryStorage(db);
  const waitUntil = async (predicate: () => Promise<boolean>, label: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  const liveFacts = async () =>
    (await memory.listFacts({ chatId: "chat" })).filter((fact) => fact.status === "verified");
  const factTexts = async () =>
    (await liveFacts()).map((fact) => String((fact.value as Record<string, unknown>).text ?? ""));
  const generatedEntries = async () =>
    (await db.select().from(lorebookEntries)).filter((entry) => entry.id.startsWith("gce_"));
  const setContent = (id: string, content: string) => db.update(messages).set({ content }).where(eq(messages.id, id));

  // 1. A turn is accepted, read and published.
  const first = await continuity.enqueueCommittedTurn({ chatId: "chat", assistantMessageId: "a1", sessionNumber: 1 });
  assert.ok(first);
  await waitUntil(async () => (await storage.get(first.id))?.status === "published", "first publication");
  assert.deepEqual(await factTexts(), ["Ismene says she is fifty-one."]);
  assert.equal((await generatedEntries()).length, 1, "publication writes a generated lore entry");

  // 2. Reconciles that name no changed message, or a message the receipt did not read, retire nothing.
  await continuity.reconcileChat("chat");
  await continuity.reconcileChat("chat", { changedMessageIds: ["u2"] });
  assert.equal((await storage.get(first.id))?.status, "published", "unrelated reconciles leave memory alone");
  const unchanged = prepareContinuitySources(await db.select().from(messages).where(eq(messages.chatId, "chat")), {});
  assert.deepEqual(
    findSourceChangedReceipts([(await storage.get(first.id))!], unchanged, ["a1"]),
    [],
    "a notification without a real text change retires nothing",
  );

  // 3. The player corrects the turn. The old reading is retired and the corrected text is read again.
  await setContent("a1", "Ismene says she is two hundred and seven.");
  await continuity.reconcileChat("chat", { changedMessageIds: ["a1"] });
  const retired = await storage.get(first.id);
  assert.equal(retired?.status, "stale");
  assert.equal(retired?.errorCode, CONTINUITY_SOURCE_RETIRED);
  assert.ok(
    !(await factTexts()).includes("Ismene says she is fifty-one."),
    "the fact read from the old text is no longer live",
  );
  const retractedOld = (await memory.listFacts({ chatId: "chat" })).find((fact) =>
    String((fact.value as Record<string, unknown>).text).includes("fifty-one"),
  );
  assert.equal(retractedOld?.status, "retracted", "the old fact is kept as retracted for the audit trail");
  await waitUntil(
    async () => (await factTexts()).includes("Ismene says she is two hundred and seven."),
    "the corrected text to be read and published",
  );
  assert.deepEqual(await factTexts(), ["Ismene says she is two hundred and seven."], "only the corrected fact is live");
  assert.equal((await generatedEntries()).length, 1, "the old generated lore entry was replaced, not duplicated");

  // 4. Undoing the edit brings the original text back; it is read again under a new id instead of being lost.
  await setContent("a1", "Ismene says she is fifty-one.");
  await continuity.reconcileChat("chat", { changedMessageIds: ["a1"] });
  await waitUntil(
    async () => (await factTexts()).includes("Ismene says she is fifty-one."),
    "the restored text to be read again",
  );
  const restored = (await storage.list("chat")).filter((receipt) => receipt.status === "published");
  assert.equal(restored.length, 1);
  assert.notEqual(restored[0]!.id, first.id, "a revived reading gets a fresh id");

  // 5. A fact the player locked survives retirement.
  const [liveFact] = await liveFacts();
  await memory.updateFact({ chatId: "chat" }, liveFact!.factId, { manualLock: true }, {
    actor: "user",
    reason: "Player locked this fact",
    expectedRevision: liveFact!.revision,
    operationId: "lock-fact",
  } as any);

  // 6. Deleting the turn takes its memory out; nothing can replace it.
  await db.delete(messages).where(eq(messages.id, "a1"));
  await continuity.reconcileChat("chat", { changedMessageIds: ["a1"] });
  assert.equal((await storage.get(restored[0]!.id))?.status, "stale");
  assert.deepEqual(
    (await generatedEntries()).map((entry) => entry.id),
    restored[0]!.entryIds,
    "the locked fact keeps the generated page it still owns",
  );
  assert.deepEqual(
    (await liveFacts()).map((fact) => fact.factId),
    [liveFact!.factId],
    "the locked fact is kept; nothing else from the deleted turn stays live",
  );

  // A user can edit a generated fact without setting manualLock. The mutation journal, not the unchanged
  // author/manualLock fields, is the evidence that automatic retirement must leave their correction alone.
  const publishExtraTurn = async (prefix: string, content: string, second: number) => {
    await db.insert(messages).values([
      { id: `${prefix}-before`, chatId: "chat", role: "user", content: "Tell me more.", createdAt: t(second) },
      { id: `${prefix}-answer`, chatId: "chat", role: "assistant", content, createdAt: t(second + 1) },
      { id: `${prefix}-after`, chatId: "chat", role: "user", content: "Continue.", createdAt: t(second + 2) },
    ]);
    const queued = await continuity.enqueueCommittedTurn({
      chatId: "chat",
      assistantMessageId: `${prefix}-answer`,
      sessionNumber: 1,
    });
    assert.ok(queued);
    await waitUntil(async () => (await storage.get(queued.id))?.status === "published", `${prefix} publication`);
    const receipt = (await storage.get(queued.id))!;
    const fact = (await liveFacts()).find((item) => (item.value as Record<string, unknown>).text === content);
    assert.ok(fact, `${prefix} published its fact`);
    assert.equal(receipt.entryIds.length, 1, `${prefix} published one owned page`);
    return { receipt, fact, entryId: receipt.entryIds[0]! };
  };

  const playerFact = await publishExtraTurn("player-fact", "Ismene keeps a blue lantern.", 4);
  await applyCampaignMemoryMutation(db, {
    chatId: "chat",
    operationId: "player-edited-generated-fact",
    actor: "user",
    reason: "Correct the remembered account",
    recordType: "fact",
    action: "update",
    recordId: playerFact.fact.factId,
    expectedRevision: playerFact.fact.revision,
    patch: { value: { ...(playerFact.fact.value as Record<string, unknown>), text: "Ismene keeps a green lantern." } },
  });
  const unlockedEditedFact = await memory.getFact({ chatId: "chat" }, playerFact.fact.factId);
  assert.equal(unlockedEditedFact?.manualLock, false);
  assert.equal(unlockedEditedFact?.author, "system");
  await db.delete(messages).where(eq(messages.id, "player-fact-answer"));
  await continuity.reconcileChat("chat", { changedMessageIds: ["player-fact-answer"] });
  assert.equal((await storage.get(playerFact.receipt.id))?.status, "stale");
  assert.equal((await memory.getFact({ chatId: "chat" }, playerFact.fact.factId))?.status, "verified");
  assert.ok(
    (await db.select().from(lorebookEntries)).some((entry) => entry.id === playerFact.entryId),
    "the owned page stays while a protected fact still points to it",
  );
  assert.ok(
    (await memory.listEntities({ chatId: "chat" })).some(
      (entity) => entity.entityId === playerFact.fact.subjectEntityId && entity.status === "active",
    ),
    "the protected fact's owner entity remains active",
  );

  // A generated page can also be edited directly. Its published content hash must prevent the retirement
  // cleanup from deleting that user-authored text, even when the associated automatic fact is retracted.
  const playerPage = await publishExtraTurn("player-page", "Ismene keeps a red lantern.", 7);
  const editedPageContent = "Player-authored account of Ismene's lantern.";
  await db
    .update(lorebookEntries)
    .set({ content: editedPageContent })
    .where(eq(lorebookEntries.id, playerPage.entryId));
  await db.delete(messages).where(eq(messages.id, "player-page-answer"));
  await continuity.reconcileChat("chat", { changedMessageIds: ["player-page-answer"] });
  assert.equal((await storage.get(playerPage.receipt.id))?.status, "stale");
  assert.equal((await memory.getFact({ chatId: "chat" }, playerPage.fact.factId))?.status, "retracted");
  assert.equal(
    (await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, playerPage.entryId)))[0]?.content,
    editedPageContent,
    "a manually edited generated page survives retirement",
  );
  assert.ok(
    (await memory.listEntities({ chatId: "chat" })).some(
      (entity) =>
        entity.owner.type === "existing" &&
        entity.owner.store === "lorebook-entries" &&
        entity.owner.recordId === playerPage.entryId &&
        entity.status === "active",
    ),
    "the preserved page keeps its owner entity",
  );

  // 7. Receipts read from identical text replace one another; different text does not.
  const a = restored[0]!;
  assert.equal(continuityReceiptsShareSources(a, { ...a, id: "other" }), true);
  assert.equal(
    continuityReceiptsShareSources(a, { ...a, id: "other", sources: a.sources.map((s) => ({ ...s, hash: "x" })) }),
    false,
  );
  assert.ok(extracted.length >= 3, "each distinct text was read by the extractor");
  // A grouped read that includes every message of an older single-turn read replaces it; the reverse does not.
  const { continuityReceiptCovers } = await import("../../packages/server/src/services/game/continuity-retirement.js");
  const single = { ...a, sources: a.sources.slice(0, 1) };
  const grouped = { ...a, id: "grouped", sources: [...a.sources, { ...a.sources[0]!, messageId: "later", hash: "h" }] };
  assert.equal(continuityReceiptCovers(grouped, single), true, "a grouped read covers the single turn it contains");
  assert.equal(continuityReceiptCovers(single, grouped), false, "a single turn never replaces a grouped read");
  assert.equal(
    continuityReceiptCovers(grouped, { ...single, sources: single.sources.map((s) => ({ ...s, hash: "edited" })) }),
    false,
    "an older read of different text is not covered",
  );

  // Slice hashes describe the original message, not the slice. Neither a disjoint slice nor a partial read
  // can replace a full read. Offsets use Unicode code points, exactly as the source slicer does.
  const fullSource = { ...a.sources[0]!, role: "assistant", content: "A🌍BCDE", start: 0, end: 6 };
  const full = { ...a, sources: [fullSource] };
  const slice = (start: number, end: number) => ({
    ...fullSource,
    start,
    end,
    content: [...fullSource.content].slice(start, end).join(""),
  });
  const firstHalf = { ...a, sources: [slice(0, 3)] };
  const secondHalf = { ...a, sources: [slice(3, 6)] };
  assert.equal(continuityReceiptCovers(firstHalf, full), false);
  assert.equal(continuityReceiptCovers(firstHalf, secondHalf), false);
  assert.equal(continuityReceiptCovers(full, secondHalf), true);
  assert.equal(continuityReceiptCovers({ ...a, sources: [slice(3, 6), slice(0, 3)] }, full), true);
  assert.equal(continuityReceiptCovers({ ...a, sources: [slice(0, 2), slice(3, 6)] }, full), false);
  assert.equal(continuityReceiptCovers({ ...a, sources: [slice(0, 4), slice(2, 6)] }, full), true);
  assert.equal(continuityReceiptCovers({ ...full, sources: [{ ...fullSource, end: 999 }] }, full), false);
  assert.equal(continuityReceiptCovers({ ...full, sources: [{ ...fullSource, role: "user" }] }, full), false);
  assert.equal(continuityReceiptCovers({ ...full, sources: [{ ...fullSource, swipeIndex: 99 }] }, full), false);
  assert.equal(
    continuityReceiptCovers({ ...full, sources: [{ ...fullSource, start: undefined, end: undefined }] }, full),
    true,
    "legacy whole-message sources use their code-point content length",
  );

  // 8. The chat routes' change notifier carries the edited message ids through its debounce to the reconcile.
  const { createContinuityChangeNotifier } =
    await import("../../packages/server/src/services/game/continuity-change-notifier.js");
  const reconciled: Array<{ chatId: string; changedMessageIds: string[] }> = [];
  const fakeApp = {
    db,
    addHook: () => undefined,
    gameContinuity: {
      reconcileChat: async (chatId: string, options: { changedMessageIds?: string[] } = {}) => {
        reconciled.push({ chatId, changedMessageIds: [...(options.changedMessageIds ?? [])].sort() });
        return [];
      },
    },
  };
  const notifier = createContinuityChangeNotifier(fakeApp as any, 20);
  notifier.notify("chat", ["u1"]);
  notifier.notify("chat", ["u2", "u1"]);
  notifier.notify("chat");
  await waitUntil(async () => reconciled.length === 1, "the debounced reconcile");
  assert.deepEqual(reconciled[0], { chatId: "chat", changedMessageIds: ["u1", "u2"] }, "edits in one burst are merged");

  console.log("game-continuity-source-retirement regression passed");
} finally {
  await runtime?.stop().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
