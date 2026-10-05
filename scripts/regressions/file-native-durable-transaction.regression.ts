import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-durable-transaction-"));
process.env.FILE_STORAGE_DIR = storageDir;

const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { eq } = await import("../../packages/server/src/db/file-query.js");
const { chats, lorebooks } = await import("../../packages/server/src/db/schema/index.js");

let writeMode: "normal" | "block" | "fail" = "normal";
let failSecondTableWrite = false;
let secondTableWriteCount = 0;
let firstTableWriteLabel = "";
let secondTableWriteLabel = "";
let firstTableWasPersistedBeforeSecondFailure = false;
const observedWrites: string[] = [];
const readShardRows = (label: string) => {
  const [table, encodedKey] = label.split("/");
  return JSON.parse(readFileSync(join(storageDir, "tables", table!, `${encodedKey}.json`), "utf8")) as Array<{
    id: string;
    name: string;
  }>;
};
let announceWrite!: () => void;
let releaseWrite!: () => void;
let writeStarted = new Promise<void>((resolve) => (announceWrite = resolve));
let writeGate = new Promise<void>((resolve) => (releaseWrite = resolve));
const hooks = {
  beforeTableWrite: async (table: string) => {
    observedWrites.push(table);
    if (failSecondTableWrite) {
      secondTableWriteCount++;
      if (secondTableWriteCount === 1) {
        firstTableWriteLabel = table;
        return;
      }
      if (secondTableWriteCount === 2) {
        secondTableWriteLabel = table;
        assert(table.startsWith("lorebooks/"), "the second dirty table is the lorebook fixture");
        assert(firstTableWriteLabel.startsWith("chats/"), "the first dirty table is the chat fixture");
        firstTableWasPersistedBeforeSecondFailure = readShardRows(firstTableWriteLabel).some(
          (row) => row.id === "keeper-durable-chat" && row.name === "partially persisted",
        );
        failSecondTableWrite = false;
        throw new Error("injected second durable table write failure");
      }
    }
    if (!table.startsWith("chats/")) return;
    if (writeMode === "block") {
      writeMode = "normal";
      announceWrite();
      await writeGate;
    } else if (writeMode === "fail") {
      writeMode = "normal";
      throw new Error("injected durable write failure");
    }
  },
};

try {
  const db = await createFileNativeDB(hooks);
  const now = new Date().toISOString();
  await db.insert(chats).values({
    id: "keeper-durable-chat",
    name: "before",
    mode: "game",
    metadata: "{}",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(lorebooks).values({
    id: "keeper-durable-book",
    name: "book before",
    description: "",
    category: "world",
    sourceAgentId: null,
    isGlobal: "false",
    characterId: null,
    personaId: null,
    chatId: "keeper-durable-chat",
    enabled: "true",
    tags: "[]",
    createdAt: now,
    updatedAt: now,
  });
  await db._fileStore.flush();

  writeMode = "block";
  let settled = false;
  const commit = db
    .transaction(async (outer) => {
      await outer.transaction(
        async (inner) => {
          await inner
            .update(chats)
            .set({ name: "committed", updatedAt: new Date().toISOString() })
            .where(eq(chats.id, "keeper-durable-chat"));
        },
        { durable: true },
      );
    })
    .finally(() => {
      settled = true;
    });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    writeStarted,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`durable write did not start; observed: ${observedWrites.join(",")}`)),
        3000,
      );
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  await Promise.resolve();
  assert.equal(settled, false, "nested durable transaction waits for the blocked disk write");
  releaseWrite();
  await commit;
  await db._fileStore.close();

  const reopened = await createFileNativeDB(hooks);
  assert.equal(
    (await reopened.select().from(chats).where(eq(chats.id, "keeper-durable-chat")))[0]?.name,
    "committed",
    "nested durable option flushes the committed row before resolving",
  );

  writeMode = "fail";
  await assert.rejects(
    reopened.transaction(
      async (tx) => {
        await tx
          .update(chats)
          .set({ name: "must roll back", updatedAt: new Date().toISOString() })
          .where(eq(chats.id, "keeper-durable-chat"));
      },
      { durable: true },
    ),
    /injected durable write failure/,
  );
  assert.equal(
    (await reopened.select().from(chats).where(eq(chats.id, "keeper-durable-chat")))[0]?.name,
    "committed",
    "a failed durable write restores the in-memory row",
  );
  await reopened._fileStore.close();

  const afterFailure = await createFileNativeDB(hooks);
  assert.equal(
    (await afterFailure.select().from(chats).where(eq(chats.id, "keeper-durable-chat")))[0]?.name,
    "committed",
    "a failure before the atomic write preserves the prior on-disk row",
  );

  failSecondTableWrite = true;
  secondTableWriteCount = 0;
  await assert.rejects(
    afterFailure.transaction(
      async (tx) => {
        await tx
          .update(chats)
          .set({ name: "partially persisted", updatedAt: new Date().toISOString() })
          .where(eq(chats.id, "keeper-durable-chat"));
        await tx
          .update(lorebooks)
          .set({ name: "must roll back too", updatedAt: new Date().toISOString() })
          .where(eq(lorebooks.id, "keeper-durable-book"));
      },
      { durable: true },
    ),
    /injected second durable table write failure/,
  );
  assert(firstTableWasPersistedBeforeSecondFailure, "the first table reached disk before the second-table failure");
  assert.equal(
    (await afterFailure.select().from(chats).where(eq(chats.id, "keeper-durable-chat")))[0]?.name,
    "committed",
    "a later table write failure restores the first table in memory",
  );
  assert.equal(
    (await afterFailure.select().from(lorebooks).where(eq(lorebooks.id, "keeper-durable-book")))[0]?.name,
    "book before",
    "a later table write failure restores the second table in memory",
  );
  assert.equal(readShardRows(firstTableWriteLabel).find((row) => row.id === "keeper-durable-chat")?.name, "committed");
  assert.equal(
    readShardRows(secondTableWriteLabel).find((row) => row.id === "keeper-durable-book")?.name,
    "book before",
  );
  await afterFailure._fileStore.close();

  const afterCrossTableRollback = await createFileNativeDB(hooks);
  assert.equal(
    (await afterCrossTableRollback.select().from(chats).where(eq(chats.id, "keeper-durable-chat")))[0]?.name,
    "committed",
    "compensation restores the first persisted table before rejection completes and reopen",
  );
  assert.equal(
    (await afterCrossTableRollback.select().from(lorebooks).where(eq(lorebooks.id, "keeper-durable-book")))[0]?.name,
    "book before",
    "the second table remains unchanged after rejection and reopen",
  );
  await afterCrossTableRollback._fileStore.close();
} finally {
  rmSync(storageDir, { recursive: true, force: true });
}
