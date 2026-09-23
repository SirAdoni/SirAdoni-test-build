/**
 * Pulse 9 task 7: duplicate reconciliation queue. Groups facts of one chat by subject +
 * predicate across different receipts (overlapping evidence or token Jaccard >= 0.8),
 * skips facts already linked by supersedesFactId, pages by cursor, and resolves a group
 * through the audited mutation path (CAS 409, idempotent replay).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpatialContextDefinition } from "@marinara-engine/shared";
import type { CampaignMemoryOwnerReader } from "../../packages/server/src/services/game/campaign-memory-owners.js";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-duplicates-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const CHAT = "dup-chat";

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, characters, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values([
    { id: CHAT, name: "Dup", mode: "game", characterIds: JSON.stringify(["char-bob"]), createdAt, updatedAt: createdAt },
  ]);
  await db.insert(characters).values([{ id: "char-bob", data: "{}", createdAt, updatedAt: createdAt }]);
  const sources = ["dup-msg-1", "dup-msg-2", "dup-msg-3", "dup-msg-4"];
  await db.insert(messages).values(
    sources.map((id, index) => ({ id, chatId: CHAT, role: "user", content: `Source ${index + 1}`, createdAt })),
  );
  const ownerReader: CampaignMemoryOwnerReader = {
    async readChatScope(chatId) {
      if (chatId !== CHAT) return null;
      return { chatId, characterIds: ["char-bob"], spatialDefinition: { locations: [] } as unknown as SpatialContextDefinition };
    },
    async readExistingOwner(owner) {
      return owner.store === "characters" && owner.recordId === "char-bob" ? { ...owner, kind: "character" } : null;
    },
    async readRegistryOwner() {
      return true;
    },
  };
  const storage = createCampaignMemoryStorage(db, ownerReader);
  const provenance = { source: "duplicates-regression", sourceRevision: "r1", actor: "system" as const };
  await storage.createEntity({
    entityId: "char-bob",
    chatId: CHAT,
    kind: "character",
    owner: { type: "existing", store: "characters", recordId: "char-bob" },
    aliases: ["Bob"],
    tags: [],
    summary: "Steward",
    attributes: {},
    status: "active",
    manualLock: false,
    provenance,
  });
  const evidenceFor = (messageId: string) => {
    const index = sources.indexOf(messageId);
    const quote = `Source ${index + 1}`;
    return [{ messageId, quote, sourceHash: hash(quote) }];
  };
  const makeFact = (
    factId: string,
    predicate: string,
    receiptId: string,
    messageId: string,
    text: string,
    extra: { supersedesFactId?: string; historical?: boolean } = {},
  ) =>
    storage.createFact({
      factId,
      chatId: CHAT,
      subjectEntityId: "char-bob",
      predicate,
      value: { text, receiptId, ...(extra.historical ? { historical: true } : {}) },
      conditions: [],
      status: "verified",
      validFromOrder: `m1|2026-01-01T00:00:0${sources.indexOf(messageId) + 1}.000Z|${messageId}`,
      sourceRevision: "r1",
      evidence: evidenceFor(messageId),
      author: "system",
      provenance,
      manualLock: false,
      ...(extra.supersedesFactId ? { supersedesFactId: extra.supersedesFactId } : {}),
    });
  // Overlapping evidence across receipts (texts unrelated). Created out of source order.
  await makeFact("fact-title-b", "title", "receipt-2", "dup-msg-1", "Unrelated wording entirely", { historical: true });
  await makeFact("fact-title-a", "title", "receipt-1", "dup-msg-1", "Bob is the steward of the hall");
  // Similar text across receipts on different messages.
  await makeFact("fact-role-c", "role", "receipt-1", "dup-msg-2", "Bob guards the northern gate at night");
  await makeFact("fact-role-d", "role", "receipt-2", "dup-msg-3", "Bob guards the northern gate at night.");
  // Already linked by supersedesFactId: never grouped even with shared evidence.
  await makeFact("fact-home-e", "home", "receipt-1", "dup-msg-4", "Bob lives in the hall");
  await makeFact("fact-home-f", "home", "receipt-2", "dup-msg-4", "Bob lives in the hall", { supersedesFactId: "fact-home-e" });
  // Same receipt: never grouped.
  await makeFact("fact-pet-g", "pet", "receipt-1", "dup-msg-2", "Bob keeps a grey cat");
  await makeFact("fact-pet-h", "pet", "receipt-1", "dup-msg-2", "Bob keeps a grey cat");
  // Different subject predicate pair with low similarity and no overlap: not grouped.
  await makeFact("fact-mood-i", "mood", "receipt-1", "dup-msg-1", "Bob is cheerful today");
  await makeFact("fact-mood-j", "mood", "receipt-2", "dup-msg-2", "Bob fears the winter storms");

  const app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryRoutes, { prefix: "/api/game" });
  await app.ready();
  const get = (url: string) => app.inject({ method: "GET", url: `/api/game/${CHAT}/memory/${url}` });
  const resolve = (groupId: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/api/game/${CHAT}/memory/review/duplicates/${groupId}/resolve`, payload });
  const factIds = (group: { facts: { factId: string }[] }) => group.facts.map((fact) => fact.factId);

  // 1. Both groups found, sorted by predicate; linked, same-receipt and dissimilar facts excluded.
  let response = await get("review/duplicates");
  assert.equal(response.statusCode, 200);
  let body = response.json();
  assert.equal(body.groups.length, 2);
  assert.equal(body.nextCursor, null);
  const [roleGroup, titleGroup] = body.groups;
  assert.equal(roleGroup.predicate, "role");
  assert.equal(roleGroup.subjectEntityId, "char-bob");
  assert.equal(roleGroup.reason, "similar-text");
  assert.equal(roleGroup.similarity, 1);
  assert.deepEqual(factIds(roleGroup), ["fact-role-c", "fact-role-d"]);
  assert.equal(titleGroup.predicate, "title");
  assert.equal(titleGroup.reason, "overlapping-evidence");
  assert.ok(typeof titleGroup.similarity === "number" && titleGroup.similarity < 0.8);
  assert.deepEqual(factIds(titleGroup), ["fact-title-a", "fact-title-b"], "facts sorted by source order then id");
  assert.deepEqual(titleGroup.facts[1], {
    factId: "fact-title-b",
    receiptId: "receipt-2",
    status: "verified",
    text: "Unrelated wording entirely",
    evidenceMessageIds: ["dup-msg-1"],
    sourceOrder: "m1|2026-01-01T00:00:01.000Z|dup-msg-1",
    historical: true,
  });
  assert.equal(titleGroup.facts[0].historical, false);
  assert.match(titleGroup.groupId, /^dup_[0-9a-f]{24}$/);
  const allGrouped = body.groups.flatMap(factIds);
  for (const excluded of ["fact-home-e", "fact-home-f", "fact-pet-g", "fact-pet-h", "fact-mood-i", "fact-mood-j"])
    assert.equal(allGrouped.includes(excluded), false, `${excluded} must not be grouped`);

  // 2. Paging by cursor.
  response = await get("review/duplicates?limit=1");
  body = response.json();
  assert.deepEqual(body.groups.map((group: { groupId: string }) => group.groupId), [roleGroup.groupId]);
  assert.equal(body.nextCursor, roleGroup.groupId);
  response = await get(`review/duplicates?limit=1&cursor=${body.nextCursor}`);
  body = response.json();
  assert.deepEqual(body.groups.map((group: { groupId: string }) => group.groupId), [titleGroup.groupId]);
  assert.equal(body.nextCursor, null);
  response = await get("review/duplicates?cursor=dup_missing");
  assert.equal(response.statusCode, 400);
  response = await get("review/duplicates?limit=0");
  assert.equal(response.statusCode, 400);

  // 3. Resolve: retired fact only changes status; the kept fact links to the first retired
  //    fact (newer -> older, as the wiki reads supersedesFactId); repeat replays.
  const payload = {
    keepFactId: "fact-title-a",
    retireFactIds: ["fact-title-b"],
    expectedRevisions: { "fact-title-b": 1, "fact-title-a": 1 },
  };
  response = await resolve(titleGroup.groupId, payload);
  assert.equal(response.statusCode, 200, response.body);
  const resolved = {
    groupId: titleGroup.groupId,
    keepFactId: "fact-title-a",
    retiredFactIds: ["fact-title-b"],
    linkedFactId: "fact-title-b",
  };
  assert.deepEqual(response.json(), resolved);
  let retiredFact = await storage.getFact({ chatId: CHAT }, "fact-title-b");
  assert.equal(retiredFact?.status, "superseded");
  assert.equal(retiredFact?.supersedesFactId, undefined, "retired fact gains no link");
  assert.equal(retiredFact?.revision, 2);
  let keptFact = await storage.getFact({ chatId: CHAT }, "fact-title-a");
  assert.equal(keptFact?.status, "verified");
  assert.equal(keptFact?.supersedesFactId, "fact-title-b", "kept fact points at the first retired fact");
  assert.equal(keptFact?.revision, 2);
  response = await resolve(titleGroup.groupId, payload);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), resolved, "replay returns the same resolution");
  retiredFact = await storage.getFact({ chatId: CHAT }, "fact-title-b");
  keptFact = await storage.getFact({ chatId: CHAT }, "fact-title-a");
  assert.equal(retiredFact?.revision, 2, "replay does not mutate the retired fact again");
  assert.equal(keptFact?.revision, 2, "replay does not mutate the kept fact again");
  response = await get("review/duplicates");
  assert.deepEqual(response.json().groups.map((group: { groupId: string }) => group.groupId), [roleGroup.groupId]);

  // 4. Stale revisions: 409 on the retired fact or on the keep, and nothing changes either way.
  const assertRoleUntouched = async () => {
    for (const factId of ["fact-role-c", "fact-role-d"]) {
      const fact = await storage.getFact({ chatId: CHAT }, factId);
      assert.equal(fact?.status, "verified", `${factId} status`);
      assert.equal(fact?.revision, 1, `${factId} revision`);
      assert.equal(fact?.supersedesFactId, undefined, `${factId} link`);
    }
  };
  response = await resolve(roleGroup.groupId, {
    keepFactId: "fact-role-c",
    retireFactIds: ["fact-role-d"],
    expectedRevisions: { "fact-role-d": 99, "fact-role-c": 1 },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, "CAMPAIGN_MEMORY_CAS_MISMATCH");
  await assertRoleUntouched();
  response = await resolve(roleGroup.groupId, {
    keepFactId: "fact-role-c",
    retireFactIds: ["fact-role-d"],
    expectedRevisions: { "fact-role-d": 1, "fact-role-c": 99 },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, "CAMPAIGN_MEMORY_CAS_MISMATCH");
  await assertRoleUntouched();

  // 5. Validation: keep cannot be retired, unknown facts 404, cross-predicate refused,
  //    missing retired or keep revision 400 (the retirement rolls back with the link).
  response = await resolve(roleGroup.groupId, { keepFactId: "fact-role-c", retireFactIds: ["fact-role-c"], expectedRevisions: {} });
  assert.equal(response.statusCode, 400);
  response = await resolve(roleGroup.groupId, { keepFactId: "fact-nope", retireFactIds: ["fact-role-d"], expectedRevisions: {} });
  assert.equal(response.statusCode, 404);
  response = await resolve(roleGroup.groupId, { keepFactId: "fact-role-c", retireFactIds: ["fact-pet-g"], expectedRevisions: { "fact-pet-g": 1 } });
  assert.equal(response.statusCode, 400);
  response = await resolve(roleGroup.groupId, { keepFactId: "fact-role-c", retireFactIds: ["fact-role-d"], expectedRevisions: { "fact-role-c": 1 } });
  assert.equal(response.statusCode, 400);
  response = await resolve(roleGroup.groupId, { keepFactId: "fact-role-c", retireFactIds: ["fact-role-d"], expectedRevisions: { "fact-role-d": 1 } });
  assert.equal(response.statusCode, 400);
  await assertRoleUntouched();

  // 6. A kept fact that another tab already retired is refused, so a group can never lose every fact.
  //    Both facts already carry a link, so resolving onto the first does not move its revision.
  await makeFact("fact-cap-k", "cap", "receipt-1", "dup-msg-1", "Bob wears a red cap", { supersedesFactId: "fact-mood-i" });
  await makeFact("fact-cap-l", "cap", "receipt-2", "dup-msg-2", "Bob wears a red cap", { supersedesFactId: "fact-mood-j" });
  response = await resolve("manual-cap", {
    keepFactId: "fact-cap-k",
    retireFactIds: ["fact-cap-l"],
    expectedRevisions: { "fact-cap-k": 1, "fact-cap-l": 1 },
  });
  assert.equal(response.statusCode, 200, response.body);
  response = await resolve("manual-cap-stale-tab", {
    keepFactId: "fact-cap-l",
    retireFactIds: ["fact-cap-k"],
    expectedRevisions: { "fact-cap-k": 1, "fact-cap-l": 1 },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, "CAMPAIGN_MEMORY_CAS_MISMATCH");
  assert.equal((await storage.getFact({ chatId: CHAT }, "fact-cap-k"))?.status, "verified", "the kept fact stays live");

  await app.close();
  await db._fileStore.close();
  console.log("campaign-memory-duplicates regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
