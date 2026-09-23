import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The campaign projection keeps only the NEWEST copy of a statement re-read in a later session. On regenerate the
// context is projected at a historical cutoff; when the kept copy was written after that cutoff it is excluded as
// "from the future" and the earlier session's copy, which was known long before the cutoff, is already gone.
const root = mkdtempSync(join(tmpdir(), "marinara-bughunt-reread-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

let db: any = null;
let failure: string | null = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { buildCampaignMemoryContextFromStorage } = await import(
    "../../packages/server/src/services/game/campaign-memory-context.js"
  );
  db = await createFileNativeDB();
  const game = "game-1";
  const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const order = (day: number) => `m1|${at(day)}|m${day}`;
  const provenance = JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "system" });
  const chat = (id: string, session: number, day: number) => ({
    id, name: `Session ${session}`, mode: "game", groupId: game, characterIds: "[]",
    metadata: JSON.stringify({ gameId: game, gameSessionNumber: session }), createdAt: at(day), updatedAt: at(day),
  });
  await db.insert(schema.chats).values([chat("s1", 1, 1), chat("s2", 2, 2)]);
  const entity = (entityId: string, chatId: string) => ({
    entityId, chatId, kind: "character", owner: JSON.stringify({ type: "existing", store: "characters", recordId: "card-mira" }),
    aliases: JSON.stringify(["Mira"]), tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance,
    revision: 1, createdAt: at(1), updatedAt: at(1),
  });
  await db.insert(schema.campaignMemoryEntities).values([entity("s1-mira", "s1"), entity("s2-mira", "s2")]);
  const fact = (factId: string, chatId: string, subject: string, day: number) => ({
    factId, chatId, subjectEntityId: subject, predicate: "possession", value: JSON.stringify("a silver dagger"),
    conditions: "[]", status: "verified", validFromOrder: order(day), sourceRevision: "r1", evidence: "[]",
    author: "system", provenance, manualLock: 0, revision: 1, createdAt: at(day), updatedAt: at(day),
  });
  await db.insert(schema.campaignMemoryFacts).values([fact("f-s1", "s1", "s1-mira", 1), fact("f-s2", "s2", "s2-mira", 5)]);

  const live = await buildCampaignMemoryContextFromStorage(db, { chatId: "s2", audience: { kind: "gm" }, maxCharacters: 10_000 });
  assert.match(live.text, /silver dagger/, "live turn sees the fact");
  // Regenerate a turn at day 3 of session 2: Mira has had the dagger since session 1.
  const historical = await buildCampaignMemoryContextFromStorage(db, {
    chatId: "s2", audience: { kind: "gm" }, maxCharacters: 10_000, cutoffOrder: order(3),
  });
  try {
    assert.match(historical.text, /silver dagger/, `historical text=${JSON.stringify(historical.text)} exclusions=${JSON.stringify(historical.exclusions)}`);
  } catch (error) { failure = (error as Error).message; }
} finally {
  await db?._fileStore?.close?.();
  rmSync(root, { recursive: true, force: true });
}
if (failure) {
  console.error(`bughunt-gmcontext-cutoff-reread: ${failure}`);
  process.exit(1);
}
console.log("bughunt-gmcontext-cutoff-reread regression passed");
