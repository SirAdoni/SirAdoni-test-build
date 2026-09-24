import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings > Features infrastructure: the `features` app setting, its routes, the cached server
// helper (absent = ON, refreshed on every storage write) and env precedence for the switches
// upstream also exposes as environment variables.
const dataDir = mkdtempSync(join(tmpdir(), "marinara-feature-settings-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
process.env.DISABLE_REQUEST_LOGGING = "true";
process.env.AUTO_CREATE_DEFAULT_CONNECTION = "false";
delete process.env.LOREBOOK_STABLE_GROUP_WINNERS;
delete process.env.PROVIDER_RETRY_TRANSIENT_ERRORS;
delete process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR;
delete process.env.MARINARA_CONSOLE_TRAY;

type TestApp = {
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<{ statusCode: number; json(): any; body: string }>;
  ready(): Promise<void>;
};
let app: TestApp | null = null;
try {
  const shared = await import("../../packages/shared/src/index.js");
  const { FEATURE_SETTINGS_KEY, FEATURE_SWITCH_NAMES, normalizeFeatureSettings } = shared;
  const features = await import("../../packages/server/src/services/features/feature-settings.js");
  const { isFeatureEnabled, getFeatureNumber, resetFeatureSettingsForTests } = features;

  // ── shared normalization: bad values fall back to the default ──
  assert.deepEqual(normalizeFeatureSettings(null), {});
  assert.deepEqual(normalizeFeatureSettings([]), {});
  assert.deepEqual(
    normalizeFeatureSettings({ messageTrash: false, providerRetry: "no", messageTrashDays: 0, other: true }),
    { messageTrash: false },
    "only well-formed known keys survive",
  );
  assert.deepEqual(normalizeFeatureSettings({ backgroundCallsPerHour: 42, messageTrashDays: 7 }), {
    backgroundCallsPerHour: 42,
    messageTrashDays: 7,
  });

  // ── absent = ON, numbers default ──
  resetFeatureSettingsForTests();
  for (const name of FEATURE_SWITCH_NAMES) assert.equal(isFeatureEnabled(name), true, `${name} defaults on`);
  assert.equal(getFeatureNumber("backgroundCallsPerHour"), 600);
  assert.equal(getFeatureNumber("messageTrashDays"), 30);

  // ── env precedence: set wins both ways, unset falls through ──
  resetFeatureSettingsForTests({ stableLorebookGroupPicks: false, providerRetry: true });
  assert.equal(isFeatureEnabled("stableLorebookGroupPicks"), false);
  process.env.LOREBOOK_STABLE_GROUP_WINNERS = "true";
  assert.equal(isFeatureEnabled("stableLorebookGroupPicks"), true, "env on beats a saved off");
  process.env.PROVIDER_RETRY_TRANSIENT_ERRORS = "false";
  assert.equal(isFeatureEnabled("providerRetry"), false, "env off beats a saved on");
  process.env.PROVIDER_RETRY_TRANSIENT_ERRORS = "  ";
  assert.equal(isFeatureEnabled("providerRetry"), true, "a blank env var counts as unset");
  assert.deepEqual(features.featureEnvOverrides(), { stableLorebookGroupPicks: "LOREBOOK_STABLE_GROUP_WINNERS" });
  delete process.env.LOREBOOK_STABLE_GROUP_WINNERS;
  delete process.env.PROVIDER_RETRY_TRANSIENT_ERRORS;
  resetFeatureSettingsForTests();

  // ── routes + storage invalidation ──
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { appSettingsRoutes } = await import("../../packages/server/src/routes/app-settings.routes.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { createAppSettingsStorage } =
    await import("../../packages/server/src/services/storage/app-settings.storage.js");
  const db = await getDB();
  const storage = createAppSettingsStorage(db);
  // A value saved before startup is loaded when the routes register.
  await storage.set(FEATURE_SETTINGS_KEY, JSON.stringify({ usageAndActivationStats: false }));
  resetFeatureSettingsForTests();
  assert.equal(isFeatureEnabled("usageAndActivationStats"), true);

  const fastify = Fastify();
  fastify.decorate("db", db);
  await fastify.register(appSettingsRoutes, { prefix: "/api/app-settings" });
  app = fastify as unknown as TestApp;
  await app.ready();
  assert.equal(isFeatureEnabled("usageAndActivationStats"), false, "startup primes the cache");

  const read = await app.inject({ method: "GET", url: "/api/app-settings/features" });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), {
    settings: { usageAndActivationStats: false },
    envOverrides: {},
    effective: {},
    // Platform-only switches: the Windows console tray is reported unavailable elsewhere.
    unavailable: process.platform === "win32" ? {} : { consoleTray: "windowsOnly" },
  });

  const saved = await app.inject({
    method: "PUT",
    url: "/api/app-settings/features",
    payload: { messageTrash: false, messageTrashDays: 5 },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().settings, { messageTrash: false, messageTrashDays: 5 });
  assert.equal(isFeatureEnabled("messageTrash"), false, "a save takes effect at once");
  assert.equal(isFeatureEnabled("usageAndActivationStats"), true, "omitted keys return to ON");
  assert.equal(getFeatureNumber("messageTrashDays"), 5);
  assert.equal(JSON.parse((await storage.get(FEATURE_SETTINGS_KEY))!).messageTrash, false, "persisted");

  const bad = await app.inject({ method: "PUT", url: "/api/app-settings/features", payload: { messageTrash: "off" } });
  // The app error handler maps the ZodError to 400; this bare Fastify answers 500. Either way it is refused.
  assert.ok(bad.statusCode >= 400, "invalid values are rejected");
  const unknown = await app.inject({ method: "PUT", url: "/api/app-settings/features", payload: { surprise: true } });
  assert.ok(unknown.statusCode >= 400, "unknown keys are rejected");
  assert.equal(isFeatureEnabled("messageTrash"), false, "a rejected save keeps the old value");

  process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR = "120";
  const locked = await app.inject({ method: "GET", url: "/api/app-settings/features" });
  assert.equal(locked.json().envOverrides.backgroundCallsPerHour, "MARINARA_BACKGROUND_CALLS_PER_HOUR");
  delete process.env.MARINARA_BACKGROUND_CALLS_PER_HOUR;

  // A switch pinned by an on/off env var reports the value in effect, so the locked toggle shows it.
  await app.inject({ method: "PUT", url: "/api/app-settings/features", payload: { stableLorebookGroupPicks: false } });
  process.env.LOREBOOK_STABLE_GROUP_WINNERS = "true";
  const pinned = (await app.inject({ method: "GET", url: "/api/app-settings/features" })).json();
  assert.equal(pinned.settings.stableLorebookGroupPicks, false, "the saved value is kept");
  assert.equal(pinned.effective.stableLorebookGroupPicks, true, "the env value is what is in effect");
  delete process.env.LOREBOOK_STABLE_GROUP_WINNERS;

  // Any writer through app-settings storage refreshes the cache; removing the key restores defaults.
  await storage.set(FEATURE_SETTINGS_KEY, "not json");
  assert.equal(isFeatureEnabled("messageTrash"), true, "bad JSON falls back to defaults");
  await storage.set(FEATURE_SETTINGS_KEY, JSON.stringify({ providerRetry: false }));
  assert.equal(isFeatureEnabled("providerRetry"), false);
  await storage.remove(FEATURE_SETTINGS_KEY);
  assert.equal(isFeatureEnabled("providerRetry"), true);
  await storage.set(FEATURE_SETTINGS_KEY, "{}");
  for (const name of FEATURE_SWITCH_NAMES) assert.equal(isFeatureEnabled(name), true, `${name}: empty object is ON`);

  // A raw row write that bypasses app-settings storage (Professor Mari's generic DB commands) is
  // picked up by reloadFeatureSettingsIfTouched; unrelated rows leave the cache alone.
  const { appSettings } = await import("../../packages/server/src/db/schema/index.js");
  await db
    .insert(appSettings)
    .values({ key: FEATURE_SETTINGS_KEY, value: JSON.stringify({ messageTrash: false }), updatedAt: "x" })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify({ messageTrash: false }) } });
  assert.equal(isFeatureEnabled("messageTrash"), true, "raw write alone does not reach the cache");
  assert.equal(await features.reloadFeatureSettingsIfTouched([{ table: "chats", id: "features" }], storage), false);
  assert.equal(isFeatureEnabled("messageTrash"), true);
  assert.equal(
    await features.reloadFeatureSettingsIfTouched([{ table: "app_settings", id: FEATURE_SETTINGS_KEY }], storage),
    true,
  );
  assert.equal(isFeatureEnabled("messageTrash"), false, "Mari-style writes refresh the cache");
  await storage.remove(FEATURE_SETTINGS_KEY);

  // The generic key route does not expose it (the typed route validates).
  const generic = await app.inject({ method: "PUT", url: "/api/app-settings/other", payload: { value: "{}" } });
  assert.equal(generic.statusCode, 404);

  console.log("feature-settings regression passed");
} finally {
  await app?.close();
  const { closeDB } = await import("../../packages/server/src/db/connection.js");
  await closeDB().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}
