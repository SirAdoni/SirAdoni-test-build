import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Campaign log reader: the Game screen shows one beat at a time and has no per-message anchors,
// so jumps to a game message open a full campaign log instead of a dead-end notice. The server
// returns every readable turn of the canonical line (hidden, command-only and the synthetic
// start message left out, /goto numbers kept); the client applies segment edits and deletions,
// searches with highlights, filters by session and speaker, and opens at a message.
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-log-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

try {
  const log = await import("../../packages/client/src/lib/game-log.js");

  // ── Pure display model ──
  const parse = (message: { id: string; content: string }) =>
    message.content.split("\n").map((line) => {
      const dialogue = /^(\w+): (.*)$/.exec(line);
      if (dialogue) return { type: "dialogue" as const, speaker: dialogue[1], content: dialogue[2]! };
      const note = /^\[Note: (.*)\]$/.exec(line);
      if (note) return { type: "readable" as const, content: note[1]!, readableType: "note" as const };
      return { type: "narration" as const, content: line };
    });
  const campaign = {
    sessions: [
      {
        chatId: "s1",
        number: 1,
        name: "Ember Road",
        playerName: "Lior",
        segmentEdits: { "m2:1": { content: "It was *very* late.", speaker: "ignored" }, "m2:2": { speaker: "Mira" } },
        segmentDeletes: ["m2:3"],
        messages: [
          { id: "m1", number: 2, role: "user" as const, content: "[To the GM] I open the gate.", createdAt: "a" },
          {
            id: "m2",
            number: 3,
            role: "assistant" as const,
            content: "The gate creaks.\nIt is late.\nVigil: Who goes there?\nSecret line.\n[Note: Keep out]",
            createdAt: "b",
          },
        ],
      },
      {
        chatId: "s2",
        number: 2,
        name: "Ember Road — Session 2",
        playerName: null,
        segmentEdits: {},
        segmentDeletes: [],
        messages: [
          { id: "m3", number: 1, role: "assistant" as const, content: "Vigil: The gate again. [dice: 1d20+2 = 15]", createdAt: "c" },
          { id: "m4", number: 4, role: "user" as const, content: "**Run** to the gate", createdAt: "d" },
        ],
      },
    ],
  };
  const entries = log.buildGameLogEntries(campaign, parse, { player: "You" });
  assert.deepEqual(
    entries.map((entry) => entry.messageId),
    ["m1", "m2", "m3", "m4"],
  );
  assert.deepEqual(entries[0]!.lines, [{ kind: "player", speaker: "Lior", text: "I open the gate." }]);
  assert.deepEqual(
    entries[1]!.lines.map((line) => [line.kind, line.speaker, line.text]),
    [
      ["narration", null, "The gate creaks."],
      ["narration", null, "It was very late."],
      ["dialogue", "Mira", "Who goes there?"],
      ["readable", null, "Keep out"],
    ],
    "segment edits apply (text and speaker), deleted segments are left out, emphasis is plain text",
  );
  assert.equal(entries[2]!.lines[0]!.text, "The gate again. (1d20+2 = 15)");
  assert.deepEqual(entries[3]!.lines[0], { kind: "player", speaker: "You", text: "Run to the gate" });

  const speakers = log.listLogSpeakers(entries);
  assert.equal(speakers[0]!.key, log.NARRATION_SPEAKER, "narration is offered first");
  assert.ok(speakers.some((item) => item.label === "Mira"));

  const onlyMira = log.filterLogEntries(entries, { sessionChatId: null, speaker: "mira" });
  assert.deepEqual(
    onlyMira.map((entry) => entry.lines.map((line) => line.text)),
    [["Who goes there?"]],
    "a speaker filter keeps only that speaker's lines",
  );
  assert.deepEqual(
    log.filterLogEntries(entries, { sessionChatId: "s2", speaker: null }).map((entry) => entry.messageId),
    ["m3", "m4"],
  );

  const { hits, capped } = log.findLogHits(entries, "the GATE");
  assert.equal(capped, false);
  assert.deepEqual(
    hits.map((hit) => [entries[hit.entryIndex]!.messageId, hit.lineIndex, hit.start, hit.end]),
    [
      ["m1", 0, 7, 15],
      ["m2", 0, 0, 8],
      ["m3", 0, 0, 8],
      ["m4", 0, 7, 15],
    ],
    "case-insensitive hits in reading order",
  );
  assert.deepEqual(log.findLogHits(entries, "g").hits, [], "one letter does not search");
  assert.deepEqual(log.findLogHits(entries, "(1d20").hits.length, 1, "regex characters are literal");
  assert.deepEqual(
    log.splitLogHighlights("open the gate now", [{ start: 5, end: 8, current: true }, { start: 9, end: 13 }]),
    [
      { text: "open ", highlighted: false, current: false },
      { text: "the", highlighted: true, current: true },
      { text: " ", highlighted: false, current: false },
      { text: "gate", highlighted: true, current: false },
      { text: " now", highlighted: false, current: false },
    ],
  );

  assert.deepEqual(log.findLogTarget(entries, { chatId: "s2", messageId: "m3" }), { index: 2, exact: true });
  assert.deepEqual(log.findLogTarget(entries, { chatId: "s1", messageNumber: 3 }), { index: 1, exact: true });
  assert.deepEqual(
    log.findLogTarget(entries, { chatId: "s2", messageNumber: 2 }),
    { index: 3, exact: false },
    "a hidden message opens at the next readable turn of its session",
  );
  assert.equal(log.findLogTarget(entries, { chatId: "nope", messageNumber: 1 }), null);
  assert.deepEqual(log.logWindowAround(1000, 5000, 60), { start: 980, end: 1040 });
  assert.deepEqual(log.logWindowAround(4999, 5000, 60), { start: 4940, end: 5000 });
  assert.deepEqual(log.logWindowAround(3, 10, 60), { start: 0, end: 10 });
  // Paging grows the rendered window a page at a time but never past the cap.
  assert.deepEqual(log.extendLogWindow({ start: 100, end: 160 }, 5000, "later", 60, 180), { start: 100, end: 220 });
  assert.deepEqual(log.extendLogWindow({ start: 100, end: 280 }, 5000, "later", 60, 180), { start: 160, end: 340 });
  assert.deepEqual(log.extendLogWindow({ start: 100, end: 280 }, 5000, "earlier", 60, 180), { start: 40, end: 220 });
  assert.deepEqual(log.extendLogWindow({ start: 30, end: 90 }, 100, "earlier", 60, 180), { start: 0, end: 90 });
  assert.deepEqual(log.extendLogWindow({ start: 30, end: 90 }, 100, "later", 60, 180), { start: 30, end: 100 });

  // ── Server: the campaign's readable turns over real storage ──
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { loadCampaignLog } = await import("../../packages/server/src/services/game/campaign-log.js");
  const db = await createFileNativeDB();
  const at = (minute: number) => `2026-09-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const chat = (id: string, session: number, extra: Record<string, unknown> = {}) => ({
    id,
    name: session === 1 ? "Ember Road" : `Ember Road — Session ${session}`,
    mode: "game" as const,
    groupId: "game-e",
    personaId: session === 1 ? "persona-1" : null,
    metadata: JSON.stringify({ gameId: "game-e", gameSessionNumber: session, ...extra }),
    createdAt: at(session),
    updatedAt: at(session),
  });
  await db.insert(schema.personas).values({ id: "persona-1", name: "Lior", createdAt: at(0), updatedAt: at(0) } as never);
  await db.insert(schema.chats).values([
    chat("c1", 1, { "segmentEdit:c1-m3:0": { content: "Edited." }, "segmentDelete:c1-m3:1": true, other: 1 }),
    chat("c2", 2),
    chat("c2-branch", 2, { branchName: "What if", branchParentChatId: "c2" }),
  ]);
  const message = (id: string, chatId: string, minute: number, role: string, content: string, extra = {}) => ({
    id,
    chatId,
    role,
    content,
    extra: JSON.stringify(extra),
    createdAt: at(minute),
  });
  await db.insert(schema.messages).values([
    message("c1-m1", "c1", 10, "user", "[Start the game]"),
    message("c1-m2", "c1", 11, "assistant", "hidden prompt", { hiddenFromUser: true }),
    message("c1-m3", "c1", 12, "assistant", "The gate creaks.\nA crow calls."),
    message("c1-m4", "c1", 13, "user", "I open the gate."),
    message("c1-m5", "c1", 14, "user", "/roll", { commandOnly: true }),
    message("c2-m1", "c2", 20, "assistant", "Session two begins."),
    message("cb-m1", "c2-branch", 21, "assistant", "Branch only."),
  ] as never);

  const loaded = await loadCampaignLog(db, "c2");
  assert.ok(loaded);
  assert.equal(loaded.gameName, "Ember Road");
  assert.deepEqual(
    loaded.sessions.map((session) => [session.chatId, session.number]),
    [
      ["c1", 1],
      ["c2", 2],
    ],
    "the canonical line, oldest first, without the branch",
  );
  const first = loaded.sessions[0]!;
  assert.equal(first.playerName, "Lior");
  assert.deepEqual(
    first.messages.map((item) => [item.id, item.number]),
    [
      ["c1-m3", 3],
      ["c1-m4", 4],
    ],
    "hidden, command-only and the synthetic start are left out; /goto numbers count every message",
  );
  assert.deepEqual(first.segmentEdits, { "c1-m3:0": { content: "Edited." } });
  assert.deepEqual(first.segmentDeletes, ["c1-m3:1"]);
  const fromBranch = await loadCampaignLog(db, "c2-branch");
  assert.deepEqual(
    fromBranch?.sessions.map((session) => session.chatId),
    ["c1", "c2-branch"],
    "opened from a branch, the branch stands in for its session",
  );
  assert.equal(await loadCampaignLog(db, "missing"), null);

  // A branch of an earlier session does not continue into the canonical sessions after the fork,
  // unless a later session was started from a branch of the same parent (it inherits the parent id).
  await db.insert(schema.chats).values([
    chat("c3", 3),
    chat("c1-branch", 1, { branchName: "Detour", branchParentChatId: "c1" }),
    chat("c3-from-branch", 3, { branchParentChatId: "c2" }),
    { ...chat("other-game", 2), metadata: JSON.stringify({ gameId: "game-other", gameSessionNumber: 2 }) },
    { ...chat("roleplay", 1), mode: "roleplay" as const, groupId: "rp-group", metadata: "{}" },
  ] as never);
  await db.insert(schema.messages).values([message("rp-m1", "roleplay", 30, "assistant", "Not a game.")] as never);
  assert.deepEqual(
    (await loadCampaignLog(db, "c1-branch"))?.sessions.map((session) => session.chatId),
    ["c1-branch"],
    "canonical sessions after the fork are not part of a branch's story",
  );
  assert.deepEqual(
    (await loadCampaignLog(db, "c2-branch"))?.sessions.map((session) => session.chatId),
    ["c1", "c2-branch", "c3-from-branch"],
    "a later session started from a branch of the same parent may continue it",
  );
  assert.ok(
    !(await loadCampaignLog(db, "c3"))?.sessions.some((session) => session.chatId === "other-game"),
    "a row of another game in the same group never joins the log",
  );
  assert.equal(await loadCampaignLog(db, "roleplay"), null, "the log only reads Game chats");

  // A campaign past the text budget drops its oldest sessions' turns, never the opened one.
  const cappedLog = await loadCampaignLog(db, "c2", 30);
  assert.deepEqual(
    cappedLog?.sessions.map((session) => [session.chatId, session.omitted === true, session.messages.length]),
    [
      ["c1", true, 0],
      ["c2", false, 1],
      ["c3", false, 0],
      ["c3-from-branch", false, 0],
    ],
  );
  const openedFromOldest = await loadCampaignLog(db, "c1", 1);
  assert.equal(openedFromOldest?.sessions[0]!.omitted, undefined, "the session the log was opened from is kept");

  // The route is read-only, 404s outside Game chats, and gzips a large payload when asked to.
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { gameToolsRoutes } = await import("../../packages/server/src/routes/game-tools.routes.js");
  const routeApp = Fastify();
  routeApp.decorate("db", db);
  await routeApp.register(gameToolsRoutes, { prefix: "/api/game-tools" });
  try {
    assert.equal((await routeApp.inject({ method: "GET", url: "/api/game-tools/log/roleplay" })).statusCode, 404);
    const small = await routeApp.inject({ method: "GET", url: "/api/game-tools/log/c2", headers: { "accept-encoding": "gzip" } });
    assert.equal(small.statusCode, 200);
    assert.equal(small.headers["content-encoding"], undefined, "a small log is sent as is");
    assert.equal(small.json().sessions.length, 4);
    await db.insert(schema.messages).values([
      message("c2-long", "c2", 25, "assistant", "The road goes on. ".repeat(6000)),
    ] as never);
    const plain = await routeApp.inject({ method: "GET", url: "/api/game-tools/log/c2" });
    assert.equal(plain.headers["content-encoding"], undefined, "no gzip unless the client accepts it");
    const zipped = await routeApp.inject({ method: "GET", url: "/api/game-tools/log/c2", headers: { "accept-encoding": "gzip, br" } });
    assert.equal(zipped.headers["content-encoding"], "gzip");
    assert.ok(zipped.rawPayload.length < plain.rawPayload.length / 4);
    assert.deepEqual(JSON.parse(gunzipSync(zipped.rawPayload).toString("utf8")), plain.json());
  } finally {
    await routeApp.close();
  }

  // ── Wiring ──
  const routes = read("../../packages/server/src/routes/game-tools.routes.ts");
  assert.match(routes, /app\.get<\{ Params: \{ chatId: string \} \}>\("\/log\/:chatId"/);
  const renderer = read("../../packages/client/src/components/layout/ModalRenderer.tsx");
  assert.match(renderer, /lazy\(\(\) => import\("\.\.\/modals\/GameLogModal"\)/, "the reader is lazy-loaded");
  assert.match(renderer, /case "game-log":/);
  const chatArea = read("../../packages/client/src/components/chat/ChatArea.tsx");
  assert.match(chatArea, /openGameLog\(\{ chatId: gotoRequest\.chatId, messageNumber: gotoRequest\.messageNumber \}\)/);
  assert.doesNotMatch(chatArea, /gotoUnavailableInGame/, "no dead-end notice for game jumps");
  const globalSearch = read("../../packages/client/src/components/modals/GlobalSearchModal.tsx");
  assert.match(globalSearch, /result\.chatMode === "game"\) openGameLog\(\{ chatId: result\.chatId, messageId: result\.messageId, messageNumber: result\.messageNumber \}\)/);
  const palette = read("../../packages/client/src/components/command-palette/CommandPaletteHost.tsx");
  assert.match(palette, /id: "action:open-campaign-log"[\s\S]*?when: \(\) => activeChatMode\(\) === "game"/);
  const tools = read("../../packages/client/src/components/game/GameToolsPanel.tsx");
  assert.match(tools, /openGameLog\(\{ chatId \}\)/);
  const modal = read("../../packages/client/src/components/modals/GameLogModal.tsx");
  assert.match(modal, /parseNarrationSegments/, "narration is split with the game's own parser");
  assert.doesNotMatch(modal, /—/, "no em dashes in the reader");
  const en = JSON.parse(read("../../packages/client/src/localization/locales/en.json")) as Record<string, string>;
  for (const [key, value] of Object.entries(en)) {
    if (key.startsWith("ui.game.log.") || key.startsWith("ui.game.tools.log")) {
      assert.doesNotMatch(value, /—/, `${key} has no em dash`);
    }
  }
  assert.equal(en["palette.actions.openCampaignLog"], "Open campaign log");
  await db._fileStore.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
