// ──────────────────────────────────────────────
// Keyboard shortcuts catalog (shown by the "?" overlay)
// ──────────────────────────────────────────────
// Every entry mirrors a binding that exists in the code; the comment after it
// names where. Keep this list in sync when adding or removing a shortcut.
// "Mod" renders as Ctrl, or as the Command key on Apple devices.

export interface KeyboardShortcut {
  /** Key combos; alternatives are separate arrays, keys within one are pressed together. */
  keys: string[][];
  /** Localization key of the description. */
  labelKey: string;
}

export interface KeyboardShortcutGroup {
  id: string;
  titleKey: string;
  shortcuts: KeyboardShortcut[];
}

export const KEYBOARD_SHORTCUT_GROUPS: readonly KeyboardShortcutGroup[] = [
  {
    id: "general",
    titleKey: "shortcuts.groups.general",
    shortcuts: [
      // CommandPaletteHost
      { keys: [["Mod", "K"]], labelKey: "shortcuts.general.palette" },
      // CommandPaletteHost (ignored while typing)
      { keys: [["?"]], labelKey: "shortcuts.general.help" },
      // Modal.tsx and every popover's Escape listener
      { keys: [["Esc"]], labelKey: "shortcuts.general.close" },
    ],
  },
  {
    id: "composer",
    titleKey: "shortcuts.groups.composer",
    shortcuts: [
      // ChatInput / ConversationInput / GameInput with "Send on Enter" on
      { keys: [["Enter"]], labelKey: "shortcuts.composer.send" },
      { keys: [["Shift", "Enter"]], labelKey: "shortcuts.composer.newline" },
      // ConversationInput / GameInput / Professor Mari with "Send on Enter" off
      { keys: [["Mod", "Enter"]], labelKey: "shortcuts.composer.sendModifier" },
      // ChatArea handleArrowUp ("Up arrow edits last message")
      { keys: [["↑"]], labelKey: "shortcuts.composer.editLast" },
      // slash, @mention and :emoji: completion lists
      { keys: [["↑"], ["↓"]], labelKey: "shortcuts.composer.completionMove" },
      { keys: [["Tab"], ["Enter"]], labelKey: "shortcuts.composer.completionAccept" },
      // use-snippet-expansion
      { keys: [["Space"], ["Tab"]], labelKey: "shortcuts.composer.snippet" },
      { keys: [["Mod", "Z"]], labelKey: "shortcuts.composer.snippetUndo" },
    ],
  },
  {
    id: "messages",
    titleKey: "shortcuts.groups.messages",
    shortcuts: [
      // ChatArea intuitive swipe navigation
      { keys: [["←"], ["→"]], labelKey: "shortcuts.messages.swipe" },
      // ChatMessage / MessageEditTextarea
      { keys: [["Mod", "Enter"]], labelKey: "shortcuts.messages.saveEdit" },
      { keys: [["Esc"]], labelKey: "shortcuts.messages.cancelEdit" },
      // ChatMessageSearch
      { keys: [["Enter"]], labelKey: "shortcuts.messages.searchJump" },
      // ChatImageLightbox
      { keys: [["←"], ["→"]], labelKey: "shortcuts.messages.lightbox" },
    ],
  },
  {
    id: "game",
    titleKey: "shortcuts.groups.game",
    shortcuts: [
      // GameCombatUI action menu
      { keys: [["↑"], ["↓"], ["W"], ["S"]], labelKey: "shortcuts.game.combatMove" },
      { keys: [["Enter"], ["Space"]], labelKey: "shortcuts.game.combatChoose" },
      // GameFeaturesGuide
      { keys: [["←"], ["→"]], labelKey: "shortcuts.game.guideChapters" },
    ],
  },
  {
    id: "editors",
    titleKey: "shortcuts.groups.editors",
    shortcuts: [
      // textarea-editing handleTextareaTab (prompt, macro and file editors)
      { keys: [["Tab"], ["Shift", "Tab"]], labelKey: "shortcuts.editors.indent" },
      // FileEditorModal
      { keys: [["Mod", "S"]], labelKey: "shortcuts.editors.saveFile" },
      // GameAssetsBrowserView
      { keys: [["Mod", "A"]], labelKey: "shortcuts.editors.selectAllAssets" },
      { keys: [["Esc"]], labelKey: "shortcuts.editors.clearAssetSelection" },
      // AppShell sidebar resize handles
      { keys: [["←"], ["→"], ["Home"], ["End"]], labelKey: "shortcuts.editors.resizeSidebar" },
    ],
  },
];

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/iu.test(platform ?? "");
}

/** Display text for one key, resolving the platform modifier. */
export function formatShortcutKey(key: string, apple = isApplePlatform()): string {
  if (key === "Mod") return apple ? "⌘" : "Ctrl";
  return key;
}
