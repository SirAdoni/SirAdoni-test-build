/** Isolated backup/restore drill (audit task 15). Never touches live storage or the live server.
 * Restores the storage tree from the Codex v1 backup (campaign.zip + data-supplement overlay) into a temp
 * DATA_DIR, boots the file store in-process, verifies chat/message/swipe/receipt counts against the live
 * source copy (read-only) and the backup's own declared counts, compares a 20-message sample byte for byte,
 * exercises /backup/import-profile?preview=true on the copy with the archive envelope, then writes
 * .tmp/v3-execution/backup-restore-drill.result.json and deletes the temp copy.
 * Run from the repo root, e.g.
 *   NODE_OPTIONS=--max-old-space-size=16384 node node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/cli.mjs scripts/evals/backup-restore-drill.mts [backup dir]
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const startedAt = Date.now();
const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const backupDir = resolve(process.argv[2] ?? join(repoRoot, "output/marinara-backup_2026-09-13_Codex_v1"));
const liveStorage = join(repoRoot, "packages/server/data/storage");
const resultPath = join(repoRoot, ".tmp/v3-execution/backup-restore-drill.result.json");
const SAMPLE_SIZE = 20;

const zipPath = join(backupDir, "campaign.zip");
const supplementDir = join(backupDir, "data-supplement");
const verificationPath = join(backupDir, "campaign-verification.json");
const artifacts = { zip: existsSync(zipPath), supplement: existsSync(supplementDir), verification: existsSync(verificationPath) };
if (!artifacts.zip) throw new Error(`campaign.zip not found under ${backupDir}`);

const root = mkdtempSync(join(tmpdir(), "marinara-backup-restore-drill-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

const timings: Record<string, number> = {};
const time = async <T>(label: string, work: () => Promise<T> | T): Promise<T> => {
  const t0 = Date.now();
  try {
    return await work();
  } finally {
    timings[label] = Date.now() - t0;
  }
};
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const unzipBinary = (() => {
  for (const candidate of ["unzip", "C:\\Program Files\\Git\\usr\\bin\\unzip.exe"]) {
    try {
      execFileSync(candidate, ["-v"], { stdio: "ignore" });
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error("unzip is not available; install Info-ZIP unzip (Git for Windows ships one)");
})();
const unzip = (args: string[], options: { maxBuffer?: number } = {}) =>
  execFileSync(unzipBinary, args, { encoding: "buffer", maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const isPrimaryShard = (name: string) => name.endsWith(".json") && !name.endsWith(".bak") && !name.endsWith(".prepaint");
/** Read-only row scan of a sharded table directory (primary shards only). */
const scanTable = (storageDir: string, table: string): Array<Record<string, any>> => {
  const dir = join(storageDir, "tables", table);
  if (!existsSync(dir)) return [];
  const rows: Array<Record<string, any>> = [];
  for (const file of readdirSync(dir)) {
    if (!isPrimaryShard(file)) continue;
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (Array.isArray(parsed)) rows.push(...parsed);
  }
  return rows;
};

const requireServer = createRequire(join(repoRoot, "packages/server/package.json"));
const Fastify = requireServer("fastify");

const report: Record<string, unknown> = { drill: "backup-restore-drill", startedAt: new Date(startedAt).toISOString(), backupDir, artifacts, tempDataDir: root };
let closeDB: (() => Promise<void>) | null = null;
let app: { close(): Promise<void>; inject(options: Record<string, unknown>): Promise<any> } | null = null;

try {
  if (artifacts.verification) report.verification = JSON.parse(readFileSync(verificationPath, "utf8"));
  const zipStat = statSync(zipPath);
  report.zipBytes = zipStat.size;
  if (artifacts.verification && typeof (report.verification as any).bytes === "number")
    assert.equal(zipStat.size, (report.verification as any).bytes, "campaign.zip size differs from campaign-verification.json");

  // 1. Restore: extract storage/** from the archive (primaries only, no writer-lease dirs), overlay the supplement.
  const entries = await time("listZipMs", () => unzip(["-Z1", zipPath], { maxBuffer: 256 * 1024 * 1024 }).toString("utf8").split(/\r?\n/).filter(Boolean));
  const topFolder = entries[0]?.split("/")[0];
  assert.ok(topFolder, "archive is empty");
  const storagePrefix = `${topFolder}/storage/`;
  const storageEntries = entries.filter((entry) => entry.startsWith(storagePrefix));
  assert.ok(storageEntries.length > 0, "archive holds no storage/ entries");
  // Info-ZIP wildcards do not reliably cross "/" on this build, so the entries are named explicitly, in batches.
  const wanted = storageEntries.filter(
    (entry) => !entry.endsWith("/") && !entry.endsWith(".bak") && !entry.endsWith(".prepaint") && !entry.startsWith(`${storagePrefix}.writer-lease`),
  );
  for (const entry of wanted) if (/[[\]*?]/.test(entry)) throw new Error(`archive entry uses glob characters, refusing to extract by name: ${entry}`);
  const extractDir = join(root, "extract");
  mkdirSync(extractDir, { recursive: true });
  await time("extractMs", () => {
    const batchSize = 200;
    for (let index = 0; index < wanted.length; index += batchSize)
      unzip(["-q", "-o", zipPath, ...wanted.slice(index, index + batchSize), "-d", extractDir]);
  });
  const extractedCount = wanted.filter((entry) => existsSync(join(extractDir, entry))).length;
  assert.equal(extractedCount, wanted.length, `extracted ${extractedCount} of ${wanted.length} storage entries`);
  renameSync(join(extractDir, topFolder, "storage"), process.env.FILE_STORAGE_DIR!);
  rmSync(extractDir, { recursive: true, force: true });
  const backupManifest = JSON.parse(readFileSync(join(process.env.FILE_STORAGE_DIR!, "manifest.json"), "utf8"));
  const supplementFiles: string[] = [];
  if (artifacts.supplement && existsSync(join(supplementDir, "storage"))) {
    await time("overlayMs", () => {
      cpSync(join(supplementDir, "storage"), process.env.FILE_STORAGE_DIR!, {
        recursive: true,
        force: true,
        filter: (src) => {
          const name = basename(src);
          const keep = !name.endsWith(".bak") && !name.endsWith(".prepaint") && !name.startsWith(".writer-lease");
          if (keep && name.endsWith(".json")) supplementFiles.push(src.slice(supplementDir.length + 1));
          return keep;
        },
      });
    });
  }
  report.restore = {
    archiveTopFolder: topFolder,
    archiveEntries: entries.length,
    storageEntriesExtracted: extractedCount,
    backupManifestSavedAt: backupManifest.savedAt,
    backupDeclaredCounts: {
      chats: backupManifest.tables?.chats,
      messages: backupManifest.tables?.messages,
      message_swipes: backupManifest.tables?.message_swipes,
      game_continuity_batches: backupManifest.tables?.game_continuity_batches,
    },
    supplementFilesOverlaid: supplementFiles,
  };

  // 2. Independent file-level truth: restored tree and the live source copy, both scanned read-only.
  const restoredFiles = await time("scanRestoredFilesMs", () => ({
    chats: scanTable(process.env.FILE_STORAGE_DIR!, "chats"),
    messages: scanTable(process.env.FILE_STORAGE_DIR!, "messages"),
    swipes: scanTable(process.env.FILE_STORAGE_DIR!, "message_swipes"),
    receipts: scanTable(process.env.FILE_STORAGE_DIR!, "game_continuity_batches"),
  }));
  const source = await time("scanSourceMs", () => ({
    chats: scanTable(liveStorage, "chats"),
    messages: scanTable(liveStorage, "messages"),
    swipes: scanTable(liveStorage, "message_swipes"),
    receipts: scanTable(liveStorage, "game_continuity_batches"),
  }));
  const sourceCounts = { chats: source.chats.length, messages: source.messages.length, swipes: source.swipes.length, receipts: source.receipts.length };
  const restoredFileCounts = {
    chats: restoredFiles.chats.length,
    messages: restoredFiles.messages.length,
    swipes: restoredFiles.swipes.length,
    receipts: restoredFiles.receipts.length,
  };

  // 3. Boot the file store on the restored copy and count through the production loader.
  const { getDB, closeDB: close } = await import("../../packages/server/src/db/connection.js");
  closeDB = close;
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { backupRoutes } = await import("../../packages/server/src/routes/backup.routes.js");
  const db = await time("bootDbMs", () => getDB());
  const quarantined = db._fileStore.getQuarantinedTables();
  const restoredRows = {
    chats: await db.select().from(schema.chats),
    messages: await db.select().from(schema.messages),
    swipes: await db.select().from(schema.messageSwipes),
    receipts: await db.select().from(schema.gameContinuityBatches),
    entities: await db.select().from(schema.campaignMemoryEntities),
    facts: await db.select().from(schema.campaignMemoryFacts),
  };
  const restoredCounts = Object.fromEntries(Object.entries(restoredRows).map(([key, rows]) => [key, rows.length]));
  report.counts = { source: sourceCounts, restoredFiles: restoredFileCounts, restoredLoaded: restoredCounts, quarantinedTables: quarantined };
  assert.equal(quarantined.length, 0, "loader quarantined restored tables");
  for (const key of ["chats", "messages", "swipes", "receipts"] as const)
    assert.equal(restoredCounts[key], restoredFileCounts[key], `${key}: loader count differs from restored shard rows`);
  const sourceChatIds = new Set(source.chats.map((row) => row.id));
  const restoredChatIds = new Set(restoredRows.chats.map((row: any) => row.id));
  const sourceMessageIds = new Set(source.messages.map((row) => row.id));
  const restoredMessageIds = new Set(restoredRows.messages.map((row: any) => row.id));
  const sourceReceiptIds = new Set(source.receipts.map((row) => row.id));
  const restoredReceiptIds = new Set(restoredRows.receipts.map((row: any) => row.id));
  const missingFromSource = {
    chats: [...restoredChatIds].filter((id) => !sourceChatIds.has(id)),
    messages: [...restoredMessageIds].filter((id) => !sourceMessageIds.has(id)).length,
    receipts: [...restoredReceiptIds].filter((id) => !sourceReceiptIds.has(id)).length,
  };
  const newerInSource = {
    chats: [...sourceChatIds].filter((id) => !restoredChatIds.has(id)),
    messages: [...sourceMessageIds].filter((id) => !restoredMessageIds.has(id)).length,
    receipts: [...sourceReceiptIds].filter((id) => !restoredReceiptIds.has(id)).length,
  };
  report.comparison = {
    note: "The backup predates the live copy, so live-only rows are expected; restored-only rows would indicate loss on the live side.",
    restoredButNotInSource: missingFromSource,
    inSourceButNotRestored: newerInSource,
  };
  assert.ok(restoredCounts.chats <= sourceCounts.chats && restoredCounts.messages <= sourceCounts.messages, "restored copy holds more rows than the live source");

  // 4. Byte-for-byte sample: 20 messages present in both trees, spread across the restored set, skipping the most recently updated live chat.
  const sourceById = new Map(source.messages.map((row) => [row.id as string, row]));
  const newestChat = [...source.chats].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0]?.id;
  const candidates = restoredRows.messages
    .filter((row: any) => sourceById.has(row.id) && row.chatId !== newestChat)
    .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
  const step = Math.max(1, Math.floor(candidates.length / SAMPLE_SIZE));
  const sample = candidates.filter((_: unknown, index: number) => index % step === 0).slice(0, SAMPLE_SIZE);
  // The archive's own profile-tables/messages.jsonl is the second reference: it proves restore fidelity even where the live copy has been edited since the backup.
  const sampleIds = new Set(sample.map((row: any) => row.id as string));
  const archiveContent = await time("scanArchiveJsonlMs", async () => {
    const found = new Map<string, string>();
    const child = spawn(unzipBinary, ["-p", zipPath, `${topFolder}/profile-tables/messages.jsonl`], { stdio: ["ignore", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    let total = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      total += 1;
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.id === "string" && sampleIds.has(row.id)) found.set(row.id, String(row.content ?? ""));
    }
    return { found, total };
  });
  const sampleResults = sample.map((row: any) => {
    const restored = Buffer.from(String(row.content ?? ""), "utf8");
    const live = Buffer.from(String(sourceById.get(row.id)!.content ?? ""), "utf8");
    const archived = archiveContent.found.has(row.id) ? Buffer.from(archiveContent.found.get(row.id)!, "utf8") : null;
    return {
      messageId: row.id,
      chatId: row.chatId,
      bytes: restored.length,
      sha256: sha(restored),
      identicalToLive: Buffer.compare(restored, live) === 0,
      identicalToArchiveJsonl: archived ? Buffer.compare(restored, archived) === 0 : null,
    };
  });
  const identicalToLive = sampleResults.filter((row: any) => row.identicalToLive).length;
  const identicalToArchive = sampleResults.filter((row: any) => row.identicalToArchiveJsonl === true).length;
  const inArchiveJsonl = sampleResults.filter((row: any) => row.identicalToArchiveJsonl !== null).length;
  report.sample = {
    requested: SAMPLE_SIZE,
    compared: sampleResults.length,
    identicalToLive,
    inArchiveJsonl,
    identicalToArchiveJsonl: identicalToArchive,
    archiveJsonlRows: archiveContent.total,
    excludedChat: newestChat,
    liveMismatches: sampleResults.filter((row: any) => !row.identicalToLive).map((row: any) => ({ messageId: row.messageId, chatId: row.chatId })),
    messages: sampleResults,
  };
  assert.equal(sampleResults.length, SAMPLE_SIZE, "fewer than 20 shared messages to sample");
  assert.equal(identicalToArchive, inArchiveJsonl, "restored message content differs from the archive's own jsonl export");
  assert.ok(inArchiveJsonl >= SAMPLE_SIZE - 2, "too few sampled messages present in the archive jsonl");

  // 5. Exercise the profile import preview on the isolated copy with the archive's own envelope.
  app = await time("bootAppMs", async () => {
    const instance = Fastify();
    instance.decorate("db", db);
    await instance.register(backupRoutes, { prefix: "/api/backup" });
    await instance.ready();
    return instance;
  });
  const envelopeEntry = `${topFolder}/marinara-profile.json`;
  const envelope = JSON.parse(unzip(["-p", zipPath, envelopeEntry], { maxBuffer: 256 * 1024 * 1024 }).toString("utf8"));
  const preview = await time("importPreviewMs", () =>
    app!.inject({ method: "POST", url: "/api/backup/import-profile?preview=true", headers: { host: "localhost" }, payload: envelope }),
  );
  const previewBody = preview.json();
  report.importPreview = {
    status: preview.statusCode,
    preview: previewBody?.preview,
    envelopeDeclared: {
      chats: envelope?.data?.fileStorage?.tables?.chats?.count,
      messages: envelope?.data?.fileStorage?.tables?.messages?.count,
      message_swipes: envelope?.data?.fileStorage?.tables?.message_swipes?.count,
    },
    imported: previewBody?.imported,
    warnings: Array.isArray(previewBody?.warnings) ? previewBody.warnings.length : previewBody?.warnings,
    totalItems: previewBody?.totalItems,
    ...(preview.statusCode !== 200 ? { error: previewBody } : {}),
  };
  assert.equal(preview.statusCode, 200, JSON.stringify(previewBody));
  assert.equal(previewBody.preview, true);
  // Preview must not write: counts through the loader are unchanged.
  assert.equal((await db.select().from(schema.messages)).length, restoredCounts.messages, "preview changed the message count");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  process.exitCode = 1;
} finally {
  try {
    await app?.close();
  } catch {
    /* ignore */
  }
  try {
    await closeDB?.();
  } catch {
    /* ignore */
  }
  await time("cleanupMs", () => rmSync(root, { recursive: true, force: true }));
  timings.totalMs = Date.now() - startedAt;
  report.timings = timings;
  report.tempCopyDeleted = !existsSync(root);
  mkdirSync(join(repoRoot, ".tmp/v3-execution"), { recursive: true });
  writeFileSync(resultPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, resultPath, counts: report.counts, sample: { ...(report.sample as any), messages: undefined }, importPreview: report.importPreview, timings, error: report.error }, null, 2));
}
