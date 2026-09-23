// ──────────────────────────────────────────────
// Command palette (Ctrl/Cmd+K)
// ──────────────────────────────────────────────
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  BookOpen,
  CornerDownLeft,
  FileText,
  MessageSquareText,
  Search,
  Settings2,
  User,
  VenetianMask,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Chat } from "@marinara-engine/shared";
import { Modal } from "../ui/Modal";
import { cn } from "../../lib/utils";
import {
  listRegisteredCommands,
  parseRecents,
  PALETTE_RECENTS_STORAGE_KEY,
  pushRecent,
  rankCommands,
  subscribeToCommands,
  type PaletteCommand,
  type PaletteSection,
} from "../../lib/command-palette";
import { openSettingsTarget } from "../../lib/settings-targets";
import { openGlobalSearch } from "../../lib/chat-insights";
import { useChats } from "../../hooks/use-chats";
import { useAllCharacterCatalog, usePersonas } from "../../hooks/use-characters";
import { useLorebooks } from "../../hooks/use-lorebooks";
import { usePresets } from "../../hooks/use-presets";
import { useCommandPaletteStore } from "../../stores/command-palette.store";
import { useUIStore } from "../../stores/ui.store";
import { openChatFromPalette, openEditorFromPalette } from "./palette-navigation";

const SECTION_ICONS: Record<PaletteSection, LucideIcon> = {
  actions: Zap,
  chats: MessageSquareText,
  characters: User,
  personas: VenetianMask,
  lorebooks: BookOpen,
  presets: FileText,
  settings: Settings2,
};

const SEARCH_CHATS_FOR_QUERY_ID = "action:search-chats-for-query";

const SETTINGS_TABS = [
  { id: "general", labelKey: "settings.tabs.general.label" },
  { id: "appearance", labelKey: "settings.tabs.appearance.label" },
  { id: "generations", labelKey: "settings.tabs.generations.label" },
  { id: "addons", labelKey: "settings.tabs.addons.label" },
  { id: "import", labelKey: "settings.tabs.imports.label" },
  { id: "advanced", labelKey: "settings.tabs.advanced.label" },
] as const;

function readRecents(): string[] {
  try {
    return parseRecents(window.localStorage.getItem(PALETTE_RECENTS_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeRecents(ids: string[]) {
  try {
    window.localStorage.setItem(PALETTE_RECENTS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* recents are a convenience; private windows may refuse storage */
  }
}

export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.paletteOpen);
  const closePalette = useCommandPaletteStore((s) => s.closePalette);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <PaletteDialog open={open} onClose={closePalette} inputRef={inputRef}>
      {open ? <PaletteContent onClose={closePalette} inputRef={inputRef} /> : null}
    </PaletteDialog>
  );
}

function PaletteDialog({
  open,
  onClose,
  inputRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      initialFocusRef={inputRef}
      title={t("palette.title")}
      width="max-w-xl"
      contentClassName="!p-0"
      panelClassName="self-start mt-[8vh] max-md:mt-2"
    >
      {children}
    </Modal>
  );
}

function PaletteContent({ onClose, inputRef }: { onClose: () => void; inputRef: RefObject<HTMLInputElement | null> }) {
  const { t } = useTranslation();
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState(readRecents);
  const registered = useSyncExternalStore(subscribeToCommands, listRegisteredCommands, listRegisteredCommands);

  const { data: chats } = useChats();
  // The compact catalog rather than the full-card list: a big library would
  // otherwise ship and JSON-parse every card each time the palette opens.
  const { data: characters } = useAllCharacterCatalog();
  const { data: personas } = usePersonas();
  const { data: lorebooks } = useLorebooks();
  const { data: presets } = usePresets();

  const entityCommands = useMemo<PaletteCommand[]>(() => {
    const commands: PaletteCommand[] = [];
    const modeLabel = (mode: string) => t(`palette.modes.${mode}`, { defaultValue: mode });
    for (const chat of (chats ?? []) as Chat[]) {
      if (chat.mode === "conversation" && (chat.metadata as { gameId?: unknown } | undefined)?.gameId) continue;
      commands.push({
        id: `chat:${chat.id}`,
        section: "chats",
        title: chat.name || t("palette.untitled"),
        subtitle: modeLabel(chat.mode),
        run: () => openChatFromPalette(chat.id),
      });
    }
    for (const character of characters ?? []) {
      const id = character.id;
      const name = character.name?.trim();
      if (!id || !name) continue;
      commands.push({
        id: `character:${id}`,
        section: "characters",
        title: name,
        subtitle: t("palette.sections.characters"),
        run: () => openEditorFromPalette(() => useUIStore.getState().openCharacterDetail(id)),
      });
    }
    for (const persona of personas ?? []) {
      commands.push({
        id: `persona:${persona.id}`,
        section: "personas",
        title: persona.name,
        subtitle: persona.comment || t("palette.sections.personas"),
        run: () => openEditorFromPalette(() => useUIStore.getState().openPersonaDetail(persona.id)),
      });
    }
    for (const lorebook of lorebooks ?? []) {
      commands.push({
        id: `lorebook:${lorebook.id}`,
        section: "lorebooks",
        title: lorebook.name,
        subtitle: t("palette.sections.lorebooks"),
        run: () => openEditorFromPalette(() => useUIStore.getState().openLorebookDetail(lorebook.id)),
      });
    }
    for (const preset of presets ?? []) {
      commands.push({
        id: `preset:${preset.id}`,
        section: "presets",
        title: preset.name,
        subtitle: t("palette.sections.presets"),
        run: () => openEditorFromPalette(() => useUIStore.getState().openPresetDetail(preset.id)),
      });
    }
    for (const tab of SETTINGS_TABS) {
      commands.push({
        id: `settings-tab:${tab.id}`,
        section: "settings",
        title: t("palette.settingsTab", { tab: t(tab.labelKey) }),
        keywords: ["settings", "preferences"],
        run: () => openSettingsTarget(tab.id),
      });
    }
    return commands;
  }, [characters, chats, lorebooks, personas, presets, t]);

  const allCommands = useMemo(() => {
    const visible = registered.filter((command) => {
      try {
        return command.when ? command.when() : true;
      } catch {
        return false;
      }
    });
    return [...visible, ...entityCommands];
  }, [entityCommands, registered]);

  const results = useMemo(() => {
    const ranked = rankCommands(allCommands, query, recents, {
      limit: 60,
      emptyQueryFallback: (command) => command.section === "actions",
    });
    // Any typed text can also be looked up inside messages, so the palette never dead-ends.
    const text = query.trim();
    if (!text) return ranked;
    const searchMessages: PaletteCommand = {
      id: SEARCH_CHATS_FOR_QUERY_ID,
      section: "chats",
      title: t("palette.actions.searchChatsFor", { query: text }),
      run: () => openGlobalSearch(text),
    };
    return [...ranked, searchMessages];
  }, [allCommands, query, recents, t]);
  const recentSet = useMemo(() => new Set(recents), [recents]);
  const showingRecents = !query.trim();

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-palette-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runCommand = useCallback(
    (command: PaletteCommand | undefined) => {
      if (!command) return;
      // The per-query message search is rebuilt for each query, so it is not a recent.
      if (command.id !== SEARCH_CHATS_FOR_QUERY_ID) {
        const nextRecents = pushRecent(recents, command.id);
        setRecents(nextRecents);
        writeRecents(nextRecents);
      }
      onClose();
      // Let the dialog close and hand focus back before the action moves it.
      window.setTimeout(() => {
        void Promise.resolve()
          .then(() => command.run())
          .catch((error: unknown) => console.error("[command-palette] action failed", error));
      }, 0);
    },
    [onClose, recents],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const count = results.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (count) setActive((index) => (index + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (count) setActive((index) => (index - 1 + count) % count);
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && event.ctrlKey) {
      event.preventDefault();
      setActive(Math.max(0, count - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runCommand(results[active]);
    }
  };

  const activeCommand = results[active];

  return (
    <div className="flex min-h-0 flex-col">
      <label className="relative flex shrink-0 items-center border-b border-[var(--border)]/70">
        <Search
          size="0.9375rem"
          className="pointer-events-none absolute left-3 text-[var(--muted-foreground)]"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("palette.placeholder")}
          aria-label={t("palette.placeholder")}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeCommand ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          className="h-12 w-full bg-transparent pl-10 pr-3 text-sm outline-none placeholder:text-[var(--muted-foreground)]"
        />
      </label>

      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("palette.results")}
        className="max-h-[min(26rem,62dvh)] min-h-0 overflow-y-auto overscroll-contain p-1.5"
      >
        {results.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-[var(--muted-foreground)]">{t("palette.noResults")}</p>
        ) : (
          results.map((command, index) => {
            const section = command.section ?? "actions";
            const Icon = SECTION_ICONS[section];
            const isRecent = recentSet.has(command.id);
            const previous = results[index - 1];
            const header =
              showingRecents && (index === 0 || (previous && recentSet.has(previous.id) !== isRecent))
                ? isRecent
                  ? t("palette.recent")
                  : t("palette.sections.actions")
                : null;
            return (
              <div key={command.id}>
                {header && (
                  <div className="px-2.5 pb-1 pt-2 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                    {header}
                  </div>
                )}
                <button
                  type="button"
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-palette-index={index}
                  tabIndex={-1}
                  onPointerMove={() => setActive(index)}
                  onClick={() => runCommand(command)}
                  className={cn(
                    "flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors sm:min-h-10",
                    index === active ? "bg-[var(--accent)] text-[var(--foreground)]" : "text-[var(--foreground)]/90",
                  )}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--secondary)]/70 text-[var(--muted-foreground)] ring-1 ring-[var(--border)]/70">
                    <Icon size="0.8125rem" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{command.title}</span>
                    {command.subtitle && (
                      <span className="block truncate text-[0.625rem] text-[var(--muted-foreground)]">
                        {command.subtitle}
                      </span>
                    )}
                  </span>
                  {command.shortcut ? (
                    <kbd className="shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[0.625rem] text-[var(--muted-foreground)]">
                      {command.shortcut}
                    </kbd>
                  ) : index === active ? (
                    <CornerDownLeft
                      size="0.75rem"
                      className="hidden shrink-0 text-[var(--muted-foreground)] sm:block"
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="hidden shrink-0 items-center gap-3 border-t border-[var(--border)]/70 px-3 py-1.5 text-[0.625rem] text-[var(--muted-foreground)] sm:flex">
        <span>{t("palette.hintNavigate")}</span>
        <span>{t("palette.hintRun")}</span>
        <span>{t("palette.hintClose")}</span>
      </div>
    </div>
  );
}
