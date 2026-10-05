import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import {
  isTrackerFieldLocked,
  normalizeInventoryTrackerRows,
  normalizeTrackerFieldLocksForState,
  roleplayInventoryTrackerLockKey,
  toggleTrackerFieldLock,
  type PlayerStats,
} from "../../packages/shared/src/index.js";
import {
  createSourceFile,
  ScriptKind,
  ScriptTarget,
  forEachChild,
  isJsxAttribute,
  isJsxExpression,
  isJsxOpeningElement,
} from "typescript";

const fixtureDir = mkdtempSync(join(tmpdir(), "marinara-inventory-identity-"));
const previousDataDir = process.env.DATA_DIR;
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.DATA_DIR = fixtureDir;
process.env.FILE_STORAGE_DIR = join(fixtureDir, "storage");

const stats = (
  inventory: PlayerStats["inventory"],
  rows: PlayerStats["inventoryTrackerInventory"] = [],
): PlayerStats => ({
  stats: [],
  attributes: null,
  skills: {},
  inventory,
  activeQuests: [],
  status: "",
  inventoryTrackerCurrencies: [],
  inventoryTrackerEquipped: [],
  inventoryTrackerInventory: rows,
});
const snapshotState = (chatId: string, playerStats: PlayerStats) => ({
  chatId,
  messageId: "retry-turn",
  swipeIndex: 0,
  date: null,
  time: null,
  location: null,
  weather: null,
  temperature: null,
  worldCustomFields: [],
  presentCharacters: [],
  recentEvents: [],
  playerStats,
  personaStats: null,
  fieldLocks: null,
  hiddenTrackerFields: null,
  committed: true,
});
const lockState = (playerStats: PlayerStats, fieldLocks: Record<string, boolean>) => ({
  ...snapshotState("inventory-locks", playerStats),
  id: "inventory-locks",
  createdAt: new Date(0).toISOString(),
  fieldLocks,
});

function findRetryInventoryHandler(): string {
  const path = new URL("../../packages/server/src/routes/generate/retry-agents-route.ts", import.meta.url);
  const source = readFileSync(path, "utf8");
  const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let body: ts.IfStatement | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(parsed).includes('result.type === "inventory_tracker_update"')
    )
      body = node;
    if (!body) ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(body, "production retry route includes inventory tracker handler");
  return ts.transpileModule(`return (async () => { ${body.getText(parsed)} })();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

async function runProductionRetryInventoryHandler(deps: {
  snapshot: any;
  storage: ReturnType<
    typeof import("../../packages/server/src/services/storage/game-state.storage.js").createGameStateStorage
  >;
  buildLockedInventoryTrackerPatch: (...args: any[]) => any;
  events: unknown[];
  errors: unknown[];
}) {
  const handler = new Function(
    "result",
    "resolvedAgents",
    "customAgentCanApplyRetryResult",
    "loadRetryTargetGameStateSnapshot",
    "assertRetryActive",
    "buildLockedInventoryTrackerPatch",
    "parseGameStateRow",
    "parseSnapshotPlayerStats",
    "gameStateStore",
    "chatId",
    "sendSseEvent",
    "reply",
    "logger",
    findRetryInventoryHandler(),
  );
  await handler(
    { success: true, type: "inventory_tracker_update", data: { inventory: [{ name: "Rope", qty: 2 }] } },
    [],
    () => true,
    async () => deps.snapshot,
    () => {},
    deps.buildLockedInventoryTrackerPatch,
    () => null,
    (row: any) => (typeof row.playerStats === "string" ? JSON.parse(row.playerStats) : (row.playerStats ?? {})),
    deps.storage,
    "retry-chat",
    (_reply: unknown, event: unknown) => deps.events.push(event),
    {},
    { error: (...args: unknown[]) => deps.errors.push(args[0] instanceof Error ? args[0].stack : args) },
  );
}

try {
  const [
    { getDB },
    { gameStateSnapshots },
    { eq },
    { createGameStateStorage },
    { buildLockedInventoryTrackerPatch, resolveTrackerGroupUpdate },
    { reconcileInventoryItemIdentities },
  ] = await Promise.all([
    import("../../packages/server/src/db/connection.js"),
    import("../../packages/server/src/db/schema/index.js"),
    import("../../packages/server/src/db/file-query.js"),
    import("../../packages/server/src/services/storage/game-state.storage.js"),
    import("../../packages/server/src/routes/generate/generate-route-utils.js"),
    import("../../packages/server/src/services/storage/inventory-item-identity.js"),
  ]);
  const db = await getDB();
  const storage = createGameStateStorage(db);

  const sharedItem = { name: "Travel rope", description: "", quantity: 1, location: "on_person" as const };
  const oldState = snapshotState("replacement-identity", stats([sharedItem]));
  const oldSnapshotId = await storage.create(oldState);
  const oldStats = JSON.parse(String((await storage.getById(oldSnapshotId))?.playerStats)) as PlayerStats;
  const originalItemId = oldStats.inventory[0]!.itemId;
  assert.ok(originalItemId);
  await storage.create({ ...snapshotState("replacement-identity", stats([])), messageId: "later-turn" });
  const replacedSnapshotId = await storage.create({ ...oldState, playerStats: oldStats });
  const replacedStats = JSON.parse(String((await storage.getById(replacedSnapshotId))?.playerStats)) as PlayerStats;
  assert.equal(
    replacedStats.inventory[0]!.itemId,
    originalItemId,
    "regenerating an older row preserves its identity even after a later empty snapshot",
  );

  const grouped = reconcileInventoryItemIdentities(oldStats, {
    ...oldStats,
    inventoryTrackerEquipped: [{ name: sharedItem.name, itemId: originalItemId }],
    inventoryTrackerInventory: [{ name: sharedItem.name, itemId: originalItemId }],
  }) as PlayerStats;
  assert.equal(
    grouped.inventory[0]!.itemId,
    originalItemId,
    "the canonical inventory and tracker may describe the same item",
  );
  assert.equal(grouped.inventoryTrackerEquipped![0]!.itemId, originalItemId);
  assert.ok(grouped.inventoryTrackerInventory![0]!.itemId);
  assert.notEqual(
    grouped.inventoryTrackerInventory![0]!.itemId,
    originalItemId,
    "separate tracker groups cannot claim the same durable row identity",
  );

  assert.deepEqual(
    normalizeInventoryTrackerRows([
      { itemId: "row-a", name: "Sword" },
      { itemId: "row-b", name: "Sword" },
    ]).map((row) => row.itemId),
    ["row-a", "row-b"],
    "same-name rows with distinct identities stay distinct",
  );
  assert.deepEqual(
    normalizeInventoryTrackerRows([{ name: "Sword" }, { name: "sword", qty: 2 }]),
    [{ name: "Sword", qty: 3 }],
    "legacy rows keep name-based compatibility",
  );
  const forgedDuplicateIdRows = normalizeInventoryTrackerRows([
    { itemId: "forged-id", name: "Silver sword" },
    { itemId: "forged-id", name: "Gold sword" },
  ]);
  assert.equal(forgedDuplicateIdRows.length, 2, "a repeated untrusted ID cannot discard a distinct named row");
  const reconciledForgedRows = reconcileInventoryItemIdentities(null, stats([], forgedDuplicateIdRows));
  assert.equal(reconciledForgedRows?.inventoryTrackerInventory?.length, 2);
  assert.notEqual(
    reconciledForgedRows?.inventoryTrackerInventory?.[0]?.itemId,
    reconciledForgedRows?.inventoryTrackerInventory?.[1]?.itemId,
    "storage replaces unknown repeated IDs with distinct host-owned identities",
  );
  const sameNameForgedRows = normalizeInventoryTrackerRows([
    { itemId: "forged-same-name", name: "Sword", description: "Copper blade", location: "left" },
    { itemId: "forged-same-name", name: "Sword", description: "Silver blade", location: "right" },
  ]);
  assert.equal(
    sameNameForgedRows.length,
    2,
    "same-name rows with an unknown repeated ID stay intact until reconciliation",
  );
  const forgedSnapshotId = await storage.create(snapshotState("forged-chat", stats([], sameNameForgedRows)));
  const forgedSnapshot = await storage.getById(forgedSnapshotId, "forged-chat");
  assert.ok(forgedSnapshot, "storage reconciles same-name forged-ID rows into a real snapshot");
  const reconciledSameNameRows = (JSON.parse(String(forgedSnapshot.playerStats)) as PlayerStats)
    .inventoryTrackerInventory;
  assert.equal(reconciledSameNameRows?.length, 2, "storage keeps both same-name rows through identity reconciliation");
  assert.ok(reconciledSameNameRows?.[0]?.itemId && reconciledSameNameRows?.[1]?.itemId);
  assert.notEqual(
    reconciledSameNameRows?.[0]?.itemId,
    reconciledSameNameRows?.[1]?.itemId,
    "storage assigns distinct host-owned identities to newly preserved same-name rows",
  );
  assert.deepEqual(
    reconciledSameNameRows?.map((row) => [row.description, row.location]),
    [
      ["Copper blade", "left"],
      ["Silver blade", "right"],
    ],
    "same-name forged-ID rows retain their distinct details",
  );
  assert.deepEqual(
    normalizeInventoryTrackerRows(
      [
        { itemId: "known-id", name: "Potion", qty: 1 },
        { itemId: "known-id", name: "Potion", qty: 2 },
      ],
      { trustedItemIds: new Set(["known-id"]) },
    ),
    [{ itemId: "known-id", name: "Potion", qty: 3 }],
    "a trusted stable ID retains duplicate-row merge behavior",
  );

  const duplicateRows = [
    { itemId: "sword-a", name: "Sword", qty: 1 },
    { itemId: "sword-b", name: "Sword", qty: 1 },
  ];
  const duplicateStats = stats([], duplicateRows);
  const swordALock = roleplayInventoryTrackerLockKey("inventory", duplicateRows[0]!, "qty", 0);
  const swordBLock = roleplayInventoryTrackerLockKey("inventory", duplicateRows[1]!, "qty", 1);
  assert.notEqual(swordALock, swordBLock, "same-name rows use distinct stable lock keys");
  const onlySwordALocked = { [swordALock]: true };
  const duplicatePatch = buildLockedInventoryTrackerPatch({
    data: {
      inventory: [
        { itemId: "sword-a", name: "Sword", qty: 7 },
        { itemId: "sword-b", name: "Sword", qty: 8 },
      ],
    },
    snapshot: { playerStats: duplicateStats },
    lockState: lockState(duplicateStats, onlySwordALocked),
  });
  assert.deepEqual(
    duplicatePatch.values.inventoryTrackerInventory?.map((row) => row.qty),
    [1, 8],
    "locking one duplicate-name row protects only that stable item ID",
  );
  const unlockedSwordA = toggleTrackerFieldLock(onlySwordALocked, swordALock);
  assert.equal(isTrackerFieldLocked(unlockedSwordA, swordALock), false);
  const unlockedPatch = buildLockedInventoryTrackerPatch({
    data: {
      inventory: [
        { itemId: "sword-a", name: "Sword", qty: 7 },
        { itemId: "sword-b", name: "Sword", qty: 8 },
      ],
    },
    snapshot: { playerStats: duplicateStats },
    lockState: lockState(duplicateStats, unlockedSwordA),
  });
  assert.deepEqual(
    unlockedPatch.values.inventoryTrackerInventory?.map((row) => row.qty),
    [7, 8],
    "unlocking one stable row does not affect another same-name row",
  );
  const legacyLock = roleplayInventoryTrackerLockKey("inventory", { name: "Sword" }, "qty", 0);
  const migratedLegacyLocks = normalizeTrackerFieldLocksForState({ [legacyLock]: true }, lockState(duplicateStats, {}));
  assert.equal(migratedLegacyLocks[swordALock], true, "legacy name lock migrates to the first stable row");
  assert.equal(migratedLegacyLocks[swordBLock], true, "legacy name lock covers all formerly ambiguous duplicates");

  const explicitRowUpdate = resolveTrackerGroupUpdate(
    { updates: [{ itemId: "sword-b", name: "Sword", qty: 11 }] },
    duplicateRows,
    lockState(duplicateStats, {}),
    "inventory",
  );
  assert.deepEqual(
    explicitRowUpdate?.map((row) => row.qty),
    [1, 11],
    "an explicit agent update targets one duplicate-name row by stable identity",
  );
  const panelPath = new URL(
    "../../packages/client/src/features/tracker-panel/components/sections/InventoryTrackerPanel.tsx",
    import.meta.url,
  );
  const panelSource = readFileSync(panelPath, "utf8");
  const panelAst = createSourceFile(panelPath.pathname, panelSource, ScriptTarget.Latest, true, ScriptKind.TSX);
  let keyedExpression: string | undefined;
  const visitPanel = (node: import("typescript").Node) => {
    if (isJsxOpeningElement(node)) {
      const key = node.attributes.properties.find(
        (attribute) => isJsxAttribute(attribute) && attribute.name.getText(panelAst) === "key",
      );
      if (key && isJsxAttribute(key) && key.initializer && isJsxExpression(key.initializer)) {
        keyedExpression = key.initializer.expression?.getText(panelAst);
      }
    }
    if (!keyedExpression) forEachChild(node, visitPanel);
  };
  visitPanel(panelAst);
  assert.ok(keyedExpression?.includes("row.itemId"), "production tracker panel keys duplicate rows by stable ID");
  const trackerKey = new Function("row", "index", `return (${keyedExpression});`);
  assert.equal(
    trackerKey({ itemId: "stable-row", name: "Rope" }, 0),
    trackerKey({ itemId: "stable-row", name: "Rope" }, 3),
    "reordering a durable tracker row preserves its React key",
  );

  const initialId = await storage.create(snapshotState("retry-chat", stats([], [{ name: "Rope", qty: 1 }])));
  let snapshot = await storage.getById(initialId, "retry-chat");
  const initial = JSON.parse(String(snapshot?.playerStats)) as PlayerStats;
  const ropeId = initial.inventoryTrackerInventory?.[0]?.itemId;
  assert.ok(ropeId, "storage assigns host identity to a new tracker row");

  const events: unknown[] = [];
  const handlerErrors: unknown[] = [];
  await runProductionRetryInventoryHandler({
    snapshot,
    storage,
    buildLockedInventoryTrackerPatch,
    events,
    errors: handlerErrors,
  });
  const persisted = await storage.getById(initialId, "retry-chat");
  assert.ok(persisted, "retry writes its exact chat-scoped snapshot");
  const saved = JSON.parse(String(persisted.playerStats)) as PlayerStats;
  assert.equal(
    saved.inventoryTrackerInventory?.[0]?.itemId,
    ropeId,
    "retry snapshot identity survives an unambiguous name update",
  );
  assert.equal(saved.inventoryTrackerInventory?.[0]?.qty, 2, "retry quantity is durably stored");
  assert.equal(
    events.length,
    1,
    `the production retry handler emits one game-state patch after persistence: ${JSON.stringify({ events, handlerErrors })}`,
  );
  assert.equal(handlerErrors.length, 0, "the production retry handler did not swallow a persistence error");
  const lockedRetryPatch = buildLockedInventoryTrackerPatch({
    data: { inventory: [{ name: "Rope", qty: 9 }] },
    snapshot: persisted,
    lockState: {
      playerStats: saved,
      fieldLocks: { [roleplayInventoryTrackerLockKey("inventory", { name: "Rope" }, "qty", 0)]: true },
    } as any,
  });
  assert.equal(
    lockedRetryPatch.playerStats.inventoryTrackerInventory?.[0]?.qty,
    2,
    "tracker field locks remain authoritative on retry",
  );

  snapshot = await storage.getById(initialId, "retry-chat");
  await db
    .update(gameStateSnapshots)
    .set({ fieldLocks: '{"player":{"status":{"locked":true}}}' })
    .where(eq(gameStateSnapshots.id, initialId));
  await assert.rejects(
    () =>
      storage.updatePlayerStatsAtSnapshot(
        initialId,
        "retry-chat",
        stats([], [{ name: "Stale overwrite", qty: 99 }]),
        null,
        { playerStats: snapshot!.playerStats, fieldLocks: snapshot!.fieldLocks },
      ),
    /GAME_STATE_INVENTORY_CONFLICT/,
    "stale retry rejects if either playerStats or fieldLocks changed",
  );
  const staleSnapshot = snapshot!;
  const staleEvents: unknown[] = [];
  const staleErrors: unknown[] = [];
  await runProductionRetryInventoryHandler({
    snapshot: staleSnapshot,
    storage,
    buildLockedInventoryTrackerPatch,
    events: staleEvents,
    errors: staleErrors,
  });
  assert.equal(staleEvents.length, 0, "the real route branch sends no patch after stale persistence is rejected");
  assert.equal(staleErrors.length, 1, "the real route branch records the rejected retry write");
  assert.equal(
    await storage.updatePlayerStatsAtSnapshot(initialId, "other-chat", stats([], [])),
    null,
    "wrong chat cannot target a snapshot",
  );
  const current = await storage.getById(initialId, "retry-chat");
  await db
    .update(gameStateSnapshots)
    .set({ playerStats: JSON.stringify({ ...JSON.parse(String(current?.playerStats)), status: "newer" }) })
    .where(eq(gameStateSnapshots.id, initialId));
  await assert.rejects(
    () =>
      storage.updatePlayerStatsAtSnapshot(initialId, "retry-chat", stats([], []), null, {
        playerStats: current!.playerStats,
        fieldLocks: current!.fieldLocks,
      }),
    /GAME_STATE_INVENTORY_CONFLICT/,
    "stale retry rejects when playerStats changed even if fieldLocks did not",
  );

  const trustedId = await storage.create(
    snapshotState(
      "trusted-chat",
      stats([{ name: "Blade", description: "", quantity: 1, location: "on_person", itemId: ropeId }]),
    ),
    null,
    { trustedInventoryIdentitySource: { snapshotId: initialId, chatId: "retry-chat" } },
  );
  const trusted = JSON.parse(String((await storage.getById(trustedId))?.playerStats)) as PlayerStats;
  assert.equal(
    trusted.inventory[0]?.itemId,
    ropeId,
    "an exact chat/snapshot source preserves known IDs in a retry branch",
  );
  await assert.rejects(
    () =>
      storage.create(
        snapshotState(
          "wrong-source-chat",
          stats([{ name: "Blade", description: "", quantity: 1, location: "on_person", itemId: ropeId }]),
        ),
        null,
        { trustedInventoryIdentitySource: { snapshotId: initialId, chatId: "wrong-chat" } },
      ),
    /GAME_STATE_TRUSTED_INVENTORY_SOURCE_NOT_FOUND/,
  );

  const ambiguous = await storage.create(
    snapshotState(
      "ambiguous-chat",
      stats([
        { name: "Twin", description: "", quantity: 1, location: "on_person" },
        { name: " twin ", description: "", quantity: 1, location: "stored" },
      ]),
    ),
  );
  const twins = JSON.parse(String((await storage.getById(ambiguous))?.playerStats)) as PlayerStats;
  assert.equal(twins.inventory[0]?.itemId, undefined, "duplicate legacy names remain ambiguous");
  assert.equal(twins.inventory[1]?.itemId, undefined, "ambiguous legacy row is not assigned a guessed ID");

  console.info("Inventory identity regression passed");
} finally {
  const { closeDB } = await import("../../packages/server/src/db/connection.js");
  await closeDB();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(fixtureDir, { recursive: true, force: true });
}
