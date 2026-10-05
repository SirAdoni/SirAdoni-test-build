import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

// Dice roll history: the pure entry builders and stats, the file-backed table (per chat
// and per game, cascade with the chat), the never-throw recorder, and the three call
// sites that feed it (GM turn save, dice tray, skill-check button).

const root = mkdtempSync(join(tmpdir(), "marinara-dice-log-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const serverRequire = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const { resetFeatureSettingsForTests } =
  await import("../../packages/server/src/services/features/feature-settings.js");

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
    who: "Party member",
  });
  assert.equal(check?.source, "skill_check");
  assert.equal(check?.label, "Athletics (DC 15)");
  assert.equal(check?.actor, "Party member");
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
  resetFeatureSettingsForTests({});
  assert.equal(await recordGameDiceRollsSafely(db, "session-1", [nat20]), 0, "missing flag suppresses recording");
  assert.equal((await storage.list({ chatId: "session-1" })).length, 0);
  resetFeatureSettingsForTests({ diceLog: true });
  const lateOffDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "select")
        return (...args: unknown[]) => {
          const query = Reflect.apply(target.select, target, args);
          return {
            from: (...fromArgs: unknown[]) => {
              const from = Reflect.apply(query.from, query, fromArgs);
              return {
                where: async (...whereArgs: unknown[]) => {
                  const rows = await Reflect.apply(from.where, from, whereArgs);
                  resetFeatureSettingsForTests({});
                  return rows;
                },
              };
            },
          };
        };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  assert.equal(
    await recordGameDiceRollsSafely(lateOffDb, "session-1", [nat20]),
    0,
    "OFF after chat lookup prevents write",
  );
  assert.equal((await storage.list({ chatId: "session-1" })).length, 0);
  resetFeatureSettingsForTests({ diceLog: true });
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

  // A clean file-store restart retains the new table and both shard scopes.
  await db._fileStore.flush();
  await db._fileStore.close();
  const restartedDb = await createFileNativeDB();
  const restartedStorage = createGameDiceRollsStorage(restartedDb);
  assert.equal((await restartedStorage.list({ gameId: "game-1" })).length, 4);

  // Inject the registered route module to exercise actual API validation and response behavior.
  const fastify = serverRequire("fastify");
  const { gameToolsRoutes } = await import("../../packages/server/src/routes/game-tools.routes.js");
  const api = fastify();
  api.decorate("db", restartedDb);
  await api.register(gameToolsRoutes, { prefix: "/api/game-tools" });
  resetFeatureSettingsForTests({});
  assert.equal((await api.inject({ method: "GET", url: "/api/game-tools/dice-log?chatId=session-1" })).statusCode, 403);
  assert.equal((await api.inject({ method: "POST", url: "/api/game-tools/dice-log", payload: {} })).statusCode, 403);
  assert.equal((await restartedStorage.list({ gameId: "game-1" })).length, 4, "OFF retains saved history");
  resetFeatureSettingsForTests({ diceLog: true });
  const invalidQuery = await api.inject({ method: "GET", url: "/api/game-tools/dice-log?chatId=session-1&limit=501" });
  assert.equal(invalidQuery.statusCode, 400);
  const missingChat = await api.inject({ method: "GET", url: "/api/game-tools/dice-log?chatId=missing" });
  assert.equal(missingChat.statusCode, 404);
  const invalidWrite = await api.inject({
    method: "POST",
    url: "/api/game-tools/dice-log",
    payload: { source: "unsupported", chatId: "session-1" },
  });
  assert.equal(invalidWrite.statusCode, 400);
  const playerWrite = await api.inject({
    method: "POST",
    url: "/api/game-tools/dice-log",
    payload: {
      source: "player",
      chatId: "session-1",
      context: "Stealth",
      result: { notation: "1d20+3", rolls: [20], modifier: 3, total: 23 },
    },
  });
  assert.equal(playerWrite.statusCode, 200);
  assert.equal(playerWrite.json().recorded, 1);
  const checkWrite = await api.inject({
    method: "POST",
    url: "/api/game-tools/dice-log",
    payload: {
      source: "skill_check",
      chatId: "session-1",
      messageId: "m-api",
      result: {
        skill: "Athletics",
        dc: 15,
        rolls: [17],
        modifier: 2,
        total: 19,
        criticalSuccess: false,
        criticalFailure: false,
        dice: "1d20",
        who: "Mira",
      },
    },
  });
  assert.equal(checkWrite.statusCode, 200);
  assert.equal(checkWrite.json().recorded, 1);
  const sessionRead = await api.inject({
    method: "GET",
    url: "/api/game-tools/dice-log?chatId=session-1&scope=session",
  });
  assert.equal(sessionRead.json().total, 4);
  const gameRead = await api.inject({
    method: "GET",
    url: "/api/game-tools/dice-log?chatId=session-1&scope=game&limit=1",
  });
  assert.equal(gameRead.statusCode, 200);
  assert.equal(gameRead.json().total, 6);
  assert.equal(gameRead.json().recent.length, 1, "limit caps response rows; all matches remain counted");
  const unknownWrite = await api.inject({
    method: "POST",
    url: "/api/game-tools/dice-log",
    payload: {
      source: "player",
      chatId: "missing",
      result: { notation: "1d6", rolls: [3], modifier: 0, total: 3 },
    },
  });
  assert.equal(unknownWrite.statusCode, 404, "invalid chat writes are rejected before storage");
  await api.close();

  // A broken store must not reach the roll.
  const broken = {
    select() {
      throw new Error("disk on fire");
    },
  } as unknown as typeof db;
  assert.equal(await recordGameDiceRollsSafely(broken, "session-1", [d6]), 0);

  // Rows go with their chat.
  await restartedDb.delete(chats).where(eq(chats.id, "session-1"));
  assert.equal((await restartedDb.select().from(gameDiceRolls).where(eq(gameDiceRolls.chatId, "session-1"))).length, 0);
  assert.equal((await restartedStorage.list({ gameId: "game-1" })).length, 2);
  await restartedDb._fileStore.close();

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
  assert.equal((generate.match(/diceLogChecks\.push\(/g) ?? []).length, 1, "one collector per generation pass");
  const hooks = read("../../packages/client/src/hooks/use-game.ts");
  assert.equal((hooks.match(/source: "skill_check"/g) ?? []).length, 1, "one history writer per completed skill check");
  assert.match(hooks, /recordDiceLogEntry\(qc, \{\s*source: "player"/, "tray rolls are logged");
  assert.match(hooks, /recordDiceLogEntry\(qc, \{\s*source: "skill_check"/, "skill-check buttons are logged");
  const client = read("../../packages/client/src/hooks/use-game-tools.ts");
  const dispatchSource = client.match(/export function diceLogEnabledAtDispatch[\s\S]*?\n\}/)?.[0];
  assert(dispatchSource, "exercise the actual client dispatch helper");
  const ts = serverRequire("typescript");
  const compiled = ts.transpileModule(dispatchSource.replace("export function", "function"), {}).outputText;
  const { resolveFeatureEnabled } = await import("../../packages/shared/src/schemas/feature-settings.schema.js");
  const enabledAtDispatch = new Function(
    "resolveFeatureEnabled",
    "featureSettingsKeys",
    `${compiled};return diceLogEnabledAtDispatch;`,
  )(resolveFeatureEnabled, { all: ["features"] });
  const clientRequire = createRequire(new URL("../../packages/client/package.json", import.meta.url));
  const { QueryClient } = clientRequire("@tanstack/react-query");
  const qc = new QueryClient();
  assert.equal(enabledAtDispatch(qc), false);
  qc.setQueryData(["features"], { settings: { diceLog: true } });
  assert.equal(enabledAtDispatch(qc), true);
  qc.setQueryData(["features"], { settings: { diceLog: false } });
  assert.equal(enabledAtDispatch(qc), false, "an old callback checks the current OFF setting");
  qc.setQueryData(["features"], { settings: { diceLog: true } });
  qc.getQueryCache()
    .find({ queryKey: ["features"] })
    .setState({ status: "error" });
  assert.equal(enabledAtDispatch(qc), false, "cached ON data after a query error cannot send history");
  qc.clear();
  assert.match(client, /\.catch\(\(\) => undefined\)/, "client logging swallows failures");
  assert.match(read("../../packages/server/src/routes/index.ts"), /gameToolsRoutes, \{ prefix: "\/api\/game-tools" \}/);
  assert.doesNotMatch(read("../../packages/server/src/routes/game.routes.ts"), /dice-roll-log|game-dice-rolls/);
  const surface = read("../../packages/client/src/components/game/GameSurface.tsx");
  assert.match(
    surface,
    /\["history", "journal", "tools"\]/,
    "the integrated Session panel hosts authoring and dice tools",
  );
  assert.match(
    read("../../packages/client/src/components/game/GameToolsPanel.tsx"),
    /<GameDiceLog chatId=\{chatId\} \/>/,
  );
} finally {
  resetFeatureSettingsForTests({});
  rmSync(root, { recursive: true, force: true });
}
