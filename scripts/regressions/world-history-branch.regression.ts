import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const root = mkdtempSync(join(tmpdir(), "marinara-history-branch-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { chats, messages, campaignMemoryEntities, campaignMemoryMutationJournal } =
    await import("../../packages/server/src/db/schema/index.js");
  const { projectCampaignMemoryBranch } =
    await import("../../packages/server/src/services/game/campaign-memory-branch.js");
  const { formatCampaignMemoryMessageOrder } =
    await import("../../packages/server/src/services/game/campaign-memory-order.js");
  const { campaignMemoryWriteRoutes } =
    await import("../../packages/server/src/routes/campaign-memory-write.routes.js");
  const db = await createFileNativeDB();
  const before = "2026-01-01T00:00:00.000Z";
  const cutoff = "2026-01-02T00:00:00.000Z";
  const after = "2026-01-03T00:00:00.000Z";
  for (const id of ["source", "child"]) {
    await db.insert(chats).values({ id, name: id, mode: "game", createdAt: before, updatedAt: before });
    await db
      .insert(messages)
      .values({ id: `${id}-message`, chatId: id, role: "user", content: "Fork point", createdAt: cutoff });
  }
  const provenance = { actor: "user" as const, source: "regression", sourceRevision: "r1" };
  const history = {
    version: 1,
    era: "First Age",
    eraOrder: 1,
    certainty: "unknown",
    dateLabel: "Unrecorded",
    date: null,
    participantEntityIds: [] as string[],
    locationEntityId: null as string | null,
  };
  const entity = (id: string) => ({
    entityId: id,
    chatId: "source",
    kind: "note",
    owner: { type: "registry", store: "campaign-memory", recordId: id },
    aliases: ["Before title"],
    tags: ["history"],
    body: "Before body",
    summary: "Before summary",
    attributes: { worldHistory: history, unrelated: "must not copy" },
    status: "active",
    manualLock: true,
    revision: 1,
    provenance,
    createdAt: before,
    updatedAt: before,
  });
  type FixtureEntity = ReturnType<typeof entity>;
  const insert = async (value: FixtureEntity) =>
    db.insert(campaignMemoryEntities).values({
      ...value,
      owner: JSON.stringify(value.owner),
      aliases: JSON.stringify(value.aliases),
      tags: JSON.stringify(value.tags),
      attributes: JSON.stringify(value.attributes),
      provenance: JSON.stringify(value.provenance),
      manualLock: 1,
    });
  const snapshot = async (value: FixtureEntity, time: string, suffix = "saved") =>
    db.insert(campaignMemoryMutationJournal).values({
      journalId: `${value.entityId}-${suffix}`,
      chatId: "source",
      operationId: `${value.entityId}-${suffix}`,
      recordType: "entity",
      recordId: value.entityId,
      actor: "user",
      expectedRevision: 0,
      before: null,
      after: JSON.stringify(value),
      reason: "Fixture snapshot",
      evidence: "[]",
      payloadHash: "fixture",
      createdAt: time,
    });
  const standalone = entity("standalone");
  const futureVersion = {
    ...standalone,
    aliases: ["Future title"],
    body: "Future body",
    revision: 2,
    updatedAt: after,
    attributes: { ...standalone.attributes, worldHistory: { ...history, era: "Future changed era" } },
  };
  await insert(futureVersion);
  await snapshot(standalone, before);
  await snapshot(futureVersion, after, "later");
  const person = { ...entity("group"), kind: "organization", attributes: {} as FixtureEntity["attributes"] };
  const place = { ...entity("place"), kind: "location", attributes: {} as FixtureEntity["attributes"] };
  await insert(person);
  await insert(place);
  const linked = {
    ...entity("linked"),
    attributes: {
      ...entity("linked").attributes,
      worldHistory: { ...history, participantEntityIds: ["group"], locationEntityId: "place" },
    },
  };
  await insert(linked);
  await snapshot(linked, before);
  for (const id of [
    "equal",
    "no-proof",
    "bad-time",
    "tie",
    "missing-ref",
    "unavailable-ref",
    "future-ref",
    "malformed",
  ]) {
    let value = entity(id);
    if (id === "missing-ref") value.attributes.worldHistory = { ...history, participantEntityIds: ["absent"] };
    if (id === "unavailable-ref") value.attributes.worldHistory = { ...history, participantEntityIds: ["invisible"] };
    if (id === "future-ref") value.attributes.worldHistory = { ...history, participantEntityIds: ["future-group"] };
    await insert(value);
    if (id !== "no-proof") await snapshot(value, id === "equal" ? cutoff : id === "bad-time" ? "invalid" : before);
    if (id === "tie") await snapshot(value, before, "same-time");
    if (id === "equal") await snapshot(value, before, "earlier-valid");
    if (id === "malformed")
      await db
        .update(campaignMemoryMutationJournal)
        .set({ after: "{}" })
        .where(eq(campaignMemoryMutationJournal.recordId, id));
  }
  await insert({
    ...person,
    entityId: "invisible",
    owner: { type: "existing", store: "characters", recordId: "missing-card" },
  });
  await insert({
    ...person,
    entityId: "future-group",
    owner: { type: "registry", store: "campaign-memory", recordId: "future-group" },
    createdAt: after,
  });
  // Cross-feature proof: real continuity publications must leave manually authored
  // history, self-owned references and its historical mutation journal untouched.
  const { lorebooks, lorebookEntries } = await import("../../packages/server/src/db/schema/index.js");
  const { publishContinuityMemory } =
    await import("../../packages/server/src/services/game/continuity-memory-publication.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const manualRows = await db.select().from(campaignMemoryEntities).where(eq(campaignMemoryEntities.chatId, "source"));
  const manualIds = new Set(manualRows.map((row) => row.entityId));
  const manualJournal = await db
    .select()
    .from(campaignMemoryMutationJournal)
    .where(eq(campaignMemoryMutationJournal.chatId, "source"));
  const sourceRows = await db.select().from(messages).where(eq(messages.chatId, "source"));
  const prepared = prepareContinuitySources(sourceRows, {});
  await db
    .insert(lorebooks)
    .values({
      id: "history-proof-book",
      chatId: "source",
      name: "Synthetic continuity",
      createdAt: after,
      updatedAt: after,
    });
  for (const id of ["history-first-read", "history-reread"]) {
    const entry = { id: `${id}-entry`, lorebookId: "history-proof-book", name: id };
    await db
      .insert(lorebookEntries)
      .values({
        ...entry,
        content: "Fork point",
        dynamicState: JSON.stringify({ receiptId: id }),
        createdAt: after,
        updatedAt: after,
      });
    const receipt = {
      id,
      chatId: "source",
      status: "verified",
      sources: prepared,
      context: [],
      config: {},
      sourceHash: id,
      records: [
        {
          id: `${id}-record`,
          kind: "event",
          text: "Fork point",
          subjects: [],
          conditions: [],
          status: "asserted",
          keys: ["history"],
          evidence: [{ messageId: "source-message", quote: "Fork point" }],
        },
      ],
    };
    await db.transaction((tx) => publishContinuityMemory(tx, receipt as never, entry, sourceRows, prepared));
    assert.deepEqual(
      (await db.select().from(campaignMemoryEntities).where(eq(campaignMemoryEntities.chatId, "source"))).filter(
        (row) => manualIds.has(row.entityId),
      ),
      manualRows,
      "Publication and reread preserve all manual attributes, owners, locks and revisions",
    );
    assert.deepEqual(
      (
        await db.select().from(campaignMemoryMutationJournal).where(eq(campaignMemoryMutationJournal.chatId, "source"))
      ).filter((row) => manualIds.has(row.recordId)),
      manualJournal,
      "Publication cannot rewrite manual history journals",
    );
  }
  const result = await projectCampaignMemoryBranch(db, {
    sourceChatId: "source",
    targetChatId: "child",
    cutoffOrder: formatCampaignMemoryMessageOrder("source-message", cutoff),
    messageIdMap: { "source-message": "child-message" },
    operationId: "fork",
  });
  assert.equal(result.copied.entities, 4, JSON.stringify(result));
  for (const id of [
    "equal",
    "no-proof",
    "bad-time",
    "tie",
    "missing-ref",
    "unavailable-ref",
    "future-ref",
    "malformed",
  ]) {
    assert.equal(result.idMap[id], undefined, id);
    assert.ok(
      result.held.some((item) => item.recordId === id),
      id,
    );
  }
  const rows = await db.select().from(campaignMemoryEntities).where(eq(campaignMemoryEntities.chatId, "child"));
  const copied = rows.find((row) => row.entityId === result.idMap.standalone)!;
  assert.deepEqual(JSON.parse(copied.aliases), ["Before title"]);
  assert.equal(copied.body, "Before body");
  assert.equal(copied.summary, "Before summary");
  assert.deepEqual(JSON.parse(copied.tags), ["history"]);
  assert.equal(copied.revision, 1);
  assert.deepEqual(JSON.parse(copied.attributes), { worldHistory: history });
  assert.equal(JSON.parse(copied.owner).recordId, copied.entityId);
  const copiedLinked = JSON.parse(rows.find((row) => row.entityId === result.idMap.linked)!.attributes).worldHistory;
  assert.deepEqual(copiedLinked.participantEntityIds, [result.idMap.group]);
  assert.equal(copiedLinked.locationEntityId, result.idMap.place);
  assert.ok(rows.every((row) => !row.body?.includes("Future")));
  const beforeJournal = await db
    .select()
    .from(campaignMemoryMutationJournal)
    .where(eq(campaignMemoryMutationJournal.chatId, "source"));
  const app = requireServer("fastify")();
  app.decorate("db", db);
  await app.register(campaignMemoryWriteRoutes, { prefix: "/api/game" });
  const edited = await app.inject({
    method: "POST",
    url: "/api/game/child/memory/mutations",
    payload: {
      operationId: "child-edit",
      action: "update",
      recordType: "entity",
      recordId: copied.entityId,
      expectedRevision: 1,
      reason: "Child isolated edit",
      patch: { body: "Child only" },
    },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  const parent = await db
    .select()
    .from(campaignMemoryEntities)
    .where(eq(campaignMemoryEntities.entityId, "standalone"));
  assert.equal(parent[0]!.body, "Future body");
  assert.deepEqual(
    await db.select().from(campaignMemoryMutationJournal).where(eq(campaignMemoryMutationJournal.chatId, "source")),
    beforeJournal,
  );
  // Exercise the actual mutation journal contract too, not just controlled timestamp fixtures.
  const realCutoff = new Date(Date.now() + 60_000).toISOString();
  for (const id of ["real-source", "real-child"]) {
    await db.insert(chats).values({ id, name: id, mode: "game", createdAt: before, updatedAt: before });
    await db
      .insert(messages)
      .values({ id: `${id}-message`, chatId: id, role: "user", content: "Real journal fork", createdAt: realCutoff });
  }
  const created = await app.inject({
    method: "POST",
    url: "/api/game/real-source/memory/mutations",
    payload: {
      operationId: "real-create",
      action: "create",
      recordType: "entity",
      reason: "Real journal proof",
      input: {
        entityId: "real-history",
        kind: "note",
        owner: { type: "registry", store: "campaign-memory", recordId: "real-history" },
        aliases: ["Real history"],
        body: "Created through route",
        attributes: { worldHistory: history },
        manualLock: true,
      },
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  const realBranch = await projectCampaignMemoryBranch(db, {
    sourceChatId: "real-source",
    targetChatId: "real-child",
    cutoffOrder: formatCampaignMemoryMessageOrder("real-source-message", realCutoff),
    messageIdMap: { "real-source-message": "real-child-message" },
    operationId: "real-fork",
  });
  assert.equal(realBranch.copied.entities, 1, JSON.stringify(realBranch));
  const realRows = await db
    .select()
    .from(campaignMemoryEntities)
    .where(eq(campaignMemoryEntities.chatId, "real-child"));
  assert.equal(realRows[0]!.body, "Created through route");
  await app.close();
  console.log(
    "World history branch: standalone as-of snapshots, future exclusion, remapped links, ambiguous holds and child isolation passed",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
