import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Historical backfill may group several accepted turns into one provider round trip. Grouping must not
// drop any accepted assistant narration or any user message from the middle of the group, and a single
// id must still produce exactly the batches live play has always produced.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-grouping-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { prepareContinuitySources, planContinuityTurnBatches, planContinuityTurnGroupBatches } = await import(
    "../../packages/server/src/services/game/continuity-sources.js"
  );

  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 16, 0, 0, seconds)).toISOString();
  const messages: Array<{ id: string; chatId: string; role: string; content: string; createdAt: string }> = [];
  for (let turn = 1; turn <= 4; turn += 1) {
    messages.push({
      id: `u${turn}`,
      chatId: "chat-1",
      role: "user",
      content: `User line for turn ${turn}: I promise payment number ${turn}.`,
      createdAt: t(turn * 2 - 1),
    });
    messages.push({
      id: `a${turn}`,
      chatId: "chat-1",
      role: "assistant",
      content: `Assistant narration for turn ${turn}: the clerk records promise number ${turn}.`,
      createdAt: t(turn * 2),
    });
  }
  // A turn counts as accepted when a user message follows it, so close the last one.
  messages.push({
    id: "u5",
    chatId: "chat-1",
    role: "user",
    content: "User line closing the last turn.",
    createdAt: t(9),
  });
  const prepared = prepareContinuitySources(messages as never, { gameContinuity: { mode: "shadow" } } as never);
  const accepted = ["a1", "a2", "a3", "a4"];

  // A single id keeps the exact live-play behaviour.
  for (const id of accepted) {
    assert.deepEqual(
      planContinuityTurnGroupBatches(prepared, [id], 8000),
      planContinuityTurnBatches(prepared, id, 8000),
      `a one-turn group equals the single-turn plan for ${id}`,
    );
  }

  const single = accepted.flatMap((id) => planContinuityTurnBatches(prepared, id, 8000));
  const grouped = planContinuityTurnGroupBatches(prepared, accepted, 8000 * accepted.length);
  assert.equal(single.length, 4, "one receipt per turn today");
  assert.equal(grouped.length, 1, "four turns fit in one grouped receipt");

  const textOf = (batches: Array<{ sources: Array<{ messageId: string; content: string }> }>) =>
    batches.flatMap((batch) => batch.sources.map((source) => source.content)).join("\n");
  const groupedText = textOf(grouped);
  for (const turn of [1, 2, 3, 4]) {
    assert.ok(groupedText.includes(`promise number ${turn}`), `user line of turn ${turn} survives grouping`);
    assert.ok(groupedText.includes(`records promise number ${turn}`), `narration of turn ${turn} survives grouping`);
  }
  const groupedIds = grouped.flatMap((batch) => batch.sources.map((source) => source.messageId));
  assert.deepEqual(
    [...new Set(groupedIds)].sort(),
    ["a1", "a2", "a3", "a4", "u1", "u2", "u3", "u4"],
    "every message of every grouped turn is a primary source, so each one still needs a disposition",
  );
  assert.equal(groupedIds.length, new Set(groupedIds).size, "no message is sent twice inside one batch");

  // A budget smaller than the group still splits rather than truncating (256 is the planner minimum).
  const split = planContinuityTurnGroupBatches(prepared, accepted, 256);
  assert.ok(split.length > 1, "a group over budget splits into several batches");
  const splitIds = new Set(split.flatMap((batch) => batch.sources.map((source) => source.messageId)));
  assert.deepEqual([...splitIds].sort(), ["a1", "a2", "a3", "a4", "u1", "u2", "u3", "u4"], "splitting loses nothing");

  // End to end through the runtime: the env knob must be read when the runtime is created, because
  // dotenv loads .env after this module is first imported and an import-time read kept every install
  // silently on one turn per call.
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages: messagesTable } = await import(
    "../../packages/server/src/db/schema/index.js"
  );
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const db = await createFileNativeDB();
  await db.insert(apiConnections).values({ id: "conn", name: "Grouping", provider: "custom", model: "m" });
  await db.insert(chats).values({
    id: "chat-1",
    name: "chat-1",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify({
      gameContinuity: { mode: "shadow", extractionInstructions: "x", verificationInstructions: "y" },
      gameSessionNumber: 1,
    }),
    createdAt: t(0),
    updatedAt: t(0),
  });
  await db.insert(messagesTable).values(messages as never);

  const enqueueWith = async (turnsPerReceipt: string | undefined): Promise<number> => {
    if (turnsPerReceipt === undefined) delete process.env.CONTINUITY_BACKFILL_TURNS_PER_RECEIPT;
    else process.env.CONTINUITY_BACKFILL_TURNS_PER_RECEIPT = turnsPerReceipt;
    const runtime = createGameContinuityRuntime(db, {
      complete: async () => ({ records: [], dispositions: [] }),
      maxDrainMs: 100,
    } as never);
    const result = await runtime.enqueueHistoricalRange({
      chatId: "chat-1",
      backfillId: `historical-${turnsPerReceipt ?? "default"}`,
      fromMessageId: "u1",
      toMessageId: "u5",
    } as never);
    await runtime.stop();
    return (result as { receipts: unknown[] }).receipts.length;
  };

  assert.equal(await enqueueWith(undefined), 4, "the default is still one receipt per accepted turn");
  assert.equal(await enqueueWith("4"), 1, "CONTINUITY_BACKFILL_TURNS_PER_RECEIPT=4 groups four turns into one receipt");
  delete process.env.CONTINUITY_BACKFILL_TURNS_PER_RECEIPT;
  await db._fileStore.close();

  console.log("continuity-turn-grouping regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
