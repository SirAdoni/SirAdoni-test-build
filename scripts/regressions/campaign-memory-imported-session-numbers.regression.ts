import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The legacy importer copied the whole lorebook into every session chat, so every imported lore page showed
// "Sessions 1-3" (or 1-12) although nothing happened to it in most of them. An imported copy no longer counts as a
// session appearance on its own: a session counts when its copy was written by something other than the importer,
// or when that session's facts, knowledge or events refer to it. A page that only exists as imported copies shows
// its earliest session.
const root = mkdtempSync(join(tmpdir(), "marinara-imported-sessions-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

let db: any = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { readCampaignMemoryProjection } = await import(
    "../../packages/server/src/services/game/campaign-memory-campaign-scope.js"
  );
  db = await createFileNativeDB();
  const game = "game-1";
  const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const imported = JSON.stringify({ source: "campaign-memory-legacy-v1", sourceRevision: "legacy", actor: "import" });
  const written = JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "system" });
  const chat = (id: string, session: number, day: number) => ({
    id,
    name: `Session ${session}`,
    mode: "game",
    groupId: game,
    characterIds: "[]",
    metadata: JSON.stringify({ gameId: game, gameSessionNumber: session }),
    createdAt: at(day),
    updatedAt: at(day),
  });
  await db.insert(schema.chats).values([chat("s1", 1, 1), chat("s2", 2, 2), chat("s3", 3, 3)]);
  const lore = (entityId: string, chatId: string, recordId: string, alias: string, provenance: string) => ({
    entityId,
    chatId,
    kind: "lore",
    owner: JSON.stringify({ type: "existing", store: "lorebook-entries", recordId }),
    aliases: JSON.stringify([alias]),
    tags: "[]",
    attributes: "{}",
    status: "active",
    manualLock: 0,
    provenance,
    revision: 1,
    createdAt: at(1),
    updatedAt: at(1),
  });
  await db.insert(schema.campaignMemoryEntities).values([
    // Quenby Mill: imported into every session, never touched.
    lore("s1-mill", "s1", "entry-mill", "Quenby Mill", imported),
    lore("s2-mill", "s2", "entry-mill", "Quenby Mill", imported),
    lore("s3-mill", "s3", "entry-mill", "Quenby Mill", imported),
    // The Vell Bridge: imported everywhere, but Session 2 wrote a fact about it.
    lore("s1-bridge", "s1", "entry-bridge", "The Vell Bridge", imported),
    lore("s2-bridge", "s2", "entry-bridge", "The Vell Bridge", imported),
    lore("s3-bridge", "s3", "entry-bridge", "The Vell Bridge", imported),
    // The Lantern Ward: imported in Session 1, registered by play in Session 3, referenced by an event in Session 2.
    lore("s1-ward", "s1", "entry-ward", "The Lantern Ward", imported),
    lore("s2-ward", "s2", "entry-ward", "The Lantern Ward", imported),
    lore("s3-ward", "s3", "entry-ward", "The Lantern Ward", written),
    // A page written by play in two sessions keeps both.
    lore("s1-gate", "s1", "entry-gate", "Mira's Gate", written),
    lore("s2-gate", "s2", "entry-gate", "Mira's Gate", written),
  ]);
  await db.insert(schema.campaignMemoryFacts).values({
    factId: "fact-bridge",
    chatId: "s2",
    subjectEntityId: "s2-bridge",
    predicate: "note",
    value: JSON.stringify({ text: "Aria Vell repaired the bridge." }),
    conditions: "[]",
    status: "verified",
    validFromOrder: null,
    validToOrder: null,
    sourceRevision: "r1",
    evidence: "[]",
    author: "system",
    provenance: written,
    manualLock: 0,
    supersedesFactId: null,
    revision: 1,
    createdAt: at(2),
    updatedAt: at(2),
  });
  await db.insert(schema.campaignMemoryEvents).values({
    eventId: "event-ward",
    chatId: "s2",
    occurrenceOrder: "m1|2026-09-02|m1",
    participantEntityIds: "[]",
    locationEntityId: "s2-ward",
    sourceRevision: "r1",
    transitions: "[]",
    evidence: "[]",
    provenance: written,
    immutable: 1,
    createdAt: at(2),
  });

  const projection = await readCampaignMemoryProjection(db, "s3");
  const sessionsOf = (alias: string) =>
    projection.entities.find((entity: any) => entity.aliases.includes(alias))?.sessionNumbers;
  assert.deepEqual(sessionsOf("Quenby Mill"), [1], "a page that only exists as imported copies shows its earliest session");
  assert.deepEqual(sessionsOf("The Vell Bridge"), [2], "an imported copy counts in the session whose facts refer to it");
  assert.deepEqual(
    sessionsOf("The Lantern Ward"),
    [2, 3],
    "a session's own registration and an event reference both count; an untouched imported copy does not",
  );
  assert.deepEqual(sessionsOf("Mira's Gate"), [1, 2], "copies written by play keep every session");
  console.log("campaign-memory-imported-session-numbers regression passed");
} finally {
  await db?._fileStore?.close?.();
  rmSync(root, { recursive: true, force: true });
}
