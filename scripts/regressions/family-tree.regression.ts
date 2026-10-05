import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  familyPersonId,
  familyCreatesCycle,
  layoutFamilyTree,
  type FamilyLink,
  type FamilyTreeData,
} from "../../packages/shared/src/utils/family-tree.js";

// A private, disposable store: no provider calls or campaign data.
const root = mkdtempSync(join(tmpdir(), "marinara-family-tree-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
let db: any;
let app: any;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, characters } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { applyCampaignMemoryMutation } =
    await import("../../packages/server/src/services/game/campaign-memory-mutations.js");
  const { readFamilyTree, writeFamilyTree } = await import("../../packages/server/src/services/game/family-tree.js");
  const { familyTreeRoutes } = await import("../../packages/server/src/routes/family-tree.routes.js");
  const { resetFeatureSettingsForTests } =
    await import("../../packages/server/src/services/features/feature-settings.js");
  resetFeatureSettingsForTests({ campaignMemory: true, familyTree: true });
  db = await createFileNativeDB();
  const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  for (const [id, session, day, extra] of [
    ["s1", 1, 1, {}],
    ["s2", 2, 2, { gameSessionParentChatId: "s1" }],
    ["s3", 3, 3, { gameSessionParentChatId: "s2" }],
    ["branch", 1, 1, { branchParentChatId: "s1", branchName: "Alternate" }],
    ["isolated", 3, 3, { gameCampaignMemoryScope: "session" }],
  ] as const) {
    await db.insert(chats).values({
      id,
      name: id,
      mode: "game",
      groupId: "house",
      characterIds: JSON.stringify(["a", "b", "c", "future", "branch-person"]),
      metadata: JSON.stringify({
        gameId: "house",
        gameSessionNumber: session,
        gameNpcs: [{ id: "npc", name: "Robin", avatarUrl: "/npc.png" }],
        ...extra,
      }),
      createdAt: at(day),
      updatedAt: at(day),
    });
  }
  const crop = { srcX: 0.1, srcY: 0, srcWidth: 0.5, srcHeight: 0.5 };
  for (const id of ["a", "b", "c", "future", "branch-person"])
    await db.insert(characters).values({
      id,
      data: JSON.stringify({
        name: id === "a" || id === "b" ? "Robin" : id,
        extensions: { avatarCrop: crop },
      }),
      avatarPath: `/${id}.png`,
      createdAt: at(1),
      updatedAt: at(1),
    });
  const storage = createCampaignMemoryStorage(db);
  const entity = async (chatId: string, id: string, store = "characters") =>
    storage.createEntity({
      chatId,
      entityId: `${chatId}-${id}`,
      kind: "character",
      owner: { type: "existing", store, recordId: id },
      aliases: ["Robin"],
      tags: ["House Rowan"],
      attributes: {},
      status: "active",
      manualLock: false,
      provenance: { source: "regression", sourceRevision: "r1", actor: "user" },
    });
  const a = await entity("s1", "a");
  const bPerson = await entity("s1", "b");
  await entity("s1", "npc", "game-npcs");
  const c = await entity("s2", "c");
  await entity("s3", "future");
  await entity("branch", "branch-person");
  const aId = familyPersonId(a),
    bId = familyPersonId(bPerson),
    cId = familyPersonId(c);
  const write = (input: Record<string, unknown>) =>
    writeFamilyTree(db, "s2", {
      operationId: randomUUID(),
      action: "save",
      sourceId: aId,
      targetId: bId,
      kind: "parent",
      note: "",
      ...input,
    } as any);
  const suggestion = await storage.createRelationship({
    chatId: "s1",
    sourceEntityId: a.entityId,
    targetEntityId: bPerson.entityId,
    type: "parent-of",
    inverseLabel: "child-of",
    status: "proposed",
    evidence: [],
    manualLock: false,
    notes: "Existing relationship note",
    provenance: { source: "continuity", sourceRevision: "r1", actor: "system" },
  });
  let graph = await readFamilyTree(db, "s2");
  assert.equal(graph.people.length, 4, "Same-name owners must stay distinct; future and unrelated branch are absent");
  assert.deepEqual(graph.people.find((p) => p.id === aId)?.avatarCrop, crop);
  assert.equal(graph.people.find((p) => p.owner.store === "game-npcs")?.avatarUrl, "/npc.png");
  assert.equal(graph.links[0]?.confirmed, false);
  assert.equal(layoutFamilyTree(graph, aId).nodes.length, 1, "Suggestions are not inferred family");
  assert.equal((await readFamilyTree(db, "isolated")).people.length, 0);
  await assert.rejects(
    () => write({ id: suggestion.relationshipId, revision: 1, targetId: cId }),
    (e: any) => e.code === "FAMILY_CONFLICT",
  );
  const longNote = "Reviewed relationship context. ".repeat(120);
  const reviewRequest = {
    id: suggestion.relationshipId,
    revision: 1,
    note: longNote,
    operationId: randomUUID(),
  };
  const reviewed = await write(reviewRequest);
  assert.deepEqual(await write(reviewRequest), reviewed, "Committed relationship retry precedes stale-revision checks");
  await write({
    id: suggestion.relationshipId,
    revision: reviewed.revision,
    note: undefined,
  });
  graph = await readFamilyTree(db, "s2");
  assert.equal(graph.links[0]?.confirmed, true);
  assert.equal(graph.links[0]?.sessionNumber, 1);
  assert.equal(graph.links[0]?.note, longNote, "Omitted notes preserve long existing relationship notes");
  await assert.rejects(
    () => write({ id: suggestion.relationshipId, revision: 1 }),
    (e: any) => e.code === "FAMILY_CONFLICT",
  );
  await assert.rejects(
    () => write({ sourceId: bId, targetId: aId, kind: "parent" }),
    (e: any) => e.code === "FAMILY_CYCLE",
  );
  await assert.rejects(
    () => write({ sourceId: bId, targetId: aId, kind: "child" }),
    (e: any) => e.code === "FAMILY_DUPLICATE",
  );
  await assert.rejects(
    () => write({ targetId: aId }),
    (e: any) => e.code === "FAMILY_SELF_LINK",
  );
  await assert.rejects(
    () => write({ targetId: "not-in-campaign" }),
    (e: any) => e.code === "FAMILY_NOT_FOUND",
  );
  const crossRequest = {
    targetId: cId,
    kind: "partner",
    note: "Explicitly recorded",
    operationId: randomUUID(),
  };
  const cross = await write(crossRequest);
  assert.deepEqual(await write(crossRequest), cross, "Lost response retries do not create duplicate facts");
  await assert.rejects(
    () => write({ ...crossRequest, note: "Different request" }),
    (e: any) => e.code === "CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT",
  );
  assert.equal((await storage.getFact({ chatId: "s1" }, cross.factId))?.manualLock, true);
  const count = (await storage.listEntities({ chatId: "s1" })).length;
  const unknown = await write({
    targetId: null,
    kind: "child",
    note: "Parent not yet identified",
  });
  assert.equal(
    (await storage.listEntities({ chatId: "s1" })).length,
    count,
    "Unknown relatives never fabricate people",
  );
  await assert.rejects(
    () => write({ targetId: null }),
    (e: any) => e.code === "FAMILY_UNKNOWN_NOTE",
  );
  const lockedBefore = await storage.getFact({ chatId: "s1" }, cross.factId);
  await assert.rejects(
    () =>
      applyCampaignMemoryMutation(db, {
        chatId: "s1",
        operationId: randomUUID(),
        actor: "system",
        reason: "continuity reread",
        recordType: "fact",
        action: "update",
        recordId: cross.factId,
        expectedRevision: cross.revision,
        patch: { value: { kind: "parent", targetId: cId, note: "guessed" } },
      }),
    (e: any) => e.code === "CAMPAIGN_MEMORY_LOCKED",
  );
  assert.equal((await storage.getFact({ chatId: "s1" }, cross.factId))?.value.note, "Explicitly recorded");
  assert.deepEqual(await storage.getFact({ chatId: "s1" }, cross.factId), lockedBefore);
  await write({
    id: unknown.factId,
    revision: unknown.revision,
    targetId: null,
    kind: "child",
    note: "Unknown mother; identity unconfirmed",
  });
  // Reopen from disk, so this checks durable state, not just an in-memory view.
  await db._fileStore.close();
  db = await createFileNativeDB();
  graph = await readFamilyTree(db, "s2");
  assert.equal(graph.links.find((link) => link.id === suggestion.relationshipId)?.note, longNote);
  assert.ok(graph.links.some((link) => link.note === "Unknown mother; identity unconfirmed"));
  assert.equal(graph.links.find((link) => link.id === cross.factId)?.targetId, cId);
  const fastify = createRequire(new URL("../../packages/server/package.json", import.meta.url))("fastify");
  app = fastify();
  app.decorate("db", db);
  await app.register(familyTreeRoutes, { prefix: "/api/family-tree" });
  resetFeatureSettingsForTests();
  assert.equal((await app.inject("/api/family-tree/s2")).statusCode, 403, "Family Tree API is off by default");
  resetFeatureSettingsForTests({ campaignMemory: true, familyTree: true });
  const post = (payload: any) => app.inject({ method: "POST", url: "/api/family-tree/s2", payload });
  assert.equal((await post({ wrong: true })).statusCode, 400);
  const relationshipRevision = graph.links.find((link) => link.id === suggestion.relationshipId)!.revision;
  const omittedNotes = await post({
    operationId: randomUUID(),
    action: "save",
    sourceId: aId,
    targetId: bId,
    kind: "parent",
    id: suggestion.relationshipId,
    revision: relationshipRevision,
  });
  assert.equal(omittedNotes.statusCode, 200);
  assert.equal(
    (await readFamilyTree(db, "s2")).links.find((link) => link.id === suggestion.relationshipId)?.note,
    longNote,
  );
  const longNotes = await post({
    operationId: randomUUID(),
    action: "save",
    sourceId: aId,
    targetId: bId,
    kind: "parent",
    id: suggestion.relationshipId,
    revision: omittedNotes.json().revision,
    note: longNote,
  });
  assert.equal(longNotes.statusCode, 200, "Existing relationship notes can exceed the new-family-fact limit");
  assert.equal(
    (
      await post({
        operationId: randomUUID(),
        action: "save",
        sourceId: aId,
        targetId: cId,
        kind: "sibling",
        note: "x".repeat(2001),
      })
    ).statusCode,
    400,
  );
  const conflict = await post({
    operationId: randomUUID(),
    action: "save",
    sourceId: aId,
    targetId: bId,
    kind: "parent",
    note: "",
    id: suggestion.relationshipId,
    revision: 1,
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "FAMILY_CONFLICT", "API client expects a top-level error code");
  assert.equal((await app.inject("/api/family-tree/missing")).statusCode, 404);
  assert.equal((await app.inject("/api/family-tree/s2")).json().people.length, 4);
  // A removed target must not prevent retraction; the submitted value must not rewrite the tombstone.
  await db.delete(characters).where(eq(characters.id, "c"));
  await write({
    id: cross.factId,
    revision: cross.revision,
    action: "remove",
    targetId: "tampered",
    kind: "parent",
    note: "tampered",
  });
  const removed = await createCampaignMemoryStorage(db).getFact({ chatId: "s1" }, cross.factId);
  assert.equal(removed?.status, "retracted");
  assert.equal(removed?.value.targetId, cId);
  assert.equal(
    (await readFamilyTree(db, "s2")).links.some((link) => link.id === cross.factId),
    false,
  );
  const confirmed = (await readFamilyTree(db, "s2")).links.find((link) => link.id === suggestion.relationshipId)!;
  const removal = {
    ...confirmed,
    action: "remove",
    note: "tampered",
    operationId: randomUUID(),
  };
  const removalResult = await write(removal);
  assert.deepEqual(await write(removal), removalResult, "Committed removal replays even after link disappears");
  assert.equal(
    (await createCampaignMemoryStorage(db).getRelationship({ chatId: "s1" }, confirmed.id))?.notes,
    longNote,
  );
  assert.equal(
    (await readFamilyTree(db, "s2")).links.some((link) => link.id === suggestion.relationshipId),
    false,
  );
  const chain: FamilyTreeData = {
    people: Array.from({ length: 150 }, (_, i) => ({
      ...graph.people[0]!,
      id: String(i),
    })),
    links: [],
  };
  for (let i = 0; i < 150; i++)
    chain.links.push({
      id: String(i),
      chatId: "s1",
      revision: 1,
      recordType: "fact",
      sourceId: String(i),
      targetId: String((i + 1) % 150),
      kind: "parent",
      note: "",
      confirmed: true,
    });
  const bounded = layoutFamilyTree(chain, "0", 500);
  assert.equal(bounded.nodes.length, 80);
  assert.equal(new Set(bounded.nodes.map((node) => node.person.id)).size, 80);
  assert.equal(bounded.truncated, true);
  assert.equal(familyCreatesCycle(chain.links.slice(0, -1), chain.links.at(-1)!), true);
  assert.equal(
    familyCreatesCycle(chain.links, {
      kind: "partner",
      sourceId: "0",
      targetId: "1",
    }),
    false,
  );
  console.log(
    "Family tree regression passed: identity, review, portraits, scope, cycles, durable edits, locks, API validation and removals.",
  );
} finally {
  await app?.close();
  await db?._fileStore.close();
  rmSync(root, { recursive: true, force: true });
}
