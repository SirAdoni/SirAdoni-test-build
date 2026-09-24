import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Dice roll history: the pure entry builders and stats, the file-backed table (per chat
// and per game, cascade with the chat), the never-throw recorder, and the three call
// sites that feed it (GM turn save, dice tray, skill-check button).

const root = mkdtempSync(join(tmpdir(), "marinara-dice-log-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

try {
  const { diceResultLogEntry, skillCheckLogEntry, summarizeDiceRolls } =
    await import("../../packages/server/src/services/game/dice-roll-log.js");

  // ── Entry builders ──
  const nat20 = diceResultLogEntry({ notation: "1d20+3", rolls: [20], modifier: 3, total: 23 }, "player", "  Sneak ");
  assert.deepEqual(nat20, {
    source: "player",
    actor: null,
    label: "Sneak",
    notation: "1d20+3",
    rolls: [20],
    modifier: 3,
    total: 23,
    critical: true,
    fumble: false,
  });
  const nat1 = diceResultLogEntry({ notation: "d20", rolls: [1], modifier: 0, total: 1 }, "gm");
  assert.equal(nat1?.fumble, true, "a natural 1 on a single d20 is a fumble");
  const pair = diceResultLogEntry({ notation: "2d20", rolls: [20, 1], modifier: 0, total: 21 }, "gm");
  assert.equal(pair?.critical, false, "two d20s summed are not a crit");
  assert.equal(pair?.fumble, false);
  assert.equal(diceResultLogEntry({ notation: "2d6", rolls: [], modifier: 0, total: 0 }, "gm"), null);
  assert.equal(diceResultLogEntry({ notation: "", rolls: [3], modifier: 0, total: 3 }, "gm"), null);

  const check = skillCheckLogEntry({
    skill: "Athletics",
    dc: 15,
    rolls: [4, 17],
    usedRoll: 17,
    modifier: 2,
    total: 19,
    success: true,
    criticalSuccess: false,
    criticalFailure: false,
    rollMode: "advantage",
    resolution: "sum",
    who: "Mira",
  });
  assert.equal(check?.source, "skill_check");
  assert.equal(check?.label, "Athletics (DC 15)");
  assert.equal(check?.actor, "Mira");
  assert.equal(check?.notation, "1d20", "a check without dice= defaults to 1d20");

  // ── One GM turn: a check that adopted a roll_dice result is logged once, as the check ──
  const { gmTurnDiceLogEntries } = await import("../../packages/server/src/services/game/dice-roll-log.js");
  const toolRoll = { notation: "2d6", rolls: [3, 5], modifier: 0, total: 8 };
  const freshRoll = { notation: "1d8", rolls: [6], modifier: 0, total: 6 };
  const adoptingCheck = {
    skill: "Stealth",
    dc: 7,
    rolls: toolRoll.rolls,
    usedRoll: 8,
    modifier: 0,
    total: 8,
    success: true,
    criticalSuccess: false,
    criticalFailure: false,
    rollMode: "normal" as const,
    resolution: "sum" as const,
    dice: "2d6",
  };
  const turn = gmTurnDiceLogEntries([toolRoll, freshRoll], [adoptingCheck]);
  assert.deepEqual(
    turn.map((entry) => `${entry.source}:${entry.notation}`),
    ["gm:1d8", "skill_check:2d6"],
    "the adopted roll is not logged a second time as a bare GM roll",
  );
  const lookalike = gmTurnDiceLogEntries([toolRoll], [{ ...adoptingCheck, rolls: [3, 5] }]);
  assert.equal(lookalike.length, 2, "equal numbers from a separate throw are still two rolls");
  assert.deepEqual(
    gmTurnDiceLogEntries([null, { notation: "1d6" }] as never, [undefined, { rolls: "x" }] as never),
    [],
    "malformed results are dropped, never thrown",
  );
  const hostile = [{}] as unknown as Parameters<typeof gmTurnDiceLogEntries>[0];
  Object.defineProperty(hostile[0], "rolls", {
    get() {
      throw new Error("boom");
    },
  });
  assert.deepEqual(gmTurnDiceLogEntries(hostile, []), [], "even a throwing getter never reaches the turn");

  // ── Stats ──
  const empty = summarizeDiceRolls([]);
  assert.equal(empty.rolls, 0);
  assert.equal(empty.averageTotal, null);
  assert.deepEqual(empty.bySides, []);

  const d6 = diceResultLogEntry({ notation: "2d6", rolls: [6, 6], modifier: 0, total: 12 }, "gm")!;
  const stats = summarizeDiceRolls([nat20!, nat1!, d6, check!]);
  assert.equal(stats.rolls, 4);
  assert.equal(stats.dice, 1 + 1 + 2 + 2);
  assert.equal(stats.natural20s, 1, "d20 faces counted across every d20 thrown");
  assert.equal(stats.natural1s, 1);
  assert.equal(stats.criticals, 1);
  assert.equal(stats.fumbles, 1);
  // Priced rolls only (checks excluded): totals 23, 1, 12 against 13.5, 10.5, 7.
  assert.equal(stats.averageTotal, 12);
  assert.equal(stats.expectedTotal, 10.33);
  const d20Stats = stats.bySides.find((entry) => entry.sides === 20)!;
  assert.equal(d20Stats.dice, 4, "the check's two d20s land in the d20 distribution");
  assert.equal(d20Stats.counts.length, 20);
  assert.equal(d20Stats.counts[19], 1);
  assert.equal(d20Stats.counts[16], 1);
  assert.equal(d20Stats.expected, 10.5);
  const d6Stats = stats.bySides.find((entry) => entry.sides === 6)!;
  assert.deepEqual(d6Stats.counts, [0, 0, 0, 0, 0, 2]);
  assert.equal(d6Stats.average, 6);
  assert.equal(stats.bySides[0]!.sides, 20, "most-thrown die size first");

  // ── Storage ──
  const { createFileNativeDB, FILE_BACKED_TABLES } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, gameDiceRolls } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameDiceRollsStorage, recordGameDiceRollsSafely } =
    await import("../../packages/server/src/services/storage/game-dice-rolls.storage.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  assert.ok(FILE_BACKED_TABLES.includes("game_dice_rolls"), "the table is registered with the store");

  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values({
    id: "session-1",
    name: "Game",
    mode: "game",
    groupId: "game-1",
    metadata: JSON.stringify({ gameId: "game-1", gameSessionNumber: 1 }),
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(chats).values({
    id: "session-2",
    name: "Game",
    mode: "game",
    groupId: "game-1",
    metadata: JSON.stringify({ gameId: "game-1", gameSessionNumber: 2 }),
    createdAt,
    updatedAt: createdAt,
  });
  const storage = createGameDiceRollsStorage(db);
  assert.equal(await recordGameDiceRollsSafely(db, "session-1", [nat20, null, nat1]), 2);
  assert.equal(await recordGameDiceRollsSafely(db, "session-2", [d6, check], { messageId: "m-9" }), 2);
  assert.equal(await recordGameDiceRollsSafely(db, "missing-chat", [d6]), 0, "an unknown chat writes nothing");
  assert.equal(await recordGameDiceRollsSafely(db, "session-1", []), 0);

  const sessionRows = await storage.list({ chatId: "session-1" });
  assert.equal(sessionRows.length, 2);
  assert.equal(sessionRows[0]!.notation, "d20", "newest first, even within one millisecond");
  assert.equal(sessionRows[0]!.gameId, "game-1");
  assert.deepEqual(sessionRows[1]!.rolls, [20]);
  assert.equal(sessionRows[1]!.critical, true);
  const gameRows = await storage.list({ gameId: "game-1" });
  assert.equal(gameRows.length, 4, "the game scope spans every session");
  assert.equal(gameRows.find((row) => row.source === "skill_check")?.messageId, "m-9");

  // A broken store must not reach the roll.
  const broken = {
    select() {
      throw new Error("disk on fire");
    },
  } as unknown as typeof db;
  assert.equal(await recordGameDiceRollsSafely(broken, "session-1", [d6]), 0);

  // Rows go with their chat.
  await db.delete(chats).where(eq(chats.id, "session-1"));
  assert.equal((await db.select().from(gameDiceRolls).where(eq(gameDiceRolls.chatId, "session-1"))).length, 0);
  assert.equal((await storage.list({ gameId: "game-1" })).length, 2);

  // ── Wiring ──
  const store = read("../../packages/server/src/db/file-backed-store.ts");
  assert.match(store, /game_dice_rolls: "chatId"/, "sharded by chat");
  assert.match(store, /\{ parent: "chats", child: "game_dice_rolls", parentKey: "id", childKey: "chatId" \}/);
  assert.match(read("../protect-launcher-data.mjs"), /"game_dice_rolls"/);
  const generate = read("../../packages/server/src/routes/generate.routes.ts");
  assert.match(
    generate,
    /void recordGameDiceRollsSafely\(\s*app\.db,\s*input\.chatId,\s*gmTurnDiceLogEntries\(toolDiceRollResults, diceLogChecks\),/,
    "GM rolls are logged, unawaited, when the turn is saved",
  );
  assert.match(
    generate,
    /diceLogChecks\.push\(\.\.\.\(rolled\.results \?\? \[\]\), \.\.\.generalRolls\.checkResults\);/,
    "the turn only collects raw results; building entries happens in the never-throw helper",
  );
  const hooks = read("../../packages/client/src/hooks/use-game.ts");
  assert.match(hooks, /recordDiceLogEntry\(qc, \{\s*source: "player"/, "tray rolls are logged");
  assert.match(hooks, /recordDiceLogEntry\(qc, \{\s*source: "skill_check"/, "skill-check buttons are logged");
  const client = read("../../packages/client/src/hooks/use-game-tools.ts");
  assert.match(client, /\.catch\(\(\) => undefined\)/, "client logging swallows failures");
  assert.match(read("../../packages/server/src/routes/index.ts"), /gameToolsRoutes, \{ prefix: "\/api\/game-tools" \}/);
  assert.doesNotMatch(read("../../packages/server/src/routes/game.routes.ts"), /dice-roll-log|game-dice-rolls/);
  const surface = read("../../packages/client/src/components/game/GameSurface.tsx");
  assert.match(
    surface,
    /sessionPanelTabs[\s\S]*?\["history", "scenes", "journal", "tools"\][\s\S]*?\["history", "journal", "tools"\]/,
    "the Tools tab is in the Session panel, with and without the scene timeline",
  );
  assert.match(surface, /<GameToolsPanel chatId=\{activeChatId\} \/>/);
  assert.match(
    surface,
    /mobile \? "flex-col gap-0\.5 px-1 py-1\.5 leading-tight" : "gap-1\.5 px-2 py-2"/,
    "four Session tabs fit a phone-width panel by stacking icon over label",
  );
  const panel = read("../../packages/client/src/components/game/GameToolsPanel.tsx");
  assert.match(panel, /<GameDiceLog chatId=\{chatId\} \/>/);
  assert.match(panel, /<NameGenerator \/>/, "the name generator is inline in the Tools tab");
  assert.match(panel, /onClick=\{openNameGenerator\}/, "and can pop out into its modal");
} finally {
  rmSync(root, { recursive: true, force: true });
}
