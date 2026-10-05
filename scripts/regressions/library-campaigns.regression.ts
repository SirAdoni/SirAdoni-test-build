// Library campaigns: Game Mode campaigns derived from session chats sharing a
// gameId, the characters/personas/lorebooks each uses, manual add/remove links
// (a removed derived item is stored as an exclusion), cache invalidation, and
// the campaign filter the library list endpoints use.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
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
import { errorHandler } from "../../packages/server/src/middleware/error-handler.js";
import { libraryCampaignsRoutes } from "../../packages/server/src/routes/library-campaigns.routes.js";
import {
  applyFeatureSettingsValue,
  isFeatureEnabled,
} from "../../packages/server/src/services/features/feature-settings.js";
import { campaignFilterRevision } from "../../packages/client/src/lib/library-campaign-filter.js";

const storageRoot = mkdtempSync(join(tmpdir(), "marinara-library-campaigns-"));
const previousStorageRoot = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageRoot;
let db = await createFileNativeDB();
const t = (minute: number) => `2026-09-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const setCampaignRoster = (enabled: boolean | undefined) => {
  applyFeatureSettingsValue(JSON.stringify(enabled === undefined ? {} : { campaignRoster: enabled }));
};
setCampaignRoster(undefined);

try {
  assert.equal(isFeatureEnabled("campaignRoster") ?? false, false, "campaign roster defaults off");
  for (const id of ["hero", "gm", "npc-card", "rogue", "spare", "other-hero"]) {
    await db.insert(characters).values({ id, data: JSON.stringify({ name: id }), createdAt: t(0), updatedAt: t(0) });
  }
  await db.insert(personas).values({ id: "player", name: "Player", createdAt: t(0), updatedAt: t(0) });
  const lorebook = (id: string, extra: Partial<typeof lorebooks.$inferInsert> = {}) =>
    db.insert(lorebooks).values({ id, name: id, createdAt: t(0), updatedAt: t(0), ...extra });
  await lorebook("world");
  await lorebook("expansion");
  await lorebook("hero-notes");
  await lorebook("keeper", { chatId: "ash-2" });
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
    "ash-1",
    "Cinderholt",
    {
      gameId: "ash",
      gameSessionNumber: 1,
      gameSetupConfig: { partyCharacterIds: ["hero", "npc:guard"], gmCharacterId: "gm", activeLorebookIds: ["world"] },
      activeLorebookIds: ["world"],
    },
    { characterIds: JSON.stringify(["hero"]), personaId: "player", groupId: "ash", updatedAt: t(2) },
  );
  await gameChat(
    "ash-2",
    "Cinderholt — Session 2",
    {
      gameId: "ash",
      gameSessionNumber: 2,
      gamePartyCharacterIds: ["hero", "rogue"],
      gameNpcs: [
        { id: "npc-1", name: "Guard", characterId: "npc-card" },
        { id: "npc-2", name: "No card" },
      ],
      activeLorebookIds: ["world", "expansion", "deleted-book"],
    },
    { characterIds: JSON.stringify(["hero", "rogue"]), groupId: "ash", lastMessageAt: t(30), updatedAt: t(20) },
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
    ["ash", "side"],
    "one campaign per gameId, most recently played first; non-game chats are ignored",
  );
  const ash = campaigns[0]!;
  assert.equal(ash.name, "Cinderholt", "name comes from the latest session without its session suffix");
  assert.equal(ash.sessionCount, 2);
  assert.equal(ash.lastPlayedAt, t(30), "last played uses the newest message");
  assert.deepEqual(
    [...ash.characterIds].sort(),
    ["gm", "hero", "npc-card", "rogue"],
    "party, GM and linked NPC cards; npc: placeholders dropped",
  );
  assert.deepEqual(ash.personaIds, ["player"]);
  assert.deepEqual(
    [...ash.lorebookIds].sort(),
    ["expansion", "hero-notes", "keeper", "world"],
    "active, chat-owned and character-linked books; hidden and deleted books dropped",
  );
  assert.deepEqual(campaigns[1]!.characterIds, ["other-hero"], "missing characters are dropped");

  assert.equal(await storage.list(), campaigns, "an unchanged library serves the cached list");

  // Manual links.
  setCampaignRoster(true);
  assert.equal(await storage.addItems("ash", "character", ["spare"]), true);
  assert.equal(await storage.addItems("ash", "character", ["missing-character"]), true);
  campaigns = await storage.list();
  assert.ok(campaigns[0]!.characterIds.includes("spare"), "manual add shows up (cache invalidated)");
  assert.ok(campaigns[0]!.manualKeys.includes("character:spare"));
  assert.equal(campaigns[0]!.manualKeys.includes("character:missing-character"), false, "unknown ids are not linked");
  assert.equal(campaigns.find((campaign) => campaign.id === "side")!.characterIds.includes("spare"), false);

  assert.equal(await storage.removeItems("ash", "character", ["rogue", "spare"]), true);
  campaigns = await storage.list();
  assert.equal(campaigns[0]!.characterIds.includes("rogue"), false, "removing a derived item hides it");
  assert.equal(campaigns[0]!.characterIds.includes("spare"), false, "removing a manual item drops it");
  assert.equal(
    (await db.select().from(characters).where(eq(characters.id, "rogue"))).length,
    1,
    "unlinking keeps the source card",
  );
  const rows = await db.select().from(libraryCampaignLinks).where(eq(libraryCampaignLinks.campaignId, "ash"));
  assert.deepEqual(
    rows.map((row) => `${row.itemId}:${row.mode}`),
    ["rogue:exclude"],
    "derived removal is an exclusion; manual removal deletes the include row",
  );

  await storage.addItems("ash", "character", ["rogue"]);
  campaigns = await storage.list();
  assert.ok(campaigns[0]!.characterIds.includes("rogue"), "adding back clears the exclusion");
  assert.equal(
    (await db.select().from(libraryCampaignLinks).where(eq(libraryCampaignLinks.campaignId, "ash"))).length,
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
  const onlyAsh = await resolveLibraryCampaignFilter(db, "lorebook", "ash");
  const lorebookPage = await createLorebooksStorage(db).listPage({ limit: 50, offset: 0, ids: onlyAsh });
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

  for (const campaign of ["ash", "__none__"]) {
    setCampaignRoster(true);
    const pendingFilter = resolveLibraryCampaignFilter(db, "character", campaign);
    setCampaignRoster(false);
    assert.equal(await pendingFilter, undefined, "late OFF preserves unfiltered baseline catalog");
  }
  setCampaignRoster(true);

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
  await storage.addItems("ash", "character", ["spare"]);
  await db.delete(characters).where(eq(characters.id, "spare"));
  const ashAfterDelete = (await storage.list()).find((campaign) => campaign.id === "ash")!;
  assert.equal(ashAfterDelete.characterIds.includes("spare"), false, "a deleted character is no member");
  assert.equal(ashAfterDelete.manualKeys.includes("character:spare"), false, "nor a manual key");

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

  // Explicit membership and the derived campaign identity survive reopening the file database.
  await storage.addItems("side", "lorebook", ["unused"]);
  await db._fileStore.close();
  db = await createFileNativeDB();
  const reopenedCampaigns = await createLibraryCampaignsStorage(db).list();
  const reopenedSide = reopenedCampaigns.find((campaign) => campaign.id === "side");
  assert.ok(reopenedSide, "the same gameId remains the campaign identity after restart");
  assert.ok(reopenedSide.lorebookIds.includes("unused"), "manual membership persists after restart");
  assert.ok(reopenedSide.manualKeys.includes("lorebook:unused"));
  await createLibraryCampaignsStorage(db).removeItems("ash", "character", ["rogue"]);

  // Native Fastify route validation and persona links use the same persisted membership contract.
  const app = Fastify();
  app.decorate("db", db);
  app.setErrorHandler(errorHandler);
  await app.register(libraryCampaignsRoutes, { prefix: "/api/library" });
  try {
    const retainedLinks = await db.select().from(libraryCampaignLinks);
    const retainedCharacter = await db.select().from(characters).where(eq(characters.id, "hero"));
    setCampaignRoster(false);
    const disabledList = await app.inject("/api/library/campaigns");
    assert.equal(disabledList.statusCode, 403, disabledList.body);
    assert.equal(disabledList.json().error.code, "FEATURE_DISABLED");
    for (const url of ["/api/library/campaigns/ash/items", "/api/library/campaigns/ash/items/remove"]) {
      const disabledMutation = await app.inject({
        method: "POST",
        url,
        payload: { itemType: "invalid", itemIds: [] },
      });
      assert.equal(disabledMutation.statusCode, 403, disabledMutation.body);
    }
    await assert.rejects(storage.addItems("ash", "character", ["hero"]), { name: "CampaignRosterDisabledError" });
    assert.deepEqual(await db.select().from(libraryCampaignLinks), retainedLinks, "OFF retains saved membership rows");
    assert.ok(
      (await storage.list()).some((campaign) => campaign.id === "ash"),
      "OFF leaves internal derivation available",
    );
    assert.deepEqual(await db.select().from(characters).where(eq(characters.id, "hero")), retainedCharacter);
    assert.equal(await resolveLibraryCampaignFilter(db, "character", "ash"), undefined, "OFF ignores campaign filters");
    const ordinaryCharacterPage = await createCharacterCatalog(db).list({
      limit: 50,
      offset: 0,
    });
    assert.ok(
      ordinaryCharacterPage.items.some((item) => item.id === "hero"),
      "OFF preserves ordinary catalog reads",
    );
    setCampaignRoster(true);
    assert.deepEqual(
      await db.select().from(libraryCampaignLinks),
      retainedLinks,
      "re-enabling restores retained links",
    );

    const listResponse = await app.inject("/api/library/campaigns");
    assert.equal(listResponse.statusCode, 200, listResponse.body);
    assert.ok(Array.isArray(listResponse.json().campaigns));

    const excludedPersona = await app.inject({
      method: "POST",
      url: "/api/library/campaigns/ash/items/remove",
      payload: { itemType: "persona", itemIds: ["player"] },
    });
    assert.equal(excludedPersona.statusCode, 200, excludedPersona.body);
    let ashViaRoute = (await createLibraryCampaignsStorage(db).list()).find((item) => item.id === "ash");
    assert.equal(ashViaRoute?.personaIds.includes("player"), false, "removing a derived persona records an exclusion");
    assert.ok(
      (await db.select().from(libraryCampaignLinks).where(eq(libraryCampaignLinks.itemId, "player"))).some(
        (row) => row.mode === "exclude",
      ),
    );

    const addedPersona = await app.inject({
      method: "POST",
      url: "/api/library/campaigns/ash/items",
      payload: { itemType: "persona", itemIds: ["player"] },
    });
    assert.equal(addedPersona.statusCode, 200, addedPersona.body);
    ashViaRoute = (await createLibraryCampaignsStorage(db).list()).find((item) => item.id === "ash");
    assert.ok(ashViaRoute?.personaIds.includes("player"), "adding the persona clears its exclusion");
    assert.equal(
      (await db.select().from(libraryCampaignLinks).where(eq(libraryCampaignLinks.itemId, "player"))).length,
      0,
    );

    const invalidBody = await app.inject({
      method: "POST",
      url: "/api/library/campaigns/ash/items",
      payload: { itemType: "unknown", itemIds: [] },
    });
    assert.equal(invalidBody.statusCode, 400, invalidBody.body);
    const missingCampaign = await app.inject({
      method: "POST",
      url: "/api/library/campaigns/missing/items",
      payload: { itemType: "persona", itemIds: ["player"] },
    });
    assert.equal(missingCampaign.statusCode, 404, missingCampaign.body);

    // If the switch flips off between two mutations in one transaction, the
    // second guard throws and the native store rolls the first mutation back.
    await db.insert(characters).values({
      id: "campaign-race-card",
      data: JSON.stringify({ name: "campaign-race-card" }),
      createdAt: t(0),
      updatedAt: t(0),
    });
    const campaignStorage = createLibraryCampaignsStorage(db);
    await campaignStorage.addItems("ash", "character", ["campaign-race-card"]);
    const beforeRace = await db
      .select()
      .from(libraryCampaignLinks)
      .where(eq(libraryCampaignLinks.itemId, "campaign-race-card"));
    assert.equal(beforeRace.length, 1);
    const transaction = db.transaction;
    const wrapBuilder = (builder: unknown): unknown =>
      new Proxy(builder as object, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === "then" && typeof value === "function") {
            return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
              new Promise((accept, decline) => Reflect.apply(value, target, [accept, decline])).then((result) => {
                setCampaignRoster(false);
                return resolve(result);
              }, reject);
          }
          if (typeof value === "function") {
            return (...args: unknown[]) => wrapBuilder(Reflect.apply(value, target, args));
          }
          return value;
        },
      });
    const flipOffAfter = async (operation: "select" | "delete", message: string) => {
      db.transaction = (callback) =>
        transaction((tx) =>
          callback(
            new Proxy(tx, {
              get(target, property) {
                const value = Reflect.get(target, property, target) as unknown;
                return property === operation && typeof value === "function"
                  ? (...args: unknown[]) => wrapBuilder(Reflect.apply(value, target, args))
                  : typeof value === "function"
                    ? (...args: unknown[]) => Reflect.apply(value, target, args)
                    : value;
              },
            }),
          ),
        );
      try {
        await assert.rejects(campaignStorage.addItems("ash", "character", ["campaign-race-card"]), {
          name: "CampaignRosterDisabledError",
        });
        const paths =
          operation === "select"
            ? ["/api/library/campaigns/ash/items", "/api/library/campaigns/ash/items/remove"]
            : ["/api/library/campaigns/ash/items"];
        for (const url of paths) {
          setCampaignRoster(true);
          const response = await app.inject({
            method: "POST",
            url,
            payload: { itemType: "character", itemIds: ["campaign-race-card"] },
          });
          assert.equal(response.statusCode, 403, response.body);
          assert.equal(response.json().error.code, "FEATURE_DISABLED", "late OFF uses the same API contract");
        }
      } finally {
        db.transaction = transaction;
        setCampaignRoster(true);
      }
      assert.deepEqual(
        await db.select().from(libraryCampaignLinks).where(eq(libraryCampaignLinks.itemId, "campaign-race-card")),
        beforeRace,
        message,
      );
    };
    await flipOffAfter("select", "OFF after the awaited link read prevents writes");
    await flipOffAfter("delete", "OFF during a transaction rolls back an earlier delete");
  } finally {
    await app.close();
  }

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
  setCampaignRoster(undefined);
  await db._fileStore.close();
  if (previousStorageRoot === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageRoot;
  rmSync(storageRoot, { recursive: true, force: true });
}
