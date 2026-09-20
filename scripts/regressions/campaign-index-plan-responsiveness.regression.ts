import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

// The campaign index plan runs an owner-import preview for every session of a game, seconds of synchronous
// work each. It must yield to the event loop between sessions: before this, the plan held the Engine's only
// thread for about twenty seconds, so avatars, status polls and the chat itself stalled until the browser tab
// looked frozen. A setImmediate ticker counts how many event-loop turns other work gets while the plan runs.
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-index-plan-yield-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

let app: { close(): Promise<void>; inject(options: unknown): Promise<{ statusCode: number; json(): unknown }> } | null =
  null;
let runtime: { stop(): Promise<void> } | null = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { campaignIndexRoutes } = await import("../../packages/server/src/routes/campaign-index.routes.js");

  const db = await createFileNativeDB();
  const now = Date.parse("2026-09-16T00:00:00.000Z");
  const at = (seconds: number) => new Date(now + seconds * 1000).toISOString();
  await db.insert(apiConnections).values({
    id: "plan-connection",
    name: "Plan responsiveness connection",
    provider: "openai",
    model: "fake-model",
    defaultForAgents: "true",
    createdAt: at(0),
    updatedAt: at(0),
  });
  const SESSIONS = 6;
  for (let session = 1; session <= SESSIONS; session += 1) {
    const chatId = `plan-s${session}`;
    await db.insert(chats).values({
      id: chatId,
      name: `Plan game session ${session}`,
      mode: "game",
      groupId: "plan-game",
      connectionId: "plan-connection",
      metadata: JSON.stringify({ gameId: "plan-game", gameSessionNumber: session, gameContinuity: { mode: "off" } }),
      createdAt: at(session * 100),
      updatedAt: at(session * 100),
    });
    await db.insert(messages).values([
      { id: `${chatId}-u`, chatId, role: "user", content: "We ride for the capital.", createdAt: at(session * 100 + 1) },
      { id: `${chatId}-a`, chatId, role: "assistant", content: "The road is long.", createdAt: at(session * 100 + 2) },
      { id: `${chatId}-u2`, chatId, role: "user", content: "Onward.", createdAt: at(session * 100 + 3) },
    ]);
  }

  const continuity = createGameContinuityRuntime(db, {
    complete: (async () => ({ records: [], dispositions: [] })) as never,
  });
  runtime = continuity;
  const instance = Fastify();
  instance.decorate("db", db);
  instance.decorate("gameContinuity", continuity);
  await instance.register(campaignIndexRoutes, { prefix: "/api/game" });
  await instance.ready();
  app = instance;

  // Count event-loop turns granted to other work while the plan is computed.
  let turns = 0;
  let ticking = true;
  const tick = () => {
    if (!ticking) return;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  const response = await instance.inject({ method: "GET", url: "/api/game/campaign-index/plan?gameId=plan-game" });
  ticking = false;

  assert.equal(response.statusCode, 200, "the plan still answers");
  const games = (response.json() as { games: Array<{ chats: unknown[] }> }).games;
  assert.equal(games[0]?.chats.length, SESSIONS, "every session is described");
  assert.ok(
    turns >= SESSIONS - 1,
    `other requests get the event loop between sessions (${turns} turns for ${SESSIONS} sessions)`,
  );

  console.log("campaign-index-plan-responsiveness regression passed");
} finally {
  await app?.close().catch(() => undefined);
  await runtime?.stop().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
