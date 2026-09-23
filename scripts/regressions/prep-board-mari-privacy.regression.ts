import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// GM prep boards are private like Private Notebook rows: Professor Mari's
// generic DB commands never list, count, read, search, validate or write the
// game_prep_boards table, and its storage files stay out of Mari's workspace.

const root = mkdtempSync(join(tmpdir(), "marinara-prep-board-mari-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MARINARA_LITE = "true";

const SENTINEL = "PREP_BOARD_MARI_SENTINEL_7310";

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { gamePrepBoards } = await import("../../packages/server/src/db/schema/index.js");
  const { createGamePrepBoardsStorage } =
    await import("../../packages/server/src/services/storage/game-prep-boards.storage.js");
  const { MariDbService } = await import("../../packages/server/src/services/mari-db/mari-db.service.js");
  const { isProfessorMariPrivateDataPath } =
    await import("../../packages/server/src/services/professor-mari/workspace-change-review.service.js");
  const { getFileStorageDir } = await import("../../packages/server/src/config/runtime-config.js");

  const db = await createFileNativeDB();
  const boards = createGamePrepBoardsStorage(db);
  const saved = await boards.save(
    "tamsin-game",
    { sections: [{ id: "notes" }], items: [{ id: "i1", sectionId: "notes", text: SENTINEL }] },
    0,
  );
  assert.equal(saved.ok, true);
  const row = (await db.select().from(gamePrepBoards))[0]!;

  const mari = new MariDbService(db);
  // The echoed command line may carry the search text itself, so only results and errors are checked.
  const leakCheck = (result: { output?: unknown; error?: unknown; validation?: unknown }, label: string) => {
    const text = JSON.stringify([result.output, result.error, result.validation]) ?? "";
    assert.doesNotMatch(text, new RegExp(SENTINEL), `${label} must not disclose prep board content`);
  };

  const tables = await mari.executeCli({ argv: ["db", "tables"] });
  assert.equal(tables.ok, true);
  assert.ok(!(tables.output as string[]).includes("game_prep_boards"), "db tables hides the prep board table");
  assert.ok((tables.output as string[]).includes("chats"), "other tables stay listed");

  const counts = await mari.executeCli({ argv: ["db", "counts"] });
  assert.equal((counts.output as Record<string, number>).game_prep_boards, undefined, "db counts skips it");

  for (const [label, argv] of [
    ["schema", ["db", "schema", "game_prep_boards"]],
    ["list", ["db", "list", "game_prep_boards"]],
    ["get", ["db", "get", "game_prep_boards", row.id]],
    ["select", ["db", "select", "game_prep_boards", "--limit", "10"]],
    ["table search", ["db", "search", "game_prep_boards", SENTINEL]],
    ["validate", ["db", "validate", "--table", "game_prep_boards"]],
    ["insert", ["db", "insert", "game_prep_boards", "--json", JSON.stringify({ gameId: "forged", board: "{}" })]],
    ["patch", ["db", "patch", "game_prep_boards", row.id, "--json", JSON.stringify({ board: "{}" })]],
    ["delete", ["db", "delete", "game_prep_boards", row.id]],
  ] as const) {
    const result = await mari.executeCli({ argv: [...argv] });
    assert.equal(result.ok, false, `mari db ${label} must be denied`);
    leakCheck(result, `mari db ${label}`);
  }

  const searchAll = await mari.executeCli({ argv: ["db", "search", "all", SENTINEL] });
  leakCheck(searchAll, "mari db search all");
  const validateAll = await mari.executeCli({ argv: ["db", "validate"] });
  leakCheck(validateAll, "mari db validate");

  const kept = await boards.get("tamsin-game");
  assert.equal(kept?.revision, 1, "denied writes left the board untouched");
  assert.equal(kept?.board.items[0]?.text, SENTINEL);

  const storage = getFileStorageDir();
  assert.equal(isProfessorMariPrivateDataPath(join(storage, "tables", "game_prep_boards", "shard.json")), true);
  assert.equal(isProfessorMariPrivateDataPath(join(storage, "tables", "game_prep_boards.json")), true);
  assert.equal(isProfessorMariPrivateDataPath(join(storage, "tables", "chats.json")), false);

  console.log("prep-board-mari-privacy regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
