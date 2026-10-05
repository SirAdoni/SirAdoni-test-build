import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// GM prep boards are private like Private Notebook rows: Professor Mari's
// generic DB commands never list, count, read, search, validate or write the
// game_prep_boards table, and its storage files stay out of Mari's workspace.

const root = mkdtempSync(join(tmpdir(), "marinara-prep-board-mari-"));
const physicalStorage = join(root, "physical-storage");
mkdirSync(physicalStorage);
symlinkSync(physicalStorage, join(root, "storage"), process.platform === "win32" ? "junction" : "dir");
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MARINARA_LITE = "true";

const SENTINEL = "PREP_BOARD_MARI_SENTINEL_7310";
let closeStore: (() => Promise<void> | void) | undefined;

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { gamePrepBoards, gameDiceRolls } = await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createGamePrepBoardsStorage } =
    await import("../../packages/server/src/services/storage/game-prep-boards.storage.js");
  const { MariDbService } = await import("../../packages/server/src/services/mari-db/mari-db.service.js");
  const { resetFeatureSettingsForTests } =
    await import("../../packages/server/src/services/features/feature-settings.js");
  const { isProfessorMariPrivateDataPath, workspacePathAccessPolicy } =
    await import("../../packages/server/src/services/professor-mari/workspace-change-review.service.js");
  const { getFileStorageDir } = await import("../../packages/server/src/config/runtime-config.js");
  const { workspaceMutationTargetForPath } =
    await import("../../packages/server/src/services/professor-mari/workspace-agent.service.js");

  const db = await createFileNativeDB();
  closeStore = () => db._fileStore.close();
  const boards = createGamePrepBoardsStorage(db);
  const saved = await boards.save(
    "tamsin-game",
    { sections: [{ id: "notes" }], items: [{ id: "i1", sectionId: "notes", text: SENTINEL }] },
    0,
  );
  assert.equal(saved.ok, true);
  const row = (await db.select().from(gamePrepBoards))[0]!;

  const mari = new MariDbService(db);
  resetFeatureSettingsForTests();
  // The echoed command line may carry the search text itself, so only results and errors are checked.
  const leakCheck = (result: { output?: unknown; error?: unknown; validation?: unknown }, label: string) => {
    const text = JSON.stringify([result.output, result.error, result.validation]) ?? "";
    assert.doesNotMatch(text, new RegExp(SENTINEL), `${label} must not disclose prep board content`);
  };

  const tables = await mari.executeCli({ argv: ["db", "tables"] });
  assert.equal(tables.ok, true);
  assert.ok(!(tables.output as string[]).includes("game_prep_boards"), "db tables hides the prep board table");
  assert.ok(
    !(tables.output as string[]).includes("random_tables"),
    "db tables hides random tables while that feature is off",
  );
  assert.ok(
    !(tables.output as string[]).includes("game_dice_rolls"),
    "db tables hides dice history while that feature is off",
  );
  assert.ok((tables.output as string[]).includes("chats"), "other tables stay listed");

  const counts = await mari.executeCli({ argv: ["db", "counts"] });
  assert.equal((counts.output as Record<string, number>).game_prep_boards, undefined, "db counts skips it");
  assert.equal(
    (counts.output as Record<string, number>).random_tables,
    undefined,
    "db counts skips random tables while off",
  );
  assert.equal(
    (counts.output as Record<string, number>).game_dice_rolls,
    undefined,
    "db counts skips dice history while off",
  );

  for (const table of ["random_tables", "game_dice_rolls"]) {
    for (const argv of [
      ["db", "schema", table],
      ["db", "list", table],
      ["db", "select", table, "--where", "row.id == 'off-attempt'"],
      ["db", "search", table, "off"],
      ["db", "validate", "--table", table],
      ["db", "insert", table, "--json", JSON.stringify({ id: "off-attempt", name: "off", gameId: "game" })],
    ]) {
      const result = await mari.executeCli({ argv: [...argv] });
      assert.equal(result.ok, false, `mari db ${argv.slice(1).join(" ")} is denied while its feature is off`);
      assert.match(result.error ?? "", /FEATURE_DISABLED/);
    }
  }

  resetFeatureSettingsForTests({ randomTables: true });
  const randomOnly = await mari.executeCli({ argv: ["db", "tables"] });
  assert.ok((randomOnly.output as string[]).includes("random_tables"));
  assert.ok(!(randomOnly.output as string[]).includes("game_dice_rolls"), "the Dice Log stays independently off");
  assert.ok(
    !(randomOnly.output as string[]).includes("game_prep_boards"),
    "enabling random tables never exposes private boards",
  );
  assert.equal((await mari.executeCli({ argv: ["db", "schema", "random_tables"] })).ok, true);

  resetFeatureSettingsForTests({ diceLog: true });
  const diceOnly = await mari.executeCli({ argv: ["db", "tables"] });
  assert.ok((diceOnly.output as string[]).includes("game_dice_rolls"));
  assert.ok(!(diceOnly.output as string[]).includes("random_tables"), "Random Tables stays independently off");
  assert.ok(!(diceOnly.output as string[]).includes("game_prep_boards"));
  assert.equal((await mari.executeCli({ argv: ["db", "schema", "game_dice_rolls"] })).ok, true);
  resetFeatureSettingsForTests();

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
  assert.equal(validateAll.ok, true, `baseline validation works with optional features OFF: ${validateAll.error}`);
  leakCheck(validateAll, "mari db validate");

  const chats = createChatsStorage(db);
  const disposableChat = (await chats.create({ name: "OFF cascade fixture", mode: "game", characterIds: [] }))!;
  await db.insert(gameDiceRolls).values({
    id: "off-cascade-roll",
    chatId: disposableChat.id,
    gameId: disposableChat.id,
    source: "player",
    notation: "1d6",
    rolls: "[4]",
    total: 4,
    createdAt: new Date().toISOString(),
  });
  const deletion = await mari.executeCli({
    argv: ["db", "delete", "chats", disposableChat.id, "--cascade", "--apply"],
  });
  assert.equal(deletion.ok, true, `ordinary chat deletion works while Dice Log is OFF: ${deletion.error}`);
  assert.equal((await db.select().from(gameDiceRolls)).length, 0, "OFF does not break dependent cleanup");
  const approval = mari.getPendingApprovals().at(-1);
  assert.ok(approval);
  const restored = await mari.restoreAppliedReview(approval.id);
  assert.ok(restored && "history" in restored, "restore works while optional tables remain OFF");
  assert.equal((await db.select().from(gameDiceRolls)).length, 1, "restore retains saved optional history");
  assert.equal(
    (await mari.executeCli({ argv: ["db", "list", "game_dice_rolls"] })).ok,
    false,
    "internal cleanup never enables direct optional table access",
  );

  const kept = await boards.get("tamsin-game");
  assert.equal(kept?.revision, 1, "denied writes left the board untouched");
  assert.equal(kept?.board.items[0]?.text, SENTINEL);

  const storage = getFileStorageDir();
  const physicalPrivatePath = join(physicalStorage, "tables", "game_prep_boards", "new", "private.json");
  assert.equal(
    isProfessorMariPrivateDataPath(physicalPrivatePath),
    true,
    "missing physical descendants remain private",
  );
  for (const readOnly of [true, false]) {
    assert.throws(
      () => workspaceMutationTargetForPath(root, physicalPrivatePath, { allowMissing: true, readOnly }),
      /cannot access/,
      "ordinary reads and writes cannot bypass privacy through a configured storage alias",
    );
  }
  assert.throws(
    () =>
      workspaceMutationTargetForPath(root, join(physicalStorage, "tables", "random_tables.json"), {
        allowMissing: true,
        readOnly: true,
      }),
    /cannot access/,
    "disabled optional data remains inaccessible through its physical alias",
  );
  assert.throws(
    () =>
      workspaceMutationTargetForPath(root, join(physicalStorage, "tables", "chats", "new.json"), {
        allowMissing: true,
        forbidStorageMutation: true,
      }),
    /managed by Marinara/,
    "general managed-storage writes cannot bypass the storage alias guard",
  );
  const pathPolicy = (file: string) => workspacePathAccessPolicy(root, join(storage, "tables", file));
  assert.equal(isProfessorMariPrivateDataPath(join(storage, "tables", "game_prep_boards", "shard.json")), true);
  assert.equal(isProfessorMariPrivateDataPath(join(storage, "tables", "game_prep_boards.json")), true);
  assert.equal(isProfessorMariPrivateDataPath(join(storage, "tables", "game_prep_boards.json.bak")), true);
  assert.equal(isProfessorMariPrivateDataPath(join(storage, "tables", "game_prep_boards.json.tmp")), true);
  if (process.platform === "win32") {
    assert.equal(isProfessorMariPrivateDataPath(join(storage, "tables", "GAME_PREP_BOARDS.JSON")), true);
    assert.equal(pathPolicy("RANDOM_TABLES.JSON"), "forbidden");
    assert.equal(pathPolicy(join("GAME_DICE_ROLLS", "shard.json")), "forbidden");
  }
  assert.equal(isProfessorMariPrivateDataPath(join(storage, "tables", "chats.json")), false);
  assert.equal(
    pathPolicy("random_tables.json"),
    "forbidden",
    "disabled random-table data is inaccessible through workspace review",
  );
  assert.equal(pathPolicy(join("random_tables", "shard.json")), "forbidden");
  assert.equal(
    pathPolicy("game_dice_rolls.json"),
    "forbidden",
    "disabled dice history is inaccessible through workspace review",
  );
  assert.equal(pathPolicy(join("game_dice_rolls", "shard.json")), "forbidden");
  assert.notEqual(pathPolicy("chats.json"), "forbidden", "unrelated app data remains available");

  resetFeatureSettingsForTests({ randomTables: true });
  assert.notEqual(pathPolicy("random_tables.json"), "forbidden", "enabling Random Tables restores its own file access");
  assert.equal(pathPolicy("game_dice_rolls.json"), "forbidden", "Dice Log stays disabled independently");
  assert.equal(
    pathPolicy("game_prep_boards.json"),
    "forbidden",
    "private prep-board files stay private even when enabled",
  );
  resetFeatureSettingsForTests({ diceLog: true });
  assert.notEqual(pathPolicy("game_dice_rolls.json"), "forbidden", "enabling Dice Log restores its own file access");
  assert.equal(pathPolicy("random_tables.json"), "forbidden", "Random Tables stays disabled independently");
  resetFeatureSettingsForTests();

  console.log("prep-board-mari-privacy regression passed");
} finally {
  await closeStore?.();
  rmSync(root, { recursive: true, force: true });
}
