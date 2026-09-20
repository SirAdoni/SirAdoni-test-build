import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
const folder = await mkdtemp(join(tmpdir(), "marinara-reference-proof-"));
process.env.DATA_DIR = folder;
process.env.FILE_STORAGE_DIR = join(folder, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
let app;
try {
  const { buildApp } = await import("../../packages/server/dist/app.js");
  const { getDB } = await import("../../packages/server/dist/db/connection.js");
  const { createCharactersStorage } = await import("../../packages/server/dist/services/storage/characters.storage.js");
  app = await buildApp();
  const storage = createCharactersStorage(await getDB());
  const original = await storage.create({ name: "Brynna Coldstream", description: "Original", personality: "" });
  assert.ok(original);
  await storage.update(original.id, { name: "Brynna Snow" });
  let row = await storage.getById(original.id);
  assert.equal(row.id, original.id);
  let card = JSON.parse(row.data);
  assert.equal(card.name, "Brynna Snow");
  assert.deepEqual(card.extensions.referenceNames, ["Brynna Coldstream"]);
  await storage.update(original.id, { description: "Edited", extensions: {} });
  row = await storage.getById(original.id);
  card = JSON.parse(row.data);
  assert.deepEqual(card.extensions.referenceNames, ["Brynna Coldstream"], "Full-card save preserves rename aliases");
  await storage.update(original.id, { name: "Brynna Winter" });
  row = await storage.getById(original.id);
  assert.deepEqual(JSON.parse(row.data).extensions.referenceNames, ["Brynna Coldstream", "Brynna Snow"]);
  process.stdout.write("Isolated real storage: stable ID, repeated renames and full-card alias preservation passed.\n");
} finally {
  await app?.close();
  // Only the directory uniquely created by this proof, never campaign storage.
  assert.ok(!relative(resolve(tmpdir()), resolve(folder)).startsWith(".."));
  assert.ok(folder.includes("marinara-reference-proof-"));
  await rm(folder, { recursive: true, force: true });
}
