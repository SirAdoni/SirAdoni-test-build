import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Abrupt-termination proof (plan S6 / PF2). A child process runs the continuity
// runtime against an isolated file store and hangs at a named checkpoint; the
// parent SIGKILLs it, reopens the same store and checks the durable state, then
// resumes with a fresh runtime and a fresh session-summary refresh service.
const CHECKPOINTS = [
  "extracting",
  "reviewing",
  "pre-commit",
  "post-commit",
] as const;
type Checkpoint = (typeof CHECKPOINTS)[number];
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..", "..");
const serverRoot = join(repositoryRoot, "packages", "server");
const CHAT_ID = "kill";
const ASSISTANT_ID = "kill-a";
const summary = {
  sessionNumber: 1,
  summary: "Original.",
  resumePoint: "At the gate.",
  partyDynamics: "Together.",
  partyState: "Ready.",
  keyDiscoveries: [],
  characterMoments: [],
  littleDetails: [],
  statsSnapshot: {},
  npcUpdates: [],
  nextSessionRequest: null,
  timestamp: "2026-09-13T00:00:00.000Z",
};

function stubResponse(stage: "extract" | "review" | "repair", receipt: any) {
  if (stage === "extract") {
    const source =
      receipt.sources.find((item: any) => item.role.startsWith("user")) ??
      receipt.sources[0];
    return {
      records: [
        {
          id: "model-id",
          kind: "promise",
          text: "Return promise",
          subjects: ["player"],
          conditions: [],
          status: "proposed",
          evidence: [
            { messageId: source.messageId, quote: source.content.slice(0, 20) },
          ],
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
      status: source.role.startsWith("assistant")
        ? "no_durable_facts"
        : "covered",
      reason: "review",
    })),
  };
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function runChild(checkpoint: Checkpoint) {
  const marker = process.env.CONTINUITY_KILL_MARKER!;
  // Keep the event loop alive while hanging so the child only dies by SIGKILL,
  // never through the store's beforeExit flush on a natural exit.
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(3), 25_000).unref();
  const { createFileNativeDB } =
    await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } =
    await import("../../packages/server/src/services/storage/chats.storage.js");
  const { buildSessionSummaryRefreshDescriptor } =
    await import("../../packages/server/src/services/game/session-summary-dependencies.js");
  const { createGameContinuityRuntime } =
    await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { applyFeatureSettingsValue } =
    await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(
    JSON.stringify({
      gameContinuity: true,
      campaignMemory: true,
      campaignIndex: true,
    }),
  );
  const db = await createFileNativeDB();
  const now = "2026-09-12T00:00:00.000Z";
  const later = "2026-09-12T00:00:01.000Z";
  const metadata: Record<string, unknown> = {
    gameContinuity: {
      mode: "active",
      extractionInstructions: "extract",
      verificationInstructions: "verify",
    },
  };
  await db.insert(apiConnections).values({
    id: "conn",
    name: "Kill test",
    provider: "custom",
    model: "test-model",
  });
  await db.insert(chats).values({
    id: CHAT_ID,
    name: CHAT_ID,
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify(metadata),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values([
    {
      id: `${CHAT_ID}-u`,
      chatId: CHAT_ID,
      role: "user",
      content: "I promise to return.",
      createdAt: now,
    },
    {
      id: ASSISTANT_ID,
      chatId: CHAT_ID,
      role: "assistant",
      content: "Acknowledged.",
      createdAt: later,
    },
  ]);
  const chatsStorage = createChatsStorage(db);
  const descriptor = buildSessionSummaryRefreshDescriptor({
    messages: await chatsStorage.listMessages(CHAT_ID),
    metadata,
    sessionNumber: 1,
    summary,
    continuityRequired: true,
  });
  assert.equal(descriptor.status, "provisional");
  await chatsStorage.updateMetadata(CHAT_ID, {
    ...metadata,
    gamePreviousSessionSummaries: [summary],
    gameSessionSummaryRefreshes: { "1": descriptor },
  });
  await db._fileStore.flush();

  const reached = async (receipt: any): Promise<never> => {
    const tmp = `${marker}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        checkpoint,
        pid: process.pid,
        id: receipt.id,
        status: receipt.status,
        attempts: receipt.attempts,
      }),
    );
    renameSync(tmp, marker);
    return new Promise<never>(() => {});
  };
  if (checkpoint === "pre-commit") {
    // Hang inside the storage.publish transaction after the lorebook entry was
    // written to memory but before the durable commit flush.
    const rawTransaction = db.transaction;
    db.transaction = (fn, options) =>
      rawTransaction(async (tx) => {
        const result: any = await fn(tx);
        if (
          result &&
          result.status === "published" &&
          Array.isArray(result.entryIds)
        )
          await reached(result);
        return result;
      }, options);
  }
  const runtime = createGameContinuityRuntime(db, {
    maxDrainMs: 100,
    complete: async ({
      stage,
      receipt,
    }: {
      stage: "extract" | "review" | "repair";
      receipt: any;
    }) => {
      if (checkpoint === "extracting" && stage === "extract")
        await reached(receipt);
      if (checkpoint === "reviewing" && stage === "review")
        await reached(receipt);
      return stubResponse(stage, receipt);
    },
    onPublished: async (receipt: any) => {
      if (checkpoint === "post-commit") await reached(receipt);
    },
  });
  const receipt = await runtime.enqueueCommittedTurn({
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_ID,
    sessionNumber: 1,
  });
  assert.ok(receipt, "child must enqueue a committed turn");
  await new Promise(() => {});
}

async function runParent() {
  const { applyFeatureSettingsValue } =
    await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(
    JSON.stringify({
      gameContinuity: true,
      campaignMemory: true,
      campaignIndex: true,
    }),
  );
  const tsxLoader = pathToFileURL(
    createRequire(pathToFileURL(join(serverRoot, "package.json")).href).resolve(
      "tsx",
    ),
  ).href;
  const expectedStatus: Record<Checkpoint, string> = {
    extracting: "extracting",
    reviewing: "reviewing",
    "pre-commit": "verified",
    "post-commit": "published",
  };
  const expectedStageCalls: Record<Checkpoint, Record<string, number>> = {
    extracting: { extract: 1, review: 1 },
    reviewing: { review: 1 },
    "pre-commit": {},
    "post-commit": {},
  };
  const expectedPublishedCallbacks: Record<Checkpoint, number> = {
    extracting: 1,
    reviewing: 1,
    "pre-commit": 1,
    "post-commit": 0,
  };
  for (const checkpoint of CHECKPOINTS) {
    const root = mkdtempSync(
      join(tmpdir(), `marinara-continuity-kill-${checkpoint}-`),
    );
    try {
      const marker = join(root, "checkpoint.json");
      const output: string[] = [];
      const child = spawn(
        process.execPath,
        ["--import", tsxLoader, scriptPath],
        {
          cwd: serverRoot,
          env: {
            ...process.env,
            DATA_DIR: root,
            FILE_STORAGE_DIR: join(root, "storage"),
            CONTINUITY_KILL_CHECKPOINT: checkpoint,
            CONTINUITY_KILL_MARKER: marker,
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      child.stdout.on("data", (chunk) => output.push(String(chunk)));
      child.stderr.on("data", (chunk) => output.push(String(chunk)));
      let exit: { code: number | null; signal: NodeJS.Signals | null } | null =
        null;
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveExit) =>
        child.once("exit", (code, signal) => {
          exit = { code, signal };
          resolveExit(exit);
        }),
      );
      await waitUntil(
        () => {
          if (exit)
            assert.fail(
              `[${checkpoint}] child exited before the checkpoint: ${JSON.stringify(exit)}\n${output.join("")}`,
            );
          return existsSync(marker);
        },
        `[${checkpoint}] child checkpoint`,
        15_000,
      );
      const reached = JSON.parse(readFileSync(marker, "utf8")) as {
        pid: number;
        id: string;
        status: string;
        attempts: number;
      };
      assert.equal(
        reached.pid,
        child.pid,
        "SIGKILL must target the actual storage writer, not a CLI wrapper",
      );
      assert.ok(
        child.kill("SIGKILL"),
        `[${checkpoint}] SIGKILL must be delivered`,
      );
      const result = await exited;
      assert.equal(
        result.signal,
        "SIGKILL",
        `[${checkpoint}] child must die by SIGKILL, got ${JSON.stringify(result)}`,
      );

      // Wait for the same OS absence signal used by writer-lease recovery.
      await waitUntil(() => {
        try {
          process.kill(reached.pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }, `[${checkpoint}] killed storage writer disappears`);

      process.env.DATA_DIR = root;
      process.env.FILE_STORAGE_DIR = join(root, "storage");
      const { createFileNativeDB } =
        await import("../../packages/server/src/db/file-backed-store.js");
      const { lorebookEntries } =
        await import("../../packages/server/src/db/schema/index.js");
      const { createGameContinuityStorage } =
        await import("../../packages/server/src/services/storage/game-continuity.storage.js");
      const { createGameContinuityRuntime } =
        await import("../../packages/server/src/services/game/continuity-runtime.js");
      const db = await createFileNativeDB();
      try {
        const storage = createGameContinuityStorage(db);
        const entriesFor = async (receiptId: string) =>
          (await db.select().from(lorebookEntries)).filter((row) => {
            try {
              return (
                JSON.parse(String(row.dynamicState ?? "{}")).receiptId ===
                receiptId
              );
            } catch {
              return false;
            }
          });
        const durable = await storage.list(CHAT_ID);
        assert.equal(
          durable.length,
          1,
          `[${checkpoint}] exactly one receipt survives`,
        );
        const receipt = durable[0]!;
        assert.equal(receipt.id, reached.id);
        assert.equal(
          receipt.status,
          expectedStatus[checkpoint],
          `[${checkpoint}] durable status is the last checkpoint`,
        );
        assert.equal(
          receipt.attempts,
          reached.attempts,
          `[${checkpoint}] attempts unchanged by the kill`,
        );
        assert.equal(receipt.attempts, 1);
        assert.equal(
          receipt.errorCode,
          undefined,
          `[${checkpoint}] a kill leaves no error diagnostic`,
        );
        assert.equal(receipt.error, undefined);
        const entriesAfterKill = await entriesFor(receipt.id);
        assert.equal(
          entriesAfterKill.length > 0,
          receipt.status === "published",
          `[${checkpoint}] lorebook entries exist iff the receipt is published (no half-publish)`,
        );
        if (checkpoint === "extracting" || checkpoint === "reviewing") {
          // Nothing verified yet, so nothing may have been published.
          assert.deepEqual(receipt.entryIds, []);
        }

        const stageCalls: Record<string, number> = {};
        const publishedCallbacks: string[] = [];
        const recovered = createGameContinuityRuntime(db, {
          maxDrainMs: 1000,
          complete: async ({
            stage,
            receipt: current,
          }: {
            stage: "extract" | "review" | "repair";
            receipt: any;
          }) => {
            stageCalls[stage] = (stageCalls[stage] ?? 0) + 1;
            return stubResponse(stage, current);
          },
          onPublished: (published: any) => {
            publishedCallbacks.push(published.id);
          },
        });
        await recovered.start();
        await waitUntil(
          async () =>
            (await recovered.list(CHAT_ID))[0]?.status === "published",
          `[${checkpoint}] recovery`,
        );
        await recovered.stop();
        const final = (await storage.list(CHAT_ID))[0]!;
        assert.equal(
          final.id,
          receipt.id,
          `[${checkpoint}] recovery resumes the same receipt`,
        );
        assert.deepEqual(
          stageCalls,
          expectedStageCalls[checkpoint],
          `[${checkpoint}] one call for the interrupted stage only`,
        );
        assert.equal(
          final.attempts,
          1,
          `[${checkpoint}] a clean interruption resumes on the same attempt`,
        );
        assert.equal(final.errorCode, undefined);
        assert.equal(
          publishedCallbacks.length,
          expectedPublishedCallbacks[checkpoint],
          `[${checkpoint}] onPublished count`,
        );
        assert.equal(final.entryIds.length, 1);
        assert.equal(
          (await entriesFor(receipt.id)).length,
          1,
          `[${checkpoint}] exactly one lorebook entry after recovery`,
        );
      } finally {
        await db._fileStore.close();
      }
      console.log(
        `abrupt kill at ${checkpoint}: durable ${expectedStatus[checkpoint]}, recovered`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.log("game continuity abrupt kill regression passed");
}

const childCheckpoint = process.env.CONTINUITY_KILL_CHECKPOINT as
  Checkpoint | undefined;
if (childCheckpoint) {
  assert.ok(
    CHECKPOINTS.includes(childCheckpoint),
    `unknown checkpoint ${childCheckpoint}`,
  );
  await runChild(childCheckpoint);
} else {
  await runParent();
}
