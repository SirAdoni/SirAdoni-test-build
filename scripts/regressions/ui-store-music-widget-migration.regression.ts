import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The mobile music widget (YouTube / local music / Spotify mini player) used to default to the
// top-left corner, where it covered left-aligned message avatars on phones. The default now docks
// to the right edge via an oversized x that the widgets clamp to the viewport, and a persist
// migration moves only the untouched previous default.

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
const { DEFAULT_MOBILE_MUSIC_WIDGET_POSITION, migrateLegacyMobileMusicWidgetPosition, useUIStore } =
  await import("../../packages/client/src/stores/ui.store.js");

// The shared helper (also meant for the server settings sync path) moves only the legacy default.
assert.deepEqual(migrateLegacyMobileMusicWidgetPosition({ x: 16, y: 144 }), {
  ...DEFAULT_MOBILE_MUSIC_WIDGET_POSITION,
});
assert.deepEqual(migrateLegacyMobileMusicWidgetPosition({ x: 200, y: 144 }), { x: 200, y: 144 });
assert.equal(migrateLegacyMobileMusicWidgetPosition(undefined), undefined);
assert.equal(migrateLegacyMobileMusicWidgetPosition(null), null);

const migrate = useUIStore.persist.getOptions().migrate;
assert.ok(migrate, "the UI store must keep its persisted-state migration");
assert.ok(UI_PERSISTENCE.version >= 102, "the music widget dock migration needs UI persistence v102 or later");

assert.ok(
  DEFAULT_MOBILE_MUSIC_WIDGET_POSITION.x >= 2000,
  "the default mobile music widget x must be a right-edge sentinel the widgets clamp to the viewport",
);
assert.equal(DEFAULT_MOBILE_MUSIC_WIDGET_POSITION.y, 144);

const PREVIOUS_VERSION = 101;
const run = (state: Record<string, unknown>, version = PREVIOUS_VERSION) =>
  migrate(structuredClone(state), version) as Record<string, any>;

// The untouched old default moves to the new docked default.
const migratedDefault = run({ spotifyMobileWidgetPosition: { x: 16, y: 144 } });
assert.deepEqual(migratedDefault.spotifyMobileWidgetPosition, { ...DEFAULT_MOBILE_MUSIC_WIDGET_POSITION });

// Positions the user dragged stay exactly where they are.
for (const dragged of [
  { x: 120, y: 300 },
  { x: 16, y: 145 },
  { x: 17, y: 144 },
  { x: 8, y: 8 },
]) {
  assert.deepEqual(run({ spotifyMobileWidgetPosition: dragged }).spotifyMobileWidgetPosition, dragged);
}

// State already on the new version is never touched, even if it happens to hold {16,144}.
assert.deepEqual(run({ spotifyMobileWidgetPosition: { x: 16, y: 144 } }, 102).spotifyMobileWidgetPosition, {
  x: 16,
  y: 144,
});

// A missing position does not crash and is not invented at this step.
assert.doesNotThrow(() => run({}));
assert.equal(run({}).spotifyMobileWidgetPosition, undefined);
assert.doesNotThrow(() => run({ spotifyMobileWidgetPosition: null }));

// Every widget that shares the position resolves the clamped on-screen x for the open panel and
// for the drag origin, so the docked sentinel never leaks into layout math.
for (const path of [
  "packages/client/src/components/chat/YouTubePlayer.tsx",
  "packages/client/src/components/chat/LocalMusicPlayer.tsx",
  "packages/client/src/components/spotify/SpotifyMiniPlayer.tsx",
]) {
  const source = readSource(path);
  assert.match(source, /function resolveMobileWidgetX\(/u, `${path} must define resolveMobileWidgetX`);
  assert.match(
    source,
    /const left = resolveMobileWidgetX\(position\.x/u,
    `${path} must open the expanded panel from the resolved x`,
  );
  assert.match(
    source,
    /originX: resolveMobileWidgetX\(mobilePosition\.x\)/u,
    `${path} must start drags from the resolved x`,
  );
  assert.doesNotMatch(
    source,
    /translateX\(\$\{Math\.round\(clampedLeft - position\.x\)\}px\)/u,
    `${path} must not offset the panel from the raw stored x`,
  );
}

// The server-synced copy has no persist version and replaces local state on load, so it needs the same move.
{
  const { readFileSync } = await import("node:fs");
  const sync = readFileSync(new URL("../../packages/client/src/hooks/use-settings-sync.ts", import.meta.url), "utf8");
  if (!/migrateLegacyMobileMusicWidgetPosition\(\s*parsed\.settings\.spotifyMobileWidgetPosition,?\s*\)/.test(sync))
    throw new Error("settings sync must migrate the synced mobile music widget position");
  if (!/spotifyMobileWidgetPosition = nextPosition;\s*staleSyncedShape = true;/.test(sync))
    throw new Error("a migrated synced position must be written back to the server");
}

console.log("ui-store music widget migration regression passed");
