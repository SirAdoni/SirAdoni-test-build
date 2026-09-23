import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { chats, lorebookEntries, lorebooks } from "../../packages/server/src/db/schema/index.js";
import {
  consolidateGameKeeperLorebooks,
  filterEligibleGameKeeperEntries,
  planGameKeeperLorebookConsolidation,
  resolveGameKeeperLorebook,
} from "../../packages/server/src/services/game/game-keeper-lorebook.js";

const root = mkdtempSync(join(tmpdir(), "marinara-keeper-consolidation-"));
process.env.FILE_STORAGE_DIR = root;
const now = new Date().toISOString();
const source = "game-lorebook-keeper";
const book = (id: string, chatId: string | null, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  description: "",
  category: "world",
  chatId,
  sourceAgentId: source,
  isGlobal: "false",
  characterId: null,
  personaId: null,
  enabled: "true",
  tags: "[]",
  createdAt,
  updatedAt: now,
  ...extra,
});
const entry = (id: string, lorebookId: string, origin?: string | null) => ({
  id,
  lorebookId,
  name: id,
  content: `content-${id}`,
  dynamicState: JSON.stringify({ source, ...(origin === undefined ? {} : { keeperSourceChatId: origin }) }),
  createdAt: now,
  updatedAt: now,
});

try {
  const db = await createFileNativeDB();
  await db.insert(chats).values([
    {
      id: "c1",
      name: "Session 1",
      mode: "game",
      groupId: "campaign",
      metadata: JSON.stringify({ gameId: "campaign", gameSessionNumber: 1 }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "c2",
      name: "Session 2",
      mode: "game",
      groupId: "campaign",
      metadata: JSON.stringify({ gameId: "campaign", gameSessionNumber: 2 }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "c4",
      name: "Session 4",
      mode: "game",
      groupId: "campaign",
      metadata: JSON.stringify({
        gameId: "campaign",
        gameSessionNumber: 4,
        activeLorebookIds: ["b2"],
        excludedLorebookIds: ["b2"],
      }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "future",
      name: "Session 5",
      mode: "game",
      groupId: "campaign",
      metadata: JSON.stringify({ gameId: "campaign", gameSessionNumber: 5 }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "branch",
      name: "Branch",
      mode: "game",
      groupId: "campaign",
      metadata: JSON.stringify({ gameId: "campaign", gameSessionNumber: 3, branchParentChatId: "c2" }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "dup",
      name: "Duplicate",
      mode: "game",
      groupId: "campaign",
      metadata: JSON.stringify({ gameId: "campaign", gameSessionNumber: 9 }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "dup2",
      name: "Duplicate 2",
      mode: "game",
      groupId: "campaign",
      metadata: JSON.stringify({ gameId: "campaign", gameSessionNumber: 9 }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "new-branch",
      name: "New Branch",
      mode: "game",
      groupId: "campaign",
      metadata: JSON.stringify({ gameId: "campaign", gameSessionNumber: 10, branchParentChatId: "c4" }),
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db
    .insert(lorebooks)
    .values([
      book("b1", "c1", "2026-01-01T00:00:00.000Z"),
      book("b2", "c2", "2026-01-02T00:00:00.000Z"),
      book("b3", "future", "2026-01-03T00:00:00.000Z"),
      book("bb", "branch", "2026-01-04T00:00:00.000Z"),
      book("bd", "dup", "2026-01-05T00:00:00.000Z"),
      book("global", null, "2026-01-06T00:00:00.000Z", { isGlobal: "true" }),
    ]);
  await db
    .insert(lorebookEntries)
    .values([
      entry("e1", "b1", null),
      entry("e2", "b2", "c2"),
      entry("e3", "b3", "future"),
      entry("eb", "bb", "branch"),
      entry("ed", "bd", "dup"),
    ]);
  const plan = await planGameKeeperLorebookConsolidation(db, "c4");
  assert.equal(plan.canonicalBookId, "b1", "oldest eligible campaign book is canonical");
  assert.deepEqual(plan.migrateEntryIds, ["e2"]);
  assert(plan.skippedEntryIds.includes("e3"), "future session does not migrate");
  assert(!plan.candidateBookIds.includes("bb"), "branch book is isolated");
  assert.equal(
    (await resolveGameKeeperLorebook(db, "future", { gameId: "campaign", gameSessionNumber: 5 }))?.id,
    "b1",
    "a later session reuses the campaign keeper",
  );
  assert(plan.duplicateSessionNumbers.includes(9), "duplicate session groups are reported");
  assert.equal(
    (await resolveGameKeeperLorebook(db, "branch", { gameId: "campaign" }))?.id,
    "bb",
    "branches never select the parent book",
  );
  const branchPlan = await planGameKeeperLorebookConsolidation(db, "branch");
  assert.deepEqual(branchPlan.candidateBookIds, ["bb"], "branch consolidation is isolated to its own book");
  const newBranchBook = await resolveGameKeeperLorebook(db, "new-branch", { gameId: "campaign" });
  assert(
    newBranchBook && newBranchBook.id !== "b1" && newBranchBook.id !== "bb",
    "a new branch gets its own deterministic book",
  );
  assert.equal(newBranchBook?.chatId, "new-branch");
  const duplicateOrigin = await filterEligibleGameKeeperEntries(
    db,
    "dup",
    [(await db.select().from(lorebookEntries)).find((row) => row.id === "e1")!],
    await db.select().from(lorebooks),
  );
  assert.equal(duplicateOrigin.length, 0, "duplicate current session cannot import cross-session origins");
  const dry = await consolidateGameKeeperLorebooks(db, "c4");
  assert.equal(dry.applied, false, "default is read-only");
  const before = (await db.select().from(lorebookEntries)).map((row) => [row.id, row.content]);
  await consolidateGameKeeperLorebooks(db, "c4", { apply: true });
  const after = (await db.select().from(lorebookEntries)).map((row) => [row.id, row.content]);
  assert.deepEqual(
    after.filter(([id]) => ["e1", "e2"].includes(id)),
    before.filter(([id]) => ["e1", "e2"].includes(id)),
    "IDs/content preserved",
  );
  const second = await consolidateGameKeeperLorebooks(db, "c4", { apply: true });
  assert.equal(second.migrateEntryIds.length, 0, "apply is idempotent");
  const current = (await db.select().from(chats)).find((row) => row.id === "c4")!;
  const metadata = JSON.parse(current.metadata);
  assert.deepEqual(metadata.activeLorebookIds, ["b1"]);
  assert.deepEqual(metadata.excludedLorebookIds, ["b1"]);
  const eligible = await filterEligibleGameKeeperEntries(
    db,
    "c4",
    await db.select().from(lorebookEntries),
    await db.select().from(lorebooks),
  );
  assert(eligible.some((row) => row.id === "e2"));
  assert(
    !eligible.some((row) => row.id === "e3" || row.id === "eb" || row.id === "ed"),
    "future, branch, and duplicate origins are filtered",
  );
  await db._fileStore.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
