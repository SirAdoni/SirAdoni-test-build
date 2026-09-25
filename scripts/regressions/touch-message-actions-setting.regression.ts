import assert from "node:assert/strict";

// Settings > Appearance "Message actions on touch screens": "inline" (default, today's row)
// or "menu" (one ⋯ button per message). Checks the store default, normalization of bad
// values, the setter, the persisted and synced shapes, the persist migration and the
// server-sync sanitizer.

// The UI store needs browser storage while Zustand initializes its persisted state.
const uiStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => uiStorage.get(key) ?? null,
    setItem: (key: string, value: string) => uiStorage.set(key, value),
    removeItem: (key: string) => uiStorage.delete(key),
  },
});

const { normalizeTouchMessageActionsMode, pickPersistedUIState, pickSyncedSettings, useUIStore } =
  await import("../../packages/client/src/stores/ui.store.js");
const { omitLocalOnlySettings } = await import("../../packages/client/src/hooks/use-settings-sync.js");

// Default is the inline row, exactly today's behaviour.
assert.equal(useUIStore.getState().touchMessageActionsMode, "inline");

// Normalization: only "menu" survives; anything else falls back to "inline".
assert.equal(normalizeTouchMessageActionsMode("menu"), "menu");
assert.equal(normalizeTouchMessageActionsMode("inline"), "inline");
for (const bad of [undefined, null, "", "MENU", "row", 1, true, {}, ["menu"]]) {
  assert.equal(normalizeTouchMessageActionsMode(bad), "inline", `bad value ${JSON.stringify(bad)} must be inline`);
}

// The setter stores valid values and normalizes invalid ones.
useUIStore.getState().setTouchMessageActionsMode("menu");
assert.equal(useUIStore.getState().touchMessageActionsMode, "menu");
useUIStore.getState().setTouchMessageActionsMode("sideways" as never);
assert.equal(useUIStore.getState().touchMessageActionsMode, "inline");

// Persisted locally and synced to the server like the other chat display settings.
useUIStore.getState().setTouchMessageActionsMode("menu");
const state = useUIStore.getState();
assert.equal(pickPersistedUIState(state).touchMessageActionsMode, "menu");
assert.equal(pickSyncedSettings(state).touchMessageActionsMode, "menu");

// Values arriving from the server are sanitized before they reach the store.
assert.equal(omitLocalOnlySettings({ touchMessageActionsMode: "menu" }).touchMessageActionsMode, "menu");
assert.equal(omitLocalOnlySettings({ touchMessageActionsMode: "bogus" }).touchMessageActionsMode, "inline");
assert.equal("touchMessageActionsMode" in omitLocalOnlySettings({}), false, "absent keys stay absent");

// The persist migration repairs a bad stored value and keeps a valid one.
const migrate = useUIStore.persist.getOptions().migrate;
assert.ok(migrate, "The UI store must retain its persisted-state migration");
const repaired = (await migrate({ touchMessageActionsMode: 42 }, 0)) as Record<string, unknown>;
assert.equal(repaired.touchMessageActionsMode, "inline");
const kept = (await migrate({ touchMessageActionsMode: "menu" }, 0)) as Record<string, unknown>;
assert.equal(kept.touchMessageActionsMode, "menu");

console.log("touch-message-actions-setting regression passed");
