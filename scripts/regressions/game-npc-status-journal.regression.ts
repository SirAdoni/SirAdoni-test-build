// Game Mode NPC status and journal source pruning.
//   - Session conclusions update an existing NPC's life status and last known location, and the
//     journal's synthetic "Tracked" line follows it: no stale setup location, never a status word
//     as a place, and no tracked line at all for a dead NPC. A later reconcile keeps that state.
//   - Journal entries sourced from a message are pruned when that message is deleted, bulk
//     deleted, or replaced by a regenerated swipe, and concurrent journal posts both survive.
//
// Storage is isolated in temp dirs; server modules are imported only after the env points there.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import type { GameNpc } from "@marinara-engine/shared";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-game-npc-status-journal-"));
const fileStorageDir = join(dataDir, "file-storage");
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = fileStorageDir;
process.env.MARINARA_FILE_STORAGE_DIR = fileStorageDir;
process.env.LOG_DIR = join(dataDir, "logs");

const { gameRoutes, applySessionConclusionPayload, buildSessionPlanMetadataUpdates } =
  await import("../../packages/server/src/routes/game.routes.js");
const { applyKnownNpcUpdates, normalizeNextSessionNpcs } =
  await import("../../packages/server/src/services/game/next-session-plan.js");
const { createJournal, addNpcEntry, reconcileNpcTrackedEntries, buildNpcTrackedInteraction } =
  await import("../../packages/server/src/services/game/journal.service.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");

const npc = (overrides: Partial<GameNpc> = {}): GameNpc => ({
  id: "npc-1",
  name: "Brannoch Vell",
  emoji: "⚒️",
  description: "A saltworks foreman.",
  location: "The Saltworks",
  reputation: 0,
  notes: [],
  avatarUrl: null,
  ...overrides,
});
const trackedLines = (journal: ReturnType<typeof createJournal>, name: string) =>
  journal.npcLog.find((entry) => entry.npcName === name)?.interactions.filter((line) => line.startsWith("Tracked")) ??
  [];
const trackedEntries = (journal: ReturnType<typeof createJournal>) =>
  journal.entries.filter((entry) => entry.type === "npc" && entry.content.startsWith("Tracked")).map((e) => e.content);

// ── Bug 3: conclusion updates status and location of an existing NPC ──
{
  const setupNpcs = [npc(), npc({ id: "npc-2", name: "Oswin Tarl", location: "Quillmarsh Gate" })];
  let journal = reconcileNpcTrackedEntries(createJournal(), setupNpcs);
  assert.deepEqual(trackedLines(journal, "Brannoch Vell"), ["Tracked at The Saltworks."]);

  const conclusion = applySessionConclusionPayload(
    {
      summary: { summary: "The foreman fell defending the gate." },
      nextSessionPlan: {
        campaignPlan: {},
        namedNpcs: [],
        knownNpcUpdates: [
          { name: "brannoch vell", status: "dead", location: "Quillmarsh Gate" },
          { name: "Oswin Tarl", location: "Deceased" },
          { name: "Nobody Known", status: "dead" },
        ],
      },
    },
    {
      sessionNumber: 1,
      currentStoryArc: null,
      currentPlotTwists: [],
      currentPartyArcs: [],
      currentMorale: 50,
      currentCards: [],
      playerCharacterNames: [],
    },
  );
  const updates = buildSessionPlanMetadataUpdates({ gameNpcs: setupNpcs }, conclusion);
  const npcs = updates.gameNpcs as GameNpc[];
  assert.equal(npcs.length, 2, "an unknown name in knownNpcUpdates never creates an NPC");
  assert.equal(npcs[0]!.status, "dead");
  assert.equal(npcs[0]!.location, "Quillmarsh Gate", "the conclusion moves the NPC's last known location");
  assert.equal(npcs[1]!.status, "dead", "a death word sent as a location sets the status");
  assert.equal(npcs[1]!.location, "Quillmarsh Gate", "a status word is never stored as a location");

  const entriesBefore = trackedEntries(journal).length;
  journal = reconcileNpcTrackedEntries(journal, npcs);
  assert.deepEqual(trackedLines(journal, "Brannoch Vell"), [], "a dead NPC keeps no stale tracked line");
  assert.equal(trackedEntries(journal).length, entriesBefore, "no new Tracked line is added for a death");
  assert.ok(!JSON.stringify(journal).includes("Tracked at Deceased"));

  // A later reconcile, and a later conclusion without updates, do not revert the death.
  const again = reconcileNpcTrackedEntries(journal, npcs);
  assert.deepEqual(again, journal, "reconcile is stable once the NPC is dead");
  const laterNpcs = normalizeNextSessionNpcs([{ name: "Brannoch Vell", location: "The Saltworks" }], npcs);
  assert.equal(laterNpcs[0]!.status, "dead");
  assert.equal(laterNpcs[0]!.location, "Quillmarsh Gate");
  assert.equal(applyKnownNpcUpdates(undefined, npcs), npcs);
}

// ── Bug 3: a move replaces the stale tracked line, and legacy status-word lines are dropped ──
{
  let journal = addNpcEntry(createJournal(), npc(), "Tracked at The Saltworks.");
  journal = addNpcEntry(journal, npc(), "Shared a drink after the shift.");
  journal = addNpcEntry(journal, npc(), "Tracked at Deceased.");
  const moved = applyKnownNpcUpdates([{ name: "Brannoch Vell", status: "alive", location: "Harrow Pier" }], [npc()]);
  journal = reconcileNpcTrackedEntries(journal, moved);
  assert.deepEqual(journal.npcLog[0]!.interactions, ["Shared a drink after the shift.", "Tracked at Harrow Pier."]);
  assert.ok(!trackedEntries(journal).includes("Tracked at Deceased."), "legacy status-word lines are removed");
  assert.equal(buildNpcTrackedInteraction(npc({ location: "Deceased" })), null);
  assert.equal(buildNpcTrackedInteraction(npc({ location: "Missing" })), "Tracked.");
  assert.equal(buildNpcTrackedInteraction(npc({ status: "unknown" })), "Tracked at The Saltworks.");
}

// ── Bug 4: journal entries follow their source message ──
const db = await getDB();
const chats = createChatsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(gameRoutes, { prefix: "/api/game" });
const chat = await chats.create({ name: "Journal source regression", mode: "game", characterIds: [] });
assert.ok(chat);

const postNote = (messageId: string, content: string, segment = 0) =>
  app.inject({
    method: "POST",
    url: "/api/game/journal/entry",
    payload: {
      chatId: chat.id,
      type: "note",
      data: { title: "Note", content, readableType: "note", sourceMessageId: messageId, sourceSegmentIndex: segment },
    },
  });
const notes = async () => {
  const fresh = await chats.getById(chat.id);
  const meta = typeof fresh?.metadata === "string" ? JSON.parse(fresh.metadata) : (fresh?.metadata ?? {});
  return ((meta.gameJournal?.entries ?? []) as Array<{ type: string; content: string; sourceMessageId?: string }>)
    .filter((entry) => entry.type === "note")
    .map((entry) => entry.content);
};
const createTurn = async (content: string) =>
  (await chats.createMessage({ chatId: chat.id, role: "assistant", characterId: null, content }))!.id;

try {
  const single = await createTurn("A ledger lies open.");
  const bulkA = await createTurn("A torn map.");
  const bulkB = await createTurn("A sealed letter.");
  const regen = await createTurn("A notice on the door.");
  const keep = await createTurn("A recipe card.");

  // Two concurrent posts both survive.
  const [first, second] = await Promise.all([postNote(single, "Ledger entry"), postNote(keep, "Recipe")]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  await Promise.all([postNote(bulkA, "Map fragment"), postNote(bulkB, "Letter text"), postNote(regen, "Old notice")]);
  assert.deepEqual((await notes()).sort(), ["Ledger entry", "Letter text", "Map fragment", "Old notice", "Recipe"]);

  await chats.removeMessage(single);
  assert.ok(!(await notes()).includes("Ledger entry"), "deleting the source message prunes its note");

  await chats.removeMessages([bulkA, bulkB], chat.id);
  assert.deepEqual((await notes()).sort(), ["Old notice", "Recipe"], "bulk delete prunes each source's notes");

  await chats.addSwipe(regen, "A different notice on the door.");
  assert.deepEqual(await notes(), ["Recipe"], "a regenerated swipe supersedes the old turn's note");
  await postNote(regen, "New notice");
  assert.deepEqual((await notes()).sort(), ["New notice", "Recipe"], "the regenerated turn's note replaces it");

  // A silent swipe (not switched to) keeps the active turn's note.
  await chats.addSwipe(keep, "An alternate recipe.", true);
  assert.ok((await notes()).includes("Recipe"));

  console.info("Game NPC status and journal source regression passed.");
} finally {
  await chats.remove(chat.id).catch((error: unknown) => console.warn("cleanup failed", error));
  await app.close();
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
