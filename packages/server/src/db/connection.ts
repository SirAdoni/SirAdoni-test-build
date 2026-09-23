// ──────────────────────────────────────────────
// File Storage Connection
// ──────────────────────────────────────────────
import { logger } from "../lib/logger.js";
import { startup } from "../lib/startup-timeline.js";
import { createFileNativeDB, type FileNativeDB, type FileNativeStoreController } from "./file-backed-store.js";

type DbCleanup = () => void | Promise<void>;

let dbPromise: Promise<DB> | null = null;
let dbCleanup: DbCleanup | null = null;
let fileStore: FileNativeStoreController | null = null;

async function createStorage(): Promise<DB> {
  const db = await createFileNativeDB();
  fileStore = db._fileStore;
  const bootStats = fileStore.getBootStats();
  if (bootStats) startup.record("storage", bootStats);
  dbCleanup = async () => {
    await fileStore?.close();
    fileStore = null;
  };
  return db;
}

export async function getDB() {
  if (!dbPromise) {
    dbPromise = createStorage();
  }
  return dbPromise;
}

export async function flushDB() {
  await fileStore?.flush();
}

export async function closeDB() {
  const activePromise = dbPromise;
  if (!activePromise) {
    return;
  }

  dbPromise = null;

  try {
    await activePromise;
  } catch (err) {
    // initialize() already reported this failure; shutdown only notes that there was nothing to close.
    logger.debug(
      { event: "storage.close", stage: "awaitInit", outcome: "skipped", err },
      "[db] Database never finished initializing; nothing to close",
    );
    dbCleanup = null;
    return;
  }

  const cleanup = dbCleanup;
  dbCleanup = null;
  if (!cleanup) {
    return;
  }

  const dirtyTables = fileStore?.getDirtyTables() ?? [];
  const started = Date.now();
  try {
    await cleanup();
    logger.info(
      { event: "storage.close", outcome: "ok", elapsedMs: Date.now() - started, dirtyTables },
      "[db] Database closed",
    );
  } catch (err) {
    logger.error(
      { event: "storage.close", outcome: "failed", elapsedMs: Date.now() - started, dirtyTables, err },
      "[db] Failed to close database",
    );
  }
}

export type DB = FileNativeDB;
