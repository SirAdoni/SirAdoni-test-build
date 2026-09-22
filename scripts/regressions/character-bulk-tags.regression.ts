import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCharacterTagEdit,
  isEmptyCharacterTagEdit,
  normalizeCharacterTagEdit,
  summarizeCharacterTagEdit,
} from "../../packages/shared/src/utils/character-tag-edits.js";

// ── Pure tag edits ──
assert.deepEqual(applyCharacterTagEdit(["Fantasy", "NPC"], { add: ["noble", "npc"] }), ["Fantasy", "NPC", "noble"]);
assert.deepEqual(applyCharacterTagEdit(["Fantasy", "NPC"], { remove: ["npc"] }), ["Fantasy"]);
assert.deepEqual(
  applyCharacterTagEdit(["a", "Old", "b"], { rename: [{ from: "old", to: "New" }] }),
  ["a", "New", "b"],
  "rename keeps position",
);
assert.deepEqual(
  applyCharacterTagEdit(["Old", "New"], { rename: [{ from: "Old", to: "new" }] }),
  ["new"],
  "rename into an existing tag merges instead of duplicating",
);
assert.deepEqual(
  applyCharacterTagEdit(["x"], { rename: [{ from: "x", to: "y" }], remove: ["y"], add: ["z"] }),
  ["z"],
  "rename, then remove, then add",
);
assert.deepEqual(normalizeCharacterTagEdit({ add: [" a ", "A", ""], rename: [{ from: "q", to: "q" }] }), {
  add: ["a"],
  remove: [],
  rename: [],
});
assert.equal(isEmptyCharacterTagEdit({ add: ["  "], rename: [{ from: "a", to: "" }] }), true);

const summary = summarizeCharacterTagEdit(
  [
    { id: "1", tags: ["old", "keep"] },
    { id: "2", tags: ["keep"] },
    { id: "3", tags: ["drop", "new"] },
  ],
  { rename: [{ from: "old", to: "new" }], remove: ["drop"], add: ["keep"] },
);
assert.deepEqual(summary.changedIds, ["1", "3"]);
assert.deepEqual(summary.renamed, [{ from: "old", to: "new", count: 1 }]);
assert.deepEqual(summary.removed, [{ tag: "drop", count: 1 }]);
assert.deepEqual(summary.added, [{ tag: "keep", count: 1 }], "only cards missing the tag count as added");

// ── Bounded concurrency for the per-card updates ──
{
  const { settleWithConcurrency } = await import("../../packages/server/src/utils/settle-with-concurrency.js");
  let inFlight = 0;
  let peak = 0;
  const settled = await settleWithConcurrency(
    Array.from({ length: 25 }, (_, index) => index),
    4,
    async (value) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      if (value === 7) throw new Error("boom");
      return value * 2;
    },
  );
  assert.ok(peak <= 4 && peak > 1, `at most 4 cards in flight (peak ${peak})`);
  assert.equal(settled.length, 25);
  assert.deepEqual(settled[3], { status: "fulfilled", value: 6 }, "results keep input order");
  assert.equal(settled[7]?.status, "rejected", "one failure does not stop the rest");
  assert.deepEqual(await settleWithConcurrency([], 4, async () => 1), []);
}

// ── Route: atomic per character, recorded in version history ──
const dataDir = mkdtempSync(join(tmpdir(), "marinara-bulk-tags-"));
const previous = {
  DATA_DIR: process.env.DATA_DIR,
  FILE_STORAGE_DIR: process.env.FILE_STORAGE_DIR,
  MARINARA_FILE_STORAGE_DIR: process.env.MARINARA_FILE_STORAGE_DIR,
  NODE_ENV: process.env.NODE_ENV,
  MARINARA_LITE: process.env.MARINARA_LITE,
};
let app: {
  close(): Promise<void>;
  ready(): Promise<unknown>;
  inject(options: Record<string, unknown>): Promise<{ statusCode: number; json(): any }>;
} | null = null;

try {
  const fileStorageDir = join(dataDir, "file-storage");
  process.env.DATA_DIR = dataDir;
  process.env.FILE_STORAGE_DIR = fileStorageDir;
  process.env.MARINARA_FILE_STORAGE_DIR = fileStorageDir;
  process.env.NODE_ENV = "test";
  process.env.MARINARA_LITE = "true";

  const [{ buildApp }, { getDB }, { createCharactersStorage }] = await Promise.all([
    import("../../packages/server/src/app.js"),
    import("../../packages/server/src/db/connection.js"),
    import("../../packages/server/src/services/storage/characters.storage.js"),
  ]);
  app = await buildApp();
  await app.ready();
  const storage = createCharactersStorage(await getDB());

  const card = (name: string, tags: string[]) =>
    ({
      name,
      description: `${name} description`,
      personality: "",
      scenario: "",
      first_mes: "",
      mes_example: "",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      tags,
      creator: "",
      character_version: "1.0",
      alternate_greetings: [],
      extensions: {},
      character_book: null,
    }) as never;
  const alpha = await storage.create(card("Alpha", ["Old", "keep"]));
  const beta = await storage.create(card("Beta", ["keep"]));
  assert.ok(alpha && beta);
  const versionsBefore = (await storage.listVersions(alpha.id)).length;

  const empty = await app.inject({ method: "POST", url: "/api/characters/bulk-tags", payload: { ids: [alpha.id] } });
  assert.equal(empty.statusCode, 400, "an edit with no changes is rejected");

  const response = await app.inject({
    method: "POST",
    url: "/api/characters/bulk-tags",
    payload: {
      ids: [alpha.id, beta.id, "missing-id"],
      add: ["Noble"],
      remove: ["keep"],
      rename: [{ from: "old", to: "Elder" }],
    },
  });
  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.deepEqual(result.updatedIds.sort(), [alpha.id, beta.id].sort());
  assert.deepEqual(result.failedIds, ["missing-id"]);

  const alphaAfter = await storage.getById(alpha.id);
  assert.deepEqual(JSON.parse(alphaAfter!.data).tags, ["Elder", "Noble"]);
  assert.deepEqual(JSON.parse((await storage.getById(beta.id))!.data).tags, ["Noble"]);
  assert.equal(JSON.parse(alphaAfter!.data).description, "Alpha description", "other card fields are untouched");

  const versionsAfter = await storage.listVersions(alpha.id);
  assert.equal(versionsAfter.length, versionsBefore + 1, "the bulk edit is recorded in version history");

  const again = await app.inject({
    method: "POST",
    url: "/api/characters/bulk-tags",
    payload: { ids: [alpha.id], add: ["noble"] },
  });
  assert.deepEqual(again.json().unchangedIds, [alpha.id], "re-adding an existing tag (any case) changes nothing");
  assert.equal((await storage.listVersions(alpha.id)).length, versionsAfter.length, "no version for a no-op");

  // Duplicate finder route: read-only grouping with side-by-side basics.
  await storage.create(card("Alpha (copy)", []));
  const duplicates = await app.inject({ method: "GET", url: "/api/characters/duplicates" });
  assert.equal(duplicates.statusCode, 200);
  const alphaGroup = duplicates.json().groups.find((group: { ids: string[] }) => group.ids.includes(alpha.id));
  assert.ok(alphaGroup, "the copy is grouped with the original");
  assert.deepEqual(alphaGroup.characters.map((character: { name: string }) => character.name).sort(), [
    "Alpha",
    "Alpha (copy)",
  ]);
} finally {
  await app?.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("character-bulk-tags regression passed");
