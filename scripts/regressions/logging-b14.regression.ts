// Logging batch 14 v1.0 (2026-09-23): silent-fallback sweep (plan B15) for
// game.routes, backgrounds.routes, illustrator references, tool resolution and
// chat insights. Runs against a temporary log directory; no provider, no live server.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "marinara-logging-b14-"));
process.env.LOG_DIR = logDir;
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";

type Line = Record<string, any>;

function mainLines(): Line[] {
  return readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
const root = join(import.meta.dirname, "../../packages/server/src");
const read = (path: string) => readFileSync(join(root, path), "utf8");

try {
  // (1) Game checkpoint catches log through logSuppressed with GAME_CHECKPOINT_FAILED.
  const game = read("routes/game.routes.ts");
  assert.equal(game.match(/event: "game\.checkpoint\.persist"/g)?.length, 4, "four checkpoint catches");
  assert.equal(game.match(/errorCode: "GAME_CHECKPOINT_FAILED"/g)?.length, 4);
  assert.ok(!/catch \{\s*\/\* non-fatal \*\/\s*\}/.test(game), "no comment-only non-fatal catches left");
  assert.ok(game.includes('event: "game.scene.persist"'), "scene background write failure is logged");

  // (2) Storage reads fall back through orFallback, not a bare .catch(() => null).
  assert.ok(
    !/createGameStateStorage\(app\.db\)\s*\.(?:getLatest|getByChatAndMessage)\([^)]*\)\s*\.catch\(\(\) => null\)/.test(
      game,
    ),
  );
  assert.ok(!game.includes("chats.listByGroup(gameId).catch(() => [])"));
  assert.ok((game.match(/event: "storage\.read\.fallback"/g)?.length ?? 0) >= 8);
  for (const [path, bare] of [
    ["routes/backgrounds.routes.ts", ".getLatest(input.chatId)\n            .catch(() => null)"],
    ["services/image/illustrator-references.ts", "args.charactersStore.list().catch(() => [])"],
    ["services/generation/tool-resolution-runtime.ts", "listEntries(writableLorebookId).catch(() => [])"],
    [
      "services/chat-insights/chat-insights.service.ts",
      "resolveChatUserIdentity(createCharactersStorage(db), chat).catch(() => null)",
    ],
  ] as const) {
    const source = read(path);
    assert.ok(!source.includes(bare), `${path} still has a silent fallback`);
    assert.ok(source.includes("orFallback(") && source.includes('event: "storage.read.fallback"'), path);
  }

  // (3) Runtime: a failing character list still resolves, and logs one suppressed line.
  const { resolveIllustratorCharacterReferences } =
    await import("../../packages/server/src/services/image/illustrator-references.js");
  const failure = new Error("characters store offline");
  const result = await resolveIllustratorCharacterReferences({
    charactersStore: { list: () => Promise.reject(failure) },
    chatCharacters: [],
    requestedNames: [],
    promptText: "",
    includeReferenceImages: false,
  });
  assert.deepEqual(result.characterIds, []);
  await settle();
  const fallback = mainLines().filter(
    (line) => line.event === "storage.read.fallback" && line.stage === "characters.list",
  );
  assert.equal(fallback.length, 1, "one storage.read.fallback line");
  assert.equal(fallback[0].outcome, "failed");
  assert.equal(fallback[0].suppressed, true);
  assert.equal(fallback[0].level, 40);

  console.log("logging-b14 regression passed");
} finally {
  rmSync(logDir, { recursive: true, force: true });
}
