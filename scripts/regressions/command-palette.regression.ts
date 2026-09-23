import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  canOpenGlobalSearchFromShortcut,
  fuzzyScore,
  isGlobalSearchShortcut,
  isPaletteShortcut,
  isShortcutsHelpKey,
  isTypingTarget,
  listRegisteredCommands,
  parseRecents,
  pushRecent,
  rankCommands,
  registerCommand,
  subscribeToCommands,
} = await import("../../packages/client/src/lib/command-palette.js");
const { formatShortcutKey, KEYBOARD_SHORTCUT_GROUPS } =
  await import("../../packages/client/src/lib/keyboard-shortcuts.js");

const noop = () => undefined;

// ── Fuzzy scoring prefers exact > prefix > word start > substring > subsequence ──
{
  const exact = fuzzyScore("aria", "Aria")!;
  const prefix = fuzzyScore("ari", "Aria Blackwood")!;
  const wordStart = fuzzyScore("black", "Aria Blackwood")!;
  const substring = fuzzyScore("ckwo", "Aria Blackwood")!;
  const subsequence = fuzzyScore("abw", "Aria Blackwood")!;
  assert.ok(exact > prefix && prefix > wordStart && wordStart > substring && substring > subsequence);
  assert.equal(fuzzyScore("xyz", "Aria Blackwood"), null);
  assert.equal(fuzzyScore("", "anything"), 0);
  assert.ok(fuzzyScore("cafe", "Café Noir")! > 800, "accents are ignored (prefix match)");
  assert.ok(fuzzyScore("(", "a (b)") != null, "regex characters in the query are literal");
}

// ── Ranking: recents first on empty query, then the fallback group; boosted near-ties ──
{
  const commands = [
    { id: "action:new", title: "New conversation", section: "actions" as const, run: noop },
    { id: "chat:1", title: "Tavern night", section: "chats" as const, run: noop },
    { id: "chat:2", title: "Tavern day", section: "chats" as const, run: noop },
    {
      id: "character:1",
      title: "Nova",
      subtitle: "Character",
      keywords: ["starlight"],
      section: "characters" as const,
      run: noop,
    },
  ];
  const empty = rankCommands(commands, "", ["chat:2"], {
    emptyQueryFallback: (command) => command.section === "actions",
  });
  assert.deepEqual(
    empty.map((command) => command.id),
    ["chat:2", "action:new"],
    "empty query shows recents, then actions, never every chat",
  );
  assert.deepEqual(
    rankCommands(commands, "tavern", ["chat:2"]).map((command) => command.id),
    ["chat:2", "chat:1"],
    "a recent item wins a tie",
  );
  assert.deepEqual(
    rankCommands(commands, "starlight", []).map((command) => command.id),
    ["character:1"],
    "hidden keywords match",
  );
  assert.equal(rankCommands(commands, "t", [], { limit: 1 }).length, 1);
}

// ── Recents ──
assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
assert.equal(
  pushRecent(
    Array.from({ length: 20 }, (_, index) => `x${index}`),
    "new",
  ).length,
  12,
);
assert.deepEqual(parseRecents('["a", 1, "b"]'), ["a", "b"]);
assert.deepEqual(parseRecents("{broken"), []);
assert.deepEqual(parseRecents(null), []);

// ── Registry: register, replace, unregister, and notify subscribers ──
{
  let notifications = 0;
  const unsubscribe = subscribeToCommands(() => notifications++);
  const first = { id: "test:cmd", title: "First", run: noop };
  const second = { id: "test:cmd", title: "Second", run: noop };
  const unregisterFirst = registerCommand(first);
  const unregisterSecond = registerCommand(second);
  assert.equal(listRegisteredCommands().filter((command) => command.id === "test:cmd").length, 1);
  assert.equal(listRegisteredCommands().find((command) => command.id === "test:cmd")?.title, "Second");
  unregisterFirst();
  assert.ok(
    listRegisteredCommands().some((command) => command.id === "test:cmd"),
    "a stale unregister must not remove its replacement",
  );
  const snapshot = listRegisteredCommands();
  assert.equal(listRegisteredCommands(), snapshot, "snapshot is stable between changes (useSyncExternalStore)");
  unregisterSecond();
  assert.equal(
    listRegisteredCommands().some((command) => command.id === "test:cmd"),
    false,
  );
  assert.equal(notifications, 3);
  unsubscribe();
}

// ── Key handling ──
const key = (
  value: string,
  modifiers: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {},
) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});
assert.equal(isPaletteShortcut(key("k", { ctrlKey: true })), true);
assert.equal(isPaletteShortcut(key("K", { metaKey: true })), true);
assert.equal(isPaletteShortcut(key("k", { ctrlKey: true, shiftKey: true })), false);
assert.equal(isPaletteShortcut(key("k")), false);
// Non-Latin layouts report the local letter in `key`; the physical K key still opens the palette.
assert.equal(isPaletteShortcut({ ...key("ל", { ctrlKey: true }), code: "KeyK" }), true, "Hebrew layout Ctrl+K");
assert.equal(isPaletteShortcut({ ...key("л", { metaKey: true }), code: "KeyK" }), true, "Cyrillic layout Cmd+K");
// A Latin layout that moves K elsewhere (Dvorak: physical K types "t") must not open it.
assert.equal(isPaletteShortcut({ ...key("t", { ctrlKey: true }), code: "KeyK" }), false, "Dvorak Ctrl+T");
assert.equal(isPaletteShortcut({ ...key("k", { ctrlKey: true }), repeat: true }), false, "held key does not re-toggle");
assert.ok(fuzzyScore("black", "Aria Blackwood")! > fuzzyScore("black", "Unblackened")!, "cached word pattern");
assert.ok(fuzzyScore("wood", "Dark wood")! > fuzzyScore("wood", "Aria Blackwood")!, "pattern follows the new query");
// Ctrl/Cmd+Shift+F opens Search all chats; plain Ctrl+F stays the browser's find.
assert.equal(isGlobalSearchShortcut(key("F", { ctrlKey: true, shiftKey: true })), true);
assert.equal(isGlobalSearchShortcut(key("f", { metaKey: true, shiftKey: true })), true);
assert.equal(isGlobalSearchShortcut(key("f", { ctrlKey: true })), false, "Ctrl+F is left to the browser");
assert.equal(isGlobalSearchShortcut(key("F", { ctrlKey: true, shiftKey: true, altKey: true })), false);
assert.equal(isGlobalSearchShortcut({ ...key("כ", { ctrlKey: true, shiftKey: true }), code: "KeyF" }), true);
// Windows AltGr arrives as Ctrl+Alt, so AltGr+Shift+F must not open search.
assert.equal(isGlobalSearchShortcut({ ...key("F", { ctrlKey: true, shiftKey: true, altKey: true }), code: "KeyF" }), false);
assert.equal(isGlobalSearchShortcut({ ...key("F", { ctrlKey: true, shiftKey: true }), repeat: true }), false);
// It may replace only the palette: never a dialog underneath the palette, nor one open on its own.
assert.equal(canOpenGlobalSearchFromShortcut(0, false), true, "nothing open");
assert.equal(canOpenGlobalSearchFromShortcut(1, true), true, "only the palette is open");
assert.equal(canOpenGlobalSearchFromShortcut(2, true), false, "palette opened over another dialog");
assert.equal(canOpenGlobalSearchFromShortcut(1, false), false, "another dialog is open");
assert.equal(isPaletteShortcut(key("F", { ctrlKey: true, shiftKey: true })), false);
assert.equal(isShortcutsHelpKey(key("?", { shiftKey: true })), true);
assert.equal(isShortcutsHelpKey(key("?", { ctrlKey: true })), false);

const element = (tagName: string, attributes: Record<string, string> = {}, extra: object = {}) => ({
  tagName,
  getAttribute: (name: string) => attributes[name] ?? null,
  closest: () => null,
  ...extra,
});
assert.equal(isTypingTarget(element("TEXTAREA")), true);
assert.equal(isTypingTarget(element("INPUT")), true);
assert.equal(isTypingTarget(element("INPUT", { type: "search" })), true);
assert.equal(isTypingTarget(element("INPUT", { type: "checkbox" })), false);
assert.equal(isTypingTarget(element("DIV", {}, { isContentEditable: true })), true);
assert.equal(isTypingTarget(element("BUTTON")), false);
assert.equal(isTypingTarget(null), false);

// ── Shortcut catalog: every label is localized and every binding exists in the code ──
const en = JSON.parse(
  readFileSync(new URL("../../packages/client/src/localization/locales/en.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const labelKeys = new Set<string>();
for (const group of KEYBOARD_SHORTCUT_GROUPS) {
  assert.equal(typeof en[group.titleKey], "string", `${group.titleKey} is in en.json`);
  for (const shortcut of group.shortcuts) {
    assert.equal(typeof en[shortcut.labelKey], "string", `${shortcut.labelKey} is in en.json`);
    assert.ok(!labelKeys.has(shortcut.labelKey), `${shortcut.labelKey} is listed once`);
    labelKeys.add(shortcut.labelKey);
    assert.ok(shortcut.keys.length > 0 && shortcut.keys.every((combo) => combo.length > 0));
  }
}
assert.equal(formatShortcutKey("Mod", true), "⌘");
assert.equal(formatShortcutKey("Mod", false), "Ctrl");

const source = (path: string) => readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), "utf8");
const bindings: Array<[string, RegExp]> = [
  ["components/command-palette/CommandPaletteHost.tsx", /isPaletteShortcut\(event\)/u],
  ["components/command-palette/CommandPaletteHost.tsx", /isShortcutsHelpKey\(event\) && !isTypingTarget/u],
  ["components/command-palette/CommandPaletteHost.tsx", /isGlobalSearchShortcut\(event\)/u],
  ["components/command-palette/CommandPalette.tsx", /event\.key === "ArrowDown"/u],
  ["components/chat/SnippetPicker.tsx", /event\.key === "ArrowDown"/u],
  ["components/modals/GlobalSearchModal.tsx", /event\.key === "Enter" && results\[0\]/u],
  ["components/chat/ChatArea.tsx", /event\.key !== "ArrowLeft" && event\.key !== "ArrowRight"/u],
  ["components/chat/ChatArea.tsx", /event\.key !== "ArrowUp"/u],
  ["components/chat/ConversationInput.tsx", /e\.key === "Enter" && \(e\.metaKey \|\| e\.ctrlKey\)/u],
  ["components/chat/MessageEditTextarea.tsx", /event\.key === "Enter" && \(event\.metaKey \|\| event\.ctrlKey\)/u],
  ["components/chat/ChatImageLightbox.tsx", /event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"/u],
  ["components/chat/ChatMessageSearch.tsx", /event\.key === "Enter" && results\[0\]/u],
  ["components/game/GameCombatUI.tsx", /e\.key === "ArrowUp" \|\| e\.key === "w"/u],
  ["components/game/GameFeaturesGuide.tsx", /event\.key === "ArrowRight"/u],
  ["components/game-assets/FileEditorModal.tsx", /e\.key === "s" && \(e\.metaKey \|\| e\.ctrlKey\)/u],
  ["components/game-assets/GameAssetsBrowserView.tsx", /e\.key === "a" && \(e\.metaKey \|\| e\.ctrlKey\)/u],
  ["lib/textarea-editing.ts", /event\.key !== "Tab"/u],
  ["hooks/use-snippet-expansion.ts", /event\.key !== "Tab"/u],
];
for (const [path, pattern] of bindings) {
  assert.match(source(path), pattern, `${path} still implements a listed shortcut`);
}

// Big libraries: the palette lists characters from the compact catalog, never the full-card list.
const palette = source("components/command-palette/CommandPalette.tsx");
assert.match(palette, /useAllCharacterCatalog\(\)/u, "palette reads the compact character catalog");
assert.doesNotMatch(palette, /useCharacters\(\)/u, "palette does not load every full character card");

// Wave-1 tools are reachable from the palette, each shown only where it applies.
const host = source("components/command-palette/CommandPaletteHost.tsx");
for (const id of [
  "action:search-all-chats",
  "action:activity-overview",
  "action:name-generator",
  "action:chat-stats",
  "action:export-chat-${format}",
  "action:dice-log",
  "action:campaign-codex",
  "action:lorebook-${tool}",
  "action:character-duplicates",
  "action:usage-dashboard",
]) {
  assert.ok(host.includes(`id: "${id}"`) || host.includes(`id: \`${id}\``), `${id} is registered`);
}
assert.match(host, /activeChatMode\(\) === "game"/u, "game tools need a game chat");
assert.match(host, /lorebookDetailId/u, "lorebook tools need an open lorebook");
for (const key of [
  "palette.actions.chatStats",
  "palette.actions.exportMarkdown",
  "palette.actions.exportStory",
  "palette.actions.diceLog",
  "palette.actions.campaignCodex",
  "palette.actions.checkLorebook",
  "palette.actions.testLorebook",
  "palette.actions.searchChatsFor",
  "chatInsights.search.open",
  "chatInsights.activity.open",
  "ui.nameGenerator.title",
  "characters.duplicates.action",
]) {
  assert.equal(typeof en[key], "string", `${key} is in en.json`);
  assert.ok(!String(en[key]).includes("—"), `${key} has no em dash`);
}
assert.match(palette, /palette\.actions\.searchChatsFor/u, "typed text can always be searched inside messages");

// Touch and mobile users need a visible way in, not only the key binding.
const topBar = source("components/layout/TopBar.tsx");
assert.match(topBar, /aria-keyshortcuts="Control\+K Meta\+K"/u, "touch users get a visible palette button");

// The palette's "Find duplicate characters" opens over any editor; opening a card keeps the dirty-editor guard.
assert.match(
  source("components/layout/ModalRenderer.tsx"),
  /openEditorFromPalette\(\(\) => useUIStore\.getState\(\)\.openCharacterDetail\(id\)\)/u,
  "global duplicates modal guards unsaved editors",
);

console.log("command palette regression passed");
