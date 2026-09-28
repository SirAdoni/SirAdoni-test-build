import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automaticBackupMode,
  automaticBackupModeUpdate,
  readStoredBackupImportForRegression,
  readStoredBackupTablesForRegression,
  pruneScheduledBackupHistoryForRegression,
  writeBackupSnapshotArchiveForRegression,
  writeBackupSnapshotForRegression,
} from "../../packages/server/src/routes/backup.routes.js";

assert.equal(automaticBackupMode(undefined), "full", "legacy settings retain the original full-backup behavior");
assert.equal(automaticBackupMode("incremental"), "incremental");
assert.equal(automaticBackupMode("data"), "data");
assert.equal(automaticBackupMode("invalid"), "full");
assert.equal(automaticBackupModeUpdate(undefined, "data"), "data", "older settings clients preserve the mode");
assert.equal(automaticBackupModeUpdate("invalid", "data"), null, "invalid updates must be rejected");

const routeSource = await readFile(
  new URL("../../packages/server/src/routes/backup.routes.ts", import.meta.url),
  "utf8",
);
assert.match(routeSource, /req\.body\?\.mode !== undefined && !isBackupMode\(req\.body\.mode\)/u);
assert.match(routeSource, /mode: automaticBackupModeUpdate\(req\.body\.mode, current\.mode\)/u);
assert.match(routeSource, /app\.get\("\/automatic"/u);
assert.match(
  routeSource,
  /app\.put<\{\s*Body: \{ enabled\?: unknown; frequency\?: unknown; retentionCount\?: unknown; mode\?: unknown \}/u,
);

const root = await mkdtemp(join(tmpdir(), "marinara-backup-modes-regression-"));
try {
  const dataDir = join(root, "data");
  const ltmPath = join(dataDir, "long-term-memory", "vault", "learned.json");
  const mediaPath = join(dataDir, "avatars", "should-be-excluded.png");
  await mkdir(join(dataDir, "long-term-memory", "vault"), { recursive: true });
  await mkdir(join(dataDir, "avatars"), { recursive: true });
  await writeFile(ltmPath, JSON.stringify({ fact: "Robert remembers the campaign" }));
  await writeFile(mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const tables = {
    chats: [{ id: "chat-roundtrip", title: "Campaign chat" }],
    messages: [{ id: "message-roundtrip", chatId: "chat-roundtrip", content: "Saved campaign turn" }],
    campaign_memory_events: [{ id: "event-roundtrip", chatId: "chat-roundtrip", eventType: "scene" }],
  };
  const snapshots = [
    { mode: "data", name: "marinara-backup-data-regression" },
    { mode: "incremental", name: "marinara-backup-incremental-regression" },
  ] as const;

  for (const { mode, name } of snapshots) {
    const snapshotPath = join(root, name);
    const archivePath = join(root, `${mode}.zip`);
    const orphanPath = join(root, ".marinara-backup-pending-00000000-0000-4000-8000-000000000000");
    await mkdir(orphanPath);
    await writeFile(join(orphanPath, "partial"), "interrupted snapshot");
    await writeBackupSnapshotForRegression({ mode, dataDir, destination: snapshotPath, tables });
    assert.equal(existsSync(orphanPath), false, "stale pending snapshot directories should be reclaimed");
    await writeBackupSnapshotArchiveForRegression(snapshotPath, name, archivePath);

    const restored = await readStoredBackupTablesForRegression(archivePath);
    assert.equal(restored.isFullBackup, true, `${mode} portable ZIP must preserve the full-backup restore marker`);
    assert.deepEqual(restored.tables?.chats, tables.chats);
    assert.deepEqual(restored.tables?.messages, tables.messages);
    assert.deepEqual(restored.tables?.campaign_memory_events, tables.campaign_memory_events);

    const ltm = await readStoredBackupImportForRegression(archivePath, "long-term-memory/vault/learned.json");
    assert.ok(ltm.asset, `${mode} import should restore non-reconstructible long-term-memory vault files`);
    const ltmChunks: Buffer[] = [];
    for await (const chunk of ltm.asset.stream) ltmChunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(ltmChunks).toString("utf8"), JSON.stringify({ fact: "Robert remembers the campaign" }));

    const profile = await readStoredBackupImportForRegression(archivePath, "avatars/should-be-excluded.png");
    const fileManifest = (profile.envelope.data as { fileStorage: { files: Array<{ path: string }> } }).fileStorage
      .files;
    if (mode === "data") {
      assert.deepEqual(fileManifest.map((file) => file.path).sort(), ["long-term-memory/vault/learned.json"]);
      assert.equal(profile.asset, null, "data mode must not claim omitted media exists");
      assert.equal(existsSync(join(snapshotPath, "avatars", "should-be-excluded.png")), false);
    } else {
      assert.ok(fileManifest.some((file) => file.path === "avatars/should-be-excluded.png"));
      assert.ok(profile.asset, "incremental mode must remain a complete export including media");
    }
    const restoreNote = await readFile(join(snapshotPath, "RESTORE.txt"), "utf8");
    if (mode === "data") assert.match(restoreNote, /long-term-memory vault and event files/u);
  }

  const failedRoot = join(root, "failed-publication");
  await mkdir(failedRoot, { recursive: true });
  const failedDestination = join(failedRoot, "marinara-backup-incremental-failed");
  await assert.rejects(
    writeBackupSnapshotForRegression({
      mode: "incremental",
      dataDir,
      destination: failedDestination,
      tables,
      beforeCopy: async () => {
        throw new Error("simulated low disk space");
      },
    }),
    /simulated low disk space/u,
  );
  assert.equal(existsSync(failedDestination), false, "a failed snapshot must not publish its destination");
  assert.deepEqual(
    (await import("node:fs/promises").then(({ readdir }) => readdir(failedRoot))).filter((name) =>
      name.startsWith("marinara-backup-"),
    ),
    [],
    "pending work must remain invisible to backup listing",
  );

  const retentionRoot = join(root, "retention");
  await mkdir(retentionRoot);
  const addScheduledSnapshot = async (name: string, seconds: number) => {
    const dir = join(retentionRoot, name);
    await mkdir(dir);
    await writeFile(join(dir, ".scheduled-backup"), "scheduled\n");
    await utimes(dir, seconds, seconds);
    return dir;
  };
  const oldZip = join(retentionRoot, "marinara-automatic-backup-older.zip");
  const newZip = join(retentionRoot, "marinara-automatic-backup-newer.zip");
  await writeFile(oldZip, "old zip");
  await writeFile(newZip, "new zip");
  await utimes(oldZip, 100, 100);
  await utimes(newZip, 300, 300);
  const scheduledOld = await addScheduledSnapshot("marinara-backup-incremental-scheduled-old", 200);
  const scheduledNewest = await addScheduledSnapshot("marinara-backup-incremental-scheduled-newest", 400);
  const manualSnapshot = await addScheduledSnapshot("marinara-backup-incremental-manual", 500);
  await rm(join(manualSnapshot, ".scheduled-backup"));
  const manualFolder = join(retentionRoot, "marinara-backup-data-manual");
  await mkdir(manualFolder);
  await pruneScheduledBackupHistoryForRegression(retentionRoot, 2);
  assert.equal(existsSync(oldZip), false);
  assert.equal(existsSync(scheduledOld), false);
  assert.equal(existsSync(newZip), true);
  assert.equal(existsSync(scheduledNewest), true);
  assert.equal(existsSync(manualSnapshot), true, "retention must not prune a manual incremental snapshot");
  assert.equal(existsSync(manualFolder), true, "retention must not prune unrelated manual backups");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Backup mode regression passed.");
