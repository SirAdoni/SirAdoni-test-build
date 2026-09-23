// Campaign-memory wiki read-path perf harness (Codex v3 task 12).
//
// Seeds an isolated temp store with a Session-9-sized campaign memory and
// measures cold/warm p50/p95 for the four hot wiki reads over 200 requests
// each. The entity table and chat row come from a copy of the live tables
// when CAMPAIGN_MEMORY_PERF_TABLES points at a `tables` directory (read-only,
// copied into the temp dir first); otherwise 600 entities are synthesised.
// Facts/knowledge/events/state/relationships are always synthesised because
// the live Session 9 chat has none of them.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");

const REQUESTS = 200;
const WARM_P95_BUDGET_MS = 250;
const CHAT_ID = process.env.CAMPAIGN_MEMORY_PERF_CHAT_ID ?? "ScmWuA8meldFVxKN4nmf0";
const SOURCE_TABLES = process.env.CAMPAIGN_MEMORY_PERF_TABLES;
const COUNTS = { entities: 600, facts: 3000, knowledge: 2000, events: 600, states: 600, relationships: 400, messages: 200 };

const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-perf-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
const startedAt = performance.now();

type Row = Record<string, unknown>;
const FIRST = ["Jadwiga", "Zerah", "Faelan", "Beatrix", "Doravel", "Thessaly", "Brannoch", "Milena", "Orsolya", "Signe"];
const LAST = ["Rookwood", "al-Oren", "Drummond", "Draval", "Quillon", "Ashgrove", "Ferrand", "Kestrel", "Nyx", "Olander"];
const KINDS = ["character", "character", "character", "persona", "location", "lore", "organization", "item"] as const;
const PREDICATES = ["holds", "owes", "seeks", "fears", "guards", "wields", "serves", "knows-of"];

function quantile(samples: number[], q: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!.toFixed(2));
}

function shardFile(tablesDir: string, table: string, encode: (key: string) => string) {
  return join(tablesDir, table, `${encode(CHAT_ID)}.json`);
}

try {
  const { createFileNativeDB, encodeShardKey } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const db = await createFileNativeDB();
  const createdAt = "2026-09-13T14:12:05.175Z";
  const provenance = JSON.stringify({ source: "perf-regression", sourceRevision: "r1", actor: "import" });

  let source: "live-copy" | "synthetic" = "synthetic";
  let entityRows: Row[] = [];
  let chatRows: Row[] = [];
  if (SOURCE_TABLES) {
    const entityFile = shardFile(SOURCE_TABLES, "campaign_memory_entities", encodeShardKey);
    const chatFile = shardFile(SOURCE_TABLES, "chats", encodeShardKey);
    assert.ok(existsSync(entityFile) && existsSync(chatFile), `Live shard copy missing for ${CHAT_ID}`);
    const copyDir = join(root, "source-copy");
    mkdirSync(copyDir, { recursive: true });
    copyFileSync(entityFile, join(copyDir, "entities.json"));
    copyFileSync(chatFile, join(copyDir, "chats.json"));
    entityRows = (JSON.parse(readFileSync(join(copyDir, "entities.json"), "utf8")) as Row[]).filter(
      (row) => row.chatId === CHAT_ID,
    );
    chatRows = (JSON.parse(readFileSync(join(copyDir, "chats.json"), "utf8")) as Row[]).filter((row) => row.id === CHAT_ID);
    assert.ok(entityRows.length > 0 && chatRows.length === 1, "Live shard copy holds no rows for the chat");
    source = "live-copy";
  } else {
    chatRows = [
      { id: CHAT_ID, name: "Perf Session", mode: "game", characterIds: "[]", createdAt, updatedAt: createdAt },
    ];
    for (let index = 0; index < COUNTS.entities; index += 1) {
      const kind = KINDS[index % KINDS.length]!;
      const name = `${FIRST[index % FIRST.length]} ${LAST[Math.floor(index / FIRST.length) % LAST.length]} ${index}`;
      entityRows.push({
        entityId: `perf-entity-${index}`,
        chatId: CHAT_ID,
        kind,
        owner: JSON.stringify(
          kind === "organization"
            ? { type: "registry", store: "campaign-memory", recordId: `perf-entity-${index}` }
            : { type: "existing", store: kind === "location" ? "locations" : "characters", recordId: `rec-${index}` },
        ),
        aliases: JSON.stringify([name, `${FIRST[index % FIRST.length]} the ${index % 7 === 0 ? "Elder" : "Younger"}`]),
        tags: JSON.stringify(["perf", kind]),
        summary: `${name} is a ${kind} of the perf campaign.`,
        attributes: "{}",
        status: "active",
        manualLock: 0,
        provenance,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }
  const entityIds = entityRows.map((row) => row.entityId as string);
  const persons = entityRows.filter((row) => row.kind === "character" || row.kind === "persona").map((row) => row.entityId as string);
  const hero = entityIds[0]!;

  await db.insert(schema.chats).values(chatRows as never);
  await db.insert(schema.campaignMemoryEntities).values(entityRows as never);

  const messageRows: Row[] = [];
  for (let index = 0; index < COUNTS.messages; index += 1) {
    messageRows.push({
      id: `perf-msg-${index}`,
      chatId: CHAT_ID,
      role: index % 2 ? "assistant" : "user",
      content: `Evidence line ${index} of the perf campaign.`,
      createdAt: new Date(Date.UTC(2026, 8, 13, 14, 0, index)).toISOString(),
    });
  }
  await db.insert(schema.messages).values(messageRows as never);
  const evidenceFor = (index: number) => {
    const content = `Evidence line ${index % COUNTS.messages} of the perf campaign.`;
    return JSON.stringify([
      {
        messageId: `perf-msg-${index % COUNTS.messages}`,
        quote: content,
        sourceHash: createHash("sha256").update(content, "utf8").digest("hex"),
      },
    ]);
  };
  const orderFor = (index: number) => `m1|${messageRows[index % COUNTS.messages]!.createdAt}|perf-msg-${index % COUNTS.messages}`;

  // The first entity carries 10% of facts so it is the largest wiki page.
  const factRows: Row[] = [];
  for (let index = 0; index < COUNTS.facts; index += 1) {
    const subject = index % 10 === 0 ? hero : entityIds[index % entityIds.length]!;
    factRows.push({
      factId: `perf-fact-${String(index).padStart(5, "0")}`,
      chatId: CHAT_ID,
      subjectEntityId: subject,
      predicate: PREDICATES[index % PREDICATES.length]!,
      value: JSON.stringify(index % 3 === 0 ? { entityId: entityIds[(index * 7) % entityIds.length] } : `value ${index}`),
      conditions: "[]",
      status: index % 5 === 0 ? "proposed" : "verified",
      validFromOrder: orderFor(index),
      sourceRevision: "r1",
      evidence: evidenceFor(index),
      author: "import",
      provenance,
      manualLock: 0,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    });
  }
  await db.insert(schema.campaignMemoryFacts).values(factRows as never);

  const knowledgeRows: Row[] = [];
  for (let index = 0; index < COUNTS.knowledge; index += 1) {
    knowledgeRows.push({
      knowledgeId: `perf-knowledge-${String(index).padStart(5, "0")}`,
      chatId: CHAT_ID,
      holderEntityId: index % 10 === 0 ? hero : persons[index % persons.length] ?? hero,
      factId: `perf-fact-${String(index % COUNTS.facts).padStart(5, "0")}`,
      epistemicState: ["knows", "believes", "rumor"][index % 3]!,
      learnedFrom: evidenceFor(index),
      learnedAtOrder: orderFor(index),
      provenance,
      manualLock: 0,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    });
  }
  await db.insert(schema.campaignMemoryKnowledge).values(knowledgeRows as never);

  const locations = entityRows.filter((row) => row.kind === "location").map((row) => row.entityId as string);
  const eventRows: Row[] = [];
  for (let index = 0; index < COUNTS.events; index += 1) {
    eventRows.push({
      eventId: `perf-event-${String(index).padStart(5, "0")}`,
      chatId: CHAT_ID,
      occurrenceOrder: orderFor(index),
      campaignTime: null,
      participantEntityIds: JSON.stringify([
        index % 4 === 0 ? hero : entityIds[index % entityIds.length],
        entityIds[(index * 3) % entityIds.length],
      ]),
      locationEntityId: locations[index % locations.length] ?? null,
      sourceRevision: "r1",
      transitions: JSON.stringify([`Transition ${index} happened.`, `Consequence ${index} followed.`]),
      evidence: evidenceFor(index),
      provenance,
      immutable: 1,
      createdAt,
    });
  }
  await db.insert(schema.campaignMemoryEvents).values(eventRows as never);

  const stateRows: Row[] = [];
  for (let index = 0; index < COUNTS.states; index += 1) {
    stateRows.push({
      stateId: `perf-state-${String(index).padStart(5, "0")}`,
      chatId: CHAT_ID,
      entityId: index % 12 === 0 ? hero : entityIds[index % entityIds.length],
      property: `property-${index}`,
      value: JSON.stringify({ mood: index % 2 ? "wary" : "calm" }),
      sourceEventId: `perf-event-${String(index % COUNTS.events).padStart(5, "0")}`,
      validAtOrder: orderFor(index),
      protected: 0,
      provenance,
      manualLock: 0,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    });
  }
  await db.insert(schema.campaignMemoryCurrentState).values(stateRows as never);

  const relationshipRows: Row[] = [];
  for (let index = 0; index < COUNTS.relationships; index += 1) {
    relationshipRows.push({
      relationshipId: `perf-rel-${String(index).padStart(5, "0")}`,
      chatId: CHAT_ID,
      sourceEntityId: index % 8 === 0 ? hero : persons[index % persons.length] ?? hero,
      targetEntityId: persons[(index * 5 + 1) % persons.length] ?? hero,
      type: "knows",
      inverseLabel: "known-by",
      status: "active",
      evidence: evidenceFor(index),
      provenance,
      manualLock: 0,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    });
  }
  await db.insert(schema.campaignMemoryRelationships).values(relationshipRows as never);

  const heroAlias = JSON.parse(entityRows[0]!.aliases as string)[0] as string;
  const prefix = encodeURIComponent(heroAlias.slice(0, 3).toLowerCase());

  const app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryRoutes, { prefix: "/api/game" });
  await app.ready();
  const base = `/api/game/${CHAT_ID}/memory`;
  const targets: Record<string, { url: string; check: (body: any) => void }> = {
    "entities?q": {
      url: `${base}/entities?q=${prefix}`,
      check: (body) => assert.ok(body.items.length > 0 && body.total > 0, "alias prefix search returned nothing"),
    },
    "entities/:id": {
      url: `${base}/entities/${encodeURIComponent(hero)}`,
      check: (body) => {
        assert.equal(body.entity.entityId, hero);
        assert.ok(body.facts.total >= COUNTS.facts / 10, "largest entity must carry its facts");
      },
    },
    "timeline?limit=50": {
      url: `${base}/timeline?limit=50`,
      check: (body) => assert.equal(body.items.length, 50),
    },
    "entities/:id/references": {
      url: `${base}/entities/${encodeURIComponent(hero)}/references`,
      check: (body) => assert.ok(body.facts >= COUNTS.facts / 10 && body.events > 0 && body.relationships > 0),
    },
  };

  async function measure(name: string) {
    const target = targets[name]!;
    const samples: number[] = [];
    for (let index = 0; index < REQUESTS; index += 1) {
      const t0 = performance.now();
      const response = await app.inject({ method: "GET", url: target.url });
      samples.push(performance.now() - t0);
      assert.equal(response.statusCode, 200, `${name} returned ${response.statusCode}: ${response.body.slice(0, 200)}`);
      if (index === 0) target.check(response.json());
    }
    return { p50: quantile(samples, 0.5), p95: quantile(samples, 0.95), max: quantile(samples, 1) };
  }

  // Cold: first 200 requests per endpoint on a freshly booted app (JIT and
  // module state untouched). Warm: a second 200-request pass afterwards.
  const cold: Record<string, unknown> = {};
  const warm: Record<string, unknown> = {};
  for (const name of Object.keys(targets)) cold[name] = await measure(name);
  for (const name of Object.keys(targets)) warm[name] = await measure(name);

  const summary = {
    regression: "campaign-memory-perf",
    source,
    chatId: CHAT_ID,
    rows: {
      entities: entityRows.length,
      facts: factRows.length,
      knowledge: knowledgeRows.length,
      events: eventRows.length,
      states: stateRows.length,
      relationships: relationshipRows.length,
      messages: messageRows.length,
    },
    requestsPerEndpoint: REQUESTS,
    warmP95BudgetMs: WARM_P95_BUDGET_MS,
    cold,
    warm,
    totalMs: Number((performance.now() - startedAt).toFixed(0)),
  };
  console.log(JSON.stringify(summary));
  for (const [name, stats] of Object.entries(warm) as [string, { p95: number }][]) {
    assert.ok(stats.p95 < WARM_P95_BUDGET_MS, `${name} warm p95 ${stats.p95}ms exceeds ${WARM_P95_BUDGET_MS}ms`);
  }
  assert.ok(summary.totalMs < 60_000, `total runtime ${summary.totalMs}ms exceeds 60s`);

  await app.close();
  await db._fileStore.close();
  console.log("campaign-memory-perf regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
