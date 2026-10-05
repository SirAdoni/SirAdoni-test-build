import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings > Features: the `features` app setting, its routes, the cached server helper
// (absent = the registry default, which is OFF for every switch; refreshed on every storage write)
// and env precedence for the switches that also have an environment variable.
const dataDir = mkdtempSync(join(tmpdir(), "marinara-feature-settings-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
process.env.DISABLE_REQUEST_LOGGING = "true";
process.env.AUTO_CREATE_DEFAULT_CONNECTION = "false";
delete process.env.LOREBOOK_STABLE_GROUP_WINNERS;
delete process.env.PROVIDER_RETRY_TRANSIENT_ERRORS;
delete process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR;

type TestApp = {
  close(): Promise<void>;
  inject(
    options: Record<string, unknown>,
  ): Promise<{ statusCode: number; json(): any; body: string }>;
  ready(): Promise<void>;
};
let app: TestApp | null = null;
try {
  const shared = await import("../../packages/shared/src/index.js");
  const {
    FEATURE_SETTINGS_KEY,
    FEATURE_SWITCH_NAMES,
    FEATURE_SWITCH_DEFAULTS,
    FEATURE_NUMBER_DEFAULTS,
    normalizeFeatureSettings,
    createDefaultPrepBoard,
  } = shared;
  const features =
    await import("../../packages/server/src/services/features/feature-settings.js");
  const {
    isFeatureEnabled,
    getFeatureNumber,
    resetFeatureSettingsForTests,
    onFeatureSettingsChange,
  } = features;

  // ── the registry: exactly these switches, every one off by default ──
  assert.deepEqual([...FEATURE_SWITCH_NAMES].sort(), [
    "backgroundCallCap",
    "backupModes",
    "campaignIndex",
    "campaignMemory",
    "campaignMemoryRecall",
    "campaignPortraits",
    "campaignRoster",
    "campaignWiki",
    "chatgptCacheAffinity",
    "diceLog",
    "draftRewrites",
    "extendedHudWidgets",
    "factionWeb",
    "familyTree",
    "floatingMediaPlacement",
    "galleryBrowsing",
    "gameCalendar",
    "gameContactBook",
    "gameContinuity",
    "gameGuide",
    "gameKeeperConsolidation",
    "gameMemoryControls",
    "gamePrepBoard",
    "gamePromptEditing",
    "gmNarrationReasoning",
    "hudListVisibility",
    "inventoryBrowsing",
    "libraryNavigation",
    "localRewriteConnection",
    "messageTrash",
    "mobileHudArrangement",
    "playerStatus",
    "privateNotebook",
    "promptInspector",
    "providerDiagnostics",
    "providerRetry",
    "randomTables",
    "recapFactualReview",
    "savedCharacterProfiles",
    "sceneTimeline",
    "speechDiagnostics",
    "stableLorebookGroupPicks",
    "usageAndActivationStats",
    "worldHistory",
  ]);
  for (const name of FEATURE_SWITCH_NAMES)
    assert.equal(FEATURE_SWITCH_DEFAULTS[name], false, `${name} defaults off`);

  // ── shared normalization: bad values fall back to the default ──
  assert.deepEqual(normalizeFeatureSettings(null), {});
  assert.deepEqual(normalizeFeatureSettings([]), {});
  assert.deepEqual(
    normalizeFeatureSettings({
      stableLorebookGroupPicks: true,
      providerRetry: "yes",
      messageTrash: true,
      privateNotebook: true,
      gamePrepBoard: false,
      randomTables: true,
      diceLog: true,
      providerDiagnostics: true,
      other: true,
    }),
    { stableLorebookGroupPicks: true, messageTrash: true, privateNotebook: true, gamePrepBoard: false, randomTables: true, diceLog: true, providerDiagnostics: true },
    "only well-formed known keys survive",
  );
  assert.deepEqual(
    normalizeFeatureSettings({
      backgroundCallCap: true,
      backgroundCallsPerHour: 240,
      badCap: 999,
    }),
    {
      backgroundCallCap: true,
      backgroundCallsPerHour: 240,
    },
  );
  assert.equal(FEATURE_NUMBER_DEFAULTS.backgroundCallsPerHour, 600);
  const budget =
    await import("../../packages/server/src/services/generation/background-call-budget.js");
  budget.resetBackgroundCallBudgetForTests();
  resetFeatureSettingsForTests({
    backgroundCallCap: true,
    backgroundCallsPerHour: 2,
  });
  assert.deepEqual(budget.tryConsumeBackgroundCall("continuity", 100), {
    allowed: true,
    used: 1,
    limit: 2,
  });
  assert.deepEqual(budget.tryConsumeBackgroundCall("repair", 200), {
    allowed: true,
    used: 2,
    limit: 2,
  });
  assert.deepEqual(budget.tryConsumeBackgroundCall("continuity", 300), {
    allowed: false,
    used: 2,
    limit: 2,
    retryAfterMs: 3_599_800,
  });
  assert.deepEqual(budget.backgroundCallBudgetSnapshot(100 + 60 * 60 * 1000), {
    used: 1,
    limit: 2,
    exhausted: false,
    bySource: { repair: 1 },
  });
  budget.resetBackgroundCallBudgetForTests();

  // ── absent = OFF ──
  resetFeatureSettingsForTests();
  for (const name of FEATURE_SWITCH_NAMES)
    assert.equal(isFeatureEnabled(name), false, `${name} is off by default`);
  assert.equal(
    getFeatureNumber("backgroundCallsPerHour"),
    600,
    "the saved budget cap has a usable default",
  );
  assert.equal(
    isFeatureEnabled("usageAndActivationStats"),
    false,
    "lorebook activation collection is opt-in",
  );

  resetFeatureSettingsForTests({ inventoryBrowsing: true });
  assert.equal(isFeatureEnabled("inventoryBrowsing"), true, "the new feature can be enabled independently");
  resetFeatureSettingsForTests({ inventoryBrowsing: false });
  assert.equal(isFeatureEnabled("inventoryBrowsing"), false, "the new feature can be disabled again");

  resetFeatureSettingsForTests({ gameGuide: true });
  assert.equal(isFeatureEnabled("gameGuide"), true, "the new feature can be enabled independently");
  resetFeatureSettingsForTests({ gameGuide: false });
  assert.equal(isFeatureEnabled("gameGuide"), false, "the new feature can be disabled again");

  // ── env precedence: set wins both ways, unset or blank falls through ──
  resetFeatureSettingsForTests({ promptInspector: true });
  assert.equal(isFeatureEnabled("promptInspector"), true);
  resetFeatureSettingsForTests({ promptInspector: false });
  assert.equal(isFeatureEnabled("promptInspector"), false);
  resetFeatureSettingsForTests({ stableLorebookGroupPicks: false, providerRetry: true });
  assert.equal(isFeatureEnabled("providerRetry"), true, "a saved on applies");
  assert.equal(
    isFeatureEnabled("providerDiagnostics"),
    false,
    "provider diagnostics stays off unless explicitly enabled",
  );
  process.env.LOREBOOK_STABLE_GROUP_WINNERS = "true";
  assert.equal(
    isFeatureEnabled("stableLorebookGroupPicks"),
    true,
    "env on beats a saved off",
  );
  process.env.PROVIDER_RETRY_TRANSIENT_ERRORS = "false";
  assert.equal(
    isFeatureEnabled("providerRetry"),
    false,
    "env off beats a saved on",
  );
  process.env.PROVIDER_RETRY_TRANSIENT_ERRORS = "  ";
  assert.equal(
    isFeatureEnabled("providerRetry"),
    true,
    "a blank env var counts as unset",
  );
  assert.deepEqual(features.featureEnvOverrides(), {
    stableLorebookGroupPicks: "LOREBOOK_STABLE_GROUP_WINNERS",
  });
  delete process.env.LOREBOOK_STABLE_GROUP_WINNERS;
  delete process.env.PROVIDER_RETRY_TRANSIENT_ERRORS;
  resetFeatureSettingsForTests();

  // ── change listeners: run on every change, a throwing one does not break the writer ──
  let notified = 0;
  const stopThrowing = onFeatureSettingsChange(() => {
    throw new Error("listener failure fixture");
  });
  const stop = onFeatureSettingsChange(() => {
    notified += 1;
  });
  resetFeatureSettingsForTests({ providerRetry: true });
  assert.equal(notified, 1);
  stop();
  stopThrowing();
  resetFeatureSettingsForTests();
  assert.equal(notified, 1, "an unsubscribed listener is not called");

  // ── routes + storage invalidation ──
  const requireServer = createRequire(
    new URL("../../packages/server/package.json", import.meta.url),
  );
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { appSettingsRoutes } = await import("../../packages/server/src/routes/app-settings.routes.js");
  const { gamePrepBoardRoutes } = await import("../../packages/server/src/routes/game-prep-board.routes.js");
  const { gameToolsRoutes } = await import("../../packages/server/src/routes/game-tools.routes.js");
  const { randomTablesRoutes } = await import("../../packages/server/src/routes/random-tables.routes.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { chats, gameDiceRolls } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameDiceRollsStorage, recordGameDiceRollsSafely } =
    await import("../../packages/server/src/services/storage/game-dice-rolls.storage.js");
  const { createGamePrepBoardsStorage } =
    await import("../../packages/server/src/services/storage/game-prep-boards.storage.js");
  const { createRandomTablesStorage } =
    await import("../../packages/server/src/services/storage/random-tables.storage.js");
  const { createAppSettingsStorage } =
    await import("../../packages/server/src/services/storage/app-settings.storage.js");
  const db = await getDB();
  const storage = createAppSettingsStorage(db);
  // A value saved before startup is loaded when the routes register.
  await storage.set(
    FEATURE_SETTINGS_KEY,
    JSON.stringify({ stableLorebookGroupPicks: true }),
  );
  resetFeatureSettingsForTests();
  assert.equal(isFeatureEnabled("stableLorebookGroupPicks"), false);

  const fastify = Fastify();
  fastify.decorate("db", db);
  await fastify.register(appSettingsRoutes, { prefix: "/api/app-settings" });
  await fastify.register(gamePrepBoardRoutes, { prefix: "/api/prep-board" });
  await fastify.register(randomTablesRoutes, { prefix: "/api/random-tables" });
  await fastify.register(gameToolsRoutes, { prefix: "/api/game-tools" });
  app = fastify as unknown as TestApp;
  await app.ready();
  assert.equal(
    isFeatureEnabled("stableLorebookGroupPicks"),
    true,
    "startup primes the cache",
  );

  const read = await app.inject({
    method: "GET",
    url: "/api/app-settings/features",
  });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), {
    settings: { stableLorebookGroupPicks: true },
    envOverrides: {},
    effective: {},
  });

  const saved = await app.inject({
    method: "PUT",
    url: "/api/app-settings/features",
    payload: { providerRetry: true },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().settings, { providerRetry: true });
  assert.equal(
    isFeatureEnabled("providerRetry"),
    true,
    "a save takes effect at once",
  );
  assert.equal(
    isFeatureEnabled("stableLorebookGroupPicks"),
    false,
    "omitted keys return to the default (off)",
  );
  assert.equal(
    JSON.parse((await storage.get(FEATURE_SETTINGS_KEY))!).providerRetry,
    true,
    "persisted",
  );

  const bad = await app.inject({
    method: "PUT",
    url: "/api/app-settings/features",
    payload: { providerRetry: "on" },
  });
  // The app error handler maps the ZodError to 400; this bare Fastify answers 500. Either way it is refused.
  assert.ok(bad.statusCode >= 400, "invalid values are rejected");
  const unknown = await app.inject({
    method: "PUT",
    url: "/api/app-settings/features",
    payload: { surprise: true },
  });
  assert.ok(unknown.statusCode >= 400, "unknown keys are rejected");
  assert.equal(
    isFeatureEnabled("providerRetry"),
    true,
    "a rejected save keeps the old value",
  );

  const savedWithTrash = await app.inject({
    method: "PUT",
    url: "/api/app-settings/features",
    payload: { providerRetry: true, messageTrash: true, privateNotebook: true, providerDiagnostics: true },
  });
  assert.equal(savedWithTrash.statusCode, 200);
  assert.deepEqual(savedWithTrash.json().settings, { providerRetry: true, messageTrash: true, privateNotebook: true, providerDiagnostics: true });
  assert.equal(isFeatureEnabled("messageTrash"), true, "a saved trash switch takes effect at once");
  assert.equal(isFeatureEnabled("privateNotebook"), true, "the notebook setting takes effect at once");
  assert.equal(isFeatureEnabled("providerDiagnostics"), true, "the diagnostics setting takes effect at once");
  assert.equal(JSON.parse((await storage.get(FEATURE_SETTINGS_KEY))!).messageTrash, true, "messageTrash persists");
  assert.equal(
    JSON.parse((await storage.get(FEATURE_SETTINGS_KEY))!).providerDiagnostics,
    true,
    "diagnostics persists",
  );

  // A switch pinned by an env var reports the value in effect, so the locked toggle shows it.
  await app.inject({
    method: "PUT",
    url: "/api/app-settings/features",
    payload: { providerRetry: true },
  });
  assert.equal(
    isFeatureEnabled("messageTrash"),
    false,
    "an omitted trash switch returns to the default (off)",
  );
  assert.equal(isFeatureEnabled("providerDiagnostics"), false, "omitting diagnostics restores the default (off)");
  process.env.PROVIDER_RETRY_TRANSIENT_ERRORS = "false";
  const pinned = (
    await app.inject({ method: "GET", url: "/api/app-settings/features" })
  ).json();
  assert.equal(pinned.settings.providerRetry, true, "the saved value is kept");
  assert.equal(
    pinned.effective.providerRetry,
    false,
    "the env value is what is in effect",
  );
  assert.equal(
    pinned.envOverrides.providerRetry,
    "PROVIDER_RETRY_TRANSIENT_ERRORS",
  );
  delete process.env.PROVIDER_RETRY_TRANSIENT_ERRORS;

  // Any writer through app-settings storage refreshes the cache; removing the key restores defaults.
  await storage.set(FEATURE_SETTINGS_KEY, "not json");
  assert.equal(
    isFeatureEnabled("providerRetry"),
    false,
    "bad JSON falls back to defaults",
  );
  await storage.set(
    FEATURE_SETTINGS_KEY,
    JSON.stringify({ providerRetry: true }),
  );
  assert.equal(isFeatureEnabled("providerRetry"), true);
  await storage.remove(FEATURE_SETTINGS_KEY);
  assert.equal(isFeatureEnabled("providerRetry"), false);
  await storage.set(FEATURE_SETTINGS_KEY, "{}");
  for (const name of FEATURE_SWITCH_NAMES)
    assert.equal(isFeatureEnabled(name), false, `${name}: empty object is off`);

  // A raw row write that bypasses app-settings storage (Professor Mari's generic DB commands) is
  // picked up by reloadFeatureSettingsIfTouched; unrelated rows leave the cache alone.
  const { appSettings } =
    await import("../../packages/server/src/db/schema/index.js");
  const raw = JSON.stringify({ stableLorebookGroupPicks: true });
  await db
    .insert(appSettings)
    .values({ key: FEATURE_SETTINGS_KEY, value: raw, updatedAt: "x" })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: raw } });
  assert.equal(
    isFeatureEnabled("stableLorebookGroupPicks"),
    false,
    "a raw write alone does not reach the cache",
  );
  assert.equal(
    await features.reloadFeatureSettingsIfTouched(
      [{ table: "chats", id: "features" }],
      storage,
    ),
    false,
  );
  assert.equal(isFeatureEnabled("stableLorebookGroupPicks"), false);
  assert.equal(
    await features.reloadFeatureSettingsIfTouched(
      [{ table: "app_settings", id: FEATURE_SETTINGS_KEY }],
      storage,
    ),
    true,
  );
  assert.equal(
    isFeatureEnabled("stableLorebookGroupPicks"),
    true,
    "Mari-style writes refresh the cache",
  );
  await storage.remove(FEATURE_SETTINGS_KEY);

  // The generic key route does not expose it (the typed route validates).
  const generic = await app.inject({
    method: "PUT",
    url: "/api/app-settings/other",
    payload: { value: "{}" },
  });
  assert.equal(generic.statusCode, 404);

  // The three authoring features fail closed independently, then preserve data across OFF/ON.
  const setFeatureSettings = async (settings: Record<string, boolean>) => {
    const response = await app!.inject({ method: "PUT", url: "/api/app-settings/features", payload: settings });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const expectFeatureDisabled = async (response: Awaited<ReturnType<TestApp["inject"]>>, feature: string) => {
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), { error: "Feature is disabled", code: "FEATURE_DISABLED", feature });
  };
  const featureChatId = "feature-gate-game";
  const createdAt = new Date().toISOString();
  await db.insert(chats).values({
    id: featureChatId,
    name: "Feature Gate Game",
    mode: "game",
    groupId: "feature-gate-game",
    metadata: JSON.stringify({ gameId: "feature-gate-game", gameSessionNumber: 1 }),
    createdAt,
    updatedAt: createdAt,
  });
  await setFeatureSettings({});

  await expectFeatureDisabled(
    await app.inject({ method: "GET", url: `/api/prep-board?chatId=${featureChatId}` }),
    "gamePrepBoard",
  );
  await expectFeatureDisabled(
    await app.inject({
      method: "PUT",
      url: "/api/prep-board",
      payload: { chatId: featureChatId, revision: 0, board: {} },
    }),
    "gamePrepBoard",
  );
  await expectFeatureDisabled(await app.inject({ method: "GET", url: "/api/random-tables" }), "randomTables");
  await expectFeatureDisabled(
    await app.inject({
      method: "POST",
      url: "/api/random-tables",
      payload: { table: { name: "off", rows: [{ text: "x" }] } },
    }),
    "randomTables",
  );
  await expectFeatureDisabled(
    await app.inject({ method: "GET", url: `/api/game-tools/dice-log?chatId=${featureChatId}` }),
    "diceLog",
  );

  await setFeatureSettings({ gamePrepBoard: true });
  const firstBoard = createDefaultPrepBoard(1);
  const boardSave = await app.inject({
    method: "PUT",
    url: "/api/prep-board",
    payload: { chatId: featureChatId, revision: 0, board: firstBoard },
  });
  assert.equal(boardSave.statusCode, 200, boardSave.body);
  await expectFeatureDisabled(await app.inject({ method: "GET", url: "/api/random-tables" }), "randomTables");
  await expectFeatureDisabled(
    await app.inject({ method: "GET", url: `/api/game-tools/dice-log?chatId=${featureChatId}` }),
    "diceLog",
  );
  await setFeatureSettings({});
  await expectFeatureDisabled(
    await app.inject({ method: "DELETE", url: `/api/prep-board?chatId=${featureChatId}` }),
    "gamePrepBoard",
  );
  assert.equal((await createGamePrepBoardsStorage(db).get("feature-gate-game"))?.revision, 1);
  await setFeatureSettings({ gamePrepBoard: true });
  assert.equal(
    (await app.inject({ method: "GET", url: `/api/prep-board?chatId=${featureChatId}` })).json().revision,
    1,
  );

  await setFeatureSettings({ randomTables: true });
  await expectFeatureDisabled(
    await app.inject({ method: "GET", url: `/api/prep-board?chatId=${featureChatId}` }),
    "gamePrepBoard",
  );
  const tableCreate = await app.inject({
    method: "POST",
    url: "/api/random-tables",
    payload: { table: { name: "Feature Gate Table", rows: [{ text: "retained" }] } },
  });
  assert.equal(tableCreate.statusCode, 200, tableCreate.body);
  const tableId = tableCreate.json().id as string;
  assert.ok(tableId);
  await setFeatureSettings({});
  await expectFeatureDisabled(await app.inject({ method: "GET", url: "/api/random-tables" }), "randomTables");
  await expectFeatureDisabled(
    await app.inject({ method: "DELETE", url: `/api/random-tables/${tableId}` }),
    "randomTables",
  );
  assert.equal((await createRandomTablesStorage(db).getById(tableId))?.name, "Feature Gate Table");
  await setFeatureSettings({ randomTables: true });
  assert.ok(
    (await app.inject({ method: "GET", url: "/api/random-tables" }))
      .json()
      .tables.some((table: { id: string }) => table.id === tableId),
  );

  await setFeatureSettings({ diceLog: true });
  await expectFeatureDisabled(
    await app.inject({ method: "GET", url: `/api/prep-board?chatId=${featureChatId}` }),
    "gamePrepBoard",
  );
  const rollPayload = {
    source: "player",
    chatId: featureChatId,
    result: { notation: "1d6", rolls: [4], modifier: 0, total: 4 },
  };
  const rollWrite = await app.inject({ method: "POST", url: "/api/game-tools/dice-log", payload: rollPayload });
  assert.equal(rollWrite.statusCode, 200, rollWrite.body);
  assert.equal(rollWrite.json().recorded, 1);
  const diceCountBeforeOff = (await db.select().from(gameDiceRolls)).length;
  await setFeatureSettings({});
  await expectFeatureDisabled(
    await app.inject({ method: "GET", url: `/api/game-tools/dice-log?chatId=${featureChatId}` }),
    "diceLog",
  );
  await expectFeatureDisabled(
    await app.inject({ method: "POST", url: "/api/game-tools/dice-log", payload: rollPayload }),
    "diceLog",
  );
  const { diceResultLogEntry } = await import("../../packages/server/src/services/game/dice-roll-log.js");
  const logEntry = diceResultLogEntry(rollPayload.result, "player")!;
  assert.equal(
    await recordGameDiceRollsSafely(db, featureChatId, [logEntry]),
    0,
    "automatic server writes stop at the storage boundary",
  );
  assert.equal(
    (await db.select().from(gameDiceRolls)).length,
    diceCountBeforeOff,
    "OFF preserves history and adds no rows",
  );
  await setFeatureSettings({ diceLog: true });
  assert.equal(
    (await app.inject({ method: "GET", url: `/api/game-tools/dice-log?chatId=${featureChatId}` })).json().total,
    1,
  );
  await setFeatureSettings({});

  console.log("feature-settings regression passed");
} finally {
  await app?.close();
  const { closeDB } =
    await import("../../packages/server/src/db/connection.js");
  await closeDB().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}
