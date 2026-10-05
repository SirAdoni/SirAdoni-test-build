import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import multipart from "../../packages/server/node_modules/@fastify/multipart/index.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { resetFeatureSettingsForTests } from "../../packages/server/src/services/features/feature-settings.js";
import {
  automaticBackupMode,
  automaticBackupModeUpdate,
  effectiveAutomaticBackupMode,
  readStoredBackupImportForRegression,
  readStoredBackupTablesForRegression,
  pruneScheduledBackupHistoryForRegression,
  writeBackupArchiveForRegression,
  writeBackupSnapshotArchiveForRegression,
  writeBackupSnapshotForRegression,
} from "../../packages/server/src/routes/backup.routes.js";

function multipartUpload(filename: string, bytes: Buffer) {
  const boundary = `marinara-${Date.now().toString(36)}`;
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

assert.equal(automaticBackupMode(undefined), "full", "legacy settings retain the original full-backup behavior");
assert.equal(automaticBackupMode("incremental"), "incremental");
assert.equal(automaticBackupMode("data"), "data");
assert.equal(automaticBackupMode("invalid"), "full");
assert.equal(automaticBackupModeUpdate(undefined, "data"), "data", "older settings clients preserve the mode");
assert.equal(automaticBackupModeUpdate("invalid", "data"), null, "invalid updates must be rejected");
resetFeatureSettingsForTests();
assert.equal(effectiveAutomaticBackupMode("incremental"), "full", "missing flag uses baseline full backups");
resetFeatureSettingsForTests({ backupModes: true });
assert.equal(effectiveAutomaticBackupMode("incremental"), "incremental");
resetFeatureSettingsForTests({ backupModes: false });
assert.equal(effectiveAutomaticBackupMode("data"), "full", "OFF ignores but does not replace a stored mode");
resetFeatureSettingsForTests({ backupModes: true });

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

const root = await realpath(await mkdtemp(join(tmpdir(), "marinara-backup-modes-regression-")));
const priorDataDir = process.env.DATA_DIR;
const priorFileStorageDir = process.env.FILE_STORAGE_DIR;
try {
  const dataDir = join(root, "data");
  const ltmPath = join(dataDir, "long-term-memory", "vault", "learned.json");
  const mediaPath = join(dataDir, "avatars", "should-be-excluded.png");
  const encryptionKeyPath = join(dataDir, ".encryption-key");
  const fileStorageDir = join(root, "file-storage");
  const packageTablePath = join(fileStorageDir, "package-tables", "sample", "record.json");
  await mkdir(join(dataDir, "long-term-memory", "vault"), { recursive: true });
  await mkdir(join(dataDir, "avatars"), { recursive: true });
  await mkdir(join(fileStorageDir, "package-tables", "sample"), { recursive: true });
  await writeFile(ltmPath, JSON.stringify({ fact: "Robert remembers the campaign" }));
  await writeFile(mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(encryptionKeyPath, "synthetic-test-key");
  await writeFile(packageTablePath, JSON.stringify({ id: "registered-package-row", value: "keep" }));
  process.env.FILE_STORAGE_DIR = fileStorageDir;

  const tables = {
    chats: [{ id: "chat-roundtrip", title: "Campaign chat" }],
    messages: [{ id: "message-roundtrip", chatId: "chat-roundtrip", content: "Saved campaign turn" }],
    characters: [{ id: "character-roundtrip", name: "Campaign character" }],
    lorebooks: [{ id: "lorebook-roundtrip", name: "Campaign lore" }],
    app_settings: [{ key: "game-setting", value: "preserve" }],
    game_state_snapshots: [{ id: "game-snapshot-roundtrip", chatId: "chat-roundtrip", state: "saved" }],
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
    assert.deepEqual(restored.tables?.characters, tables.characters);
    assert.deepEqual(restored.tables?.lorebooks, tables.lorebooks);
    assert.deepEqual(restored.tables?.app_settings, tables.app_settings);
    assert.deepEqual(restored.tables?.game_state_snapshots, tables.game_state_snapshots);

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
      assert.equal(
        restored.entryNames.some((name) => name.endsWith("/.encryption-key")),
        false,
        "data mode must omit the local encryption key",
      );
      assert.equal(
        restored.entryNames.some((name) => name.endsWith("/storage/package-tables/sample/record.json")),
        false,
        "data mode must disclose and omit package-owned rows stored outside the portable profile contract",
      );
      assert.equal(existsSync(join(snapshotPath, "avatars", "should-be-excluded.png")), false);
      assert.match(await readFile(join(snapshotPath, "RESTORE.txt"), "utf8"), /omitting package-owned table data/u);
    } else {
      assert.ok(fileManifest.some((file) => file.path === "avatars/should-be-excluded.png"));
      assert.ok(profile.asset, "incremental mode must remain a complete export including media");
      assert.ok(
        restored.entryNames.some((name) => name.endsWith("/.encryption-key")),
        "incremental mode must remain a complete export including the local key",
      );
      assert.ok(
        restored.entryNames.some((name) => name.endsWith("/storage/package-tables/sample/record.json")),
        `incremental mode must keep package-owned raw storage for full recovery: ${JSON.stringify(restored.entryNames.filter((name) => name.includes("storage")))}`,
      );
    }
    const restoreNote = await readFile(join(snapshotPath, "RESTORE.txt"), "utf8");
    if (mode === "data") assert.match(restoreNote, /long-term-memory vault and event files/u);
  }

  const deletedFilePath = join(dataDir, "campaign-history", "removed.json");
  await mkdir(join(dataDir, "campaign-history"), { recursive: true });
  await writeFile(deletedFilePath, JSON.stringify({ stale: true }));
  const beforeDeleteSnapshot = join(root, "incremental-before-delete");
  const afterDeleteSnapshot = join(root, "incremental-after-delete");
  await writeBackupSnapshotForRegression({
    mode: "incremental",
    dataDir,
    destination: beforeDeleteSnapshot,
    tables,
  });
  await rm(deletedFilePath);
  await writeBackupSnapshotForRegression({
    mode: "incremental",
    dataDir,
    destination: afterDeleteSnapshot,
    previous: beforeDeleteSnapshot,
    tables,
  });
  assert.equal(
    existsSync(join(afterDeleteSnapshot, "campaign-history", "removed.json")),
    false,
    "an incremental snapshot must omit files deleted since its previous snapshot",
  );
  const afterDeleteArchive = join(root, "incremental-after-delete.zip");
  await writeBackupSnapshotArchiveForRegression(
    afterDeleteSnapshot,
    "marinara-backup-incremental-after-delete",
    afterDeleteArchive,
  );
  const afterDeleteImport = await readStoredBackupImportForRegression(
    afterDeleteArchive,
    "campaign-history/removed.json",
  );
  assert.equal(
    afterDeleteImport.asset,
    null,
    "the incremental archive must not restore a file deleted from its source",
  );

  const fullArchive = join(root, "full.zip");
  await writeBackupArchiveForRegression({ mode: "full", dataDir, outputPath: fullArchive, tables });
  const fullTables = await readStoredBackupTablesForRegression(fullArchive);
  assert.deepEqual(fullTables.tables?.chats, tables.chats, "the full default retains saved chat data");
  assert.ok(
    fullTables.entryNames.some((name) => name.endsWith("/.encryption-key")),
    "the full default retains the local encryption key",
  );
  assert.ok(
    fullTables.entryNames.some((name) => name.endsWith("/storage/package-tables/sample/record.json")),
    "the full default retains package-owned raw storage",
  );
  const fullMedia = await readStoredBackupImportForRegression(fullArchive, "avatars/should-be-excluded.png");
  assert.ok(fullMedia.asset, "the full default retains local media files");

  const profileDataDir = join(root, "profile-roundtrip-data");
  const physicalProfileDataDir = join(root, "physical-profile-data");
  await mkdir(physicalProfileDataDir);
  await symlink(physicalProfileDataDir, profileDataDir, process.platform === "win32" ? "junction" : "dir");
  const profileFileStorageDir = join(profileDataDir, "storage");
  process.env.DATA_DIR = profileDataDir;
  process.env.FILE_STORAGE_DIR = profileFileStorageDir;
  const [dbModule, schema, backupModule, cryptoModule] = await Promise.all([
    import("../../packages/server/src/db/connection.js"),
    import("../../packages/server/src/db/schema/index.js"),
    import("../../packages/server/src/routes/backup.routes.js"),
    import("../../packages/server/src/utils/crypto.js"),
  ]);
  const db = await dbModule.getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(multipart);
  await app.register(backupModule.backupRoutes, { prefix: "/api/backup" });
  await app.ready();
  try {
    resetFeatureSettingsForTests({ backupModes: true });
    const redirectedBackups = join(physicalProfileDataDir, "backups");
    const outsideBackups = join(root, "outside-backups");
    await mkdir(outsideBackups);
    await writeFile(join(outsideBackups, "sentinel"), "untouched");
    await symlink(outsideBackups, redirectedBackups, process.platform === "win32" ? "junction" : "dir");
    const rejectedRedirect = await app.inject({
      method: "POST",
      url: "/api/backup/download",
      payload: { mode: "incremental" },
    });
    assert.equal(rejectedRedirect.statusCode, 500, "a linked backups child must be rejected");
    assert.equal(await readFile(join(outsideBackups, "sentinel"), "utf8"), "untouched");
    assert.deepEqual(
      await readdir(outsideBackups),
      ["sentinel"],
      "no snapshot is written through the redirected child",
    );
    await rm(redirectedBackups, { recursive: true });
    const linkedDownload = await app.inject({
      method: "POST",
      url: "/api/backup/download",
      payload: { mode: "incremental" },
    });
    assert.equal(linkedDownload.statusCode, 200, "incremental download supports a linked DATA_DIR");
    const linkedStart = await app.inject({
      method: "POST",
      url: "/api/backup/download/start",
      payload: { mode: "incremental" },
    });
    assert.equal(linkedStart.statusCode, 202, linkedStart.body);
    let linkedStatus = "preparing";
    for (let attempt = 0; attempt < 200 && linkedStatus === "preparing"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const response = await app.inject({
        method: "GET",
        url: `/api/backup/download/status/${linkedStart.json().jobId}`,
      });
      linkedStatus = response.json().status;
    }
    assert.equal(linkedStatus, "ready", "asynchronous incremental download supports a linked DATA_DIR");
    for (const state of [undefined, false, true, false] as const) {
      resetFeatureSettingsForTests(state === undefined ? {} : { backupModes: state });
      for (const route of ["/download", "/download/start"]) {
        if (state === true) continue;
        for (const mode of ["data", "incremental"]) {
          const response = await app.inject({ method: "POST", url: `/api/backup${route}`, payload: { mode } });
          assert.equal(response.statusCode, 403, `${route} rejects ${mode} while OFF`);
        }
      }
      const saved = await app.inject({
        method: "PUT",
        url: "/api/backup/automatic",
        payload: {
          enabled: false,
          frequency: "daily",
          retentionCount: 5,
          mode: "incremental",
        },
      });
      assert.equal(saved.statusCode, state ? 200 : 403, saved.body);
      if (state === false) {
        const baselineUpdate = await app.inject({
          method: "PUT",
          url: "/api/backup/automatic",
          payload: {
            enabled: false,
            frequency: "daily",
            retentionCount: 5,
          },
        });
        assert.equal(baselineUpdate.statusCode, 200, baselineUpdate.body);
      }
    }
    const retained = await app.inject({ method: "GET", url: "/api/backup/automatic" });
    assert.equal(retained.json().mode, "incremental", "OFF baseline settings save preserves selected mode");
    const fullOff = await app.inject({ method: "POST", url: "/api/backup/download", payload: { mode: "full" } });
    assert.equal(fullOff.statusCode, 200, "ordinary full download remains available OFF");
    const timestamp = new Date(0).toISOString();
    const parentChatId = "lineage-profile-parent";
    const validBranchId = "lineage-profile-valid-branch";
    const danglingParentBranchId = "lineage-profile-dangling-parent";
    const danglingMessageBranchId = "lineage-profile-dangling-message";
    const wrongOwnerBranchId = "lineage-profile-wrong-owner";
    const nullBranchId = "lineage-profile-null-branch";
    const parentMessageId = "lineage-profile-parent-message";
    const validChildMessageId = "lineage-profile-valid-child-message";
    const danglingParentChildMessageId = "lineage-profile-dangling-parent-child-message";
    const danglingMessageChildMessageId = "lineage-profile-dangling-message-child-message";
    const chatFixture = (id: string, name: string, metadata: Record<string, unknown> = {}) => ({
      id,
      name,
      mode: "game",
      characterIds: "[]",
      groupId: "lineage-profile-campaign",
      metadata: JSON.stringify(metadata),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db.insert(schema.chats).values([
      chatFixture(parentChatId, "Campaign source"),
      chatFixture(validBranchId, "Exported branch", {
        branchParentChatId: parentChatId,
        branchParentMessageId: parentMessageId,
        branchMessageId: validChildMessageId,
      }),
      chatFixture(danglingParentBranchId, "Branch with missing parent", {
        branchParentChatId: "lineage-profile-missing-chat",
        branchParentMessageId: "lineage-profile-missing-parent-message",
        branchMessageId: danglingParentChildMessageId,
      }),
      chatFixture(danglingMessageBranchId, "Branch with missing message", {
        branchParentChatId: parentChatId,
        branchParentMessageId: "lineage-profile-missing-source-message",
        branchMessageId: danglingMessageChildMessageId,
      }),
      chatFixture(wrongOwnerBranchId, "Branch with wrong message owners", {
        branchParentChatId: parentChatId,
        branchParentMessageId: validChildMessageId,
        branchMessageId: parentMessageId,
      }),
      chatFixture(nullBranchId, "Explicitly unbranched", {
        branchParentChatId: null,
        branchParentMessageId: null,
        branchMessageId: null,
      }),
    ] as never);
    await db.insert(schema.messages).values([
      { id: parentMessageId, chatId: parentChatId, role: "user", content: "Source message", createdAt: timestamp },
      {
        id: validChildMessageId,
        chatId: validBranchId,
        role: "assistant",
        content: "Copied branch turn",
        createdAt: timestamp,
      },
      {
        id: danglingParentChildMessageId,
        chatId: danglingParentBranchId,
        role: "assistant",
        content: "Branch turn",
        createdAt: timestamp,
      },
      {
        id: danglingMessageChildMessageId,
        chatId: danglingMessageBranchId,
        role: "assistant",
        content: "Branch turn",
        createdAt: timestamp,
      },
    ] as never);
    const preservedApiKey = cryptoModule.encryptApiKey("local-profile-api-key");
    const preservedManagementToken = cryptoModule.encryptApiKey("local-profile-management-token");
    await db.insert(schema.apiConnections).values({
      id: "lineage-profile-credential",
      name: "Existing profile connection",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEncrypted: preservedApiKey,
      managementTokenEncrypted: preservedManagementToken,
      model: "gpt-test",
      createdAt: timestamp,
      updatedAt: timestamp,
    } as never);

    const profileArchivePath = join(root, "profile-lineage.zip");
    const exportResponse = await app.inject({ method: "GET", url: "/api/backup/export-profile?format=zip" });
    assert.equal(exportResponse.statusCode, 200, exportResponse.body);
    await writeFile(profileArchivePath, exportResponse.rawPayload);
    const exportedProfile = await readStoredBackupTablesForRegression(profileArchivePath);
    const exportedChats = exportedProfile.tables?.chats as Array<Record<string, unknown>>;
    const exportedValidBranch = exportedChats.find((chat) => chat.id === validBranchId)!;
    assert.deepEqual(
      JSON.parse(String(exportedValidBranch.metadata)),
      {
        branchParentChatId: parentChatId,
        branchParentMessageId: parentMessageId,
        branchMessageId: validChildMessageId,
      },
      "profile export must preserve valid included branch references",
    );
    const exportedConnections = exportedProfile.tables?.api_connections as Array<Record<string, unknown>>;
    const exportedConnection = exportedConnections.find(
      (connection) => connection.id === "lineage-profile-credential",
    )!;
    assert.equal(exportedConnection.apiKeyEncrypted, "", "profile export must not include local API credentials");
    assert.equal(
      exportedConnection.managementTokenEncrypted,
      "",
      "profile export must not include local management tokens",
    );

    await db.update(schema.chats).set({ name: "Local branch edit" }).where(eq(schema.chats.id, validBranchId));
    await db.insert(schema.chats).values(chatFixture("lineage-profile-target-only", "Local-only chat") as never);
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/backup/import-profile?preview=true",
      ...multipartUpload("profile-lineage.zip", await readFile(profileArchivePath)),
    });
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = previewResponse.json();
    const lineageWarnings = (preview.warnings as Array<{ type: string; path?: string; message: string }>).filter(
      (warning) => warning.type === "branch_lineage_references_omitted",
    );
    assert.equal(
      lineageWarnings.length,
      3,
      `dangling refs should produce one import warning for each affected chat: ${JSON.stringify(preview.warnings)}`,
    );
    assert.ok(lineageWarnings.every((warning) => warning.path && warning.message));
    const importResponse = await app.inject({
      method: "POST",
      url: "/api/backup/import-profile",
      headers: { "x-profile-preview-token": preview.previewToken },
    });
    assert.equal(importResponse.statusCode, 200, importResponse.body);
    const importWarnings = (
      importResponse.json().warnings as Array<{ type: string; path?: string; message: string }>
    ).filter((warning) => warning.type === "branch_lineage_references_omitted");
    assert.deepEqual(importWarnings, lineageWarnings, "final import must retain the preview's lineage warnings");

    const restoredChats = (await db.select().from(schema.chats)) as Array<Record<string, unknown>>;
    const restoredById = new Map(restoredChats.map((chat) => [String(chat.id), chat]));
    assert.equal(
      restoredById.get(validBranchId)?.name,
      "Exported branch",
      "same-ID rows should update from the imported archive",
    );
    assert.ok(restoredById.has("lineage-profile-target-only"), "profile import must retain target-only rows");
    assert.deepEqual(
      JSON.parse(String(restoredById.get(validBranchId)?.metadata)),
      {
        branchParentChatId: parentChatId,
        branchParentMessageId: parentMessageId,
        branchMessageId: validChildMessageId,
      },
      "valid branch references must survive an actual ZIP export/import roundtrip",
    );
    assert.deepEqual(
      JSON.parse(String(restoredById.get(danglingParentBranchId)?.metadata)),
      {
        branchMessageId: danglingParentChildMessageId,
      },
      "missing parent-chat/message references should be removed while valid child endpoints remain",
    );
    assert.deepEqual(
      JSON.parse(String(restoredById.get(danglingMessageBranchId)?.metadata)),
      {
        branchParentChatId: parentChatId,
        branchMessageId: danglingMessageChildMessageId,
      },
      "a missing parent message should be removed without dropping its valid chat and child references",
    );
    const restoredConnections = (await db.select().from(schema.apiConnections)) as Array<Record<string, unknown>>;
    assert.deepEqual(
      JSON.parse(String(restoredById.get(wrongOwnerBranchId)?.metadata)),
      { branchParentChatId: parentChatId },
      "existing messages owned by the wrong chats must not become valid branch endpoints",
    );
    assert.deepEqual(
      JSON.parse(String(restoredById.get(nullBranchId)?.metadata)),
      { branchParentChatId: null, branchParentMessageId: null, branchMessageId: null },
      "explicit null branch markers must survive export and import without warnings",
    );
    const restoredConnection = restoredConnections.find(
      (connection) => connection.id === "lineage-profile-credential",
    )!;
    assert.equal(restoredConnection.apiKeyEncrypted, preservedApiKey, "profile import must preserve the local API key");
    assert.equal(
      restoredConnection.managementTokenEncrypted,
      preservedManagementToken,
      "profile import must preserve the local management token",
    );
  } finally {
    await app.close();
    await dbModule.closeDB();
    if (priorDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = priorDataDir;
    if (priorFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
    else process.env.FILE_STORAGE_DIR = priorFileStorageDir;
  }

  const failedRoot = join(root, "failed-publication");
  resetFeatureSettingsForTests({ backupModes: true });
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
  const disabledDestination = join(failedRoot, "marinara-backup-incremental-disabled");
  await assert.rejects(
    writeBackupSnapshotForRegression({
      mode: "incremental",
      dataDir,
      destination: disabledDestination,
      tables,
      beforeCopy: async () => {
        resetFeatureSettingsForTests({ backupModes: false });
      },
    }),
    /Additional backup modes are disabled/u,
  );
  assert.equal(existsSync(disabledDestination), false, "disabling during preparation prevents publication");
  assert.equal(existsSync(afterDeleteSnapshot), true, "existing snapshot survives disabling");
  resetFeatureSettingsForTests({ backupModes: true });
  const lateDisabledDestination = join(failedRoot, "marinara-backup-incremental-disabled-after-publication");
  await assert.rejects(
    writeBackupSnapshotForRegression({
      mode: "incremental",
      dataDir,
      destination: lateDisabledDestination,
      tables,
      afterPublish: async () => {
        assert.equal(existsSync(lateDisabledDestination), true, "the test toggles OFF only after the final rename");
        resetFeatureSettingsForTests({ backupModes: false });
      },
    }),
    /Additional backup modes are disabled/u,
  );
  assert.equal(existsSync(lateDisabledDestination), false, "a newly published optional snapshot is removed after OFF");
  assert.equal(existsSync(afterDeleteSnapshot), true, "late OFF preserves snapshots that predate this request");

  resetFeatureSettingsForTests({ backupModes: true });
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
  resetFeatureSettingsForTests({ backupModes: false });
  await pruneScheduledBackupHistoryForRegression(retentionRoot, 2);
  assert.equal(existsSync(scheduledOld), true, "OFF retention preserves scheduled incremental archives");
  assert.equal(existsSync(scheduledNewest), true);
  resetFeatureSettingsForTests({ backupModes: true });
  await pruneScheduledBackupHistoryForRegression(retentionRoot, 2);
  assert.equal(existsSync(oldZip), false);
  assert.equal(existsSync(scheduledOld), false);
  assert.equal(existsSync(newZip), true);
  assert.equal(existsSync(scheduledNewest), true);
  assert.equal(existsSync(manualSnapshot), true, "retention must not prune a manual incremental snapshot");
  assert.equal(existsSync(manualFolder), true, "retention must not prune unrelated manual backups");
} finally {
  resetFeatureSettingsForTests();
  if (priorDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = priorDataDir;
  if (priorFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = priorFileStorageDir;
  await rm(root, { recursive: true, force: true });
}

console.log("Backup mode regression passed.");
