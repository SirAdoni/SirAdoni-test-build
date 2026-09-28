import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPreparedBackupDownloadUrl,
  isPreparedBackupDownloadTokenValid,
} from "../../packages/server/src/routes/backup.routes.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const jobId = "job/id";
const token = "token+value";

assert.equal(buildPreparedBackupDownloadUrl(jobId, token), "/api/backup/download/file/job%2Fid?token=token%2Bvalue");
assert.equal(isPreparedBackupDownloadTokenValid(token, token), true);
assert.equal(isPreparedBackupDownloadTokenValid(token, "wrong-token"), false);
assert.equal(isPreparedBackupDownloadTokenValid(token, undefined), false);

const settingsPanelSource = readFileSync(
  join(repositoryRoot, "packages/client/src/components/panels/SettingsPanel.tsx"),
  "utf8",
);
const backupRoutesSource = readFileSync(join(repositoryRoot, "packages/server/src/routes/backup.routes.ts"), "utf8");
assert.match(
  backupRoutesSource,
  /"\/download\/file\/:jobId",\s*\{ exposeHeadRoute: false,/u,
  "HEAD requests must not consume the one-time prepared backup job",
);
const downloadStart = settingsPanelSource.indexOf("const startBackupDownload = async");
const createStart = settingsPanelSource.indexOf("const handleCreateBackup = async () =>");
const createEnd = settingsPanelSource.indexOf("const handleDownloadBackup", createStart);
const listStart = settingsPanelSource.indexOf("const { data: backups }");
assert.ok(downloadStart >= 0 && createStart > downloadStart && createEnd > createStart && listStart > createEnd);
const downloadSource = settingsPanelSource.slice(downloadStart, createStart);
const createSource = settingsPanelSource.slice(createStart, createEnd);
assert.match(downloadSource, /api\.post<[^>]+>\("\/backup\/download\/start", request\)/u);
assert.match(downloadSource, /window\.location\.assign\(status\.downloadUrl\)/u);
assert.doesNotMatch(downloadSource, /\.blob\(\)|createObjectURL|showSaveFilePicker/u);
assert.match(createSource, /settings\.mode === "incremental"[\s\S]*?api\.post\("\/backup"\)/u);
assert.match(createSource, /startBackupDownload\(\{ mode: settings\.mode \}\)/u);
assert.doesNotMatch(
  createSource.match(/if \(settings\.mode === "incremental"\)[\s\S]*?return;/u)?.[0] ?? "",
  /startBackupDownload/u,
);
assert.match(
  settingsPanelSource,
  /disabled=\{\s*automaticBackupQuery\.isLoading\s*\|\|\s*!automaticBackupQuery\.data\s*\|\|\s*automaticBackupMutation\.isPending\s*\}/u,
);

console.log("Backup download handoff regression passed.");
