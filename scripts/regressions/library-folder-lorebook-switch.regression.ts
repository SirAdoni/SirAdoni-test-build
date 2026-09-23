import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

// Covers POST /lorebooks/bulk-enabled (the library folder lorebook switch) and its undo:
// only lorebooks that flipped are reported, so undo flips exactly those back.
// The pure planning and the campaign roster live in library-campaign-roster.regression.ts.

// ── POST /lorebooks/bulk-enabled ──
const dataDir = mkdtempSync(join(tmpdir(), "marinara-library-folder-lorebook-switch-"));
const previous = {
  DATA_DIR: process.env.DATA_DIR,
  FILE_STORAGE_DIR: process.env.FILE_STORAGE_DIR,
  MARINARA_FILE_STORAGE_DIR: process.env.MARINARA_FILE_STORAGE_DIR,
};
type Response = { statusCode: number; body: string; json(): any };
let app: { close(): Promise<void>; inject(options: Record<string, unknown>): Promise<Response> } | null = null;
try {
  const fileStorageDir = join(dataDir, "file-storage");
  process.env.DATA_DIR = dataDir;
  process.env.FILE_STORAGE_DIR = fileStorageDir;
  process.env.MARINARA_FILE_STORAGE_DIR = fileStorageDir;
  const [{ createFileNativeDB }, { lorebooksRoutes }] = await Promise.all([
    import("../../packages/server/src/db/file-backed-store.js"),
    import("../../packages/server/src/routes/lorebooks.routes.js"),
  ]);
  const db = await createFileNativeDB();
  const Fastify = createRequire(new URL("../../packages/server/package.json", import.meta.url))("fastify");
  const server = Fastify();
  server.decorate("db", db);
  await server.register(lorebooksRoutes, { prefix: "/api/lorebooks" });
  app = server;
  const request = async (method: string, url: string, payload?: unknown, status = 200) => {
    const response = await app!.inject({ method, url, payload });
    assert.equal(response.statusCode, status, `${method} ${url} -> ${response.statusCode} ${response.body}`);
    return response.body ? response.json() : null;
  };

  const on = await request("POST", "/api/lorebooks", { name: "On" });
  const off = await request("POST", "/api/lorebooks", { name: "Off", enabled: false });
  const disabled = await request("POST", "/api/lorebooks/bulk-enabled", {
    ids: [on.id, off.id, "missing"],
    enabled: false,
  });
  assert.deepEqual(disabled, { changedIds: [on.id], unchangedIds: [off.id], missingIds: ["missing"] });
  assert.equal((await request("GET", `/api/lorebooks/${on.id}`)).enabled, false);

  // Undo flips back only what changed: "Off" stays off.
  await request("POST", "/api/lorebooks/bulk-enabled", { ids: disabled.changedIds, enabled: true });
  assert.equal((await request("GET", `/api/lorebooks/${on.id}`)).enabled, true);
  assert.equal((await request("GET", `/api/lorebooks/${off.id}`)).enabled, false);

  await request("POST", "/api/lorebooks/bulk-enabled", { ids: [], enabled: true }, 400);
  await request("POST", "/api/lorebooks/bulk-enabled", { ids: [on.id, on.id], enabled: true }, 400);
} finally {
  await app?.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("library-folder-lorebook-switch regression passed");
