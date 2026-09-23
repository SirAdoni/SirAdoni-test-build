// Logging batch B2 (storage engine), plan v1.0 (2026-09-23): the storage lines
// the plan asks for reach the log file with their structured fields intact.
//   - quarantinedPaths survives the sanitizer (the old `files` key was redacted),
//   - an unreadable primary AND backup writes ONE storage.recover error line,
//   - registerTables returns { registered, rejected } and logs package.tables,
//   - a flush writes a storage.flush line with FlushStats,
//   - initialize() writes storage.load and exposes getBootStats(),
//   - renameWithTransientRetry reports storage.rename.retry after a retry.
// Runs against temporary storage and log directories; no provider, no server.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "marinara-logging-b1-"));
const logDir = join(sandbox, "logs");
const storageDir = join(sandbox, "storage");
mkdirSync(storageDir, { recursive: true });
process.env.LOG_DIR = logDir;
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";
process.env.FILE_STORAGE_DIR = storageDir;

// Console output is not under test; keep it out of the runner's output.
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (() => true) as typeof process.stderr.write;

type Line = Record<string, any>;

function lines(): Line[] {
  let names: string[] = [];
  try {
    names = readdirSync(logDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^marinara-.*\.log/.test(name))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

const byEvent = (event: string) => lines().filter((line) => line.event === event);

try {
  const { logger } = await import("../../packages/server/src/lib/logger.js");
  const { fileTable, text } = await import("../../packages/server/src/db/file-schema.js");
  const { createFileNativeDB, renameWithTransientRetry } =
    await import("../../packages/server/src/db/file-backed-store.js");
  await new Promise((resolve) => setTimeout(resolve, 0));

  // ── (1) quarantinedPaths survives the sanitizer; a `files` key would not ──
  logger.error(
    { table: "demo", quarantinedPaths: [{ from: "/data/a.json", to: "/data/a.json.corrupt-1" }], files: ["x"] },
    "quarantine probe",
  );
  const probe = lines().find((line) => line.msg === "quarantine probe");
  assert.ok(probe, "the probe line reaches the log file");
  assert.deepEqual(probe.quarantinedPaths, [{ from: "/data/a.json", to: "/data/a.json.corrupt-1" }]);
  assert.equal(probe.files, "[REDACTED]", "the old field name is redacted, which is why it was renamed");

  // ── (6) initialize() writes storage.load and keeps the stats ──
  const db = await createFileNativeDB();
  try {
    const load = byEvent("storage.load");
    assert.equal(load.length, 1, "one storage.load line per boot");
    for (const key of ["elapsedMs", "phases", "totalRows", "tables", "bytesRead", "quarantinedFiles", "heapUsedMiB"]) {
      assert.ok(key in load[0]!, `storage.load carries ${key}`);
    }
    const stats = db._fileStore.getBootStats();
    assert.ok(stats, "getBootStats() is set after initialize()");
    assert.equal(typeof stats.phases.leaseMs, "number");
    assert.ok(Array.isArray(db._fileStore.getDirtyTables()));
    assert.equal(typeof db._fileStore.getTableSizes(), "object");

    // ── (5) an unreadable primary AND backup writes ONE storage.recover line ──
    const shardDir = join(storageDir, "tables", "logging_b1_events");
    mkdirSync(shardDir, { recursive: true });
    const shardPath = join(shardDir, "event-1.json");
    writeFileSync(shardPath, "{ not json", "utf8");
    writeFileSync(`${shardPath}.bak`, "also not json", "utf8");
    const events = fileTable("logging_b1_events", {
      id: text("id").primaryKey(),
      body: text("body").notNull(),
      createdAt: text("created_at").notNull(),
    });

    // ── (7) registerTables returns what it registered and what it refused ──
    const result = db._fileStore.registerTables([
      events,
      "not a table",
      fileTable("../escape", { id: text("id").primaryKey() }),
    ]);
    assert.deepEqual(result.registered, ["logging_b1_events"]);
    assert.deepEqual(
      result.rejected.map((entry) => entry.index),
      [1, 2],
      "each refused candidate is reported by its index",
    );
    const packageLines = byEvent("package.tables");
    assert.equal(packageLines.filter((line) => line.outcome === "failed").length, 2);
    assert.ok(packageLines.some((line) => line.outcome === "ok" && line.table === "logging_b1_events"));

    const recover = byEvent("storage.recover").filter((line) => line.path === shardPath);
    assert.equal(recover.length, 1, "both files failing writes ONE line");
    assert.equal(recover[0]!.source, "fallback");
    assert.equal(recover[0]!.outcome, "failed");
    assert.equal(recover[0]!.errorCode, "ME_STORAGE_CORRUPT");
    assert.ok(recover[0]!.backupErr, "the backup failure rides on the same line");
    const quarantine = lines().find(
      (line) => Array.isArray(line.quarantinedPaths) && line.table === "logging_b1_events",
    );
    assert.ok(quarantine, "the quarantine line names the moved files");
    assert.equal(quarantine.quarantinedPaths.length, 2);

    // ── (4) a flush logs its FlushStats ──
    await db.insert(events).values({ id: "e1", body: "PLANTED BODY", createdAt: new Date().toISOString() });
    await db._fileStore.flush();
    const flushes = byEvent("storage.flush").filter((line) => line.outcome === "ok");
    assert.ok(flushes.length > 0, "a successful flush writes storage.flush");
    const last = flushes.at(-1)!;
    assert.ok(last.filesWritten >= 1 && last.bytesWritten > 0);
    assert.ok(last.tables.includes("logging_b1_events"));
    assert.ok(!JSON.stringify(lines()).includes("PLANTED BODY"), "row content never reaches the log");
  } finally {
    await db._fileStore.close();
  }
  assert.ok(
    byEvent("storage.flush").every((line) => line.outcome !== "failed"),
    "no flush failed during the test",
  );

  // ── (11) a rename that succeeds after retries logs storage.rename.retry ──
  let calls = 0;
  await renameWithTransientRetry(
    "/tmp/a.tmp",
    "/tmp/b.json",
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
    "win32",
    async () => undefined,
  );
  const retry = byEvent("storage.rename.retry").at(-1);
  assert.ok(retry, "a retried rename is reported");
  assert.equal(retry.attempt, 3);
  assert.equal(retry.errorCode, "EBUSY");
  let exhausted: any;
  await renameWithTransientRetry(
    "/tmp/a.tmp",
    "/tmp/b.json",
    async () => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
    "win32",
    async () => undefined,
  ).catch((error) => {
    exhausted = error;
  });
  assert.ok(exhausted && exhausted.attempt > 1, "an exhausted rename carries its attempt count");

  process.stderr.write = originalStderrWrite;
  console.log("logging-b1 regression passed");
} finally {
  process.stderr.write = originalStderrWrite;
  rmSync(sandbox, { recursive: true, force: true });
}
