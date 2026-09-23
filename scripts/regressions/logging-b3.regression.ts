// Logging batch B4 (backup and import), logging plan v1.0 (2026-09-23).
// Scans a planted SillyTavern folder with one unreadable card and checks that the
// skip is a debug line with only the file name, followed by one warn summary for
// the directory. Source checks cover the backup route: shared errorId in replies,
// no silent legacy-import catches and no printf memory lines.
// Runs against temporary directories; no provider, no live server.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "marinara-logging-b3-"));
const dataDir = mkdtempSync(join(tmpdir(), "marinara-logging-b3-data-"));
const stRoot = mkdtempSync(join(tmpdir(), "marinara-logging-b3-st-"));
process.env.LOG_DIR = logDir;
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = `${process.env.DATA_DIR}/storage`; // never the live store named in .env

const PLANTED_CONTENT = "PLANTED CARD CONTENT never logged";

type Line = Record<string, any>;

function mainLines(): Line[] {
  return readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

try {
  const charactersDir = join(stRoot, "characters");
  mkdirSync(charactersDir, { recursive: true });
  writeFileSync(join(charactersDir, "good.json"), JSON.stringify({ name: "Good Card" }));
  writeFileSync(join(charactersDir, "broken.json"), `{ "name": "${PLANTED_CONTENT}", `);

  const { scanSTFolder } = await import("../../packages/server/src/services/import/st-bulk.importer.js");
  const { logger } = await import("../../packages/server/src/lib/logger.js");

  const result = await scanSTFolder(stRoot);
  assert.equal(result.success, true);
  assert.equal(result.characters.length, 1, "the readable card is still listed");

  logger.flush?.();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const lines = mainLines();

  const skip = lines.find((line) => line.event === "import.st.item" && line.stage === "scan");
  assert.ok(skip, "the unreadable card logs one import.st.item scan line");
  assert.equal(skip.level, 20, "a scan skip is debug");
  assert.equal(skip.fileName, "broken.json");
  assert.equal(skip.directory, "characters");
  assert.equal(typeof skip.errorCode, "string");

  const summary = lines.filter((line) => line.event === "import.st" && line.stage === "scan");
  assert.equal(summary.length, 1, "one warn summary per directory with skips");
  assert.equal(summary[0].level, 40);
  assert.equal(summary[0].outcome, "skipped");
  assert.equal(summary[0].skippedCount, 1);

  const allText = readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .map((name) => readFileSync(join(logDir, name), "utf8"))
    .join("\n");
  assert.ok(!allText.includes("Good Card"), "card names are not logged");

  // Source checks for the backup route (building the whole route needs the app).
  const backupSource = readFileSync(
    new URL("../../packages/server/src/routes/backup.routes.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!/catch \{\s*\/\* skip/.test(backupSource), "legacy import catches report through skipLegacyItem");
  assert.ok(!backupSource.includes("heap=%d MiB"), "memory lines are structured");
  assert.match(backupSource, /errorId: ref\.errorId,\s*code: ref\.code/, "route errors return the logged errorId");
  assert.match(backupSource, /"backup\.automatic"/);
  assert.match(backupSource, /"profile\.import\.rollback"/);
  assert.match(backupSource, /event: "backup\.failed"/);
  assert.ok(!/logger\.error\(\s*rollbackError/.test(backupSource), "rollback failure is one warn without err");

  const importerSource = readFileSync(
    new URL("../../packages/server/src/services/import/st-bulk.importer.ts", import.meta.url),
    "utf8",
  );
  assert.equal((importerSource.match(/logImportItemFailure\("/g) ?? []).length, 7, "all seven item catches log");

  console.log("logging-b3 regression passed");
} finally {
  rmSync(stRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
}
