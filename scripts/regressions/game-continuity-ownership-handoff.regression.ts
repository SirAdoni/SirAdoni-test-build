import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  keeperDisabledByContinuity,
  readContinuityOwnership,
} from "../../packages/server/src/services/game/continuity-ownership.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-game-continuity-ownership-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

// ── Pure Keeper gate decision ──
const continuityOwned = { lorebook: "continuity" as const, fromSession: 5 };
const keeperOwned = { lorebook: "keeper" as const, fromSession: 5 };
// Absent ownership keeps the wholesale gate.
assert.equal(keeperDisabledByContinuity({ continuityActive: true, ownership: null, sessionNumber: 1 }), true);
assert.equal(keeperDisabledByContinuity({ continuityActive: true, ownership: null, sessionNumber: 99 }), true);
// Continuity not active: Keeper always runs.
assert.equal(keeperDisabledByContinuity({ continuityActive: false, ownership: null, sessionNumber: 1 }), false);
assert.equal(keeperDisabledByContinuity({ continuityActive: false, ownership: continuityOwned, sessionNumber: 9 }), false);
// Keeper ownership: Keeper keeps running while continuity is active.
assert.equal(keeperDisabledByContinuity({ continuityActive: true, ownership: keeperOwned, sessionNumber: 1 }), false);
assert.equal(keeperDisabledByContinuity({ continuityActive: true, ownership: keeperOwned, sessionNumber: 9 }), false);
// Continuity ownership from session 5: session 4 keeps the Keeper, session 5 disables it.
assert.equal(keeperDisabledByContinuity({ continuityActive: true, ownership: continuityOwned, sessionNumber: 4 }), false);
assert.equal(keeperDisabledByContinuity({ continuityActive: true, ownership: continuityOwned, sessionNumber: 5 }), true);
assert.equal(keeperDisabledByContinuity({ continuityActive: true, ownership: continuityOwned, sessionNumber: 6 }), true);

// Metadata reader tolerates malformed values.
assert.deepEqual(readContinuityOwnership({ mode: "active", ownership: continuityOwned }), continuityOwned);
assert.equal(readContinuityOwnership({ mode: "active" }), null);
assert.equal(readContinuityOwnership({ ownership: { lorebook: "nobody", fromSession: 1 } }), null);
assert.equal(readContinuityOwnership({ ownership: { lorebook: "keeper", fromSession: 0 } }), null);
assert.equal(readContinuityOwnership(null), null);
assert.equal(readContinuityOwnership("active"), null);

// The automatic Keeper runner must consult the ownership-aware gate with the concluded session number.
const routeSource = readFileSync(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");
const performStart = routeSource.indexOf("async function performGameLorebookKeeperAfterConclusion");
const performEnd = routeSource.indexOf("async function runGameLorebookKeeperAfterConclusion", performStart);
assert.ok(performStart >= 0 && performEnd > performStart, "the automatic Keeper runner remains discoverable");
const performSource = routeSource.slice(performStart, performEnd);
assert.match(performSource, /keeperDisabledByContinuity\(\{[\s\S]*sessionNumber:\s*args\.sessionNumber/u);
assert.match(performSource, /ownership:\s*readContinuityOwnership\(meta\.gameContinuity\)/u);

// ── PATCH / GET routes ──
let app: { close(): Promise<void>; inject(options: Record<string, unknown>): Promise<any> } | null = null;

try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  app = await buildApp();
  await app.ready();
  const chatsStorage = createChatsStorage(await getDB());

  const created = await app.inject({
    method: "POST",
    url: "/api/chats",
    payload: { name: "Continuity ownership handoff", mode: "game", characterIds: [] },
  });
  assert.equal(created.statusCode, 200);
  const chat = created.json();
  const url = `/api/game/${chat.id}/continuity`;

  const before = await app.inject({ method: "GET", url });
  assert.equal(before.statusCode, 200);
  assert.equal(before.json().config.ownership, undefined);

  // Invalid ownership values are rejected and nothing is stored.
  for (const ownership of [
    { lorebook: "nobody", fromSession: 5 },
    { lorebook: "continuity", fromSession: 0 },
    { lorebook: "continuity", fromSession: 1.5 },
    { lorebook: "continuity" },
    { lorebook: "keeper", fromSession: 5, extra: true },
    "continuity",
  ]) {
    const rejected = await app.inject({ method: "PATCH", url, payload: { ownership } });
    assert.equal(rejected.statusCode, 400, `ownership ${JSON.stringify(ownership)} must be rejected`);
  }
  assert.equal((await app.inject({ method: "GET", url })).json().config.ownership, undefined);

  // Valid ownership is stored in gameContinuity.ownership and exposed by PATCH and GET.
  const stored = await app.inject({
    method: "PATCH",
    url,
    payload: { mode: "active", ownership: { lorebook: "continuity", fromSession: 5 } },
  });
  assert.equal(stored.statusCode, 200);
  assert.deepEqual(stored.json().config.ownership, { lorebook: "continuity", fromSession: 5 });
  assert.equal(stored.json().config.mode, "active");
  const persisted = await chatsStorage.getById(chat.id);
  const persistedMeta =
    typeof persisted!.metadata === "string" ? JSON.parse(persisted!.metadata) : (persisted!.metadata as any);
  assert.deepEqual(persistedMeta.gameContinuity.ownership, { lorebook: "continuity", fromSession: 5 });
  const fetched = await app.inject({ method: "GET", url });
  assert.deepEqual(fetched.json().config.ownership, { lorebook: "continuity", fromSession: 5 });

  // Other patches leave ownership untouched; switching to keeper ownership works; null clears it.
  const unrelated = await app.inject({ method: "PATCH", url, payload: { extractionInstructions: "durable facts" } });
  assert.deepEqual(unrelated.json().config.ownership, { lorebook: "continuity", fromSession: 5 });
  const keeper = await app.inject({ method: "PATCH", url, payload: { ownership: { lorebook: "keeper", fromSession: 1 } } });
  assert.equal(keeper.statusCode, 200);
  assert.deepEqual(keeper.json().config.ownership, { lorebook: "keeper", fromSession: 1 });
  const cleared = await app.inject({ method: "PATCH", url, payload: { ownership: null } });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().config.ownership, undefined);
  assert.equal((await app.inject({ method: "GET", url })).json().config.ownership, undefined);
  assert.equal((await app.inject({ method: "GET", url })).json().config.mode, "active");
} finally {
  if (app) await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("game-continuity-ownership-handoff regression passed");
