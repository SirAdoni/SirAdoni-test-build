// ──────────────────────────────────────────────
// Command palette host: global shortcuts + built-in actions
// ──────────────────────────────────────────────
// Ctrl/Cmd+K toggles the palette anywhere (no other binding in the app uses
// it, so it also works while typing). "?" opens the shortcuts overlay unless
// the user is typing. Both surfaces are lazy-loaded on first open.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Chat } from "@marinara-engine/shared";
import { toast } from "sonner";
import {
  canOpenGlobalSearchFromShortcut,
  isGlobalSearchShortcut,
  isPaletteShortcut,
  isShortcutsHelpKey,
  isTypingTarget,
  registerCommand,
} from "../../lib/command-palette";
import { requestChatHelp } from "../../lib/chat-help-events";
import { openActivityOverview, openChatStats, openGlobalSearch } from "../../lib/chat-insights";
import { requestGameSessionPanel } from "../../lib/game-session-panel-events";
import { formatShortcutKey } from "../../lib/keyboard-shortcuts";
import { requestLorebookEditorTool } from "../../lib/lorebook-editor-events";
import { openCharacterDuplicates } from "../../lib/open-character-duplicates";
import { openNameGenerator } from "../../lib/open-name-generator";
import { countModalOverlays } from "../../lib/modal-overlay-registry";
import { downloadCampaignCodex } from "../../hooks/use-game-tools";
import {
  openSettingsTarget,
  TEXT_SNIPPETS_SETTINGS_CONTROL_ID,
  USAGE_DASHBOARD_SETTINGS_CONTROL_ID,
} from "../../lib/settings-targets";
import { requestSnippetPicker } from "../../hooks/use-snippet-expansion";
import { chatKeys, useExportChat } from "../../hooks/use-chats";
import { textSnippetKeys } from "../../hooks/use-text-snippets";
import { useLaunchNewChat } from "../chat/HomeNewChatLauncher";
import { useCommandPaletteStore } from "../../stores/command-palette.store";
import { useChatStore } from "../../stores/chat.store";
import { useUIStore, type Panel } from "../../stores/ui.store";
import { confirmLeaveDirtyEditor } from "./palette-navigation";

const CommandPalette = lazy(() => import("./CommandPalette").then((module) => ({ default: module.CommandPalette })));
const KeyboardShortcutsOverlay = lazy(() =>
  import("./KeyboardShortcutsOverlay").then((module) => ({ default: module.KeyboardShortcutsOverlay })),
);

const PANEL_COMMANDS: ReadonlyArray<{ panel: Panel; labelKey: string; keywords: string[] }> = [
  { panel: "characters", labelKey: "palette.actions.openCharacters", keywords: ["cards", "bots"] },
  { panel: "personas", labelKey: "palette.actions.openPersonas", keywords: ["user", "profile"] },
  { panel: "lorebooks", labelKey: "palette.actions.openLorebooks", keywords: ["world info", "lore"] },
  { panel: "presets", labelKey: "palette.actions.openPresets", keywords: ["prompts"] },
  { panel: "connections", labelKey: "palette.actions.openConnections", keywords: ["api", "models", "providers"] },
  { panel: "agents", labelKey: "palette.actions.openAgents", keywords: ["tools"] },
];

export function CommandPaletteHost() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const paletteOpen = useCommandPaletteStore((s) => s.paletteOpen);
  const shortcutsOpen = useCommandPaletteStore((s) => s.shortcutsOpen);
  const [paletteLoaded, setPaletteLoaded] = useState(false);
  const [shortcutsLoaded, setShortcutsLoaded] = useState(false);
  const { launch } = useLaunchNewChat();
  // launch() is rebuilt every render; a ref keeps the registered actions stable.
  const launchRef = useRef(launch);
  launchRef.current = launch;
  const exportChat = useExportChat();
  const exportChatRef = useRef(exportChat.mutate);
  exportChatRef.current = exportChat.mutate;

  useEffect(() => {
    if (paletteOpen) setPaletteLoaded(true);
  }, [paletteOpen]);
  useEffect(() => {
    if (shortcutsOpen) setShortcutsLoaded(true);
  }, [shortcutsOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (isPaletteShortcut(event)) {
        event.preventDefault();
        useCommandPaletteStore.getState().togglePalette();
        return;
      }
      // Never swaps out a dialog the user is in the middle of, except the palette itself.
      if (isGlobalSearchShortcut(event)) {
        const palette = useCommandPaletteStore.getState();
        if (!canOpenGlobalSearchFromShortcut(countModalOverlays(), palette.paletteOpen)) return;
        event.preventDefault();
        palette.closePalette();
        openGlobalSearch();
        return;
      }
      if (isShortcutsHelpKey(event) && !isTypingTarget(event.target)) {
        event.preventDefault();
        useCommandPaletteStore.getState().openShortcuts();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Built-in actions go through the same public registry other features use.
  useEffect(() => {
    const activeChatMode = () => {
      const activeChatId = useChatStore.getState().activeChatId;
      if (!activeChatId) return null;
      const chats = queryClient.getQueryData<Chat[]>(chatKeys.list());
      return chats?.find((chat) => chat.id === activeChatId)?.mode ?? null;
    };
    const newChat = (mode: "conversation" | "roleplay" | "game") => async () => {
      if (!(await confirmLeaveDirtyEditor())) return;
      useUIStore.getState().closeAllDetails();
      launchRef.current(mode);
    };
    const unregisters = [
      registerCommand({
        id: "action:new-conversation",
        section: "actions",
        title: t("palette.actions.newConversation"),
        keywords: ["new chat", "create", "start"],
        run: newChat("conversation"),
      }),
      registerCommand({
        id: "action:new-roleplay",
        section: "actions",
        title: t("palette.actions.newRoleplay"),
        keywords: ["new chat", "create", "start", "rp"],
        run: newChat("roleplay"),
      }),
      registerCommand({
        id: "action:new-game",
        section: "actions",
        title: t("palette.actions.newGame"),
        keywords: ["new chat", "create", "start", "campaign"],
        run: newChat("game"),
      }),
      registerCommand({
        id: "action:home",
        section: "actions",
        title: t("palette.actions.home"),
        keywords: ["start page", "hub"],
        run: async () => {
          if (!(await confirmLeaveDirtyEditor())) return;
          window.dispatchEvent(new Event("marinara:home-professor-mari-close"));
          useChatStore.getState().setActiveChatId(null);
          useUIStore.getState().closeAllDetails();
        },
      }),
      registerCommand({
        id: "action:toggle-chats",
        section: "actions",
        title: t("palette.actions.toggleChats"),
        keywords: ["sidebar", "chat list"],
        run: () => useUIStore.getState().toggleSidebar(),
      }),
      registerCommand({
        id: "action:open-settings",
        section: "actions",
        title: t("palette.actions.openSettings"),
        keywords: ["preferences", "options"],
        run: () => useUIStore.getState().openRightPanel("settings"),
      }),
      registerCommand({
        id: "action:toggle-theme",
        section: "actions",
        title: t("palette.actions.toggleTheme"),
        keywords: ["dark mode", "light mode", "appearance"],
        run: () => {
          const ui = useUIStore.getState();
          ui.setTheme(ui.theme === "dark" ? "light" : "dark");
        },
      }),
      registerCommand({
        id: "action:shortcuts",
        section: "actions",
        title: t("palette.actions.shortcuts"),
        keywords: ["keyboard", "hotkeys", "help", "keys"],
        shortcut: "?",
        run: () => useCommandPaletteStore.getState().openShortcuts(),
      }),
      registerCommand({
        id: "action:chat-guide",
        section: "actions",
        title: t("palette.actions.chatGuide"),
        keywords: ["help", "tour", "explain"],
        when: () => activeChatMode() !== null,
        run: () => {
          const mode = activeChatMode();
          if (mode) requestChatHelp(mode);
        },
      }),
      registerCommand({
        id: "action:insert-snippet",
        section: "actions",
        title: t("palette.actions.insertSnippet"),
        keywords: ["snippets", "text", "expand"],
        when: () =>
          !!useChatStore.getState().activeChatId &&
          (queryClient.getQueryData<{ snippets: unknown[] }>(textSnippetKeys.catalog)?.snippets.length ?? 0) > 0,
        run: requestSnippetPicker,
      }),
      registerCommand({
        id: "action:manage-snippets",
        section: "settings",
        title: t("palette.actions.manageSnippets"),
        keywords: ["text snippets", "expand", "trigger"],
        run: () => openSettingsTarget("general", TEXT_SNIPPETS_SETTINGS_CONTROL_ID),
      }),
      registerCommand({
        id: "action:usage-dashboard",
        section: "settings",
        title: t("palette.actions.usageDashboard"),
        keywords: ["tokens", "cost", "usage", "spend", "statistics"],
        run: () => openSettingsTarget("advanced", USAGE_DASHBOARD_SETTINGS_CONTROL_ID),
      }),
      registerCommand({
        id: "action:browse-cards",
        section: "actions",
        title: t("palette.actions.browseCards"),
        keywords: ["bot browser", "download", "import"],
        run: () => useUIStore.getState().openBotBrowser(),
      }),
      registerCommand({
        id: "action:character-library",
        section: "actions",
        title: t("palette.actions.characterLibrary"),
        keywords: ["characters", "cards"],
        run: () => useUIStore.getState().openCharacterLibrary(),
      }),
      // ── Tools that have their own opener ──
      registerCommand({
        id: "action:search-all-chats",
        section: "actions",
        title: t("chatInsights.search.open"),
        keywords: ["find", "global search", "messages", "history"],
        shortcut: `${formatShortcutKey("Mod")}+Shift+F`,
        run: () => openGlobalSearch(),
      }),
      registerCommand({
        id: "action:activity-overview",
        section: "actions",
        title: t("chatInsights.activity.open"),
        keywords: ["statistics", "streak", "heatmap", "history"],
        run: openActivityOverview,
      }),
      registerCommand({
        id: "action:name-generator",
        section: "actions",
        title: t("ui.nameGenerator.title"),
        keywords: ["names", "random", "fantasy", "npc"],
        run: openNameGenerator,
      }),
      registerCommand({
        id: "action:chat-stats",
        section: "chats",
        title: t("palette.actions.chatStats"),
        subtitle: t("chatInsights.stats.open"),
        keywords: ["statistics", "words", "messages", "count"],
        when: () => activeChatMode() !== null,
        run: () => {
          const chatId = useChatStore.getState().activeChatId;
          if (chatId) openChatStats(chatId);
        },
      }),
      ...(["markdown", "html"] as const).map((format) =>
        registerCommand({
          id: `action:export-chat-${format}`,
          section: "chats",
          title: t(format === "markdown" ? "palette.actions.exportMarkdown" : "palette.actions.exportStory"),
          subtitle: t(format === "markdown" ? "chatInsights.export.markdownTitle" : "chatInsights.export.htmlTitle"),
          keywords: ["download", "save", "transcript", format === "markdown" ? "md" : "html"],
          when: () => activeChatMode() !== null,
          run: () => {
            const chatId = useChatStore.getState().activeChatId;
            if (chatId) exportChatRef.current({ chatId, format });
          },
        }),
      ),
      registerCommand({
        id: "action:dice-log",
        section: "actions",
        title: t("palette.actions.diceLog"),
        keywords: ["dice", "rolls", "game tools", "luck"],
        // The Session panel lives on the game screen, which an open editor covers.
        when: () => activeChatMode() === "game" && !useUIStore.getState().hasAnyDetailOpen(),
        run: () => requestGameSessionPanel("tools"),
      }),
      registerCommand({
        id: "action:campaign-codex",
        section: "actions",
        title: t("palette.actions.campaignCodex"),
        keywords: ["export", "download", "wiki", "campaign memory", "game"],
        when: () => activeChatMode() === "game",
        run: async () => {
          const chatId = useChatStore.getState().activeChatId;
          if (!chatId) return;
          try {
            await downloadCampaignCodex(chatId, "md");
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t("ui.game.tools.codexFailed"));
          }
        },
      }),
      ...(["check", "test"] as const).map((tool) =>
        registerCommand({
          id: `action:lorebook-${tool}`,
          section: "lorebooks",
          title: t(tool === "check" ? "palette.actions.checkLorebook" : "palette.actions.testLorebook"),
          keywords:
            tool === "check"
              ? ["lint", "problems", "issues", "validate", "lorebook"]
              : ["keyword test", "scanner", "activation", "lorebook"],
          when: () => !!useUIStore.getState().lorebookDetailId,
          run: () => requestLorebookEditorTool(tool),
        }),
      ),
      registerCommand({
        id: "action:character-duplicates",
        section: "characters",
        title: t("characters.duplicates.action"),
        keywords: ["duplicates", "dedupe", "same", "cleanup", "library"],
        run: openCharacterDuplicates,
      }),
      ...PANEL_COMMANDS.map(({ panel, labelKey, keywords }) =>
        registerCommand({
          id: `action:panel-${panel}`,
          section: "actions",
          title: t(labelKey),
          keywords,
          run: () => useUIStore.getState().openRightPanel(panel),
        }),
      ),
    ];
    return () => unregisters.forEach((unregister) => unregister());
  }, [queryClient, t]);

  return (
    <>
      {paletteLoaded && (
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      )}
      {shortcutsLoaded && (
        <Suspense fallback={null}>
          <KeyboardShortcutsOverlay />
        </Suspense>
      )}
    </>
  );
}
