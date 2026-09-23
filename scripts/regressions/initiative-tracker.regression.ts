import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Initiative and encounter tracker: the pure turn-order module, the file-backed
// encounters table and its registrations, the routes (CRUD per game, the
// initiative roll and its "initiative" dice-log rows) and the client wiring.

const root = mkdtempSync(join(tmpdir(), "marinara-initiative-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

try {
  const tracker = await import("../../packages/shared/src/utils/initiative-tracker.ts");
  const {
    addCombatant,
    advanceTurn,
    applyInitiatives,
    createInitiativeState,
    currentCombatant,
    delayCombatant,
    formatInitiativeTurnSummary,
    moveCombatant,
    normalizeInitiativeDice,
    previousTurn,
    removeCombatant,
    sameInitiativeState,
    sanitizeInitiativeState,
    sortCombatantsByInitiative,
    updateCombatant,
  } = tracker;
  type Combatant = import("../../packages/shared/src/utils/initiative-tracker.ts").InitiativeCombatant;

  const make = (id: string, name: string, initiative: number | null = null, dice = "d20"): Combatant => ({
    id,
    name,
    source: "custom",
    sourceId: null,
    dice,
    initiative,
    hp: "",
    notes: "",
  });
  const names = (state: { combatants: Combatant[] }) => state.combatants.map((combatant) => combatant.name);

  // ── Dice ──
  assert.equal(normalizeInitiativeDice(""), "d20");
  assert.equal(normalizeInitiativeDice("+3"), "d20+3");
  assert.equal(normalizeInitiativeDice("-1"), "d20-1");
  assert.equal(normalizeInitiativeDice("2"), "d20+2");
  assert.equal(normalizeInitiativeDice(" D20 + 4 "), "d20+4");
  assert.equal(normalizeInitiativeDice("banana"), null);

  // ── Sorting and ties ──
  const sorted = sortCombatantsByInitiative([
    make("a", "Tamsin", 12, "d20+1"),
    make("b", "Goblin", null),
    make("c", "Ysolde", 12, "d20+4"),
    make("d", "Wolf", 18),
  ]);
  assert.deepEqual(
    sorted.map((combatant) => combatant.name),
    ["Wolf", "Ysolde", "Tamsin", "Goblin"],
    "high first, ties to the higher modifier, unrolled last",
  );

  // ── Adding and rolling ──
  let state = createInitiativeState();
  state = addCombatant(state, make("a", "Tamsin"));
  state = addCombatant(state, make("b", "Goblin"));
  state = addCombatant(state, make("c", "Goblin"));
  assert.deepEqual(names(state), ["Tamsin", "Goblin", "Goblin 2"], "duplicate names get a number");
  state = applyInitiatives(state, { a: 9, b: 15, c: 4 }, { restart: true });
  assert.deepEqual(names(state), ["Goblin", "Tamsin", "Goblin 2"]);
  assert.equal(state.round, 1);
  assert.equal(currentCombatant(state)?.name, "Goblin");

  // ── Turns and rounds ──
  state = advanceTurn(state);
  assert.equal(currentCombatant(state)?.name, "Tamsin");
  state = advanceTurn(advanceTurn(state));
  assert.equal(state.round, 2, "past the last combatant the round goes up");
  assert.equal(state.turn, 0);
  state = previousTurn(state);
  assert.equal(state.round, 1);
  assert.equal(currentCombatant(state)?.name, "Goblin 2");
  state = previousTurn(previousTurn(state));
  assert.deepEqual([state.round, state.turn], [1, 0]);
  assert.deepEqual(previousTurn(state), state, "round 1's first turn is the floor");

  // ── A late arrival keeps the current turn ──
  state = advanceTurn(state); // Tamsin acts
  state = addCombatant(state, make("d", "Wolf", 20));
  assert.deepEqual(names(state), ["Wolf", "Goblin", "Tamsin", "Goblin 2"]);
  assert.equal(currentCombatant(state)?.name, "Tamsin", "inserting above does not steal the turn");
  state = applyInitiatives(state, { c: 30 });
  assert.equal(names(state)[0], "Goblin 2");
  assert.equal(currentCombatant(state)?.name, "Tamsin", "a mid-fight roll keeps the turn");

  // ── Reorder, delay, remove ──
  state = moveCombatant(state, "a", -1);
  assert.equal(currentCombatant(state)?.name, "Tamsin", "the turn marker follows the combatant");
  assert.deepEqual(moveCombatant(state, "c", -1), state, "the top cannot move up");
  const beforeDelay = names(state);
  const turnBefore = state.turn;
  state = delayCombatant(state, "a");
  assert.equal(state.turn, turnBefore, "delaying on your turn hands it to the next");
  assert.equal(names(state)[turnBefore + 1], "Tamsin");
  assert.notDeepEqual(names(state), beforeDelay);
  const lastId = state.combatants[state.combatants.length - 1]!.id;
  assert.deepEqual(delayCombatant(state, lastId), state, "the last in the order cannot delay");

  const acting = currentCombatant(state)!;
  state = removeCombatant(state, acting.id);
  assert.notEqual(currentCombatant(state)?.id, acting.id);
  assert.equal(state.combatants.length, 3);
  const onLast = { ...state, turn: state.combatants.length - 1 };
  const afterLast = removeCombatant(onLast, onLast.combatants[onLast.turn]!.id);
  assert.equal(afterLast.turn, 0, "removing the last on their turn ends the round");
  assert.equal(afterLast.round, onLast.round + 1);

  // ── Notes and summary ──
  state = updateCombatant(state, state.combatants[state.turn]!.id, { hp: "12/20", notes: "poisoned" });
  const summary = formatInitiativeTurnSummary(state);
  assert.match(summary, /^Round \d+: .+'s turn \(HP 12\/20; poisoned\)\. Next: .+\.$/);
  assert.equal(formatInitiativeTurnSummary(createInitiativeState()), "");
  assert.ok(!summary.includes("—"));

  // ── Sanitize ──
  const clean = sanitizeInitiativeState({
    round: -4,
    turn: 99,
    combatants: [
      make("x", "Ari"),
      make("x", "Copy"),
      { id: "", name: "Nobody" },
      "junk",
      { ...make("y", "Brin"), dice: "??" },
    ],
  });
  assert.deepEqual(names(clean), ["Ari", "Brin"], "duplicate ids and malformed rows are dropped");
  assert.equal(clean.round, 1);
  assert.equal(clean.turn, 1, "the turn is clamped into the list");
  assert.equal(clean.combatants[1]!.dice, "d20");
  assert.deepEqual(sanitizeInitiativeState(null), createInitiativeState());

  // ── Unsaved-change check (loading another encounter asks first) ──
  const fight = addCombatant(addCombatant(createInitiativeState(), make("a", "Ari", 12)), make("b", "Brin", 8));
  const reordered = { ...fight, combatants: fight.combatants.map((c) => ({ notes: c.notes, hp: c.hp, ...c })) };
  assert.ok(sameInitiativeState(fight, reordered), "key order does not count as a change");
  assert.ok(sameInitiativeState(fight, JSON.parse(JSON.stringify(sanitizeInitiativeState(fight)))));
  assert.ok(!sameInitiativeState(fight, advanceTurn(fight)), "a turn change is a change");
  assert.ok(!sameInitiativeState(fight, updateCombatant(fight, "a", { hp: "3/9" })), "an HP change is a change");
  const trackerSource = read("../../packages/client/src/components/tools/InitiativeTracker.tsx");
  assert.ok(
    trackerSource.includes("sameInitiativeState(loaded.state, state)"),
    "switching encounters checks for unsaved changes",
  );
  assert.ok(
    read("../../packages/client/src/hooks/use-initiative.ts").includes("error.status === 404) return create()"),
    "saving an encounter deleted elsewhere creates it again",
  );

  // ── Registration ──
  const { createFileNativeDB, FILE_BACKED_TABLES, getFileTableShardStrategy, isLazyUnitTable } =
    await import("../../packages/server/src/db/file-backed-store.js");
  assert.ok(FILE_BACKED_TABLES.includes("game_initiative_encounters"));
  assert.equal(getFileTableShardStrategy("game_initiative_encounters").kind, "primary-key");
  assert.equal(isLazyUnitTable("game_initiative_encounters"), false);
  assert.match(read("../protect-launcher-data.mjs"), /"game_initiative_encounters"/);
  assert.match(read("../../packages/server/src/routes/admin.routes.ts"), /runDelete\("game_initiative_encounters"/);
  assert.match(read("../../packages/server/src/db/schema/index.ts"), /game-initiative-encounters\.js/);
  assert.match(
    read("../../packages/server/src/routes/index.ts"),
    /gameInitiativeRoutes, \{ prefix: "\/api\/game-initiative" \}/,
  );

  // ── Routes ──
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { chats } = await import("../../packages/server/src/db/schema/index.js");
  const { gameInitiativeRoutes } = await import("../../packages/server/src/routes/game-initiative.routes.js");
  const { createGameDiceRollsStorage } =
    await import("../../packages/server/src/services/storage/game-dice-rolls.storage.js");

  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  for (const [id, groupId] of [
    ["session-1", "game-1"],
    ["session-2", "game-1"],
    ["other-1", "game-2"],
  ] as const) {
    await db.insert(chats).values({
      id,
      name: `Test game ${id}`,
      mode: "game",
      groupId,
      metadata: JSON.stringify({ gameId: groupId }),
      createdAt,
      updatedAt: createdAt,
    });
  }
  await db.insert(chats).values({
    id: "rp-1",
    name: "Roleplay",
    mode: "roleplay",
    metadata: "{}",
    createdAt,
    updatedAt: createdAt,
  });

  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameInitiativeRoutes, { prefix: "/api/game-initiative", maxEncounters: 2 });
  await app.ready();
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url: `/api/game-initiative${url}`, payload: payload as never });
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
  };

  try {
    const created = await call("POST", "/", { chatId: "session-1", name: "  Ford   ambush ", state });
    assert.equal(created.status, 200);
    assert.equal(created.body.name, "Ford ambush");
    assert.equal(created.body.gameId, "game-1");
    assert.deepEqual(names(created.body.state), names(state));

    const listed = await call("GET", "/?chatId=session-2");
    assert.deepEqual(
      listed.body.encounters.map((encounter: { id: string }) => encounter.id),
      [created.body.id],
      "another session of the same game sees the encounter",
    );
    assert.equal((await call("GET", "/?chatId=other-1")).body.encounters.length, 0, "other games do not");
    assert.equal((await call("GET", "/?chatId=rp-1")).status, 400, "only Game Mode chats have encounters");
    assert.equal((await call("POST", "/", { chatId: "rp-1", name: "X", state })).status, 400);

    const advanced = advanceTurn(state);
    const updated = await call("PUT", `/${created.body.id}`, { state: advanced });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.state.turn, advanced.turn);
    assert.equal(updated.body.name, "Ford ambush", "a state update keeps the name");
    assert.equal((await call("PUT", "/missing", { name: "Y" })).status, 404);

    assert.equal((await call("POST", "/", { chatId: "session-1", name: "Second", state: {} })).status, 200);
    assert.equal((await call("POST", "/", { chatId: "session-1", name: "Third", state: {} })).status, 409, "cap");

    const rolled = await call("POST", "/roll", {
      chatId: "session-1",
      combatants: [
        { id: "a", name: "Tamsin", dice: "+3" },
        { id: "b", name: "Goblin", dice: "d20" },
      ],
    });
    assert.equal(rolled.status, 200);
    assert.equal(rolled.body.logged, 2);
    assert.equal(rolled.body.results[0].notation, "d20+3");
    assert.ok(rolled.body.totals.a >= 4 && rolled.body.totals.a <= 23);
    assert.ok(rolled.body.totals.b >= 1 && rolled.body.totals.b <= 20);
    const log = await createGameDiceRollsStorage(db).list({ chatId: "session-1" });
    assert.equal(log.length, 2);
    assert.ok(log.every((record) => record.source === "initiative" && record.label === "Initiative"));
    assert.deepEqual(log.map((record) => record.actor).sort(), ["Goblin", "Tamsin"]);

    const outside = await call("POST", "/roll", { chatId: "rp-1", combatants: [{ id: "a", name: "A", dice: "" }] });
    assert.equal(outside.status, 200);
    assert.equal(outside.body.logged, 0, "nothing is logged outside Game Mode");
    assert.equal(
      (await call("POST", "/roll", { chatId: "session-1", combatants: [{ id: "a", name: "A", dice: "x" }] })).status,
      400,
    );

    assert.equal((await call("DELETE", `/${created.body.id}`)).status, 200);
    assert.equal((await call("DELETE", `/${created.body.id}`)).status, 404);
  } finally {
    await app.close();
  }

  // ── Client wiring ──
  assert.match(read("../../packages/client/src/components/game/GameToolsPanel.tsx"), /<InitiativeTracker /);
  const host = read("../../packages/client/src/components/command-palette/CommandPaletteHost.tsx");
  assert.match(host, /id: "action:initiative-tracker"/);
  assert.match(read("../../packages/client/src/components/layout/ModalRenderer.tsx"), /case "initiative-tracker"/);
  const component = read("../../packages/client/src/components/tools/InitiativeTracker.tsx");
  assert.match(component, /insertIntoChatInput\(formatOocNote/);
  assert.doesNotMatch(component, /sendMessage|useSendMessage/, "the summary is never sent");
  const english = JSON.parse(read("../../packages/client/src/localization/locales/en.json")) as Record<string, string>;
  const used = [...component.matchAll(/t\("(ui\.initiative\.[\w.]+)"/g)].map((match) => match[1]!);
  for (const key of used) assert.ok(english[key], `${key} has an English string`);
  for (const [key, value] of Object.entries(english)) {
    if (key.startsWith("ui.initiative.")) assert.ok(!value.includes("—"), `${key} has no em dash`);
  }
  assert.ok(english["ui.game.diceLog.sourceInitiative"]);
  assert.ok(english["palette.actions.initiativeTracker"]);
  console.log("initiative tracker regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
