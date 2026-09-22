import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

// Bug hunt: the one-word NPC fold (campaign-memory-campaign-scope.ts, "Liveth" -> "Liveth Corren") scans every
// group for every single-word group and recomputes namesOf(other) (flatMap + NFKD nameKey + Set) inside the scan,
// so it is O(groups^2 * sessions * aliases). The projection is rebuilt whenever any chat row or memory table is
// written (every GM turn), so a long campaign pays this on every turn and on the next wiki read.
const root = mkdtempSync(join(tmpdir(), "marinara-bughunt-fold-perf-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

const SESSIONS = 12;
const NPCS = Number(process.env.BUGHUNT_NPCS ?? 600); // tracked NPCs with one-word names, re-registered each session
const BUDGET_MS = 1_000;

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
  const chats = Array.from({ length: SESSIONS }, (_, index) => ({
    id: `s${index + 1}`, name: `Session ${index + 1}`, mode: "game", groupId: game, characterIds: "[]",
    metadata: JSON.stringify({ gameId: game, gameSessionNumber: index + 1 }), createdAt: at(index + 1), updatedAt: at(index + 1),
  }));
  await db.insert(schema.chats).values(chats);
  const rows: Record<string, unknown>[] = [];
  for (const chat of chats)
    for (let n = 0; n < NPCS; n += 1)
      rows.push({
        entityId: `${chat.id}-npc-${n}`, chatId: chat.id, kind: "character",
        owner: JSON.stringify({ type: "existing", store: "game-npcs", recordId: `npc:${n}` }),
        aliases: JSON.stringify([`Npc${n}`, `Nickname${n}`]), tags: "[]", attributes: "{}", status: "active",
        manualLock: 0, provenance, revision: 1, createdAt: at(1), updatedAt: at(1),
      });
  for (let start = 0; start < rows.length; start += 500) await db.insert(schema.campaignMemoryEntities).values(rows.slice(start, start + 500));

  const started = performance.now();
  const projection = await readCampaignMemoryProjection(db, `s${SESSIONS}`);
  const elapsed = performance.now() - started;
  console.log(`projection of ${SESSIONS} sessions x ${NPCS} NPCs built in ${elapsed.toFixed(0)} ms`);
  assert.equal(projection.entities.length, NPCS);
  assert.ok(elapsed < BUDGET_MS, `projection build took ${elapsed.toFixed(0)} ms (budget ${BUDGET_MS} ms)`);
  console.log("bughunt projection fold perf regression passed");
} finally {
  await db?._fileStore?.close?.().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
