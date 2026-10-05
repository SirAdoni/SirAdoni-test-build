import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const file = new URL("../../packages/server/src/services/game/campaign-memory-campaign-scope.ts", import.meta.url);
const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(
  (n) => ts.isFunctionDeclaration(n) && n.name?.text === "readCampaignMemorySourcesForProjection",
);
assert.ok(declaration);
const code = ts.transpileModule(declaration.getText(source).replace(/^export /, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const cache = new Map();
let version = "v1",
  reads = 0;
const read = new Function(
  "sourceCache",
  "MAX_CACHED_SESSION_MEMORIES",
  "chatVersion",
  "readCampaignMemorySources",
  code + ";return readCampaignMemorySourcesForProjection;",
)(
  cache,
  24,
  async () => version,
  async (_db, { chatId }) => {
    reads++;
    return new Map([[chatId, { chatId, quote: "kept" }]]);
  },
);
const load = (id) => read({}, { chatId: "current", sessionChatIds: [id] });
for (let i = 0; i < 30; i++) await load(String(i));
assert.equal(cache.size, 24);
assert.equal(cache.has("0"), false);
assert.equal(cache.has("6"), true);
const count = reads;
await load("29");
assert.equal(reads, count, "unchanged prior session reuses its source map");
version = "v2";
const merged = await load("29");
assert.equal(reads, count + 1);
assert.equal(cache.size, 24);
assert.equal(cache.has("6"), true, "refreshing an existing session must not evict another");
assert.equal(merged.get("29").chatId, "current");
await load("current");
assert.equal(cache.has("current"), false);
assert.equal(cache.size, 24);
console.log("Source cache: cap, version refresh, current-session bypass and projected identity passed");
