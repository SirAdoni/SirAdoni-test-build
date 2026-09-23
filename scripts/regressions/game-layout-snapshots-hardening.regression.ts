import assert from "node:assert/strict";
import {
  LAYOUT_IMPORT_MAX_CHARS,
  applyLayoutSnapshot,
  captureLayoutSnapshot,
  clearLayoutScope,
  exportLayoutJson,
  parseLayoutJson,
  type LayoutStorage,
} from "../../packages/client/src/lib/game-layout-snapshots.js";

class MemoryStorage implements LayoutStorage {
  map = new Map<string, string>();
  quota = Infinity;
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (!this.map.has(key) && this.map.size >= this.quota) throw new Error("QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

// ── Cross-chat apply remaps the scope prefix ──
const storage = new MemoryStorage();
storage.setItem("marinara-game-panel:chat-a:floating:narration:size-v2", '{"w":1}');
storage.setItem("marinara-game-panel:chat-a:floating:widget:only-a:hidden", "true");
storage.setItem("marinara-game-panel-stacks:chat-a", "{}");
storage.setItem("marinara-game-panel:chat-b:floating:narration:tucked", "true");
storage.setItem("marinara-game-panel:chat-b:floating:widget:x:size-v2:growth", "bottom");
const fromA = captureLayoutSnapshot(storage, "chat-a");
assert.equal(applyLayoutSnapshot(storage, "chat-b", fromA), true);
assert.equal(storage.getItem("marinara-game-panel:chat-b:floating:narration:size-v2"), '{"w":1}');
assert.equal(storage.getItem("marinara-game-panel-stacks:chat-b"), "{}");
assert.equal(storage.getItem("marinara-game-panel:chat-b:floating:narration:tucked"), null, "stale tuck cleared");
assert.equal(storage.getItem("marinara-game-panel:chat-b:floating:widget:x:size-v2:growth"), null, "stale growth cleared");
assert.equal(storage.getItem("marinara-game-panel:chat-a:floating:narration:size-v2"), '{"w":1}', "source chat untouched");

// ── Reset clears tuck, stacks, hidden and growth for the scope only ──
clearLayoutScope(storage, "chat-b");
assert.deepEqual(captureLayoutSnapshot(storage, "chat-b").entries, {});
assert.equal(Object.keys(captureLayoutSnapshot(storage, "chat-a").entries).length, 3);

// ── Quota error mid-apply restores the previous layout instead of leaving it half written ──
const tight = new MemoryStorage();
tight.setItem("marinara-game-panel:c:floating:narration:size-v2", "old");
tight.quota = 2;
const big = {
  entries: {
    "panel:floating:a:size-v2": "1",
    "panel:floating:b:size-v2": "2",
    "panel:floating:c:size-v2": "3",
  },
};
assert.equal(applyLayoutSnapshot(tight, "c", big), false);
assert.deepEqual(captureLayoutSnapshot(tight, "c").entries, { "panel:floating:narration:size-v2": "old" });

// ── Import: malformed, huge and hostile JSON is refused ──
assert.equal(parseLayoutJson("{not json"), null);
assert.equal(parseLayoutJson("null"), null);
assert.equal(parseLayoutJson("[]"), null);
assert.equal(parseLayoutJson('{"entries":{"other-key":"x"}}'), null);
assert.equal(parseLayoutJson('{"entries":{"panel:x":5}}'), null);
assert.equal(parseLayoutJson('{"format":"something-else","entries":{}}'), null);
const huge = JSON.stringify({ entries: { "panel:floating:a": "x".repeat(LAYOUT_IMPORT_MAX_CHARS) } });
assert.equal(parseLayoutJson(huge), null, "oversized import is refused before parsing");
const hostile = parseLayoutJson('{"entries":{"__proto__":"x"}}');
assert.equal(hostile, null);
assert.equal(({} as Record<string, unknown>).polluted, undefined);

// ── Export and import round-trip ──
const snapshot = captureLayoutSnapshot(storage, "chat-a");
const roundTrip = parseLayoutJson(exportLayoutJson("Mine", snapshot));
assert.ok(roundTrip);
assert.equal(roundTrip.length, 1);
assert.equal(roundTrip[0]!.name, "Mine");
assert.deepEqual(roundTrip[0]!.snapshot.entries, snapshot.entries);

// ── Store: a refused write reports failure and leaves undo history and saved layouts alone ──
const storeStorage = new MemoryStorage();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: storeStorage,
  setTimeout,
  clearTimeout,
  dispatchEvent: () => true,
};
const store = await import("../../packages/client/src/lib/game-layout-editor-store.js");
storeStorage.setItem("marinara-game-panel:s:floating:narration:size-v2", "v1");
store.beginLayoutEditSession("s");
assert.equal(store.applyLayoutAsStep("s", { entries: { "panel:floating:narration:size-v2": "v2" } }), true);
storeStorage.quota = storeStorage.map.size;
assert.equal(
  store.applyLayoutAsStep("s", { entries: { "panel:floating:extra:size-v2": "x", "panel:floating:more:size-v2": "y" } }),
  false,
  "apply reports a full storage",
);
assert.equal(storeStorage.getItem("marinara-game-panel:s:floating:narration:size-v2"), "v2", "layout kept");
storeStorage.quota = Infinity;
assert.equal(store.undoLayout("s"), true, "undo still steps back to v1");
assert.equal(storeStorage.getItem("marinara-game-panel:s:floating:narration:size-v2"), "v1");
store.endLayoutEditSession("s");
storeStorage.quota = storeStorage.map.size;
assert.equal(store.writeSavedLayouts([]), false, "saving layouts reports a full storage");
storeStorage.quota = Infinity;
assert.equal(store.writeSavedLayouts([]), true);
(globalThis as unknown as { window: unknown }).window = undefined;
assert.equal(store.writeSavedLayouts([]), false, "saving layouts reports unavailable storage");

console.log("game-layout-snapshots-hardening regression passed");
