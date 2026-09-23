// Logging batch B3 (storage services) v1.0 (2026-09-23): parseStoredJson keeps
// the old fallbacks, reports storage.json_corrupt once per table/rowId/field and
// never writes the raw stored text. Runs against a temporary log directory; no
// provider, no live server.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "marinara-logging-b2-"));
process.env.LOG_DIR = logDir;
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";

const PLANTED = "{ PLANTED stored text the dragon whispers";

type Line = Record<string, any>;

function mainLines(): Line[] {
  return readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

try {
  const { parseStoredJson, STORAGE_JSON_CORRUPT } = await import(
    "../../packages/server/src/services/storage/stored-json.js"
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const where = { table: "chats", rowId: "chat-b2", field: "metadata" };
  assert.deepEqual(parseStoredJson('{"a":1}', {}, where), { a: 1 }, "valid JSON parses");
  assert.deepEqual(parseStoredJson(null, { d: 1 }, where), { d: 1 }, "null returns the fallback");
  assert.deepEqual(parseStoredJson("", { d: 2 }, where), { d: 2 }, "empty string returns the fallback");
  const already = { b: 2 };
  assert.equal(parseStoredJson(already, {}, where), already, "a non-string value passes through");
  assert.equal(mainLines().filter((line) => line.event === "storage.json_corrupt").length, 0, "no corrupt line yet");

  assert.deepEqual(parseStoredJson(PLANTED, { f: true }, where), { f: true }, "corrupt JSON returns the fallback");
  parseStoredJson(PLANTED, { f: true }, where);
  parseStoredJson(PLANTED, { f: true }, where);
  const corrupt = mainLines().filter((line) => line.event === "storage.json_corrupt");
  assert.equal(corrupt.length, 1, "one line per table/rowId/field inside the window");
  assert.equal(corrupt[0].table, "chats");
  assert.equal(corrupt[0].rowId, "chat-b2");
  assert.equal(corrupt[0].field, "metadata");
  assert.equal(corrupt[0].rawLength, PLANTED.length);
  assert.equal(corrupt[0].errorCode, STORAGE_JSON_CORRUPT);
  assert.equal(corrupt[0].level, 40, "corrupt stored JSON logs at warn");

  parseStoredJson(PLANTED, "raw", { table: "agent_runs", rowId: "run-b2", field: "resultData" });
  assert.equal(
    mainLines().filter((line) => line.event === "storage.json_corrupt").length,
    2,
    "a different row logs its own line",
  );

  const text = readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .map((name) => readFileSync(join(logDir, name), "utf8"))
    .join("\n");
  assert.ok(!text.includes("PLANTED"), "the raw stored text is never logged");

  console.log("logging-b2 regression passed");
} finally {
  rmSync(logDir, { recursive: true, force: true });
}
