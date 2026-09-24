/**
 * Campaign Wiki review and timeline text.
 *
 * Duplicates: facts about the same person that merely cite the same message used to form a duplicate group no
 * matter what they said, because one reply yields many unrelated facts. Now facts sharing a message must also read
 * alike (token Jaccard >= 0.5) or cite an identical quote; near-duplicates on one message still group.
 *
 * Event text: fact sentences were joined with "; " (producing ".;"), and every event from one message read the same,
 * because all facts citing that message's quote were shared. Now sentences join with one space, each event reads
 * the facts about its own participants, and an event whose text an earlier event from the same message already shows
 * takes its next option instead of repeating it, including across timeline pages.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-wiki-review-text-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const CHAT = "review-text-chat";

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values([
    { id: CHAT, name: "Review text", mode: "game", characterIds: "[]", createdAt, updatedAt: createdAt },
  ]);
  const contents: Record<string, string> = {
    "msg-scene": "Orla swears at the lighthouse, and Tamsin opens the gate.",
    "msg-dup": "Orla speaks of oaths and of debts.",
    "msg-ledger": "The ledger line names Orla.",
  };
  await db.insert(messages).values(
    Object.entries(contents).map(([id, content]) => ({ id, chatId: CHAT, role: "assistant", content, createdAt })),
  );
  const storage = createCampaignMemoryStorage(db);
  const provenance = { source: "review-text-regression", sourceRevision: "r1", actor: "system" as const };
  for (const [entityId, alias] of [
    ["ent-orla", "Orla"],
    ["ent-tamsin", "Tamsin"],
  ] as const)
    await storage.createEntity({
      entityId,
      chatId: CHAT,
      kind: "note",
      owner: { type: "registry", store: "campaign-memory", recordId: entityId },
      aliases: [alias],
      tags: [],
      attributes: {},
      status: "active",
      manualLock: false,
      provenance,
    });
  // The source hash is the hash of the whole cited message.
  const ev = (messageId: string, quote: string) => [{ messageId, quote, sourceHash: hash(contents[messageId]!) }];
  const makeFact = (
    factId: string,
    subjectEntityId: string,
    predicate: string,
    receiptId: string,
    evidence: ReturnType<typeof ev>,
    text: string,
  ) =>
    storage.createFact({
      factId,
      chatId: CHAT,
      subjectEntityId,
      predicate,
      value: { text, receiptId, recordId: `rec-${factId}` },
      conditions: [],
      status: "verified",
      validFromOrder: `m1|2026-01-01T00:00:01.000Z|${evidence[0]!.messageId}`,
      sourceRevision: "r1",
      evidence,
      author: "system",
      provenance,
      manualLock: false,
    });

  // ---- Bug 2: duplicate groups need similar text or an identical quote, not just a shared message.
  await makeFact("dup-oath-1", "ent-orla", "oath", "receipt-1", ev("msg-dup", "speaks of oaths"), "Orla swore an oath to the lighthouse keepers");
  // Same message, different quote, unrelated text: not a duplicate.
  await makeFact("dup-oath-2", "ent-orla", "oath", "receipt-2", ev("msg-dup", "and of debts"), "Orla owes the ferryman three silver pieces");
  // Same message, different quote, near-duplicate text (Jaccard ~0.78, below the 0.8 text-only bar): grouped.
  await makeFact("dup-oath-3", "ent-orla", "oath", "receipt-3", ev("msg-dup", "Orla speaks"), "Orla swore an oath to the lighthouse keepers at dawn");
  // Identical quote, dissimilar wording: still grouped.
  await makeFact("dup-debt-1", "ent-orla", "debt", "receipt-1", ev("msg-ledger", "The ledger line names Orla."), "Orla owes a debt to the harbour guild");
  await makeFact("dup-debt-2", "ent-orla", "debt", "receipt-2", ev("msg-ledger", "The ledger line names Orla."), "An unpaid sum stands against her name");

  // ---- Bug 3: several events from one message, facts citing the one shared quote.
  const sceneQuote = "Orla swears at the lighthouse, and Tamsin opens the gate.";
  const scene = ev("msg-scene", sceneQuote);
  await makeFact("scene-orla-1", "ent-orla", "vow", "receipt-s", scene, "Orla swore an oath at the lighthouse.");
  await makeFact("scene-orla-2", "ent-orla", "secret", "receipt-s", scene, "Orla hid the brass key");
  await makeFact("scene-tamsin", "ent-tamsin", "deed", "receipt-s", scene, "Tamsin opened the sea gate.");
  const order = "m1|2026-01-01T00:00:01.000Z|msg-scene";
  const makeEvent = (eventId: string, participantEntityIds: string[]) =>
    storage.createEvent({
      eventId,
      chatId: CHAT,
      occurrenceOrder: order,
      participantEntityIds,
      sourceRevision: "r1",
      transitions: [`transition-${eventId}`],
      evidence: scene,
      provenance,
      immutable: true,
    });
  await makeEvent("ev-1", ["ent-orla"]);
  await makeEvent("ev-2", ["ent-tamsin"]);
  await makeEvent("ev-3", ["ent-orla"]);
  await makeEvent("ev-4", ["ent-orla"]);

  const app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryRoutes, { prefix: "/api/game" });
  await app.ready();
  const get = (url: string) => app.inject({ method: "GET", url: `/api/game/${CHAT}/memory/${url}` });

  let response = await get("review/duplicates");
  assert.equal(response.statusCode, 200, response.body);
  const groups = response.json().groups as Array<{ predicate: string; reason: string; facts: { factId: string }[] }>;
  const byPredicate = new Map(groups.map((group) => [group.predicate, group.facts.map((fact) => fact.factId).sort()]));
  assert.deepEqual(byPredicate.get("oath"), ["dup-oath-1", "dup-oath-3"], "near-duplicates on one message group; the unrelated fact does not");
  assert.ok(!groups.some((group) => group.facts.some((fact) => fact.factId === "dup-oath-2")), "a shared message alone never groups");
  assert.deepEqual(byPredicate.get("debt"), ["dup-debt-1", "dup-debt-2"], "an identical evidence quote groups");
  assert.equal(groups.find((group) => group.predicate === "oath")?.reason, "overlapping-evidence");
  assert.equal(groups.length, 2, "no other groups (the scene facts each have their own predicate)");

  response = await get("timeline");
  assert.equal(response.statusCode, 200, response.body);
  const summaries = Object.fromEntries(
    (response.json().items as Array<{ eventId: string; summary: string }>).map((item) => [item.eventId, item.summary]),
  );
  assert.equal(summaries["ev-1"], "Orla swore an oath at the lighthouse. Orla hid the brass key.", "sentences join with one space and gain a full stop only when missing");
  assert.equal(summaries["ev-2"], "Tamsin opened the sea gate.", "an event reads the facts about its own participants");
  assert.equal(
    summaries["ev-3"],
    "Orla swore an oath at the lighthouse. Orla hid the brass key. Tamsin opened the sea gate.",
    "a repeat takes its next option (all facts citing the quote) instead of the same text",
  );
  assert.equal(summaries["ev-4"], sceneQuote, "then the quote");
  for (const text of Object.values(summaries)) assert.ok(!text.includes(".;") && !text.includes("; "), `no "; " joins: ${text}`);
  const shown = Object.values(summaries).filter(Boolean);
  assert.equal(new Set(shown).size, shown.length, "no two events from one message share a text");

  // Paging: a later page dedupes against events on earlier pages, so text is stable across page sizes.
  response = await get("timeline?limit=2&cursor=ev-2");
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    (response.json().items as Array<{ eventId: string; summary: string }>).map((item) => [item.eventId, item.summary]),
    [
      ["ev-3", summaries["ev-3"]],
      ["ev-4", summaries["ev-4"]],
    ],
  );

  // Fact dependents list the same event text.
  response = await get("facts/scene-tamsin/dependents");
  assert.equal(response.statusCode, 200, response.body);
  const dependents = response.json().events as Array<{ eventId: string; summary: string }>;
  assert.deepEqual(
    dependents.map((item) => [item.eventId, item.summary]),
    ["ev-1", "ev-2", "ev-3", "ev-4"].map((id) => [id, summaries[id]]),
  );

  await app.close();
  console.log("campaign-memory-wiki-review-text regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
