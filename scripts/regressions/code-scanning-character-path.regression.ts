import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-character-delete-path-"));
const previousDataDir = process.env.DATA_DIR;
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
const previousMarinaraFileStorageDir = process.env.MARINARA_FILE_STORAGE_DIR;
const previousNodeEnv = process.env.NODE_ENV;
const previousLiteMode = process.env.MARINARA_LITE;

let app: {
  close(): Promise<void>;
  ready(): Promise<unknown>;
  inject(options: Record<string, unknown>): Promise<{
    statusCode: number;
    json(): unknown;
  }>;
} | null = null;

try {
  const fileStorageDir = join(dataDir, "file-storage");
  process.env.DATA_DIR = dataDir;
  process.env.FILE_STORAGE_DIR = fileStorageDir;
  process.env.MARINARA_FILE_STORAGE_DIR = fileStorageDir;
  process.env.NODE_ENV = "test";
  process.env.MARINARA_LITE = "true";

  const { buildApp } = await import("../../packages/server/src/app.js");
  app = await buildApp();
  await app.ready();

  const outsideGalleryDir = join(dataDir, "gallery", "outside");
  const outsideSentinel = join(outsideGalleryDir, "must-survive.txt");
  mkdirSync(outsideGalleryDir, { recursive: true });
  writeFileSync(outsideSentinel, "outside the character gallery root", "utf8");

  const traversal = await app.inject({
    method: "DELETE",
    url: "/api/characters/%2e%2e%2foutside",
  });
  assert.equal(traversal.statusCode, 400, "encoded traversal IDs must be rejected before character deletion");
  assert.equal(
    existsSync(outsideSentinel),
    true,
    "character deletion must not recursively remove a sibling of the character gallery root",
  );

  const created = await app.inject({
    method: "POST",
    url: "/api/characters",
    payload: { data: { name: "Safe deletion regression" } },
  });
  assert.equal(created.statusCode, 200);
  const characterId = (created.json() as { id?: unknown }).id;
  assert.equal(typeof characterId, "string");

  const ownedGalleryDir = join(dataDir, "gallery", "characters", characterId as string);
  mkdirSync(ownedGalleryDir, { recursive: true });
  writeFileSync(join(ownedGalleryDir, "owned.txt"), "owned by the character", "utf8");

  const deletion = await app.inject({
    method: "DELETE",
    url: `/api/characters/${encodeURIComponent(characterId as string)}`,
  });
  assert.equal(deletion.statusCode, 204, "valid character deletion must remain available");
  assert.equal(existsSync(ownedGalleryDir), false, "valid character deletion must remove its owned gallery directory");
  assert.equal(existsSync(outsideSentinel), true, "valid deletion must not disturb sibling directories");
} finally {
  await app?.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  if (previousMarinaraFileStorageDir === undefined) delete process.env.MARINARA_FILE_STORAGE_DIR;
  else process.env.MARINARA_FILE_STORAGE_DIR = previousMarinaraFileStorageDir;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousLiteMode === undefined) delete process.env.MARINARA_LITE;
  else process.env.MARINARA_LITE = previousLiteMode;
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("code scanning character path regression passed");
