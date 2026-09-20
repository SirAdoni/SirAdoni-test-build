import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Editing a game message costs an Opus re-read, so continuity only pays for one when the edit could have changed
// what was remembered:
// - A small edit (typo, reworded aside) that keeps every quoted line keeps the turn's memory. The receipt is
//   re-pointed at the current text and its evidence re-stamped, so the GM context does not drop those facts as stale.
// - An edit that removes a quoted line, or is large, retires the receipt and reads the turn again.
// - The next turn is never re-read just because the tail of the edited message was part of its context.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-small-edit-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

let runtime: { stop(): Promise<void> } | null = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { CONTINUITY_SOURCE_RETIRED, continuityChangedCharacters } =
    await import("../../packages/server/src/services/game/continuity-retirement.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  assert.equal(continuityChangedCharacters("The rain is heavy.", "The rain is very heavy."), 5);
  assert.equal(continuityChangedCharacters("same", "same"), 0);

  const db = await createFileNativeDB();
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 16, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Small edit test", provider: "custom", model: "m" });
  await db.insert(chats).values({
    id: "chat",
    name: "Small edit",
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
  await db.insert(messages).values([
    { id: "u1", chatId: "chat", role: "user", content: "Who is at the door?", createdAt: t(1) },
    {
      id: "a1",
      chatId: "chat",
      role: "assistant",
      content: "Elsevere says she is two hundred and seven. The rain is heavy on the drive.",
      createdAt: t(2),
    },
    { id: "u2", chatId: "chat", role: "user", content: "Let her in.", createdAt: t(3) },
    { id: "a2", chatId: "chat", role: "assistant", content: "Audrey opens the door. Poppy signs.", createdAt: t(4) },
    { id: "u3", chatId: "chat", role: "user", content: "Good.", createdAt: t(5) },
  ]);

  // The stub remembers the first sentence of each assistant turn and quotes only that sentence.
  const extracted: string[] = [];
  const firstSentence = (text: string) => text.slice(0, text.indexOf(".") + 1);
  const complete = async ({ stage, receipt }: { stage: "extract" | "review" | "repair"; receipt: any }) => {
    const assistant = receipt.sources.find((source: any) => source.role.startsWith("assistant"));
    const dispositions = receipt.sources.map((source: any) => ({
      messageId: source.messageId,
      status: source.role.startsWith("assistant") ? "covered" : "no_durable_facts",
      reason: "stub",
    }));
    if (stage !== "extract") return { findings: [], dispositions };
    extracted.push(assistant.messageId);
    const quote = firstSentence(assistant.content);
    return {
      records: [
        {
          id: "model-id",
          kind: "other",
          text: quote,
          subjects: ["Elsevere"],
          conditions: [],
          status: "asserted",
          evidence: [{ messageId: assistant.messageId, quote }],
          keys: ["Elsevere"],
        },
      ],
      dispositions,
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
  const settle = async () => {
    await waitUntil(
      async () =>
        (await storage.list("chat")).every(
          (receipt) => !["queued", "extracting", "reviewing", "repairing", "verified"].includes(receipt.status),
        ),
      "the queue to settle",
    );
  };
  const setContent = (id: string, content: string) =>
    db.update(messages).set({ content }).where(eq(messages.id, id));
  const liveFacts = async () =>
    (await memory.listFacts({ chatId: "chat" })).filter((fact) => fact.status === "verified");
  const factTexts = async () =>
    (await liveFacts()).map((fact) => String((fact.value as Record<string, unknown>).text ?? "")).sort();

  const r1 = await continuity.enqueueCommittedTurn({ chatId: "chat", assistantMessageId: "a1", sessionNumber: 1 });
  const r2 = await continuity.enqueueCommittedTurn({ chatId: "chat", assistantMessageId: "a2", sessionNumber: 1 });
  assert.ok(r1 && r2);
  await settle();
  assert.equal((await storage.get(r1.id))?.status, "published");
  assert.equal((await storage.get(r2.id))?.status, "published");
  assert.deepEqual(extracted.sort(), ["a1", "a2"]);
  extracted.length = 0;

  // 1. A typo fix outside the quoted sentence: no re-read of either turn, memory kept and still fresh.
  const fixed = "Elsevere says she is two hundred and seven. The rain is very heavy on the drive.";
  await setContent("a1", fixed);
  await continuity.reconcileChat("chat", { changedMessageIds: ["a1"] });
  await settle();
  assert.deepEqual(extracted, [], "a small edit that keeps the quote pays for no extraction, for this turn or the next");
  const kept = await storage.get(r1.id);
  assert.equal(kept?.status, "published", "the receipt stays published");
  assert.equal(kept?.sources.find((source) => source.messageId === "a1")?.content, fixed, "it now points at the edited text");
  assert.equal((await storage.list("chat")).length, 2, "no replacement receipts were queued");
  const currentHash = createHash("sha256").update(fixed).digest("hex");
  const a1Fact = (await liveFacts()).find((fact) => fact.evidence.some((item) => item.messageId === "a1"));
  assert.ok(a1Fact, "the fact from the edited turn is still live");
  assert.ok(
    a1Fact.evidence.every((item) => item.messageId !== "a1" || item.sourceHash === currentHash),
    "its evidence is re-stamped, so the GM context does not drop it as a stale source",
  );

  // 2. An edit that changes the quoted sentence: this turn is retired and re-read; the next turn is not.
  await setContent("a1", "Elsevere says she is a high elf. The rain is very heavy on the drive.");
  await continuity.reconcileChat("chat", { changedMessageIds: ["a1"] });
  assert.equal((await storage.get(r1.id))?.errorCode, CONTINUITY_SOURCE_RETIRED);
  await settle();
  assert.deepEqual(extracted, ["a1"], "only the edited turn is read again, not its neighbour");
  assert.equal((await storage.get(r2.id))?.status, "published", "the next turn keeps its reading");
  assert.deepEqual(await factTexts(), ["Audrey opens the door.", "Elsevere says she is a high elf."]);

  // 3. A large rewrite that happens to keep the quote is still read again.
  extracted.length = 0;
  await setContent(
    "a1",
    `Elsevere says she is a high elf. ${"She has been cutting the western ward-join for two months without asking. ".repeat(4)}`,
  );
  await continuity.reconcileChat("chat", { changedMessageIds: ["a1"] });
  await settle();
  assert.deepEqual(extracted, ["a1"], "a large edit is read again even when the quote survives");

  console.log("game-continuity-small-edit regression passed");
} finally {
  await runtime?.stop().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
