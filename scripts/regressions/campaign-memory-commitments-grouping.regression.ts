import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Continuity publishes one fact per resolved subject, so one promise between three people arrived as three rows in
// the commitments list. The list now merges every copy sharing value.receiptId + value.recordId into one commitment:
// all subjects are participants, the evidence is combined, the newest-written copy is the representative (its id,
// state and revision), paging counts merged commitments, and a transition on the representative keeps the group.
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-commitments-grouping-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { campaignMemoryCommitmentsRoutes } =
    await import("../../packages/server/src/routes/campaign-memory-commitments.routes.js");
  const db = await createFileNativeDB();
  const chatId = "grouping-chat";
  const t0 = new Date("2026-09-15T10:00:00.000Z");
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000).toISOString();
  await db.insert(chats).values({ id: chatId, name: "Grouping", mode: "game", characterIds: "[]", createdAt: at(0), updatedAt: at(0) });
  const contents: Record<string, string> = {
    "msg-vow": "Brisa promises Corwen and Dell a boat by spring.",
    "msg-vow-2": "Brisa repeats the promise of a boat.",
    "msg-map": "Dell offers Corwen a map.",
    "msg-keep": "Brisa has the boat ready.",
  };
  await db.insert(messages).values(
    Object.entries(contents).map(([id, content], index) => ({ id, chatId, role: "assistant", content, createdAt: at(index + 1) })),
  );
  const storage = createCampaignMemoryStorage(db);
  const provenance = { source: "grouping-regression", sourceRevision: "r1", actor: "system" as const };
  for (const [entityId, alias] of [
    ["brisa", "Brisa"],
    ["corwen", "Corwen"],
    ["dell", "Dell"],
  ] as const)
    await storage.createEntity({ entityId, chatId, kind: "note", owner: { type: "registry", store: "campaign-memory", recordId: entityId }, aliases: [alias], tags: [], attributes: {}, status: "active", manualLock: false, provenance });
  const ev = (messageId: string, quote: string) => [{ messageId, quote, sourceHash: hash(contents[messageId]!) }];
  const order = (messageId: string) => `m1|${at(Object.keys(contents).indexOf(messageId) + 1)}|${messageId}`;
  const published = (
    factId: string,
    subjectEntityId: string,
    kind: string,
    receiptId: string,
    recordId: string,
    status: string,
    evidence: ReturnType<typeof ev>,
  ) =>
    storage.createFact({
      factId, chatId, subjectEntityId, predicate: kind,
      value: { text: `Record ${recordId}`, status, conditions: [], evidence, subject: subjectEntityId, kind, keys: [], receiptId, historical: false, recordId },
      conditions: [], status: "verified", validFromOrder: order(evidence[0]!.messageId), sourceRevision: "r1", evidence,
      author: "system", provenance, manualLock: false,
    });

  // One promise, three subjects (per-subject copies), second copy cites an extra quote.
  await published("vow-brisa", "brisa", "promise", "receipt-a", "rec-boat", "proposed", ev("msg-vow", "promises Corwen and Dell a boat"));
  await published("vow-corwen", "corwen", "promise", "receipt-a", "rec-boat", "proposed", [
    ...ev("msg-vow", "promises Corwen and Dell a boat"),
    ...ev("msg-vow-2", "repeats the promise"),
  ]);
  await published("vow-dell", "dell", "promise", "receipt-a", "rec-boat", "proposed", ev("msg-vow", "promises Corwen and Dell a boat"));
  // A different record in the same receipt stays separate.
  await published("map-dell", "dell", "offer", "receipt-a", "rec-map", "proposed", ev("msg-map", "offers Corwen a map"));
  await published("map-corwen", "corwen", "offer", "receipt-a", "rec-map", "proposed", ev("msg-map", "offers Corwen a map"));
  // A fact without receipt/record keys groups alone under its own id.
  await published("loose", "brisa", "invitation", "", "", "proposed", ev("msg-map", "offers Corwen a map"));

  const app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryCommitmentsRoutes, { prefix: "/api/game" });
  await app.ready();
  const get = (url: string) => app.inject({ method: "GET", url: `/api/game/${chatId}/memory/commitments${url}` });
  type Item = {
    commitmentId: string; memberCommitmentIds: string[]; state: string; kind: string; revision: number;
    participants: Array<{ entityId: string; role: string; alias: string }>; evidence: Array<{ messageId: string; quote: string }>;
  };

  let response = await get("");
  assert.equal(response.statusCode, 200, response.body);
  let items = response.json().items as Item[];
  assert.equal(items.length, 3, "three distinct commitments, not six rows");
  assert.equal(response.json().total, 3, "the total counts merged commitments");
  const boat = items.find((item) => item.kind === "promise")!;
  assert.deepEqual([...boat.memberCommitmentIds].sort(), ["vow-brisa", "vow-corwen", "vow-dell"]);
  assert.ok(boat.memberCommitmentIds.includes(boat.commitmentId), "the representative is one of the copies");
  assert.deepEqual(
    boat.participants.map((p) => [p.entityId, p.alias]).sort(),
    [["brisa", "Brisa"], ["corwen", "Corwen"], ["dell", "Dell"]],
    "every subject is a participant, with its name",
  );
  assert.deepEqual(
    boat.evidence.map((item) => item.messageId).sort(),
    ["msg-vow", "msg-vow-2"],
    "evidence is combined without repeating the shared quote",
  );
  const map = items.find((item) => item.kind === "offer")!;
  assert.deepEqual([...map.memberCommitmentIds].sort(), ["map-corwen", "map-dell"]);
  assert.deepEqual(items.find((item) => item.kind === "invitation")!.memberCommitmentIds, ["loose"]);

  // Filters see the merged commitment: any participant finds it, once.
  response = await get("?entityId=dell");
  assert.deepEqual((response.json().items as Item[]).map((item) => item.kind).sort(), ["offer", "promise"]);
  assert.equal(response.json().total, 2);

  // Paging walks merged commitments; totals and cursors agree.
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    response = await get(`?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().total, 3);
    seen.push(...(response.json().items as Item[]).map((item) => item.commitmentId));
    cursor = response.json().nextCursor;
  } while (cursor);
  assert.deepEqual(seen, items.map((item) => item.commitmentId), "paging visits each merged commitment once");
  // A cursor naming a non-representative copy still resolves to its group.
  const otherCopy = boat.memberCommitmentIds.find((id) => id !== boat.commitmentId)!;
  response = await get(`?limit=50&cursor=${otherCopy}`);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    (response.json().items as Item[]).map((item) => item.commitmentId),
    items.slice(items.findIndex((item) => item.commitmentId === boat.commitmentId) + 1).map((item) => item.commitmentId),
  );

  // A transition on the representative keeps the group together and shows the newest state.
  response = await app.inject({
    method: "POST",
    url: `/api/game/${chatId}/memory/commitments/${boat.commitmentId}/transition`,
    payload: { state: "active", expectedRevision: boat.revision, operationId: "grouping-keep", evidence: ev("msg-keep", "has the boat ready") },
  });
  assert.equal(response.statusCode, 200, response.body);
  const kept = response.json() as Item;
  assert.equal(kept.state, "active");
  assert.equal(kept.memberCommitmentIds.length, 3, "the transitioned copy stays merged with the other two");
  response = await get("");
  items = response.json().items as Item[];
  assert.equal(items.length, 3);
  const after = items.find((item) => item.kind === "promise")!;
  assert.equal(after.commitmentId, kept.commitmentId, "the new head is the representative");
  assert.equal(after.state, "active", "the newest status wins over the untouched copies");
  assert.equal((await get("?state=proposed")).json().items.some((item: Item) => item.kind === "promise"), false, "the merged promise is not also listed as proposed");
  assert.deepEqual(after.participants.map((p) => p.entityId).sort(), ["brisa", "corwen", "dell"], "every person survives the transition");

  // The client transitions the listed item by its commitmentId + revision: a stale revision is a 409, and a second
  // transition on the grouped item continues the same chain and stays merged.
  const transition = (item: Item, state: string, revision: number, operationId: string) =>
    app.inject({
      method: "POST",
      url: `/api/game/${chatId}/memory/commitments/${item.commitmentId}/transition`,
      payload: { state, expectedRevision: revision, operationId, reason: "Grouped promise regression" },
    });
  response = await transition(after, "completed", after.revision + 1, "grouping-stale");
  assert.equal(response.statusCode, 409, "a stale revision on the grouped item is a conflict");
  response = await transition(after, "completed", after.revision, "grouping-complete");
  assert.equal(response.statusCode, 200, response.body);
  const done = response.json() as Item;
  assert.equal(done.state, "completed");
  assert.equal(done.memberCommitmentIds.length, 3, "a second transition keeps the three copies merged");
  response = await transition(after, "cancelled", after.revision, "grouping-twice");
  assert.equal(response.statusCode, 409, "transitioning an already-transitioned head is refused");
  items = (await get("")).json().items as Item[];
  assert.equal(items.length, 3, "still three commitments after two transitions");
  const final = items.find((item) => item.kind === "promise")!;
  assert.equal(final.commitmentId, done.commitmentId);
  assert.equal(final.state, "completed");
  assert.equal((await get("?entityId=corwen")).json().items.find((item: Item) => item.kind === "promise")?.state, "completed", "any participant's page shows the newest state");

  await app.close();
  console.log("campaign-memory-commitments-grouping regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
