import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  defaultGameCalendarState,
  worldHistorySchema,
  type WorldHistoryData,
} from "../../packages/shared/src/index.js";

const root = mkdtempSync(join(tmpdir(), "marinara-world-history-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, campaignMemoryEntities } = await import("../../packages/server/src/db/schema/index.js");
  const { campaignMemoryWriteRoutes } =
    await import("../../packages/server/src/routes/campaign-memory-write.routes.js");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const { resetFeatureSettingsForTests } =
    await import("../../packages/server/src/services/features/feature-settings.js");
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  const calendar = { ...defaultGameCalendarState(), enabled: true };
  for (const [id, session, game] of [
    ["early", 1, "history"],
    ["later", 2, "history"],
    ["foreign", 1, "other"],
  ] as const)
    await db.insert(chats).values({
      id,
      name: id,
      mode: "game",
      groupId: game,
      metadata: JSON.stringify({
        gameId: game,
        gameSessionNumber: session,
        gameSessionParentChatId: id === "later" ? "early" : undefined,
        gameCalendar:
          id === "early"
            ? {
                ...calendar,
                config: {
                  ...calendar.config,
                  months: calendar.config.months.map((month, index) =>
                    index === 0 ? { ...month, name: "Shortmoon", days: 24 } : month,
                  ),
                },
              }
            : calendar,
      }),
      createdAt: now,
      updatedAt: now,
    });
  const app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryWriteRoutes, { prefix: "/api/game" });
  await app.register(campaignMemoryRoutes, { prefix: "/api/game" });
  await app.ready();
  resetFeatureSettingsForTests();
  assert.equal((await app.inject("/api/game/early/memory/world-history")).statusCode, 403);
  assert.equal((await app.inject("/api/game/early/memory/entities")).statusCode, 403);
  resetFeatureSettingsForTests({ campaignMemory: true, campaignWiki: true, worldHistory: true });
  const history: WorldHistoryData = {
    version: 1,
    era: "First Age",
    eraOrder: 1,
    certainty: "approximate",
    dateLabel: "Around the founding",
    date: { year: -300, month: null, day: null },
    participantEntityIds: [],
    locationEntityId: null,
  };
  const post = (chat: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/api/game/${chat}/memory/mutations`, payload });
  const create = (id: string, h: unknown = history, title = "Founding") => ({
    operationId: `create-${id}`,
    action: "create",
    recordType: "entity",
    reason: "Test historical note",
    input: {
      entityId: id,
      kind: "note",
      owner: { type: "registry", store: "campaign-memory", recordId: id },
      aliases: [title],
      body: "Recorded history, not an inferred fact.",
      attributes: { unrelated: "preserve", worldHistory: h },
      manualLock: true,
    },
  });
  assert.equal((await post("early", create("one"))).statusCode, 200);
  assert.equal(
    (await post("later", create("two", { ...history, date: { year: 20, month: 0, day: 1 } }))).statusCode,
    200,
  );
  assert.equal(
    (
      await post(
        "later",
        create("unknown", { ...history, certainty: "unknown", date: null, dateLabel: "Lost records" }),
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await post(
        "later",
        create("second-age", { ...history, era: "Second Age", eraOrder: 2, date: { year: 1, month: null, day: null } }),
      )
    ).statusCode,
    200,
  );
  assert.equal((await post("foreign", create("secret"))).statusCode, 200);
  let response = await app.inject({ url: "/api/game/later/memory/world-history?limit=2" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().total, 4, "same-title events are not merged and foreign campaign stays isolated");
  assert.deepEqual(
    response.json().items.map((x: any) => x.entity.entityId),
    ["one", "two"],
  );
  assert.equal(response.json().items[0].entity.originChatId, "early");
  response = await app.inject({ url: "/api/game/later/memory/world-history?offset=2&limit=2" });
  assert.deepEqual(
    response.json().items.map((x: any) => x.entity.entityId),
    ["unknown", "second-age"],
  );
  assert.equal(
    (await app.inject({ url: "/api/game/early/memory/world-history" })).json().total,
    1,
    "old sessions never see future history",
  );
  assert.equal((await app.inject({ url: "/api/game/later/memory/world-history?q=Lost" })).json().total, 1);
  assert.equal((await app.inject({ url: "/api/game/later/memory/world-history?era=Second%20Age" })).json().total, 1);
  const edit = {
    operationId: "edit-one",
    action: "update",
    recordType: "entity",
    recordId: "one",
    expectedRevision: 1,
    reason: "Correct title",
    patch: { aliases: ["The founding"], body: "Corrected history" },
  };
  assert.equal((await post("early", edit)).statusCode, 200);
  assert.equal(
    (await post("early", { ...edit, operationId: "stale" })).statusCode,
    409,
    "stale edits cannot overwrite",
  );
  response = await app.inject({ url: "/api/game/later/memory/world-history?q=Corrected" });
  assert.equal(response.json().items[0].entity.attributes.unrelated, "preserve");
  assert.equal(response.json().items[0].entity.manualLock, true);
  assert.equal(response.json().items[0].entity.provenance.actor, "user");
  const archive = { ...edit, operationId: "archive-one", expectedRevision: 2, patch: { status: "archived" } };
  assert.equal((await post("early", archive)).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/game/later/memory/world-history" })).json().total, 3);
  assert.equal((await app.inject({ url: "/api/game/later/memory/world-history?archived=true" })).json().total, 4);
  assert.equal(
    (await post("early", { ...archive, operationId: "restore-one", expectedRevision: 3, patch: { status: "active" } }))
      .statusCode,
    200,
  );
  assert.equal(
    (await post("later", create("bad-date", { ...history, date: { year: 10, month: 1, day: 31 } }))).statusCode,
    400,
  );
  assert.equal((await post("later", create("unknown-numeric", { ...history, certainty: "unknown" }))).statusCode, 400);
  assert.equal(
    (await post("later", create("bad-link", { ...history, participantEntityIds: ["secret"] }))).statusCode,
    404,
  );
  assert.equal(worldHistorySchema.safeParse({ ...history, date: { year: 10, month: null, day: 5 } }).success, false);
  assert.equal((await app.inject({ url: "/api/game/later/memory/world-history?limit=10000" })).statusCode, 400);
  // Existing owner records are projected across sessions, while saved links retain their original IDs.
  for (const [entityId, chatId, kind, store, recordId] of [
    ["old-person", "early", "character", "characters", "person-card"],
    ["new-person", "later", "character", "characters", "person-card"],
    ["place", "later", "location", "spatial-context", "place-node"],
  ])
    await db.insert(campaignMemoryEntities).values({
      entityId,
      chatId,
      kind,
      owner: JSON.stringify({ type: "existing", store, recordId }),
      aliases: JSON.stringify([entityId === "place" ? "Harbor" : "Mira"]),
      tags: "[]",
      attributes: "{}",
      status: "active",
      manualLock: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      provenance: JSON.stringify({ source: "regression", sourceRevision: "one", actor: "system" }),
    });
  const organization = create("guild");
  organization.input.kind = "organization";
  organization.input.attributes = {} as typeof organization.input.attributes;
  assert.equal((await post("later", organization)).statusCode, 200);
  assert.equal(
    (
      await post(
        "later",
        create("linked", {
          ...history,
          participantEntityIds: ["old-person", "guild"],
          locationEntityId: "place",
        }),
      )
    ).statusCode,
    200,
  );
  response = await app.inject({ url: "/api/game/later/memory/world-history?q=Mira" });
  assert.equal(response.json().total, 1);
  assert.deepEqual(response.json().items[0].history.participantEntityIds, ["old-person", "guild"]);
  assert.ok(
    response
      .json()
      .relatedEntities.some((entity: any) => entity.entityId === "old-person" && entity.aliases[0] === "Mira"),
  );
  assert.equal(
    (await post("later", create("wrong-kind", { ...history, locationEntityId: "old-person" }))).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ url: "/api/game/later/memory/timeline" })).json().items.length,
    0,
    "manual history never forges immutable scene events",
  );
  assert.equal(
    (await post("early", create("early-valid", { ...history, date: { year: 10, month: 0, day: 24 } }))).statusCode,
    200,
  );
  assert.equal(
    (await post("early", create("early-invalid", { ...history, date: { year: 10, month: 0, day: 25 } }))).statusCode,
    400,
  );
  assert.equal(
    (await post("later", create("later-valid", { ...history, date: { year: 10, month: 0, day: 25 } }))).statusCode,
    200,
  );
  // Real browser leaf queries include a constrained kind, and archive sends a status-only patch.
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const leafStorage = createCampaignMemoryStorage(db);
  resetFeatureSettingsForTests({ campaignMemory: true, worldHistory: true, factionWeb: true });
  const pickerIds = { character: "new-person", organization: "guild", location: "place" } as const;
  for (const kind of ["character", "organization", "location"] as const) {
    const picker = await app.inject(`/api/game/later/memory/world-history/entities?q=&kind=${kind}&offset=0&limit=10`);
    assert.equal(picker.statusCode, 200, picker.body);
    assert.ok(picker.json().items.some((item: { entityId: string }) => item.entityId === pickerIds[kind]));
    assert.ok(picker.json().items.every((item: { kind: string }) => item.kind === kind));
  }
  const factions = await app.inject("/api/game/later/memory/factions/entities?q=&kind=organization&offset=0&limit=20");
  assert.equal(factions.statusCode, 200, factions.body);
  assert.ok(factions.json().items.some((item: { entityId: string }) => item.entityId === "guild"));
  assert.ok(factions.json().items.every((item: { kind: string }) => item.kind === "organization"));
  for (const surface of ["world-history", "factions"]) {
    for (const scope of ["session", "campaign"]) {
      const scoped = await app.inject(`/api/game/later/memory/${surface}/entities?scope=${scope}&kind=organization`);
      assert.equal(scoped.statusCode, 200, scoped.body);
      assert.ok(scoped.json().items.every((item: { kind: string }) => item.kind === "organization"));
    }
    assert.equal((await app.inject(`/api/game/later/memory/${surface}/entities?scope=invalid`)).statusCode, 400);
  }
  for (const url of [
    "factions/entities?kind=character",
    "world-history/entities?kind=note",
    "world-history/entities?arbitrary=true",
  ])
    assert.equal((await app.inject(`/api/game/early/memory/${url}`)).statusCode, 400);
  assert.equal(
    (await app.inject("/api/game/early/memory/entities")).statusCode,
    403,
    "leaf access does not enable generic Wiki",
  );
  const leafPost = (payload: unknown) =>
    app.inject({ method: "POST", url: "/api/game/early/memory/world-history/mutations", payload });
  const leafCreated = await leafPost(create("leaf-world-event"));
  assert.equal(leafCreated.statusCode, 200, leafCreated.body);
  const leafEdit = { action: "update", recordType: "entity", recordId: "leaf-world-event", reason: "leaf archive" };
  const archived = await leafPost({
    ...leafEdit,
    operationId: "leaf-archive",
    expectedRevision: 1,
    patch: { status: "archived" },
  });
  assert.equal(archived.statusCode, 200, archived.body);
  assert.deepEqual(archived.json().attributes.worldHistory, history);
  assert.equal(archived.json().attributes.unrelated, "preserve");
  assert.equal(
    (await leafPost({ ...leafEdit, operationId: "leaf-strip", expectedRevision: 2, patch: { attributes: {} } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await leafPost({ ...leafEdit, operationId: "leaf-restore", expectedRevision: 2, patch: { status: "active" } }))
      .statusCode,
    200,
  );
  resetFeatureSettingsForTests({ campaignMemory: true });
  assert.equal(
    (await leafPost({ ...leafEdit, operationId: "leaf-off", expectedRevision: 3, patch: { status: "archived" } }))
      .statusCode,
    403,
  );
  assert.equal((await leafStorage.getEntity({ chatId: "early" }, "leaf-world-event"))?.status, "active");

  await app.close();
  console.log("World history: scoped persistence, dates, pagination, edits, conflict, archive and restore passed");
} finally {
  // Only the unique directory created by this fixture is removed.
  assert.ok(root.startsWith(join(tmpdir(), "marinara-world-history-")));
  rmSync(root, { recursive: true, force: true });
}
