import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "marinara-usage-dashboard-"));
process.env.DATA_DIR = directory;
process.env.FILE_STORAGE_DIR = join(directory, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;

const { createFileNativeDB, FILE_BACKED_TABLES, getFileTableShardStrategy, isLazyUnitTable } =
  await import("../../packages/server/src/db/file-backed-store.js");
const { apiConnections, chats, generationUsage } = await import("../../packages/server/src/db/schema/index.js");
const { createGenerationUsageStorage, ledgerInputTokens } =
  await import("../../packages/server/src/services/storage/generation-usage.storage.js");
const { aggregateUsage, localUsageDay, resolveUsageRange } =
  await import("../../packages/server/src/services/usage/usage-aggregation.js");
const { usageRoutes } = await import("../../packages/server/src/routes/usage.routes.js");
const { estimateUsageCost, formatTokenCount, parsePriceDraft, presetUsageRange } =
  await import("../../packages/client/src/lib/usage-dashboard.js");
const { usageDashboardSettingsSchema } = await import("../../packages/shared/src/schemas/usage-dashboard.schema.ts");

// ── Table registration: a new file-backed table, one shard per UTC day, always resident ──
assert.ok(FILE_BACKED_TABLES.includes("generation_usage"), "generation_usage is a registered file-backed table");
assert.deepEqual(getFileTableShardStrategy("generation_usage"), { kind: "parent", column: "day" });
assert.equal(isLazyUnitTable("generation_usage"), false, "the ledger must stay resident for cross-chat queries");

// ── Pure range + bucketing ──
{
  const range = resolveUsageRange("2026-09-03", "2026-09-01", 120);
  assert.ok(range);
  assert.deepEqual(range.days, ["2026-09-01", "2026-09-02", "2026-09-03"], "reversed ranges are swapped");
  assert.equal(range.fromIso, "2026-08-31T22:00:00.000Z", "local midnight at UTC+2 starts two hours earlier");
  assert.equal(range.toIso, "2026-09-03T21:59:59.999Z");
  assert.equal(localUsageDay("2026-09-01T23:30:00.000Z", 120), "2026-09-02");
  assert.equal(localUsageDay("2026-09-01T23:30:00.000Z", -300), "2026-09-01");
  const clamped = resolveUsageRange("2020-01-01", "2026-09-01", 0);
  assert.equal(clamped?.days.length, 366, "ranges are clamped to a year");
  assert.equal(clamped?.to, "2026-09-01");
  assert.equal(resolveUsageRange("nope", "2026-09-01", 0), null);
}

// ── Claude subscription reports fresh input only; the ledger stores the full input ──
assert.equal(
  ledgerInputTokens({
    chatId: null,
    messageId: null,
    connectionId: null,
    provider: "claude_subscription",
    model: "m",
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 100,
    cacheWriteInputTokens: 20,
  }),
  130,
);
assert.equal(
  ledgerInputTokens({
    chatId: null,
    messageId: null,
    connectionId: null,
    provider: "openai",
    model: "m",
    inputTokens: 110,
    outputTokens: 5,
    cachedInputTokens: 100,
  }),
  110,
);

// ── Storage + route over a real file-native DB ──
const db = await createFileNativeDB();
try {
  const now = "2026-09-10T12:00:00.000Z";
  await db.insert(apiConnections).values({
    id: "conn-a",
    name: "Main API",
    provider: "openai",
    model: "gpt-x",
    createdAt: now,
    updatedAt: now,
  } as typeof apiConnections.$inferInsert);
  await db.insert(chats).values({
    id: "chat-a",
    name: "Tavern night",
    mode: "roleplay",
    characterIds: "[]",
    createdAt: now,
    updatedAt: now,
  } as typeof chats.$inferInsert);

  const ledger = createGenerationUsageStorage(db);
  const base = {
    chatId: "chat-a",
    messageId: "m-1",
    connectionId: "conn-a",
    provider: "openai",
    model: "gpt-x",
    cachedInputTokens: 0,
  };
  await ledger.record({ ...base, inputTokens: 1000, outputTokens: 200 }, "2026-09-09T10:00:00.000Z");
  await ledger.record(
    { ...base, inputTokens: 3000, outputTokens: 400, cachedInputTokens: 5000 },
    "2026-09-10T08:00:00.000Z",
  );
  await ledger.record(
    { ...base, chatId: "chat-gone", connectionId: "conn-gone", model: "old", inputTokens: 50, outputTokens: 5 },
    "2026-09-10T09:00:00.000Z",
  );
  await ledger.record({ ...base, inputTokens: 999, outputTokens: 999 }, "2026-08-01T09:00:00.000Z");
  assert.equal(
    await ledger.record({ ...base, inputTokens: null, outputTokens: 0 }, "2026-09-10T09:30:00.000Z"),
    null,
    "a generation with no reported tokens is not recorded",
  );

  const stored = await db.select().from(generationUsage);
  assert.equal(stored.length, 4);
  const cappedRow = stored.find((row) => row.createdAt === "2026-09-10T08:00:00.000Z");
  assert.equal(cappedRow?.cachedInputTokens, 3000, "cached input never exceeds total input");
  assert.equal(cappedRow?.day, "2026-09-10");

  const range = resolveUsageRange("2026-09-09", "2026-09-10", 0)!;
  const rows = await ledger.listBetween(range.fromIso, range.toIso);
  assert.equal(rows.length, 3, "rows outside the range are excluded");
  const summary = aggregateUsage(rows, range, 0, {
    connections: new Map([["conn-a", "Main API"]]),
    chats: new Map([["chat-a", "Tavern night"]]),
  });
  assert.deepEqual(summary.totals, { requests: 3, inputTokens: 4050, outputTokens: 605, cachedInputTokens: 3000 });
  assert.equal(summary.byConnection[0]?.name, "Main API", "largest connection first");
  assert.equal(summary.byConnection[1]?.name, null, "deleted connections keep their tokens with no name");
  assert.deepEqual(summary.byConnection[1]?.models, ["old"]);
  assert.deepEqual(
    summary.byDay.map((day) => [day.day, day.requests]),
    [
      ["2026-09-09", 1],
      ["2026-09-10", 2],
    ],
  );

  const app = Fastify();
  app.decorate("db", db);
  await app.register(usageRoutes, { prefix: "/api/usage" });
  const response = await app.inject({
    method: "GET",
    url: "/api/usage/summary?from=2026-09-10&to=2026-09-10&tzOffsetMinutes=0",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.totals.requests, 2);
  assert.deepEqual(
    body.byChat.map((chat: { name: string | null }) => chat.name),
    ["Tavern night", null],
  );
  // At UTC-10, local Sept 9 runs 09-09T10:00Z..09-10T09:59Z, so it also holds the Sept 10 morning rows.
  const shifted = (
    await app.inject({ method: "GET", url: "/api/usage/summary?from=2026-09-09&to=2026-09-09&tzOffsetMinutes=-600" })
  ).json();
  assert.equal(shifted.totals.requests, 3);

  const defaults = (await app.inject({ method: "GET", url: "/api/usage/settings" })).json();
  assert.deepEqual(defaults, { version: 1, currency: "$", prices: {} });
  const saved = await app.inject({
    method: "PUT",
    url: "/api/usage/settings",
    payload: { version: 1, currency: "€", prices: { "conn-a": { input: 2.5, output: 10 } } },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/usage/settings" })).json().prices, {
    "conn-a": { input: 2.5, output: 10 },
  });
  const rejected = await app.inject({
    method: "PUT",
    url: "/api/usage/settings",
    payload: { version: 1, currency: "$", prices: { "conn-a": { input: -1, output: null } } },
  });
  assert.notEqual(rejected.statusCode, 200, "negative prices are rejected");
  await app.close();
} finally {
  await db._fileStore.close();
  rmSync(directory, { recursive: true, force: true });
}

// ── Client helpers ──
assert.equal(estimateUsageCost({ inputTokens: 2_000_000, outputTokens: 500_000 }, { input: 2.5, output: 10 }), 10);
assert.equal(estimateUsageCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, { input: null, output: 3 }), 3);
assert.equal(estimateUsageCost({ inputTokens: 1, outputTokens: 1 }, { input: null, output: null }), null);
assert.equal(estimateUsageCost({ inputTokens: 1, outputTokens: 1 }, undefined), null);
assert.equal(formatTokenCount(950), "950");
assert.equal(formatTokenCount(12_400), "12.4K");
assert.equal(formatTokenCount(3_000_000), "3M");
assert.equal(formatTokenCount(250_000_000), "250M");
assert.equal(parsePriceDraft(""), null);
assert.equal(parsePriceDraft("2,5"), 2.5);
assert.equal(parsePriceDraft("-1"), undefined);
assert.equal(parsePriceDraft("abc"), undefined);
assert.deepEqual(presetUsageRange(7, new Date(2026, 8, 3)), { from: "2026-08-28", to: "2026-09-03" });
assert.equal(usageDashboardSettingsSchema.safeParse({ version: 1, prices: {} }).success, true);

// ── Expunging chats also clears the ledger that names them ──
{
  const source = readFileSync(new URL("../../packages/server/src/routes/admin.routes.ts", import.meta.url), "utf8");
  assert.match(source, /runDelete\("generation_usage"/u, "chat expunge clears generation_usage");
}

console.log("usage dashboard regression passed");
