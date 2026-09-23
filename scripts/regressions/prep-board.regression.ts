import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// GM prep board: the pure board module (ordering, keyboard steps, carry-over,
// search, sanitizing, export/import/merge), the file-backed table and its
// registrations, the routes (per-game board shared across sessions, revision
// conflicts, survival when the last session is deleted) and the privacy
// guarantee that prompt assembly never includes the board.

const root = mkdtempSync(join(tmpdir(), "marinara-prep-board-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MARINARA_LITE = "true";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const NOW = "2026-01-01T00:00:00.000Z";

try {
  const prep = await import("../../packages/shared/src/utils/prep-board.ts");
  const {
    PREP_BOARD_DEFAULT_SECTIONS,
    PREP_BOARD_LIMITS,
    addPrepItem,
    addPrepSection,
    archiveUsedPrepItems,
    buildPrepBoardExport,
    carryOverPrepBoard,
    countPrepItems,
    createDefaultPrepBoard,
    mergePrepBoards,
    movePrepItem,
    movePrepSection,
    parsePrepBoardImport,
    parsePrepTags,
    prepSectionItems,
    prepSectionTitle,
    removePrepSection,
    renamePrepSection,
    sanitizePrepBoard,
    searchPrepBoard,
    setPrepItemArchived,
    setPrepItemDone,
    stepPrepItem,
    updatePrepItem,
  } = prep;
  type Board = ReturnType<typeof createDefaultPrepBoard>;

  const add = (board: Board, id: string, sectionId: string, text = id, extra: Record<string, unknown> = {}) =>
    addPrepItem(board, { id, sectionId, text, currentSession: 2, now: NOW, ...extra });
  const ids = (board: Board, sectionId: string, archived = false) =>
    prepSectionItems(board, sectionId, archived).map((item) => item.id);

  // ── Defaults ──
  {
    const board = createDefaultPrepBoard(3);
    assert.equal(board.session, 3);
    assert.deepEqual(
      board.sections.map((section) => section.preset),
      [...PREP_BOARD_DEFAULT_SECTIONS],
      "Lazy DM sections in order",
    );
    assert.equal(prepSectionTitle(board.sections[2]!), "Secrets and clues");
    assert.equal(
      prepSectionTitle(board.sections[2]!, () => "Localized"),
      "Localized",
    );
  }

  // ── Adding keeps sections grouped and records sessions ──
  let board = createDefaultPrepBoard(2);
  board = add(board, "a1", "scenes");
  board = add(board, "s1", "secrets", "The duke is a vampire", { tags: "#villain, duke, Villain" });
  board = add(board, "a2", "scenes");
  board = add(board, "a3", "scenes");
  assert.deepEqual(ids(board, "scenes"), ["a1", "a2", "a3"]);
  assert.deepEqual(
    board.items.map((item) => item.id),
    ["a1", "a2", "a3", "s1"],
    "a new item lands after its section's last item",
  );
  const secret = board.items.find((item) => item.id === "s1")!;
  assert.deepEqual(secret.tags, ["villain", "duke"], "tags drop # and case-insensitive duplicates");
  assert.equal(secret.createdSession, 2);
  assert.equal(secret.session, 2, "planned for the board's session");
  assert.equal(add(board, "x", "nope"), board, "unknown sections are refused");
  assert.equal(add(board, "y", "scenes", "   "), board, "blank text is refused");
  assert.equal(add(board, "a1", "scenes", "dup"), board, "duplicate ids are refused");

  // ── Ordering within and across sections ──
  {
    let moved = movePrepItem(board, "a3", "scenes", 0);
    assert.deepEqual(ids(moved, "scenes"), ["a3", "a1", "a2"]);
    moved = movePrepItem(moved, "a3", "scenes", 99);
    assert.deepEqual(ids(moved, "scenes"), ["a1", "a2", "a3"], "an index past the end appends");
    assert.equal(movePrepItem(moved, "a1", "scenes", 0), moved, "a no-op move keeps the same board");

    moved = movePrepItem(board, "a2", "secrets", 0);
    assert.deepEqual(ids(moved, "scenes"), ["a1", "a3"]);
    assert.deepEqual(ids(moved, "secrets"), ["a2", "s1"], "moved across sections, before the target");

    moved = movePrepItem(board, "a1", "npcs", 0);
    assert.deepEqual(ids(moved, "npcs"), ["a1"], "into an empty section");
    const order = moved.items.map((item) => item.sectionId);
    const ranks = order.map((sectionId) => moved.sections.findIndex((section) => section.id === sectionId));
    assert.deepEqual(
      ranks,
      [...ranks].sort((l, r) => l - r),
      "items stay grouped in section order",
    );

    // Archived items are skipped by indexes and keep their place.
    let archived = setPrepItemArchived(board, "a2", true, NOW);
    assert.deepEqual(ids(archived, "scenes"), ["a1", "a3"]);
    archived = movePrepItem(archived, "a3", "scenes", 0);
    assert.deepEqual(ids(archived, "scenes"), ["a3", "a1"]);
    assert.deepEqual(ids(archived, "scenes", true), ["a3", "a1", "a2"]);
  }

  // ── Keyboard steps cross section boundaries ──
  {
    let stepped = stepPrepItem(board, "a2", -1);
    assert.deepEqual(ids(stepped, "scenes"), ["a2", "a1", "a3"]);
    stepped = stepPrepItem(stepped, "a2", -1);
    assert.deepEqual(ids(stepped, "scenes"), ["a1", "a3"], "past the top it leaves the section");
    assert.deepEqual(ids(stepped, "strong_start"), ["a2"], "into the end of the section above");
    stepped = stepPrepItem(stepped, "a2", -1);
    assert.deepEqual(ids(stepped, "strong_start"), ["a2"], "the very top stays put");
    stepped = stepPrepItem(stepped, "a2", 1);
    assert.deepEqual(ids(stepped, "scenes"), ["a2", "a1", "a3"], "down into the start of the section below");
    let last = add(board, "n1", "notes");
    last = stepPrepItem(last, "n1", 1);
    assert.deepEqual(ids(last, "notes"), ["n1"], "the very bottom stays put");
  }

  // ── Done, archive used, carry-over ──
  {
    let played = setPrepItemDone(board, "a1", true, 3, NOW);
    assert.equal(played.items.find((item) => item.id === "a1")!.usedSession, 3, "used in the current session");
    assert.equal(
      setPrepItemDone(played, "a1", false, 3, NOW).items.find((item) => item.id === "a1")!.usedSession,
      null,
    );
    const archivedUsed = archiveUsedPrepItems(played, NOW);
    assert.equal(archivedUsed.archived, 1);
    assert.deepEqual(ids(archivedUsed.board, "scenes"), ["a2", "a3"]);

    played = setPrepItemDone(played, "s1", true, 3, NOW);
    const { board: next, carried, archived } = carryOverPrepBoard(played, NOW);
    assert.equal(next.session, 3, "the board moves on to the next session");
    assert.equal(carried, 2);
    assert.equal(archived, 2);
    for (const id of ["a2", "a3"]) {
      const item = next.items.find((entry) => entry.id === id)!;
      assert.equal(item.session, 3);
      assert.equal(item.carried, 1);
      assert.equal(item.createdSession, 2, "created session is kept");
      assert.equal(item.archived, false);
    }
    const used = next.items.find((entry) => entry.id === "a1")!;
    assert.equal(used.archived, true);
    assert.equal(used.usedSession, 3, "used session is kept on archive");
    assert.equal(used.session, 2, "used items stay recorded against the session they were planned for");
    assert.deepEqual(countPrepItems(next), { open: 2, done: 0, archived: 2 });

    const again = carryOverPrepBoard(next, NOW, 6);
    assert.equal(again.board.session, 6, "a later explicit session wins");
    assert.equal(again.board.items.find((entry) => entry.id === "a2")!.carried, 2);
    assert.equal(carryOverPrepBoard(next, NOW, 1).board.session, 4, "an earlier one never moves backwards");
  }

  // ── Search ──
  {
    const linked = updatePrepItem(
      board,
      "a1",
      { link: { kind: "character", id: "char-1", label: "Ysolde Varn" }, tags: ["heist"] },
      NOW,
    );
    assert.deepEqual([...searchPrepBoard(linked, "vampire")], ["s1"]);
    assert.deepEqual([...searchPrepBoard(linked, "#villain")], ["s1"], "tag search");
    assert.deepEqual([...searchPrepBoard(linked, "ysolde")], ["a1"], "link name search");
    assert.deepEqual([...searchPrepBoard(linked, "secrets duke")], ["s1"], "all words, section name included");
    assert.equal(searchPrepBoard(linked, "  ").size, 0);
    assert.equal(updatePrepItem(linked, "a1", { text: "  " }, NOW), linked, "an edit to blank text is refused");
  }

  // ── Sections ──
  {
    let sections = addPrepSection(board, "custom", "  Faction   moves ");
    assert.equal(sections.sections.at(-1)!.title, "Faction moves");
    sections = renamePrepSection(sections, "scenes", "Set pieces");
    assert.equal(prepSectionTitle(sections.sections[1]!), "Set pieces");
    sections = renamePrepSection(sections, "scenes", "");
    assert.equal(sections.sections[1]!.title, "", "a blank name restores the preset name");
    sections = movePrepSection(sections, "secrets", -1);
    assert.equal(sections.sections[1]!.id, "secrets");
    assert.deepEqual(
      sections.items.map((item) => item.id),
      ["s1", "a1", "a2", "a3"],
      "items follow their section's new place",
    );
    const removed = removePrepSection(sections, "scenes", "notes");
    assert.ok(!removed.sections.some((section) => section.id === "scenes"));
    assert.deepEqual(ids(removed, "notes"), ["a1", "a2", "a3"], "items move to the chosen section");
    let single = createDefaultPrepBoard();
    for (const section of PREP_BOARD_DEFAULT_SECTIONS.slice(1)) single = removePrepSection(single, section);
    assert.equal(single.sections.length, 1);
    assert.equal(removePrepSection(single, "strong_start"), single, "the last section stays");
  }

  // ── Sanitizing ──
  {
    const dirty = sanitizePrepBoard({
      session: "4",
      sections: [{ id: "one", title: "One" }, { id: "one", title: "Dup" }, { title: "no id" }, "junk"],
      items: [
        { id: "i1", sectionId: "one", text: "  keep  ", done: true, usedSession: 2, tags: ["a", "A", "", 5] },
        { id: "i1", sectionId: "one", text: "duplicate id" },
        { id: "i2", sectionId: "missing", text: "orphan", done: "yes", usedSession: 9 },
        { id: "i3", sectionId: "one", text: "" },
        { id: "i4", sectionId: "one", text: "bad link", link: { kind: "lorebook_entry", id: "e1" } },
        null,
      ],
      extra: "dropped",
    });
    assert.equal(dirty.session, 4);
    assert.deepEqual(dirty.sections, [{ id: "one", title: "One", preset: null }]);
    assert.deepEqual(
      dirty.items.map((item) => [item.id, item.text, item.sectionId, item.done, item.usedSession]),
      [
        ["i1", "keep", "one", true, 2],
        ["i2", "orphan", "one", false, null],
        ["i4", "bad link", "one", false, null],
      ],
    );
    assert.deepEqual(dirty.items[0]!.tags, ["a"]);
    assert.equal(dirty.items[2]!.link, null, "a lorebook link needs its lorebook");
    assert.ok(!("extra" in dirty));
    assert.equal(sanitizePrepBoard(null, 5).sections.length, PREP_BOARD_DEFAULT_SECTIONS.length);
    assert.equal(sanitizePrepBoard(null, 5).session, 5);
    const huge = sanitizePrepBoard({
      sections: [{ id: "s" }],
      items: Array.from({ length: PREP_BOARD_LIMITS.items + 5 }, (_, index) => ({
        id: `i${index}`,
        sectionId: "s",
        text: "x".repeat(PREP_BOARD_LIMITS.itemText + 10),
      })),
    });
    assert.equal(huge.items.length, PREP_BOARD_LIMITS.items);
    assert.equal(huge.items[0]!.text.length, PREP_BOARD_LIMITS.itemText);
    assert.equal(parsePrepTags(Array.from({ length: 50 }, (_, index) => `t${index}`)).length, PREP_BOARD_LIMITS.tags);
  }

  // ── Export, import and merge ──
  {
    const exported = buildPrepBoardExport(board, NOW, "Ashfall campaign");
    assert.equal(exported.format, "marinara-prep-board");
    const roundTrip = parsePrepBoardImport(JSON.parse(JSON.stringify(exported)));
    assert.deepEqual(roundTrip, sanitizePrepBoard(board), "an export reads back as the same board");
    assert.deepEqual(parsePrepBoardImport({ sections: board.sections, items: [] })!.items, [], "a bare board works");
    assert.equal(parsePrepBoardImport({ hello: "world" }), null);
    assert.equal(parsePrepBoardImport([board]), null);
    assert.equal(parsePrepBoardImport("board"), null);

    let counter = 0;
    const withCustom = addPrepSection(board, "rumours", "Rumours");
    const incoming = add(withCustom, "r1", "rumours", "The mill burned");
    const merged = mergePrepBoards(board, incoming, () => `new-${++counter}`);
    assert.equal(merged.added, incoming.items.length);
    assert.equal(merged.board.items.length, board.items.length * 2 + 1);
    assert.ok(
      merged.board.sections.some((section) => section.id === "rumours"),
      "unknown sections are appended",
    );
    assert.equal(new Set(merged.board.items.map((item) => item.id)).size, merged.board.items.length, "fresh ids");
    assert.deepEqual(
      prepSectionItems(merged.board, "scenes").map((item) => item.text),
      ["a1", "a2", "a3", "a1", "a2", "a3"],
    );
    const byName = mergePrepBoards(
      board,
      sanitizePrepBoard({
        sections: [{ id: "other-id", title: "Secrets and clues" }],
        items: [{ id: "q", sectionId: "other-id", text: "clue" }],
      }),
      () => `n-${++counter}`,
    );
    assert.deepEqual(
      prepSectionItems(byName.board, "secrets").map((item) => item.text),
      ["The duke is a vampire", "clue"],
      "sections also match by name",
    );
  }

  // ── Registration ──
  const { createFileNativeDB, FILE_BACKED_TABLES, CASCADES, getFileTableShardStrategy, isLazyUnitTable } =
    await import("../../packages/server/src/db/file-backed-store.js");
  assert.ok(FILE_BACKED_TABLES.includes("game_prep_boards"));
  assert.equal(getFileTableShardStrategy("game_prep_boards").kind, "primary-key");
  assert.equal(isLazyUnitTable("game_prep_boards"), false);
  assert.ok(
    !CASCADES.some((cascade) => cascade.child === "game_prep_boards"),
    "a board is keyed by game, so no chat deletion cascades into it",
  );
  assert.match(read("../protect-launcher-data.mjs"), /"game_prep_boards"/);
  assert.match(read("../../packages/server/src/routes/admin.routes.ts"), /runDelete\("game_prep_boards"/);
  assert.match(read("../../packages/server/src/db/schema/index.ts"), /game-prep-boards\.js/);
  assert.match(
    read("../../packages/server/src/routes/index.ts"),
    /gamePrepBoardRoutes, \{ prefix: "\/api\/prep-board" \}/,
  );

  // ── Privacy: only the board's own modules touch the table ──
  {
    const serverSrc = fileURLToPath(new URL("../../packages/server/src", import.meta.url));
    const allowed = new Set([
      "db/schema/game-prep-boards.ts",
      "db/schema/index.ts",
      "db/file-backed-store.ts",
      "routes/game-prep-board.routes.ts",
      "routes/index.ts",
      "services/storage/game-prep-boards.storage.ts",
      // Deny lists that hide the table from Professor Mari (prep-board-mari-privacy.regression.ts).
      "services/mari-db/mari-db.service.ts",
      "services/professor-mari/workspace-change-review.service.ts",
      // Danger Zone "clear chats" deletes every board with the games; it never reads them.
      "routes/admin.routes.ts",
    ]);
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
      });
    const touching = walk(serverSrc)
      .filter((path) =>
        /gamePrepBoards|game_prep_boards|game-prep-board|prep-board|PrepBoard/.test(readFileSync(path, "utf8")),
      )
      .map((path) => relative(serverSrc, path).replace(/\\/g, "/"));
    assert.deepEqual(
      touching.filter((path) => !allowed.has(path)),
      [],
      "no prompt, generation, agent or export path reads the prep board",
    );
  }

  // ── Routes ──
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { chats } = await import("../../packages/server/src/db/schema/index.js");
  const { gamePrepBoardRoutes } = await import("../../packages/server/src/routes/game-prep-board.routes.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { assemblePrompt } = await import("../../packages/server/src/services/prompt/assembler.js");

  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  const gameChat = (id: string, session: number) => ({
    id,
    name: `Ashfall, session ${session}`,
    mode: "game",
    groupId: "ashfall-group",
    characterIds: "[]",
    metadata: JSON.stringify({ gameId: "ashfall", gameSessionNumber: session }),
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(chats).values(gameChat("session-1", 1));
  await db.insert(chats).values(gameChat("session-2", 2));
  await db.insert(chats).values({
    id: "rp-1",
    name: "Roleplay",
    mode: "roleplay",
    characterIds: "[]",
    metadata: "{}",
    createdAt,
    updatedAt: createdAt,
  });

  const app = Fastify();
  app.decorate("db", db);
  await app.register(gamePrepBoardRoutes, { prefix: "/api/prep-board" });
  await app.ready();
  const call = async (method: "GET" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url: `/api/prep-board${url}`, payload: payload as never });
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
  };

  try {
    assert.equal((await call("GET", "?chatId=rp-1")).status, 400, "not a game chat");
    assert.equal((await call("GET", "")).status, 400);

    const fresh = await call("GET", "?chatId=session-2");
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.gameId, "ashfall");
    assert.equal(fresh.body.sessionNumber, 2);
    assert.equal(fresh.body.revision, 0, "nothing saved yet");
    assert.equal(fresh.body.board.session, 2, "a new board plans the chat's session");

    const SENTINEL = "PREP_BOARD_SENTINEL_MUST_NEVER_REACH_THE_MODEL_5521";
    const draft = add(fresh.body.board, "p1", "secrets", SENTINEL);
    const saved = await call("PUT", "", { chatId: "session-2", revision: 0, board: draft });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 1);

    const stale = await call("PUT", "", { chatId: "session-2", revision: 0, board: createDefaultPrepBoard() });
    assert.equal(stale.status, 409, "a stale save is refused");
    assert.equal(stale.body.revision, 1);
    assert.equal(stale.body.board.items[0].text, SENTINEL, "and gets the stored board back");

    const otherSession = await call("GET", "?chatId=session-1");
    assert.equal(otherSession.body.revision, 1, "every session of the game shares one board");
    assert.equal(otherSession.body.sessionNumber, 1);
    assert.equal(otherSession.body.board.items[0].text, SENTINEL);

    const junk = await call("PUT", "", {
      chatId: "session-1",
      revision: 1,
      board: { sections: [{ id: "s" }], items: [{ id: "x", sectionId: "s", text: "ok", evil: true }] },
    });
    assert.equal(junk.status, 200);
    assert.equal(junk.body.board.items[0].evil, undefined, "the server sanitizes what it stores");
    assert.equal((await call("PUT", "", { chatId: "session-1", revision: 2, board: [] })).status, 400);

    const back = await call("PUT", "", { chatId: "session-1", revision: 2, board: draft });
    assert.equal(back.body.revision, 3);

    // Two saves racing on the same revision: exactly one wins.
    const racing = await Promise.all([
      call("PUT", "", { chatId: "session-1", revision: 3, board: draft }),
      call("PUT", "", { chatId: "session-2", revision: 3, board: draft }),
    ]);
    assert.deepEqual(racing.map((result) => result.status).sort(), [200, 409]);

    // ── Privacy: prompt assembly for a session of this game never includes the board ──
    const assembled = await assemblePrompt({
      db,
      preset: {
        id: "prep-board-prompt-isolation",
        name: "Prep board prompt isolation",
        sectionOrder: JSON.stringify(["main"]),
        groupOrder: JSON.stringify([]),
        wrapFormat: "xml",
        parameters: JSON.stringify({}),
        variableGroups: JSON.stringify([]),
        variableValues: JSON.stringify({}),
      },
      sections: [
        {
          id: "main",
          presetId: "prep-board-prompt-isolation",
          identifier: "main",
          name: "Main",
          content: "You are the game master.",
          role: "system",
          enabled: "true",
          isMarker: "false",
          groupId: null,
          markerConfig: null,
          injectionPosition: "ordered",
          injectionDepth: 0,
          injectionOrder: 0,
          forbidOverrides: "false",
        },
      ],
      groups: [],
      choiceBlocks: [],
      chatChoices: {},
      chatId: "session-2",
      characterIds: [],
      personaName: "Player",
      personaDescription: "",
      chatMessages: [{ role: "user", content: "We enter the mill." }],
      disableLorebooks: true,
      enableAgents: false,
    } as never);
    assert.ok(assembled.messages.length > 0, "the prompt was assembled");
    assert.doesNotMatch(
      JSON.stringify(assembled),
      new RegExp(SENTINEL),
      "the prep board must never enter an assembled model prompt",
    );

    // ── Deleting every session leaves the board in place ──
    const chatStorage = createChatsStorage(db);
    await chatStorage.remove("session-1");
    await chatStorage.remove("session-2");
    assert.equal((await db.select().from(chats)).filter((chat) => chat.mode === "game").length, 0);
    const { gamePrepBoards } = await import("../../packages/server/src/db/schema/index.js");
    const kept = await db.select().from(gamePrepBoards);
    assert.equal(kept.length, 1, "the board outlives its last session");
    assert.match(kept[0]!.board, new RegExp(SENTINEL));

    // A new session of the same game finds it again, and DELETE removes it on purpose.
    await db.insert(chats).values(gameChat("session-3", 3));
    const reopened = await call("GET", "?chatId=session-3");
    assert.equal(reopened.body.board.items[0].text, SENTINEL);
    assert.deepEqual((await call("DELETE", "?chatId=session-3")).body, { deleted: true });
    assert.deepEqual((await call("DELETE", "?chatId=session-3")).body, { deleted: false });
    assert.equal((await call("GET", "?chatId=session-3")).body.revision, 0);
  } finally {
    await app.close();
  }

  console.log("prep-board regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
