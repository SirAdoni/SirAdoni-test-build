import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The campaign codex reads the campaign memory projection on the canonical line, so it folds
// identities the same way the game does (a tracked NPC and the library card of the same name are
// one entry), keeps presence only from the newest session and dedupes facts re-read in later
// sessions. When the projection would not cover exactly the canonical sessions (a later branch of
// an earlier session), the codex falls back to reading each session chat.
const root = mkdtempSync(join(tmpdir(), "marinara-codex-projection-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

try {
  const source = readFileSync(
    new URL("../../packages/server/src/services/game/campaign-codex.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /readCampaignMemoryProjection\(db, newest\.id\)/, "the loader reads the canonical projection");

  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { loadCampaignCodex } = await import("../../packages/server/src/services/game/campaign-codex.js");
  const db = await createFileNativeDB();
  const game = "game-p";
  const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const order = (day: number) => `m1|${at(day)}|m${day}`;
  const provenance = JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "system" });
  const chat = (id: string, session: number, day: number, extra: Record<string, unknown> = {}) => ({
    id,
    name: session === 1 ? "Ember Road" : `Ember Road — Session ${session}`,
    mode: "game",
    groupId: game,
    characterIds: "[]",
    metadata: JSON.stringify({ gameId: game, gameSessionNumber: session, ...extra }),
    createdAt: at(day),
    updatedAt: at(day),
  });
  await db.insert(schema.chats).values([chat("p1", 1, 1), chat("p2", 2, 2)]);
  const entity = (entityId: string, chatId: string, store: string, recordId: string, alias: string) => ({
    entityId,
    chatId,
    kind: "character",
    owner: JSON.stringify({ type: "existing", store, recordId }),
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
    entity("p1-vigil", "p1", "characters", "card-vigil", "Vigil"),
    entity("p2-vigil-npc", "p2", "game-npcs", "npc:vigil", "Vigil"),
    entity("p1-mira", "p1", "characters", "card-mira", "Mira"),
    entity("p2-mira", "p2", "characters", "card-mira", "Mira"),
  ]);
  const fact = (factId: string, chatId: string, subject: string, text: string, day: number) => ({
    factId,
    chatId,
    subjectEntityId: subject,
    predicate: "decision",
    value: JSON.stringify({ text }),
    conditions: "[]",
    status: "verified",
    validFromOrder: order(day),
    sourceRevision: "r1",
    evidence: "[]",
    author: "system",
    provenance,
    manualLock: 0,
    revision: 1,
    createdAt: at(day),
    updatedAt: at(day),
  });
  await db.insert(schema.campaignMemoryFacts).values([
    fact("f-vigil", "p2", "p2-vigil-npc", "Vigil repaired the bridge.", 2),
    fact("f-dagger-1", "p1", "p1-mira", "Mira keeps a dagger in her boot.", 1),
    fact("f-dagger-2", "p2", "p2-mira", "Mira keeps a dagger in her boot.", 2),
  ]);
  await db.insert(schema.campaignMemoryEvents).values([
    {
      eventId: "e-p1",
      chatId: "p1",
      occurrenceOrder: order(1),
      campaignTime: null,
      participantEntityIds: JSON.stringify(["p1-mira"]),
      locationEntityId: null,
      sourceRevision: "r1",
      transitions: JSON.stringify(["Mira arrived at the gate."]),
      evidence: "[]",
      provenance,
      immutable: 1,
      createdAt: at(1),
    },
  ]);
  await db.insert(schema.campaignMemoryCurrentState).values([
    {
      stateId: "st-presence",
      chatId: "p1",
      entityId: "p1-mira",
      property: "presence",
      value: JSON.stringify("present"),
      sourceEventId: "e-p1",
      validAtOrder: order(1),
      protected: 0,
      provenance,
      manualLock: 0,
      revision: 1,
      createdAt: at(1),
      updatedAt: at(1),
    },
  ]);

  for (const from of ["p1", "p2"]) {
    const codex = await loadCampaignCodex(db, from);
    assert.ok(codex);
    assert.equal(codex.gameName, "Ember Road");
    assert.deepEqual(
      codex.sessions.map((session) => session.number),
      [1, 2],
    );
    const vigil = codex.entities.filter((item) => item.name === "Vigil");
    assert.equal(vigil.length, 1, `the tracked NPC folds into the library card (export from ${from})`);
    assert.deepEqual(vigil[0]!.sessions, [1, 2]);
    assert.deepEqual(
      vigil[0]!.facts.map((item) => item.value),
      ["Text: Vigil repaired the bridge."],
    );
    const mira = codex.entities.find((item) => item.name === "Mira")!;
    assert.equal(mira.facts.length, 1, "a fact re-read in a later session appears once");
    assert.deepEqual(mira.currentState, [], "presence from an earlier session is not current");
    assert.equal(codex.events.length, 1);
    assert.deepEqual(codex.events[0]!.participants, ["Mira"]);
  }

  // A branch of session 1 made alongside session 2: the projection would pick the branch for
  // session 1, so the canonical codex falls back to per-session reads and stays canonical.
  await db.insert(schema.chats).values([chat("p1-branch", 1, 2, { branchName: "Detour", branchParentChatId: "p1" })]);
  await db.insert(schema.campaignMemoryEntities).values([entity("pb-ghost", "p1-branch", "game-npcs", "npc:ghost", "Ghost")]);
  const canonical = await loadCampaignCodex(db, "p2");
  assert.ok(canonical);
  assert.ok(!canonical.entities.some((item) => item.name === "Ghost"), "branch memory stays out of a canonical export");
  assert.ok(canonical.entities.some((item) => item.name === "Mira"));
  const branch = await loadCampaignCodex(db, "p1-branch");
  assert.ok(branch?.entities.some((item) => item.name === "Ghost"), "a branch export still includes the branch");
} finally {
  rmSync(root, { recursive: true, force: true });
}
