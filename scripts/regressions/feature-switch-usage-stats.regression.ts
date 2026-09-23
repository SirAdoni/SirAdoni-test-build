import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings > Features "Usage and activation stats" (usageAndActivationStats). ON (default) is today:
// every generation writes a usage ledger row and lorebook activation counts. OFF is upstream: both
// writes are skipped (the client hides the Usage Dashboard and the lorebook stats).
const dataDir = mkdtempSync(join(tmpdir(), "marinara-feature-usage-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";

const { resetFeatureSettingsForTests } =
  await import("../../packages/server/src/services/features/feature-settings.js");
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { createGenerationUsageStorage } =
    await import("../../packages/server/src/services/storage/generation-usage.storage.js");
  const stats = await import("../../packages/server/src/services/lorebook/activation-stats.js");
  const db = await createFileNativeDB();
  const usage = createGenerationUsageStorage(db);
  const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
  const lorebooks = createLorebooksStorage(db);
  const book = (await lorebooks.create({ name: "Grove lore" }))!;
  const entryOn = (await lorebooks.createEntry({ lorebookId: book.id, name: "Alder", content: "Alder." } as never))!.id;
  const entryOff = (await lorebooks.createEntry({ lorebookId: book.id, name: "Birch", content: "Birch." } as never))!
    .id;
  const input = { chatId: "chat-grove", provider: "openai", model: "m", inputTokens: 100, outputTokens: 20 };
  const all = () => usage.listBetween("2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z");

  // ON = today
  resetFeatureSettingsForTests();
  const row = await usage.record(input, "2026-09-23T10:00:00.000Z");
  assert.equal(row?.inputTokens, 100, "ON: usage is recorded");
  assert.equal((await all()).length, 1);
  stats.recordLorebookActivations(db, { entryIds: [entryOn], chatId: "chat-grove" });
  await stats.flushLorebookActivationStats(db);
  assert.equal((await stats.listLorebookActivationStats(db, [entryOn]))[0]?.count, 1, "ON: activations recorded");

  // OFF = upstream: no writes
  resetFeatureSettingsForTests({ usageAndActivationStats: false });
  assert.equal(await usage.record(input, "2026-09-23T11:00:00.000Z"), null, "OFF: nothing recorded");
  assert.equal((await all()).length, 1, "OFF: the ledger is untouched");
  stats.recordLorebookActivations(db, { entryIds: [entryOn, entryOff], chatId: "chat-grove" });
  await stats.flushLorebookActivationStats(db);
  const after = await stats.listLorebookActivationStats(db, [entryOn, entryOff]);
  assert.deepEqual(
    after.map((stat) => [stat.entryId, stat.count]),
    [[entryOn, 1]],
    "OFF: no activation counts written",
  );

  // Queued while ON, switched OFF before the batch flushes: the queued batch is dropped too.
  resetFeatureSettingsForTests();
  stats.recordLorebookActivations(db, { entryIds: [entryOn, entryOff], chatId: "chat-grove" });
  resetFeatureSettingsForTests({ usageAndActivationStats: false });
  await stats.flushLorebookActivationStats(db);
  resetFeatureSettingsForTests();
  await stats.flushLorebookActivationStats(db);
  assert.deepEqual(
    (await stats.listLorebookActivationStats(db, [entryOn, entryOff])).map((stat) => [stat.entryId, stat.count]),
    [[entryOn, 1]],
    "OFF: a batch queued before the switch was turned off is not written",
  );
} finally {
  resetFeatureSettingsForTests();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("feature-switch-usage-stats regression passed");
