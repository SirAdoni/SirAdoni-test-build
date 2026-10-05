import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft, MessageSquareText, Search, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Chat } from "@marinara-engine/shared";
import { Modal } from "../ui/Modal";
import { cn } from "../../lib/utils";
import { openGlobalSearch } from "../../lib/chat-insights";
import { useChats } from "../../hooks/use-chats";
import { useAllCharacterCatalog } from "../../hooks/use-characters";
import { PanelErrorState } from "../ui/PanelStates";
import {
  PALETTE_RECENTS_STORAGE_KEY,
  parseRecents,
  pushRecent,
  rankCommands,
  type PaletteCommand,
  type PaletteSection,
} from "../../lib/command-palette";
import { useCommandPaletteStore } from "../../stores/command-palette.store";
import { useUIStore } from "../../stores/ui.store";
import { openChatFromPalette, openEditorFromPalette } from "./palette-navigation";
import { openPrepBoard } from "../../lib/open-prep-board";
import { openRandomTables } from "../../lib/open-random-tables";
import { useFeatureEnabled } from "../../hooks/use-feature-settings";

const SECTION_ICONS = { actions: Search, chats: MessageSquareText, characters: User } satisfies Record<
  PaletteSection,
  typeof Search
>;

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
    // Recents are a convenience; private windows may refuse storage.
  }
}

export function CommandPalette() {
  const { t } = useTranslation();
  const prepEnabled = useFeatureEnabled("gamePrepBoard");
  const tablesEnabled = useFeatureEnabled("randomTables");
  const open = useCommandPaletteStore((state) => state.paletteOpen);
  const close = useCommandPaletteStore((state) => state.closePalette);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState(readRecents);
  const chatsQuery = useChats();
  const charactersQuery = useAllCharacterCatalog(open);
  const { data: chats } = chatsQuery;
  const { data: characters } = charactersQuery;

  const commands = useMemo<PaletteCommand[]>(() => {
    const items: PaletteCommand[] = [
      {
        id: "action:open-characters",
        section: "actions",
        title: t("palette.actions.openCharacters"),
        run: async () => {
          await openEditorFromPalette(() => {
            const ui = useUIStore.getState();
            if (ui.hasAnyDetailOpen()) ui.closeAllDetails();
            ui.openRightPanel("characters");
          });
        },
      },
      {
        id: "action:open-prep-board",
        section: "actions",
        title: t("palette.actions.prepBoard"),
        run: () => openEditorFromPalette(() => openPrepBoard()),
      },
      {
        id: "action:open-random-tables",
        section: "actions",
        title: t("palette.actions.randomTables"),
        run: () => openEditorFromPalette(() => openRandomTables()),
      },
      {
        id: "action:search-all-chats",
        section: "actions",
        title: t("palette.actions.searchAllChats"),
        run: () => openGlobalSearch(),
      },
    ];
    for (const chat of (chats ?? []) as Chat[]) {
      items.push({
        id: `chat:${chat.id}`,
        section: "chats",
        title: chat.name || t("palette.untitled"),
        subtitle: t(`palette.modes.${chat.mode}`, { defaultValue: chat.mode }),
        run: () => openChatFromPalette(chat.id),
      });
    }
    for (const character of characters ?? []) {
      if (!character.id || !character.name?.trim()) continue;
      items.push({
        id: `character:${character.id}`,
        section: "characters",
        title: character.name,
        subtitle: t("palette.sections.characters"),
        run: () => openEditorFromPalette(() => useUIStore.getState().openCharacterDetail(character.id)),
      });
    }
    return items.filter(
      (item) =>
        (item.id !== "action:open-prep-board" || prepEnabled) &&
        (item.id !== "action:open-random-tables" || tablesEnabled),
    );
  }, [characters, chats, t, prepEnabled, tablesEnabled]);

  const results = useMemo(() => {
    const ranked = rankCommands(commands, query, recents, {
      emptyQueryFallback: (command) => command.section === "actions",
    });
    const text = query.trim();
    if (!text) return ranked;
    return [
      ...ranked,
      {
        id: "action:search-messages",
        section: "actions" as const,
        title: t("palette.actions.searchMessagesFor", { query: text }),
        run: () => openGlobalSearch(text),
      },
    ];
  }, [commands, query, recents, t]);

  useEffect(() => {
    setQuery("");
    setActive(0);
    setRecents(readRecents());
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-palette-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runCommand = useCallback(
    (command: PaletteCommand | undefined) => {
      if (!command) return;
      if (command.id !== "action:search-messages") {
        const next = pushRecent(recents, command.id);
        setRecents(next);
        writeRecents(next);
      }
      close();
      window.setTimeout(() => {
        void Promise.resolve()
          .then(() => command.run())
          .catch((error: unknown) => console.error("[command-palette] action failed", error));
      }, 0);
    },
    [close, recents],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length) setActive((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length) setActive((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runCommand(results[active]);
    }
  };

  const activeCommand = results[active];
  return (
    <Modal
      open={open}
      onClose={close}
      initialFocusRef={inputRef}
      title={t("palette.title")}
      width="max-w-xl"
      contentClassName="!p-0"
      panelClassName="self-start mt-[8vh] max-md:mt-2 [@media(max-height:500px)]:mt-0"
    >
      {open ? (
        <div className="flex min-h-0 flex-col">
          <label className="relative flex shrink-0 items-center border-b border-[var(--border)]/70">
            <Search
              size="0.9375rem"
              className="pointer-events-none absolute left-3 text-[var(--muted-foreground)]"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              autoFocus
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
          {chatsQuery.isError ? (
            <PanelErrorState
              message={t("palette.errors.chats")}
              onRetry={() => void chatsQuery.refetch()}
              retrying={chatsQuery.isFetching}
            />
          ) : null}
          {charactersQuery.isError ? (
            <PanelErrorState
              message={t("palette.errors.characters")}
              onRetry={() => void charactersQuery.refetch()}
              retrying={charactersQuery.isFetching}
            />
          ) : null}
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
                const Icon = SECTION_ICONS[command.section];
                return (
                  <button
                    key={command.id}
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
                      {command.subtitle ? (
                        <span className="block truncate text-[0.625rem] text-[var(--muted-foreground)]">
                          {command.subtitle}
                        </span>
                      ) : null}
                    </span>
                    {index === active ? (
                      <CornerDownLeft
                        size="0.75rem"
                        className="hidden shrink-0 text-[var(--muted-foreground)] sm:block"
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
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
      ) : null}
    </Modal>
  );
}
