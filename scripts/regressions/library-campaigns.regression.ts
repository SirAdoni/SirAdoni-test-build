// Library campaigns: Game Mode campaigns derived from session chats sharing a
// gameId, the characters/personas/lorebooks each uses, manual add/remove links
// (a removed derived item is stored as an exclusion), cache invalidation, and
// the campaign filter the library list endpoints use.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import {
  characters,
  chats,
  libraryCampaignLinks,
  lorebookCharacterLinks,
  lorebooks,
  personas,
} from "../../packages/server/src/db/schema/index.js";
import { createLibraryCampaignsStorage } from "../../packages/server/src/services/storage/library-campaigns.storage.js";
import {
  parseCatalogIdsQuery,
  resolveLibraryCampaignFilter,
  restrictLibraryIdFilter,
} from "../../packages/server/src/routes/library-campaigns.routes.js";
import { createCharacterCatalog } from "../../packages/server/src/services/storage/character-catalog.js";
import { createLorebooksStorage } from "../../packages/server/src/services/storage/lorebooks.storage.js";
import { campaignFilterRevision } from "../../packages/client/src/lib/library-campaign-filter.js";

const storageRoot = mkdtempSync(join(tmpdir(), "marinara-library-campaigns-"));
const previousStorageRoot = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageRoot;
const db = await createFileNativeDB();
const t = (minute: number) => `2026-09-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

try {
  for (const id of ["hero", "gm", "npc-card", "rogue", "spare", "other-hero"]) {
    await db.insert(characters).values({ id, data: JSON.stringify({ name: id }), createdAt: t(0), updatedAt: t(0) });
  }
  await db.insert(personas).values({ id: "player", name: "Player", createdAt: t(0), updatedAt: t(0) });
  const lorebook = (id: string, extra: Partial<typeof lorebooks.$inferInsert> = {}) =>
    db.insert(lorebooks).values({ id, name: id, createdAt: t(0), updatedAt: t(0), ...extra });
  await lorebook("world");
  await lorebook("expansion");
  await lorebook("hero-notes");
  await lorebook("keeper", { chatId: "vald-2" });
  await lorebook("embedded", { characterId: "hero", hiddenFromLibrary: "true" });
  await lorebook("unused");
  await db.insert(lorebookCharacterLinks).values({
    id: "link-1",
    lorebookId: "hero-notes",
    characterId: "hero",
    createdAt: t(0),
  });

  const gameChat = (
    id: string,
    name: string,
    metadata: Record<string, unknown>,
    extra: Partial<typeof chats.$inferInsert> = {},
  ) =>
    db.insert(chats).values({
      id,
      name,
      mode: "game",
      metadata: JSON.stringify(metadata),
      createdAt: t(1),
      updatedAt: t(1),
      ...extra,
    });
  await gameChat(
    "vald-1",
    "Valdenmoor",
    {
      gameId: "vald",
      gameSessionNumber: 1,
      gameSetupConfig: { partyCharacterIds: ["hero", "npc:guard"], gmCharacterId: "gm", activeLorebookIds: ["world"] },
      activeLorebookIds: ["world"],
    },
    { characterIds: JSON.stringify(["hero"]), personaId: "player", groupId: "vald", updatedAt: t(2) },
  );
  await gameChat(
    "vald-2",
    "Valdenmoor — Session 2",
    {
      gameId: "vald",
      gameSessionNumber: 2,
      gamePartyCharacterIds: ["hero", "rogue"],
      gameNpcs: [
        { id: "npc-1", name: "Guard", characterId: "npc-card" },
        { id: "npc-2", name: "No card" },
      ],
      activeLorebookIds: ["world", "expansion", "deleted-book"],
    },
    { characterIds: JSON.stringify(["hero", "rogue"]), groupId: "vald", lastMessageAt: t(30), updatedAt: t(20) },
  );
  await gameChat(
    "other-1",
    "Side Story",
    { gameId: "side", gameSessionNumber: 1 },
    { characterIds: JSON.stringify(["other-hero", "ghost-character"]) },
  );
  await db.insert(chats).values({
    id: "plain",
    name: "Roleplay",
    mode: "roleplay",
    characterIds: JSON.stringify(["spare"]),
    metadata: "{}",
    createdAt: t(0),
    updatedAt: t(40),
  });

  const storage = createLibraryCampaignsStorage(db);
  let campaigns = await storage.list();
  assert.deepEqual(
    campaigns.map((campaign) => campaign.id),
    ["vald", "side"],
    "one campaign per gameId, most recently played first; non-game chats are ignored",
  );
  const vald = campaigns[0]!;
  assert.equal(vald.name, "Valdenmoor", "name comes from the latest session without its session suffix");
  assert.equal(vald.sessionCount, 2);
  assert.equal(vald.lastPlayedAt, t(30), "last played uses the newest message");
  assert.deepEqual(
    [...vald.characterIds].sort(),
    ["gm", "hero", "npc-card", "rogue"],
    "party, GM and linked NPC cards; npc: placeholders dropped",
  );
  assert.deepEqual(vald.personaIds, ["player"]);
  assert.deepEqual(
    [...vald.lorebookIds].sort(),
    ["expansion", "hero-notes", "keeper", "world"],
    "active, chat-owned and character-linked books; hidden and deleted books dropped",
  );
  assert.deepEqual(campaigns[1]!.characterIds, ["other-hero"], "missing characters are dropped");

  assert.equal(await storage.list(), campaigns, "an unchanged library serves the cached list");

  // Manual links.
  assert.equal(await storage.addItems("vald", "character", ["spare"]), true);
  campaigns = await storage.list();
  assert.ok(campaigns[0]!.characterIds.includes("spare"), "manual add shows up (cache invalidated)");
  assert.ok(campaigns[0]!.manualKeys.includes("character:spare"));

  assert.equal(await storage.removeItems("vald", "character", ["rogue", "spare"]), true);
  campaigns = await storage.list();
  assert.equal(campaigns[0]!.characterIds.includes("rogue"), false, "removing a derived item hides it");
  assert.equal(campaigns[0]!.characterIds.includes("spare"), false, "removing a manual item drops it");
  const rows = await db.select().from(libraryCampaignLinks).where(eq(libraryCampaignLinks.campaignId, "vald"));
  assert.deepEqual(
    rows.map((row) => `${row.itemId}:${row.mode}`),
    ["rogue:exclude"],
    "derived removal is an exclusion; manual removal deletes the include row",
  );

  await storage.addItems("vald", "character", ["rogue"]);
  campaigns = await storage.list();
  assert.ok(campaigns[0]!.characterIds.includes("rogue"), "adding back clears the exclusion");
  assert.equal(
    (await db.select().from(libraryCampaignLinks).where(eq(libraryCampaignLinks.campaignId, "vald"))).length,
    0,
    "no stale rows remain after add-back",
  );
  assert.equal(await storage.addItems("missing", "lorebook", ["world"]), false, "unknown campaigns are rejected");

  // A new session chat invalidates the cache.
  await gameChat("side-2", "Side Story — Session 2", { gameId: "side", gameSessionNumber: 2 }, { updatedAt: t(50) });
  campaigns = await storage.list();
  assert.equal(campaigns[0]!.id, "side", "new activity reorders campaigns");
  assert.equal(campaigns[0]!.sessionCount, 2);

  // List filters used by the Lorebooks and Characters panels.
  const onlyVald = await resolveLibraryCampaignFilter(db, "lorebook", "vald");
  const lorebookPage = await createLorebooksStorage(db).listPage({ limit: 50, offset: 0, ids: onlyVald });
  assert.deepEqual(lorebookPage.items.map((item: { id: string }) => item.id).sort(), [
    "expansion",
    "hero-notes",
    "keeper",
    "world",
  ]);
  const none = await resolveLibraryCampaignFilter(db, "lorebook", "__none__");
  const unusedPage = await createLorebooksStorage(db).listPage({ limit: 50, offset: 0, ids: none });
  assert.deepEqual(
    unusedPage.items.map((item: { id: string }) => item.id),
    ["unused"],
    "not in any campaign",
  );
  const characterPage = await createCharacterCatalog(db).list({
    limit: 50,
    offset: 0,
    ids: await resolveLibraryCampaignFilter(db, "character", "side"),
  });
  assert.deepEqual(
    characterPage.items.map((item) => item.id),
    ["other-hero"],
  );
  assert.equal(await resolveLibraryCampaignFilter(db, "character", "nope"), undefined, "unknown campaign: no filter");

  // A metadata edit that swaps one lorebook id for another of the same length,
  // without moving updatedAt, must still be noticed (the usage memo compares content).
  await lorebook("atlas");
  const sideRow = (await db.select().from(chats).where(eq(chats.id, "other-1")))[0]!;
  await db
    .update(chats)
    .set({ metadata: JSON.stringify({ gameId: "side", gameSessionNumber: 1, activeLorebookIds: ["world"] }) })
    .where(eq(chats.id, "other-1"));
  let side = (await storage.list()).find((campaign) => campaign.id === "side")!;
  assert.ok(side.lorebookIds.includes("world"));
  await db
    .update(chats)
    .set({
      metadata: JSON.stringify({ gameId: "side", gameSessionNumber: 1, activeLorebookIds: ["atlas"] }),
      updatedAt: sideRow.updatedAt,
    })
    .where(eq(chats.id, "other-1"));
  side = (await storage.list()).find((campaign) => campaign.id === "side")!;
  assert.ok(side.lorebookIds.includes("atlas"), "a same-length id swap in chat metadata is picked up");
  assert.equal(side.lorebookIds.includes("world"), false, "the swapped-out lorebook leaves the campaign");

  // Deleted items: their manual include rows no longer count as members or manual keys.
  await storage.addItems("vald", "character", ["spare"]);
  await db.delete(characters).where(eq(characters.id, "spare"));
  const valdAfterDelete = (await storage.list()).find((campaign) => campaign.id === "vald")!;
  assert.equal(valdAfterDelete.characterIds.includes("spare"), false, "a deleted character is no member");
  assert.equal(valdAfterDelete.manualKeys.includes("character:spare"), false, "nor a manual key");

  // Concurrent adds of the same item both succeed and leave a single include row.
  await Promise.all([
    storage.addItems("side", "lorebook", ["unused"]),
    storage.addItems("side", "lorebook", ["unused"]),
  ]);
  const unusedLinks = await db.select().from(libraryCampaignLinks).where(eq(libraryCampaignLinks.itemId, "unused"));
  assert.equal(unusedLinks.length, 1, "no duplicate include rows from concurrent adds");

  // Client page key: the filter revision follows the membership it resolves to.
  const listed = await storage.list();
  const before = campaignFilterRevision(listed, "lorebook", "side");
  assert.equal(before, campaignFilterRevision([...listed].reverse(), "lorebook", "side"), "order does not matter");
  await storage.removeItems("side", "lorebook", ["unused"]);
  const after = campaignFilterRevision(await storage.list(), "lorebook", "side");
  assert.notEqual(after, before, "a membership change changes the filtered page key");
  assert.notEqual(
    campaignFilterRevision(listed, "lorebook", null),
    campaignFilterRevision(await storage.list(), "lorebook", null),
    "the not-in-any-campaign key follows the union of all campaigns",
  );

  // `ids=` on the character catalog: folder members beyond the loaded pages, still campaign-filtered.
  assert.equal(parseCatalogIdsQuery(undefined), undefined);
  assert.equal(parseCatalogIdsQuery(" , "), undefined, "an empty list filters nothing");
  assert.deepEqual(parseCatalogIdsQuery("a, b,a,,c"), ["a", "b", "c"], "ids are trimmed and deduplicated");
  assert.equal(parseCatalogIdsQuery(Array.from({ length: 150 }, (_, i) => `id${i}`).join(","))?.length, 100);
  assert.deepEqual(restrictLibraryIdFilter(undefined, ["a"]), { include: ["a"] });
  assert.deepEqual(restrictLibraryIdFilter({ include: ["a", "b"] }, ["b", "c"]), { include: ["b"] }, "intersects");
  assert.deepEqual(
    restrictLibraryIdFilter({ exclude: ["a"] }, ["a", "b"]),
    { exclude: ["a"], include: ["a", "b"] },
    "keeps the not-in-any-campaign exclusions",
  );
  assert.deepEqual(restrictLibraryIdFilter({ include: ["a"] }, undefined), { include: ["a"] });

  console.log("library campaigns regression passed");
} finally {
  await db._fileStore.close();
  if (previousStorageRoot === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageRoot;
  rmSync(storageRoot, { recursive: true, force: true });
}
