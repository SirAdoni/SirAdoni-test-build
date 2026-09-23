import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Bug hunt: listCampaignSessionChats keeps, per earlier session number, the most recently created chat. A chat
// branch (chats.routes branch: metadata.branchName, same gameId/gameSessionNumber) is always newer than the chat it
// forks, so an abandoned "what if" branch of Session 1 replaces the real Session 1 in Session 2's memory, although
// /game/session/start itself ignores branches (selectSessionForNextStart prefers canonical sessions).
const root = mkdtempSync(join(tmpdir(), "marinara-bughunt-branch-"));
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
  const provenance = JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "system" });
  const chat = (id: string, session: number, day: number, extra: Record<string, unknown> = {}) => ({
    id, name: `Session ${session}`, mode: "game", groupId: game, characterIds: "[]",
    metadata: JSON.stringify({ gameId: game, gameSessionNumber: session, ...extra }), createdAt: at(day), updatedAt: at(day),
  });
  await db.insert(schema.chats).values([
    chat("s1", 1, 1),
    chat("s1-whatif", 1, 2, { branchName: "New Branch", branchParentChatId: "s1" }),
    chat("s2", 2, 3),
  ]);
  const entity = (entityId: string, chatId: string) => ({
    entityId, chatId, kind: "character", owner: JSON.stringify({ type: "existing", store: "characters", recordId: "card-mira" }),
    aliases: JSON.stringify(["Mira"]), tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance,
    revision: 1, createdAt: at(1), updatedAt: at(1),
  });
  await db.insert(schema.campaignMemoryEntities).values([entity("s1-mira", "s1"), entity("b-mira", "s1-whatif"), entity("s2-mira", "s2")]);
  const fact = (factId: string, chatId: string, subject: string, text: string) => ({
    factId, chatId, subjectEntityId: subject, predicate: "decision", value: JSON.stringify({ text }), conditions: "[]",
    status: "verified", sourceRevision: "r1", evidence: "[]", author: "system", provenance, manualLock: 0, revision: 1,
    createdAt: at(1), updatedAt: at(1),
  });
  await db.insert(schema.campaignMemoryFacts).values([
    fact("f-canon", "s1", "s1-mira", "Mira spared the smuggler."),
    fact("f-whatif", "s1-whatif", "b-mira", "Mira killed the smuggler."),
  ]);
  const projection = await readCampaignMemoryProjection(db, "s2");
  assert.deepEqual(
    { sessions: projection.sessionChatIds, facts: projection.facts.map((item: any) => item.factId).sort() },
    { sessions: ["s1", "s2"], facts: ["f-canon"] },
    "an abandoned branch of an earlier session must not replace that session in a later session's memory",
  );
  console.log("bughunt projection branch session regression passed");
} finally {
  await db?._fileStore?.close?.().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
