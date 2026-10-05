import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function parse(path) {
  return ts.createSourceFile(path, readFileSync(join(repo, path), "utf8"), ts.ScriptTarget.Latest, true);
}
function find(source, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}
const assets = parse("packages/server/src/services/game/game-asset-generation.ts");
const cleanup = find(assets, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "removeOwnedNpcPortrait");
assert.equal(cleanup.length, 1);
const compiled = ts.transpileModule(cleanup[0].getText(assets).replace(/^export /u, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const root = mkdtempSync(join(tmpdir(), "me-portrait-review-"));
try {
  const remove = new Function(
    "deps",
    `const { basename, resolve, sep, existsSync, unlinkSync, NPC_AVATAR_DIR } = deps; ${compiled}; return removeOwnedNpcPortrait;`,
  )({
    basename,
    resolve,
    sep,
    existsSync,
    unlinkSync,
    NPC_AVATAR_DIR: root,
  });
  const token = "11111111-2222-4333-8444-555555555555";
  mkdirSync(join(root, "chat"));
  for (const ext of ["png", "jpg", "jpeg", "webp", "gif", "avif"]) {
    const file = `npc-${token}.${ext}`;
    const path = join(root, "chat", file);
    writeFileSync(path, "isolated generated image fixture");
    assert.equal(remove("chat", `/api/avatars/npc/chat/${file}`, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), false);
    assert.equal(existsSync(path), true, "Other generation ownership must be preserved");
    assert.equal(remove("chat", `/api/avatars/npc/chat/${file}`, token), true, `${ext} output must be cleaned`);
    assert.equal(existsSync(path), false);
  }
  assert.equal(remove("..", "/api/avatars/npc/../owned.png", token), false);
  assert.equal(remove("chat", `/api/avatars/npc/chat/../npc-${token}.png`, token), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const route = parse("packages/server/src/routes/game.routes.ts");
const ids = find(
  route,
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText(route) === "gameImagePromptReviewId" &&
    node.arguments[0]?.getText(route) === '"portrait"',
);
assert.ok(ids.length >= 3, "Inspect both preview and generation identity consumers");
for (const npc of [{ npcId: "npc-a", name: "Same" }, { npcId: "npc-b", name: "Same" }, { name: "Legacy" }]) {
  for (const campaignPortraitBatch of [false, true]) {
    const actual = ids.map((node) =>
      new Function(
        "npc",
        "input",
        "explicitCampaignPortrait",
        "metadataNpc",
        `return ${node.arguments[1].getText(route)};`,
      )(npc, { campaignPortraitBatch }, campaignPortraitBatch, { id: npc.npcId ?? npc.name }),
    );
    assert.ok(
      actual.every((id) => id === (campaignPortraitBatch ? (npc.npcId ?? npc.name) : npc.name)),
      "Preview and override lookup must share the stable identity",
    );
  }
}
console.info("Portrait cleanup ownership and preview identity regression passed");
