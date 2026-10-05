import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(path: string) {
  return readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");
}

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

const { UI_PERSISTENCE } = await import("../../packages/client/src/lib/ui-persistence.js");
const { DEFAULT_MOBILE_MUSIC_WIDGET_POSITION, useUIStore } =
  await import("../../packages/client/src/stores/ui.store.js");

assert.deepEqual(DEFAULT_MOBILE_MUSIC_WIDGET_POSITION, { x: 16, y: 144 });
assert.equal(UI_PERSISTENCE.version, 101, "the opt-in feature must not migrate saved positions");
const migrate = useUIStore.persist.getOptions().migrate;
assert.ok(migrate, "the UI store must keep its existing persisted-state migration");

for (const position of [
  { x: 16, y: 144 },
  { x: 200, y: 300 },
  { x: 8, y: 8 },
]) {
  const migrated = migrate(structuredClone({ spotifyMobileWidgetPosition: position }), 100) as Record<string, any>;
  assert.deepEqual(migrated.spotifyMobileWidgetPosition, position, "legacy migration must retain user coordinates");
}
assert.equal(
  (migrate(structuredClone({}), 100) as Record<string, unknown>).spotifyMobileWidgetPosition,
  undefined,
  "migration must not invent a saved position",
);

for (const path of [
  "packages/client/src/components/chat/YouTubePlayer.tsx",
  "packages/client/src/components/chat/LocalMusicPlayer.tsx",
  "packages/client/src/components/spotify/SpotifyMiniPlayer.tsx",
]) {
  const source = readSource(path);
  assert.match(source, /useFeatureEnabled\(FLOATING_MEDIA_PLACEMENT_FEATURE\)/u, `${path} must read the opt-in flag`);
  assert.match(
    source,
    path.endsWith("SpotifyMiniPlayer.tsx")
      ? /useFloatingWidgetAvoid\(floating && floatingMediaPlacementEnabled\)/u
      : /useFloatingWidgetAvoid\(mobile && floatingMediaPlacementEnabled\)/u,
    `${path} must avoid observers and calculations while the flag is off`,
  );
  assert.match(
    source,
    /const rendered = floatingMediaPlacementEnabled \? event\.currentTarget\.getBoundingClientRect\(\) : null;/u,
    `${path} must not measure drag geometry while the flag is off`,
  );
  assert.match(
    source,
    /originX: rendered\?\.left \?\? mobilePosition\.x/u,
    `${path} must retain legacy drag origins while off`,
  );
  assert.match(
    source,
    /originY: rendered\?\.top \?\? mobilePosition\.y/u,
    `${path} must retain legacy drag origins while off`,
  );
}

const sync = readSource("packages/client/src/hooks/use-settings-sync.ts");
assert.doesNotMatch(sync, /spotifyMobileWidgetPosition/u, "settings sync must not migrate or rewrite saved positions");

console.log("ui-store music widget position opt-in regression passed");
