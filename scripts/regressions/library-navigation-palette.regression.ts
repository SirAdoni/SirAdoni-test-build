import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { fuzzyScore, isPaletteShortcut, parseRecents, pushRecent, rankCommands } =
  await import("../../packages/client/src/lib/command-palette.js");
const { __resetModalOverlayRegistryForTests, countModalOverlays, registerModalOverlay } =
  await import("../../packages/client/src/lib/modal-overlay-registry.js");

__resetModalOverlayRegistryForTests();
assert.equal(countModalOverlays(), 0, "no overlays are counted initially");
const firstOverlay = registerModalOverlay();
assert.equal(countModalOverlays(), 1, "one open modal is counted");
const secondOverlay = registerModalOverlay();
assert.equal(countModalOverlays(), 2, "nested open modals are counted independently");
firstOverlay.release();
assert.equal(countModalOverlays(), 1, "releasing a lower modal preserves the remaining overlay");
secondOverlay.release();
secondOverlay.release();
assert.equal(countModalOverlays(), 0, "overlay release remains idempotent");

const noop = () => undefined;
const commands = [
  { id: "chat:1", title: "The Red Tavern", section: "chats" as const, run: noop },
  { id: "character:2", title: "Aria Blackwood", section: "characters" as const, run: noop },
  { id: "action:characters", title: "Open Characters", section: "actions" as const, run: noop },
];

assert.ok(fuzzyScore("aria", "Aria Blackwood")! > fuzzyScore("black", "Aria Blackwood")!);
assert.ok(fuzzyScore("abw", "Aria Blackwood")! > 0, "ordered initials find a character");
assert.equal(fuzzyScore("missing", "Aria Blackwood"), null);
assert.deepEqual(
  rankCommands(commands, "red tavern", []).map((item) => item.id),
  ["chat:1"],
  "chat names are searchable",
);
assert.deepEqual(
  rankCommands(commands, "blackwood", []).map((item) => item.id),
  ["character:2"],
  "character names are searchable",
);
assert.deepEqual(
  rankCommands(commands, "", ["character:2"], { emptyQueryFallback: (item) => item.section === "actions" }).map(
    (item) => item.id,
  ),
  ["character:2", "action:characters"],
  "empty query offers recent navigation and useful actions without dumping every result",
);
assert.deepEqual(parseRecents('["character:2", 1, "chat:1"]'), ["character:2", "chat:1"]);
assert.deepEqual(parseRecents("not-json"), []);
assert.deepEqual(pushRecent(["chat:1", "character:2"], "chat:1"), ["chat:1", "character:2"]);
assert.equal(isPaletteShortcut({ key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }), true);
assert.equal(
  isPaletteShortcut({ key: "כ", code: "KeyK", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }),
  true,
  "the physical shortcut works with a non-Latin keyboard layout",
);
assert.equal(isPaletteShortcut({ key: "k", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }), false);

const source = (relativePath: string) =>
  readFileSync(new URL(`../../packages/client/src/${relativePath}`, import.meta.url), "utf8");
const palette = source("components/command-palette/CommandPalette.tsx");
const host = source("components/command-palette/CommandPaletteHost.tsx");
const navigation = source("components/command-palette/palette-navigation.ts");
const modalOverlayRegistry = source("lib/modal-overlay-registry.ts");
assert.match(palette, /useAllCharacterCatalog\(open\)/u, "search uses the compact character catalog only while open");
assert.match(palette, /openGlobalSearch\(text\)/u, "message queries route to existing Search All Chats");
assert.match(host, /isPaletteShortcut\(event\)/u, "Ctrl/Cmd+K opens the palette");
assert.match(host, /countModalOverlays\(\)/u, "shortcut checks the exact overlay stack depth");
assert.match(modalOverlayRegistry, /export function countModalOverlays\(\): number/u);
assert.match(navigation, /confirmLeaveDirtyEditor/u, "navigation protects unsaved editors");
assert.match(navigation, /setActiveChatId\(chatId\)/u, "chat results select the requested chat");

console.log("Library navigation palette regression passed");
