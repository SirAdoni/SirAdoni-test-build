import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Character usage: the pure role extraction from a chat row, the cached index
// (built from chat rows, rebuilt only when a row changes, never reading
// messages unless counts are asked for), the routes, and the client wiring.

const root = mkdtempSync(join(tmpdir(), "marinara-character-usage-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

try {
  const { extractChatCharacterRoles, gameNameFromChatName, groupGameUsage, createCharacterUsageIndex } =
    await import("../../packages/server/src/services/characters/character-usage.js");

  // ── Pure role extraction ──
  {
    const roles = extractChatCharacterRoles({
      id: "g1",
      mode: "game",
      characterIds: JSON.stringify(["mira", "npc:bandit", "__professor_mari__"]),
      personaCharacterId: "self",
      metadata: JSON.stringify({
        gamePartyCharacterIds: ["mira", "npc:tracked", "aldric"],
        gameNpcs: [{ id: "npc-1", characterId: "sela" }, { id: "npc-2", characterId: null }, "junk"],
        gameGmMode: "character",
        gameGmCharacterId: "narrator",
      }),
    });
    assert.deepEqual(
      Object.fromEntries([...roles].map(([id, set]) => [id, [...set].sort()])),
      {
        mira: ["member", "party"],
        self: ["persona"],
        aldric: ["party"],
        sela: ["npc"],
        narrator: ["gm"],
      },
      "members, persona, party, linked NPCs and a character GM; tracked npc: ids and Mari are skipped",
    );
    const roleplay = extractChatCharacterRoles({
      id: "r1",
      mode: "roleplay",
      characterIds: "not json",
      metadata: JSON.stringify({ gamePartyCharacterIds: ["x"] }),
    });
    assert.equal(roleplay.size, 0, "game metadata is only read for game chats; bad JSON is empty");
    assert.equal(gameNameFromChatName("Valdenmoor — Session 12"), "Valdenmoor");
    assert.equal(gameNameFromChatName("Valdenmoor - Session 3"), "Valdenmoor");
    assert.equal(gameNameFromChatName("Plain"), "Plain");
    const games = groupGameUsage([
      {
        chatId: "s2",
        chatName: "V — Session 2",
        mode: "game",
        roles: ["npc"],
        gameId: "g",
        gameName: "V renamed",
        lastActivityAt: "2026-09-02",
        lastMessageAt: null,
        createdAt: "",
      },
      {
        chatId: "s1",
        chatName: "V — Session 1",
        mode: "game",
        roles: ["party"],
        gameId: "g",
        gameName: "V",
        lastActivityAt: "2026-09-01",
        lastMessageAt: null,
        createdAt: "",
      },
    ]);
    assert.deepEqual(games, [
      { gameId: "g", gameName: "V renamed", sessions: 2, roles: ["party", "npc"], lastActivityAt: "2026-09-02" },
    ]);
  }

  // ── Index over a real store ──
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, characters, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const db = await createFileNativeDB();
  const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T12:00:00.000Z`;
  const card = (id: string, name: string, extensions: Record<string, unknown> = {}) =>
    db.insert(characters).values({
      id,
      data: JSON.stringify({ name, extensions }),
      comment: "",
      avatarPath: null,
      createdAt: at(1),
      updatedAt: at(1),
    } as never);
  await card("mira", "Mira");
  await card("aldric", "Aldric");
  await card("sela", "Sela", { libraryCategory: "npcs" });
  await card("lonely", "Lonely");
  await card("orphan-npc", "Orphan", { marinara: { gameNpc: { autoCreated: true } } });

  const chat = (id: string, values: Record<string, unknown>) =>
    db.insert(chats).values({
      id,
      name: id,
      mode: "roleplay",
      characterIds: "[]",
      metadata: "{}",
      createdAt: at(1),
      updatedAt: at(1),
      ...values,
    } as never);
  await chat("rp-1", { characterIds: JSON.stringify(["mira"]), lastMessageAt: at(5) });
  await chat("session-1", {
    name: "Valdenmoor — Session 1",
    mode: "game",
    groupId: "game-1",
    characterIds: JSON.stringify(["mira"]),
    metadata: JSON.stringify({ gameId: "game-1", gamePartyCharacterIds: ["mira", "aldric"] }),
    lastMessageAt: at(8),
  });
  await chat("session-2", {
    name: "Valdenmoor — Session 2",
    mode: "game",
    groupId: "game-1",
    metadata: JSON.stringify({ gameId: "game-1", gameNpcs: [{ id: "n", characterId: "sela" }] }),
    lastMessageAt: at(9),
  });
  await chat("mari", {
    characterIds: JSON.stringify(["lonely"]),
    metadata: JSON.stringify({ internalAssistant: "professor-mari" }),
  });
  for (let index = 0; index < 3; index += 1) {
    await db.insert(messages).values({
      id: `m-${index}`,
      chatId: "rp-1",
      role: "user",
      content: "hi",
      createdAt: at(2),
    } as never);
  }

  const index = createCharacterUsageIndex();
  const summary = await index.summary(db);
  assert.deepEqual(Object.keys(summary).sort(), ["aldric", "mira", "sela"], "the internal Mari chat does not count");
  assert.deepEqual(summary.mira, { chats: 2, games: 1, lastActivityAt: at(8) });
  assert.equal(index.builds, 1);
  await index.summary(db);
  assert.equal(index.builds, 1, "an unchanged chat list reuses the index");

  const mira = await index.forCharacter(db, "mira");
  assert.deepEqual(
    mira.chats.map((usage) => [usage.chatId, usage.roles]),
    [
      ["session-1", ["member", "party"]],
      ["rp-1", ["member"]],
    ],
    "newest first, with roles",
  );
  assert.equal(mira.games[0]?.gameName, "Valdenmoor");

  // A chat change invalidates: the next request sees it.
  await db
    .update(chats)
    .set({ characterIds: JSON.stringify(["mira", "lonely"]), updatedAt: at(10) } as never)
    .where(eq(chats.id, "rp-1"));
  assert.ok((await index.summary(db)).lonely, "an added member shows up");
  assert.equal(index.builds, 2);
  await db.delete(chats).where(eq(chats.id, "rp-1"));
  assert.equal((await index.summary(db)).lonely, undefined, "a deleted chat drops out");
  assert.equal((await index.summary(db)).mira?.chats, 1);

  // Message counts are opt-in and cached per chat.
  await chat("rp-2", { characterIds: JSON.stringify(["aldric"]), lastMessageAt: at(3) });
  for (let i = 0; i < 2; i += 1) {
    await db
      .insert(messages)
      .values({ id: `n-${i}`, chatId: "rp-2", role: "user", content: "x", createdAt: at(3) } as never);
  }
  const aldric = await index.forCharacter(db, "aldric");
  const counted = await index.countMessages(db, aldric.chats);
  assert.deepEqual(counted, { counts: { "session-1": 0, "rp-2": 2 }, truncated: false });

  // ── Routes ──
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { characterUsageRoutes } = await import("../../packages/server/src/routes/character-usage.routes.js");
  const app = Fastify();
  app.decorate("db", db);
  await app.register(characterUsageRoutes, { prefix: "/api/character-usage" });
  await app.ready();
  try {
    const get = async (url: string) => {
      const response = await app.inject({ method: "GET", url: `/api/character-usage${url}` });
      return { status: response.statusCode, body: JSON.parse(response.body) };
    };
    const unused = await get("/unused");
    assert.equal(unused.status, 200);
    assert.deepEqual(
      unused.body.characters.map((row: { id: string; category: string }) => [row.id, row.category]).sort(),
      [
        ["lonely", "characters"],
        ["orphan-npc", "npcs"],
      ],
    );
    const detail = await get("/aldric");
    assert.equal(detail.status, 200);
    assert.equal(detail.body.messageCounts, null, "no counts unless asked");
    assert.equal(detail.body.games.length, 1);
    const withCounts = await get("/aldric?counts=1");
    assert.deepEqual(withCounts.body.messageCounts, { "session-1": 0, "rp-2": 2 });
    assert.equal((await get("/missing")).status, 404);
    assert.ok((await get("/summary")).body.characters.sela);
  } finally {
    await app.close();
  }

  // ── Wiring ──
  assert.match(
    read("../../packages/server/src/routes/index.ts"),
    /characterUsageRoutes, \{ prefix: "\/api\/character-usage" \}/,
  );
  const panel = read("../../packages/client/src/components/panels/CharactersPanel.tsx");
  assert.match(panel, /<CharacterUnusedModal/);
  assert.match(read("../../packages/client/src/components/characters/CharacterEditor.tsx"), /<CharacterUsageSection/);
  const service = read("../../packages/server/src/services/characters/character-usage.ts");
  assert.doesNotMatch(
    service.slice(0, service.indexOf("async countMessages")),
    /messages\b.*eq\(/,
    "the index never queries messages",
  );
  const english = JSON.parse(read("../../packages/client/src/localization/locales/en.json")) as Record<string, string>;
  for (const [key, value] of Object.entries(english)) {
    if (key.startsWith("characters.usage.") || key.startsWith("characters.unused.")) {
      assert.ok(!value.includes("—"), `${key} has no em dash`);
    }
  }
  console.log("character usage regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
