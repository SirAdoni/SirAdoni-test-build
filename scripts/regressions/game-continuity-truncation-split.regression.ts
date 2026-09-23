import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A model that runs out of output tokens (finish reason "length") returns a cut-off answer; retrying the same
// batch pays for the same cut-off answer again. Live on 2026-09-23 this was every generic stage failure (8 of 8).
// A batch of several messages is now split into halves like a context overflow; a single-message batch still
// fails normally, so an oversized turn can never loop.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-truncation-split-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { normalizeContinuityError } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const db = await createFileNativeDB();
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Truncation test", provider: "custom", model: "m" });
  const addChat = async (id: string, rows: Array<{ role: "user" | "assistant"; content: string }>) => {
    await db.insert(chats).values({
      id,
      name: id,
      mode: "game",
      connectionId: "conn",
      metadata: JSON.stringify({
        gameContinuity: { mode: "shadow", extractionInstructions: "x", verificationInstructions: "y" },
      }),
      createdAt: t(0),
      updatedAt: t(0),
    });
    await db.insert(messages).values(
      rows.map((row, index) => ({ id: `${id}-${index}`, chatId: id, role: row.role, content: row.content, createdAt: t(index + 1) })),
    );
  };
  await addChat("pair", [
    { role: "user", content: "I promise to return the amulet." },
    { role: "assistant", content: "The priestess nods and records the vow." },
    { role: "user", content: "Thanks." },
  ]);
  await addChat("single", [
    { role: "assistant", content: "The gate is closed for the night." },
    { role: "user", content: "I wait." },
  ]);

  // The provider wraps a length finish as a generic stage failure whose cause names the finish reason.
  const truncated = () => {
    throw normalizeContinuityError(new Error("CONTINUITY_PROVIDER_FINISH_length"));
  };
  const complete = async ({ stage, receipt }: { stage: "extract" | "review" | "repair"; receipt: any }) => {
    if (receipt.sources.length > 1 || receipt.chatId === "single") truncated();
    const dispositions = receipt.sources.map((source: any) => ({
      messageId: source.messageId,
      status: "no_durable_facts",
      reason: "nothing durable",
    }));
    return stage === "extract" ? { records: [], dispositions } : { findings: [], dispositions };
  };
  const runtime = createGameContinuityRuntime(db, { complete, maxDrainMs: 3000 });
  const waitUntil = async (check: () => Promise<boolean>, timeoutMs = 15_000) => {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const pair = await runtime.enqueueCommittedTurn({ chatId: "pair", assistantMessageId: "pair-1" });
  assert.equal(pair!.sources.length, 2);
  await waitUntil(async () => (await runtime.get(pair!.id))?.status === "stale");
  const splitInto = ((await runtime.get(pair!.id))?.config as { splitInto?: string[] }).splitInto;
  assert.ok(Array.isArray(splitInto) && splitInto.length === 2, "a truncated two-message batch is split in halves");
  await waitUntil(async () => {
    for (const id of splitInto!) if ((await runtime.get(id))?.status !== "verified") return false;
    return true;
  });

  const single = await runtime.enqueueCommittedTurn({ chatId: "single", assistantMessageId: "single-0" });
  await waitUntil(async () => ["failed", "unresolved"].includes((await runtime.get(single!.id))?.status ?? ""));
  assert.equal(
    ((await runtime.get(single!.id))?.config as { splitInto?: unknown }).splitInto,
    undefined,
    "a single-message batch is never split",
  );
  await runtime.stop();
  await db._fileStore.close();
  console.log("game-continuity-truncation-split regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
