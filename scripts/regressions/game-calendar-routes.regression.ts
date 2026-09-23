import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The calendar routes keep the calendar in chat metadata and move the one Game Mode clock (gameTime).
const root = mkdtempSync(join(tmpdir(), "marinara-game-calendar-"));
process.env.DATA_DIR = root;
// The repo's .env points FILE_STORAGE_DIR at the live data; without this the test would open it.
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

async function main() {
  // ── Wiring: registered route, Tools tab section, palette command, docs nav ──
  assert.match(
    read("../../packages/server/src/routes/index.ts"),
    /gameCalendarRoutes, \{ prefix: "\/api\/game-calendar" \}/,
  );
  assert.match(
    read("../../packages/client/src/components/game/GameToolsPanel.tsx"),
    /<GameCalendarTool chatId=\{chatId\} \/>/,
  );
  assert.match(
    read("../../packages/client/src/components/command-palette/CommandPaletteHost.tsx"),
    /id: "action:game-calendar"/,
  );
  assert.match(
    read("../../packages/server/src/routes/docs.routes.ts"),
    /"map-time-weather\.md",\r?\n\s+"calendar\.md",/,
  );
  // The GM prompt reads the time line through the calendar-aware helper (byte-identical without a calendar).
  assert.match(
    read("../../packages/server/src/services/generation/game-gm-prompt-runtime.ts"),
    /gameTime = composeGameTimeLine\(snap, args\.chatMetadata\)/,
  );

  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats } = await import("../../packages/server/src/db/schema/index.js");
  const { gameCalendarRoutes } = await import("../../packages/server/src/routes/game-calendar.routes.js");
  const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");

  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values({
    id: "session-1",
    name: "Test game",
    mode: "game",
    groupId: "game-1",
    metadata: JSON.stringify({ gameId: "game-1", gameTime: { day: 3, hour: 14, minute: 30 }, gameWeather: "rain" }),
    createdAt,
    updatedAt: createdAt,
  });
  await db
    .insert(chats)
    .values({ id: "rp-1", name: "Roleplay", mode: "roleplay", metadata: "{}", createdAt, updatedAt: createdAt });
  const gameStates = createGameStateStorage(db);
  await gameStates.create({
    chatId: "session-1",
    messageId: "",
    swipeIndex: 0,
    date: null,
    time: "Day 3, 14:30 (afternoon)",
    location: null,
    weather: null,
    temperature: null,
    presentCharacters: [],
    recentEvents: [],
    playerStats: null,
    personaStats: null,
  } as never);

  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameCalendarRoutes, { prefix: "/api/game-calendar" });
  await app.ready();
  const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url: `/api/game-calendar${url}`, payload: payload as never });
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
  };
  const metadata = async () => {
    const chat = await createChatsStorage(db).getById("session-1");
    return JSON.parse(String(chat!.metadata)) as Record<string, any>;
  };

  try {
    // A game without a calendar reads a switched-off default and its real clock.
    const initial = await call("GET", "/session-1");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.calendar.enabled, false);
    assert.deepEqual(initial.body.clock, { day: 3, hour: 14, minute: 30 });
    assert.equal((await call("GET", "/rp-1")).status, 404, "only game chats have a calendar");
    assert.equal((await call("GET", "/missing")).status, 404);

    // Saving sanitizes and never touches the clock or other metadata.
    const saved = await call("PUT", "/session-1", {
      calendar: {
        enabled: true,
        config: {
          months: [
            { name: "Seedfall", days: 30 },
            { name: "Emberwane", days: 30 },
          ],
          weekdays: ["Oneday", "Twoday", "Threeday", "Fourday", "Restday"],
          era: "AR",
          startDate: { year: 88, month: 0, day: 29 },
        },
        events: [
          { id: "fair", title: "Lantern Fair", date: { year: 88, month: 1, day: 3 } },
          { title: "  ", date: { year: 88, month: 1, day: 3 } },
        ],
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.calendar.enabled, true);
    assert.equal(saved.body.calendar.events.length, 1, "blank events are dropped");
    let meta = await metadata();
    assert.deepEqual(meta.gameTime, { day: 3, hour: 14, minute: 30 });
    assert.equal(meta.gameWeather, "rain");
    assert.equal(meta.gameCalendar.config.era, "AR");
    assert.equal((await call("PUT", "/session-1", { nope: true })).status, 200, "a missing calendar saves the default");
    await call("PUT", "/session-1", { calendar: saved.body.calendar });

    // Advancing days moves gameTime.day (hour and minute kept) and the snapshot's time label.
    const advanced = await call("POST", "/session-1/advance", { days: 5 });
    assert.equal(advanced.status, 200);
    assert.deepEqual(advanced.body.clock, { day: 8, hour: 14, minute: 30 });
    assert.equal(advanced.body.formattedTime, "Day 8, 14:30 (afternoon)");
    meta = await metadata();
    assert.deepEqual(meta.gameTime, { day: 8, hour: 14, minute: 30 });
    assert.equal((await gameStates.getLatest("session-1"))!.time, "Day 8, 14:30 (afternoon)");

    // Negative advance, clamped at Day 1.
    assert.deepEqual((await call("POST", "/session-1/advance", { days: -2 })).body.clock.day, 6);
    assert.deepEqual((await call("POST", "/session-1/advance", { days: -50 })).body.clock.day, 1);
    assert.equal((await call("POST", "/session-1/advance", { days: 0 })).status, 400);
    assert.equal((await call("POST", "/session-1/advance", { days: 1.5 })).status, 400);

    // Setting a date after Day 1 moves only the clock: startDate is 29 Seedfall, so 3 Emberwane is Day 5.
    const set = await call("POST", "/session-1/date", { date: { year: 88, month: 1, day: 3 } });
    assert.equal(set.status, 200);
    assert.equal(set.body.clock.day, 5);
    assert.deepEqual(set.body.calendar.config.startDate, { year: 88, month: 0, day: 29 });
    // A date before Day 1 moves the calendar's start there instead and puts the clock on Day 1.
    const rewound = await call("POST", "/session-1/date", { date: { year: 88, month: 0, day: 20 } });
    assert.equal(rewound.body.clock.day, 1);
    assert.deepEqual(rewound.body.calendar.config.startDate, { year: 88, month: 0, day: 20 });
    meta = await metadata();
    assert.equal(meta.gameCalendar.events[0].title, "Lantern Fair", "events survive a start move");
    assert.equal((await call("POST", "/session-1/date", { date: { year: "x" } })).status, 400);

    // A game with no clock yet starts from the default Day 1, 08:00 like /game/time/advance.
    await db.insert(chats).values({
      id: "session-2",
      name: "Fresh game",
      mode: "game",
      metadata: "{}",
      createdAt,
      updatedAt: createdAt,
    });
    assert.deepEqual((await call("POST", "/session-2/advance", { days: 2 })).body.clock, {
      day: 3,
      hour: 8,
      minute: 0,
    });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
  console.log("game calendar routes regression passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
