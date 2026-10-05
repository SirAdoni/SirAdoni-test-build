// ──────────────────────────────────────────────
// Game: GM prep board
// A private, per-game planning board (Lazy DM style sections). Items can be
// checked off, linked to a card or lorebook entry, tagged, dragged (or moved
// with the arrow keys on their handle) within and across sections, archived,
// carried over to the next session, and dropped into the chat input as an OOC
// note. The board is never sent to the model.
// ──────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  GripVertical,
  Link2,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  SkipForward,
  Trash2,
  Upload,
  User,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  addPrepItem,
  addPrepSection,
  archiveUsedPrepItems,
  buildPrepBoardExport,
  carryOverPrepBoard,
  countPrepItems,
  mergePrepBoards,
  movePrepItem,
  movePrepSection,
  parsePrepBoardImport,
  prepSectionItems,
  prepSectionTitle,
  removePrepItem,
  removePrepSection,
  renamePrepSection,
  searchPrepBoard,
  setPrepItemArchived,
  setPrepItemDone,
  stepPrepItem,
  updatePrepItem,
  type PrepBoard,
  type PrepBoardItem,
  type PrepBoardLink,
  type PrepBoardPreset,
  type PrepBoardSection,
} from "@marinara-engine/shared";
import { cn, generateClientId } from "../../lib/utils";
import { api } from "../../lib/api-client";
import { showChoiceDialog, showConfirmDialog, showPromptDialog } from "../../lib/app-dialogs";
import { formatOocNote, insertIntoChatInput } from "../../lib/chat-input-insert";
import { openLorebookEntry } from "../../lib/lorebook-entry-focus";
import { useCharacters } from "../../hooks/use-characters";
import { usePrepBoard } from "../../hooks/use-prep-board";
import { useUIStore } from "../../stores/ui.store";

const FIELD_CLASS =
  "h-8 pointer-coarse:h-9 min-w-0 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40";
const ICON_BUTTON_CLASS =
  "flex h-7 w-7 pointer-coarse:h-9 pointer-coarse:w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50";
const SMALL_BUTTON_CLASS =
  "flex h-7 pointer-coarse:h-9 pointer-coarse:shrink-0 pointer-coarse:whitespace-nowrap items-center gap-1.5 rounded-md border border-border px-2.5 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-60";
const MENU_ITEM_CLASS =
  "flex w-full pointer-coarse:min-h-9 items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none";
const IMPORT_MAX_BYTES = 16 * 1024 * 1024;
const COLLAPSED_KEY = "marinara-prep-board-collapsed";

const PRESET_KEYS: Record<PrepBoardPreset, string> = {
  strong_start: "ui.prepBoard.presetStrongStart",
  scenes: "ui.prepBoard.presetScenes",
  secrets: "ui.prepBoard.presetSecrets",
  threads: "ui.prepBoard.presetThreads",
  npcs: "ui.prepBoard.presetNpcs",
  locations: "ui.prepBoard.presetLocations",
  treasure: "ui.prepBoard.presetTreasure",
  notes: "ui.prepBoard.presetNotes",
};

function readCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(value: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...value].slice(-200)));
  } catch {
    /* ignore */
  }
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFileName(value: string) {
  return (
    value
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "game"
  );
}

// ── Small popover menu ──

function MenuButton({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={ICON_BUTTON_CLASS}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-8 pointer-coarse:top-10 z-30 w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// ── Link picker ──

interface EntrySearchRow {
  id: string;
  lorebookId: string;
  name: string;
}

function LinkPicker({ onPick, onCancel }: { onPick: (link: PrepBoardLink) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<EntrySearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const { data: characterRows } = useCharacters();
  const characters = useMemo(
    () =>
      ((characterRows ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
        let name = typeof row.name === "string" ? row.name : "";
        if (!name && typeof row.data === "string") {
          try {
            const card = JSON.parse(row.data) as { name?: unknown };
            name = typeof card.name === "string" ? card.name : "";
          } catch {
            /* Incomplete imported record. */
          }
        }
        return typeof row.id === "string" && name ? [{ id: row.id, name }] : [];
      }),
    [characterRows],
  );
  const needle = query.trim().toLocaleLowerCase();
  const characterMatches = useMemo(
    () =>
      needle ? characters.filter((character) => character.name.toLocaleLowerCase().includes(needle)).slice(0, 8) : [],
    [characters, needle],
  );

  useEffect(() => {
    if (needle.length < 2) {
      setSearching(false);
      setEntries([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api
        .get<Array<{ id: string; lorebookId: string; name?: string }>>(
          `/lorebooks/search/entries?q=${encodeURIComponent(needle)}`,
        )
        .then((rows) => {
          if (cancelled) return;
          const byName = rows
            .filter((row) => row.id && row.lorebookId)
            .map((row) => ({ id: row.id, lorebookId: row.lorebookId, name: row.name?.trim() || row.id }))
            .sort(
              (left, right) =>
                Number(!left.name.toLocaleLowerCase().includes(needle)) -
                Number(!right.name.toLocaleLowerCase().includes(needle)),
            );
          setEntries(byName.slice(0, 8));
        })
        .catch(() => {
          if (!cancelled) setEntries([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      setSearching(false);
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [needle]);

  const empty = needle && characterMatches.length === 0 && entries.length === 0 && !searching;
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-background/60 p-2">
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onCancel();
            }
          }}
          placeholder={t("ui.prepBoard.linkSearch")}
          aria-label={t("ui.prepBoard.linkSearch")}
          className={cn(FIELD_CLASS, "flex-1")}
        />
        {searching && <Loader2 size={13} className="shrink-0 animate-spin text-muted-foreground" />}
        <button type="button" className={ICON_BUTTON_CLASS} onClick={onCancel} aria-label={t("ui.prepBoard.cancel")}>
          <X size={13} />
        </button>
      </div>
      {(characterMatches.length > 0 || entries.length > 0) && (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto">
          {characterMatches.map((character) => (
            <li key={`c-${character.id}`}>
              <button
                type="button"
                className={MENU_ITEM_CLASS}
                onClick={() => onPick({ kind: "character", id: character.id, label: character.name })}
              >
                <User size={12} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{character.name}</span>
                <span className="shrink-0 text-[0.625rem] pointer-coarse:text-[0.6875rem] text-muted-foreground">
                  {t("ui.prepBoard.linkCharacter")}
                </span>
              </button>
            </li>
          ))}
          {entries.map((entry) => (
            <li key={`e-${entry.id}`}>
              <button
                type="button"
                className={MENU_ITEM_CLASS}
                onClick={() =>
                  onPick({ kind: "lorebook_entry", id: entry.id, lorebookId: entry.lorebookId, label: entry.name })
                }
              >
                <BookOpen size={12} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="shrink-0 text-[0.625rem] pointer-coarse:text-[0.6875rem] text-muted-foreground">
                  {t("ui.prepBoard.linkEntry")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {empty && <p className="px-1 text-[0.6875rem] text-muted-foreground">{t("ui.prepBoard.linkNoMatches")}</p>}
      {!needle && <p className="px-1 text-[0.6875rem] text-muted-foreground">{t("ui.prepBoard.linkHint")}</p>}
    </div>
  );
}

// ── Item editor ──

function ItemEditor({
  item,
  onSave,
  onCancel,
}: {
  item: PrepBoardItem;
  onSave: (patch: { text: string; tags: string; link: PrepBoardLink | null }) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(item.text);
  const [tags, setTags] = useState(item.tags.join(", "));
  const [link, setLink] = useState<PrepBoardLink | null>(item.link);
  const [picking, setPicking] = useState(false);
  const save = () => {
    if (text.trim()) onSave({ text, tags, link });
  };
  return (
    <div
      className="space-y-2 rounded-md border border-border bg-card p-2"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !picking) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <textarea
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          }
        }}
        rows={3}
        aria-label={t("ui.prepBoard.itemText")}
        className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      />
      <input
        value={tags}
        onChange={(event) => setTags(event.target.value)}
        placeholder={t("ui.prepBoard.tagsPlaceholder")}
        aria-label={t("ui.prepBoard.tags")}
        className={cn(FIELD_CLASS, "w-full")}
      />
      {picking ? (
        <LinkPicker
          onPick={(picked) => {
            setLink(picked);
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      ) : (
        <div className="flex min-w-0 items-center gap-1.5">
          {link ? (
            <>
              <span className="flex min-w-0 items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[0.6875rem] text-foreground">
                {link.kind === "character" ? <User size={11} /> : <BookOpen size={11} />}
                <span className="truncate">{link.label || t("ui.prepBoard.linkUnnamed")}</span>
              </span>
              <button
                type="button"
                className={ICON_BUTTON_CLASS}
                onClick={() => setLink(null)}
                title={t("ui.prepBoard.unlink")}
                aria-label={t("ui.prepBoard.unlink")}
              >
                <X size={12} />
              </button>
            </>
          ) : null}
          <button type="button" className={SMALL_BUTTON_CLASS} onClick={() => setPicking(true)}>
            <Link2 size={12} />
            {link ? t("ui.prepBoard.changeLink") : t("ui.prepBoard.addLink")}
          </button>
        </div>
      )}
      <div className="flex justify-end gap-1.5">
        <button type="button" className={SMALL_BUTTON_CLASS} onClick={onCancel}>
          {t("ui.prepBoard.cancel")}
        </button>
        <button
          type="button"
          disabled={!text.trim()}
          className="flex h-7 pointer-coarse:h-9 items-center rounded-md bg-primary px-2.5 text-[0.6875rem] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          onClick={save}
        >
          {t("ui.prepBoard.save")}
        </button>
      </div>
    </div>
  );
}

// ── Item row ──

interface ItemActions {
  toggleDone: (item: PrepBoardItem) => void;
  step: (item: PrepBoardItem, direction: -1 | 1) => void;
  edit: (item: PrepBoardItem) => void;
  toInput: (item: PrepBoardItem) => void;
  archive: (item: PrepBoardItem, archived: boolean) => void;
  remove: (item: PrepBoardItem) => void;
  openLink: (link: PrepBoardLink) => void;
  searchTag: (tag: string) => void;
}

function ItemRow({
  item,
  actions,
  dragEnabled,
  moveLabel,
}: {
  item: PrepBoardItem;
  actions: ItemActions;
  dragEnabled: boolean;
  moveLabel: string;
}) {
  const { t } = useTranslation();
  const disabled = !dragEnabled || item.archived;
  const {
    setNodeRef: setDragRef,
    listeners,
    transform,
    isDragging,
  } = useDraggable({ id: `item:${item.id}`, disabled });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `before:${item.id}`, disabled: item.archived });
  const setRefs = useCallback(
    (node: HTMLLIElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );

  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      actions.step(item, event.key === "ArrowUp" ? -1 : 1);
    }
  };

  const meta: string[] = [];
  if (item.carried > 0) meta.push(t("ui.prepBoard.carriedCount", { count: item.carried }));
  if (item.done && item.usedSession !== null) meta.push(t("ui.prepBoard.usedIn", { session: item.usedSession }));

  return (
    <li
      ref={setRefs}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      className={cn(
        "group relative flex items-start gap-1 rounded-md border border-transparent px-1 py-1 transition-colors hover:border-border hover:bg-secondary/40",
        isOver &&
          !isDragging &&
          "before:absolute before:-top-px before:left-1 before:right-1 before:h-0.5 before:rounded before:bg-primary",
        isDragging && "z-20 border-border bg-card shadow-lg",
        item.archived && "opacity-60",
      )}
      data-prep-item-id={item.id}
    >
      {!item.archived ? (
        <button
          type="button"
          data-prep-handle={item.id}
          className="mt-0.5 pointer-coarse:mt-0 flex h-5 w-4 pointer-coarse:h-9 pointer-coarse:w-9 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 active:cursor-grabbing"
          title={moveLabel}
          aria-label={moveLabel}
          {...(disabled ? {} : listeners)}
          onKeyDown={onHandleKey}
        >
          <GripVertical size={12} />
        </button>
      ) : (
        <span className="w-4 pointer-coarse:w-9 shrink-0" />
      )}
      <label className="flex shrink-0 pointer-coarse:h-9 pointer-coarse:w-9 pointer-coarse:items-center pointer-coarse:justify-center">
        <input
          type="checkbox"
          checked={item.done}
          onChange={() => actions.toggleDone(item)}
          aria-label={t("ui.prepBoard.markUsed")}
          className="mt-1 h-3.5 w-3.5 shrink-0 accent-[var(--primary)] pointer-coarse:mt-0 pointer-coarse:h-4 pointer-coarse:w-4"
        />
      </label>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => actions.edit(item)}
          title={item.createdSession !== null ? t("ui.prepBoard.addedIn", { session: item.createdSession }) : undefined}
          className={cn(
            "block w-full pointer-coarse:min-h-9 pointer-coarse:py-2 whitespace-pre-wrap break-words rounded text-left text-xs leading-snug text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            item.done && "text-muted-foreground line-through decoration-muted-foreground/60",
          )}
        >
          {item.text}
        </button>
        {(item.link || item.tags.length > 0 || meta.length > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {item.link && (
              <button
                type="button"
                onClick={() => actions.openLink(item.link!)}
                className="flex max-w-full pointer-coarse:min-h-9 items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[0.625rem] pointer-coarse:text-[0.6875rem] text-foreground transition-colors hover:bg-secondary/70"
                title={t("ui.prepBoard.openLink")}
              >
                {item.link.kind === "character" ? <User size={10} /> : <BookOpen size={10} />}
                <span className="truncate">{item.link.label || t("ui.prepBoard.linkUnnamed")}</span>
              </button>
            )}
            {item.tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => actions.searchTag(tag)}
                className="rounded pointer-coarse:min-h-9 pointer-coarse:min-w-9 px-1 py-0.5 text-[0.625rem] pointer-coarse:text-[0.6875rem] text-primary transition-colors hover:bg-primary/10"
              >
                #{tag}
              </button>
            ))}
            {meta.length > 0 && (
              <span className="text-[0.625rem] pointer-coarse:text-[0.6875rem] text-muted-foreground">
                {meta.join(" · ")}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center opacity-100 sm:opacity-0 sm:transition-opacity sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
        {!item.archived && (
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={() => actions.toInput(item)}
            title={t("ui.prepBoard.toInput")}
            aria-label={t("ui.prepBoard.toInput")}
          >
            <MessageSquarePlus size={13} />
          </button>
        )}
        <MenuButton label={t("ui.prepBoard.itemMenu")}>
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM_CLASS}
                onClick={() => {
                  close();
                  actions.edit(item);
                }}
              >
                <Pencil size={12} />
                {t("ui.prepBoard.edit")}
              </button>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM_CLASS}
                onClick={() => {
                  close();
                  actions.archive(item, !item.archived);
                }}
              >
                {item.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                {item.archived ? t("ui.prepBoard.restore") : t("ui.prepBoard.archive")}
              </button>
              <button
                type="button"
                role="menuitem"
                className={cn(MENU_ITEM_CLASS, "text-destructive")}
                onClick={() => {
                  close();
                  actions.remove(item);
                }}
              >
                <Trash2 size={12} />
                {t("ui.prepBoard.delete")}
              </button>
            </>
          )}
        </MenuButton>
      </div>
    </li>
  );
}

function SectionEndDrop({ sectionId, active }: { sectionId: string; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `end:${sectionId}` });
  return (
    <li
      ref={setNodeRef}
      aria-hidden
      className={cn("h-2 rounded transition-colors", active && "h-4", isOver && "bg-primary/30")}
    />
  );
}

function AddItemInput({ sectionTitle, onAdd }: { sectionTitle: string; onAdd: (text: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const submit = () => {
    if (!value.trim()) return;
    onAdd(value);
    setValue("");
  };
  return (
    <div className="mt-1 flex items-center gap-1 pl-5">
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={t("ui.prepBoard.addItem")}
        aria-label={t("ui.prepBoard.addItemTo", { section: sectionTitle })}
        className={cn(FIELD_CLASS, "h-7 pointer-coarse:h-9 flex-1 border-dashed bg-transparent")}
      />
      {value.trim() && (
        <button type="button" className={ICON_BUTTON_CLASS} onClick={submit} aria-label={t("ui.prepBoard.add")}>
          <Plus size={13} />
        </button>
      )}
    </div>
  );
}

// ── Board ──

export function GamePrepBoard({
  chatId,
  variant = "panel",
  onNavigate,
}: {
  chatId: string | null;
  variant?: "panel" | "full";
  /** Called before opening a linked card or entry (the full-screen window closes itself). */
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const { data, isLoading, error, edit, removeBoard, retry } = usePrepBoard(chatId);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  const board = data?.board ?? null;
  const currentSession = data?.sessionNumber ?? null;
  const presetTitle = useCallback((preset: PrepBoardPreset) => t(PRESET_KEYS[preset]), [t]);
  const titleOf = useCallback(
    (section: PrepBoardSection) => prepSectionTitle(section, presetTitle) || t("ui.prepBoard.untitled"),
    [presetTitle, t],
  );
  const matches = useMemo(
    () => (board && query.trim() ? searchPrepBoard(board, query, presetTitle) : null),
    [board, presetTitle, query],
  );
  const counts = useMemo(() => (board ? countPrepItems(board) : { open: 0, done: 0, archived: 0 }), [board]);
  const now = () => new Date().toISOString();

  const focusHandle = (itemId: string) => {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-prep-handle="${CSS.escape(itemId)}"]`)?.focus();
    });
  };

  const toggleCollapsed = (sectionId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      writeCollapsed(next);
      return next;
    });
  };

  const actions: ItemActions = {
    toggleDone: (item) => edit((current) => setPrepItemDone(current, item.id, !item.done, currentSession, now())),
    step: (item, direction) => {
      const next = edit((current) => stepPrepItem(current, item.id, direction));
      if (!next) return;
      const moved = next.items.find((entry) => entry.id === item.id);
      const section = next.sections.find((entry) => entry.id === moved?.sectionId);
      if (moved && section) {
        const position = prepSectionItems(next, section.id).findIndex((entry) => entry.id === item.id) + 1;
        setAnnouncement(t("ui.prepBoard.movedTo", { section: titleOf(section), position }));
        if (collapsed.has(section.id)) toggleCollapsed(section.id);
      }
      focusHandle(item.id);
    },
    edit: (item) => setEditingId(item.id),
    toInput: (item) => {
      insertIntoChatInput(formatOocNote(item.text), chatId);
      toast.success(t("ui.prepBoard.insertedToInput"));
    },
    archive: (item, archived) => edit((current) => setPrepItemArchived(current, item.id, archived, now())),
    remove: async (item) => {
      const confirmed = await showConfirmDialog({
        title: t("ui.prepBoard.deleteItemTitle"),
        message: t("ui.prepBoard.deleteItemMessage"),
        confirmLabel: t("ui.prepBoard.delete"),
        tone: "destructive",
      });
      if (confirmed) edit((current) => removePrepItem(current, item.id));
    },
    openLink: (link) => {
      onNavigate?.();
      if (link.kind === "character") useUIStore.getState().openCharacterDetail(link.id);
      else if (link.lorebookId) openLorebookEntry(link.lorebookId, link.id);
    },
    searchTag: (tag) => setQuery(`#${tag}`),
  };

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(false);
    if (!board || !event.over) return;
    const itemId = String(event.active.id).replace(/^item:/, "");
    const overId = String(event.over.id);
    let next: PrepBoard | null = null;
    if (overId.startsWith("end:")) {
      const sectionId = overId.slice(4);
      next = edit((current) => movePrepItem(current, itemId, sectionId, Number.MAX_SAFE_INTEGER));
    } else if (overId.startsWith("before:")) {
      const targetId = overId.slice(7);
      if (targetId === itemId) return;
      const target = board.items.find((item) => item.id === targetId);
      if (!target) return;
      const index = prepSectionItems(board, target.sectionId)
        .filter((item) => item.id !== itemId)
        .findIndex((item) => item.id === targetId);
      next = edit((current) => movePrepItem(current, itemId, target.sectionId, index));
    }
    if (next) {
      const moved = next.items.find((item) => item.id === itemId);
      const section = next.sections.find((entry) => entry.id === moved?.sectionId);
      if (section) setAnnouncement(t("ui.prepBoard.movedToSection", { section: titleOf(section) }));
    }
  };

  const carryOver = async () => {
    if (!board) return;
    const target = board.session + 1;
    const confirmed = await showConfirmDialog({
      title: t("ui.prepBoard.carryOverTitle", { session: target }),
      message: t("ui.prepBoard.carryOverMessage", { open: counts.open, done: counts.done, session: target }),
      confirmLabel: t("ui.prepBoard.carryOver"),
    });
    if (!confirmed) return;
    let summary = { carried: 0, archived: 0 };
    edit((current) => {
      const result = carryOverPrepBoard(current, now());
      summary = { carried: result.carried, archived: result.archived };
      return result.board;
    });
    toast.success(t("ui.prepBoard.carriedOver", { ...summary, session: target }));
  };

  const archiveUsed = () => {
    let archived = 0;
    edit((current) => {
      const result = archiveUsedPrepItems(current, now());
      archived = result.archived;
      return result.board;
    });
    toast.success(t("ui.prepBoard.archivedCount", { count: archived }));
  };

  const addSection = async () => {
    const title = await showPromptDialog({
      title: t("ui.prepBoard.addSection"),
      message: t("ui.prepBoard.addSectionMessage"),
      placeholder: t("ui.prepBoard.sectionName"),
      confirmLabel: t("ui.prepBoard.add"),
    });
    if (title?.trim()) edit((current) => addPrepSection(current, generateClientId(), title));
  };

  const renameSection = async (section: PrepBoardSection) => {
    const title = await showPromptDialog({
      title: t("ui.prepBoard.renameSection"),
      message: t("ui.prepBoard.renameSectionMessage"),
      defaultValue: titleOf(section),
      placeholder: t("ui.prepBoard.sectionName"),
      confirmLabel: t("ui.prepBoard.save"),
    });
    if (title !== null) edit((current) => renamePrepSection(current, section.id, title));
  };

  const deleteSection = async (section: PrepBoardSection) => {
    if (!board) return;
    const itemCount = prepSectionItems(board, section.id, true).length;
    const others = board.sections.filter((entry) => entry.id !== section.id);
    let moveTo: string | undefined;
    if (itemCount > 0) {
      const choice = await showChoiceDialog({
        title: t("ui.prepBoard.deleteSectionTitle", { section: titleOf(section) }),
        message: t("ui.prepBoard.deleteSectionMessage", { count: itemCount }),
        choices: others.slice(0, 12).map((entry) => ({ key: entry.id, label: titleOf(entry) })),
        cancelLabel: t("ui.prepBoard.cancel"),
      });
      if (!choice) return;
      moveTo = choice;
    } else {
      const confirmed = await showConfirmDialog({
        title: t("ui.prepBoard.deleteSectionTitle", { section: titleOf(section) }),
        message: t("ui.prepBoard.deleteEmptySectionMessage"),
        confirmLabel: t("ui.prepBoard.delete"),
        tone: "destructive",
      });
      if (!confirmed) return;
    }
    edit((current) => removePrepSection(current, section.id, moveTo));
  };

  const exportBoard = () => {
    if (!board) return;
    const name = data?.chatName ?? "";
    downloadJson(`prep-board-${safeFileName(name)}.json`, buildPrepBoardExport(board, now(), name || undefined));
  };

  const importFile = async (file: File) => {
    if (!board) return;
    if (file.size > IMPORT_MAX_BYTES) {
      toast.error(t("ui.prepBoard.importTooLarge"));
      return;
    }
    let incoming: PrepBoard | null = null;
    try {
      incoming = parsePrepBoardImport(JSON.parse(await file.text()));
    } catch {
      incoming = null;
    }
    if (!incoming) {
      toast.error(t("ui.prepBoard.importInvalid"));
      return;
    }
    const choice = await showChoiceDialog({
      title: t("ui.prepBoard.importTitle"),
      message: t("ui.prepBoard.importMessage", { count: incoming.items.length }),
      choices: [
        { key: "merge", label: t("ui.prepBoard.importMerge") },
        { key: "replace", label: t("ui.prepBoard.importReplace"), tone: "destructive" },
      ],
      cancelLabel: t("ui.prepBoard.cancel"),
    });
    if (!choice) return;
    const source = incoming;
    if (choice === "replace") {
      edit(() => source);
      toast.success(t("ui.prepBoard.imported", { count: source.items.length }));
    } else {
      let added = 0;
      edit((current) => {
        const result = mergePrepBoards(current, source, generateClientId);
        added = result.added;
        return result.board;
      });
      toast.success(t("ui.prepBoard.imported", { count: added }));
    }
  };

  const deleteBoard = async () => {
    const confirmed = await showConfirmDialog({
      title: t("ui.prepBoard.deleteBoardTitle"),
      message: t("ui.prepBoard.deleteBoardMessage"),
      confirmLabel: t("ui.prepBoard.delete"),
      tone: "destructive",
    });
    if (!confirmed) return;
    try {
      await removeBoard();
      toast.success(t("ui.prepBoard.boardDeleted"));
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : t("ui.prepBoard.saveFailed"));
    }
  };

  if (!chatId) return <p className="text-xs text-muted-foreground">{t("ui.prepBoard.needsGame")}</p>;
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 size={13} className="animate-spin" />
        {t("ui.prepBoard.loading")}
      </div>
    );
  }
  if (error || !board) {
    return (
      <div className="space-y-2 text-xs" role="alert">
        <p className="text-muted-foreground">{t("ui.prepBoard.loadFailed")}</p>
        <button type="button" className={SMALL_BUTTON_CLASS} onClick={retry}>
          {t("ui.prepBoard.retry")}
        </button>
      </div>
    );
  }

  const searching = matches !== null;
  const visibleSections = board.sections.filter(
    (section) => !searching || prepSectionItems(board, section.id, showArchived).some((item) => matches.has(item.id)),
  );

  return (
    <div className="space-y-3">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">
            {t("ui.prepBoard.planning", { session: board.session })}
          </p>
          <p className="text-[0.625rem] pointer-coarse:text-[0.6875rem] text-muted-foreground">
            {t("ui.prepBoard.summary", { open: counts.open, done: counts.done })}
            {currentSession !== null && currentSession !== board.session
              ? t("ui.prepBoard.currentSession", { session: currentSession })
              : ""}
          </p>
        </div>
        <div className="flex items-center">
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={() => void carryOver()}
            title={t("ui.prepBoard.carryOverHint")}
            aria-label={t("ui.prepBoard.carryOver")}
          >
            <SkipForward size={13} />
          </button>
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={archiveUsed}
            disabled={counts.done === 0}
            title={t("ui.prepBoard.archiveUsed")}
            aria-label={t("ui.prepBoard.archiveUsed")}
          >
            <Archive size={13} />
          </button>
          <button
            type="button"
            className={cn(ICON_BUTTON_CLASS, showArchived && "bg-secondary text-foreground")}
            onClick={() => setShowArchived((value) => !value)}
            aria-pressed={showArchived}
            title={
              showArchived ? t("ui.prepBoard.hideArchived") : t("ui.prepBoard.showArchived", { count: counts.archived })
            }
            aria-label={
              showArchived ? t("ui.prepBoard.hideArchived") : t("ui.prepBoard.showArchived", { count: counts.archived })
            }
          >
            {showArchived ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <MenuButton label={t("ui.prepBoard.boardMenu")}>
            {(close) => (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM_CLASS}
                  onClick={() => {
                    close();
                    void addSection();
                  }}
                >
                  <Plus size={12} />
                  {t("ui.prepBoard.addSection")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM_CLASS}
                  onClick={() => {
                    close();
                    exportBoard();
                  }}
                >
                  <Download size={12} />
                  {t("ui.prepBoard.export")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM_CLASS}
                  onClick={() => {
                    close();
                    fileRef.current?.click();
                  }}
                >
                  <Upload size={12} />
                  {t("ui.prepBoard.import")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={cn(MENU_ITEM_CLASS, "text-destructive")}
                  onClick={() => {
                    close();
                    void deleteBoard();
                  }}
                >
                  <Trash2 size={12} />
                  {t("ui.prepBoard.deleteBoard")}
                </button>
              </>
            )}
          </MenuButton>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importFile(file);
            }}
          />
        </div>
      </div>

      <div className="relative">
        <Search
          size={12}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.stopPropagation();
              setQuery("");
            }
          }}
          placeholder={t("ui.prepBoard.search")}
          aria-label={t("ui.prepBoard.search")}
          className={cn(FIELD_CLASS, "w-full pl-7", query && "pr-7 pointer-coarse:pr-10")}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute right-1 pointer-coarse:right-0 top-1/2 flex h-6 w-6 pointer-coarse:h-9 pointer-coarse:w-9 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            aria-label={t("ui.prepBoard.clearSearch")}
          >
            <X size={12} />
          </button>
        )}
      </div>

      {searching && visibleSections.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("ui.prepBoard.noMatches")}</p>
      )}

      <DndContext
        sensors={sensors}
        onDragStart={() => setDragging(true)}
        onDragCancel={() => setDragging(false)}
        onDragEnd={onDragEnd}
      >
        <div className={cn(variant === "full" ? "grid gap-3 md:grid-cols-2 xl:grid-cols-3" : "space-y-2")}>
          {visibleSections.map((section, sectionIndex) => {
            const title = titleOf(section);
            const all = prepSectionItems(board, section.id, showArchived);
            const items = searching ? all.filter((item) => matches.has(item.id)) : all;
            const openCount = prepSectionItems(board, section.id).filter((item) => !item.done).length;
            const isCollapsed = !searching && collapsed.has(section.id);
            return (
              <section
                key={section.id}
                aria-label={title}
                className={cn("rounded-md", variant === "full" && "border border-border bg-card/40 p-2")}
              >
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(section.id)}
                    aria-expanded={!isCollapsed}
                    className="flex min-w-0 flex-1 pointer-coarse:min-h-9 items-center gap-1 rounded py-0.5 text-left text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <span className="truncate">{title}</span>
                    {openCount > 0 && (
                      <span className="ml-1 rounded bg-secondary px-1 text-[0.625rem] pointer-coarse:text-[0.6875rem] font-medium normal-case text-foreground">
                        {openCount}
                      </span>
                    )}
                  </button>
                  <MenuButton label={t("ui.prepBoard.sectionMenu", { section: title })}>
                    {(close) => (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM_CLASS}
                          onClick={() => {
                            close();
                            void renameSection(section);
                          }}
                        >
                          <Pencil size={12} />
                          {t("ui.prepBoard.renameSection")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={sectionIndex === 0 || searching}
                          className={cn(MENU_ITEM_CLASS, "disabled:opacity-50")}
                          onClick={() => {
                            close();
                            edit((current) => movePrepSection(current, section.id, -1));
                          }}
                        >
                          <ChevronDown size={12} className="rotate-180" />
                          {t("ui.prepBoard.moveSectionUp")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={sectionIndex === visibleSections.length - 1 || searching}
                          className={cn(MENU_ITEM_CLASS, "disabled:opacity-50")}
                          onClick={() => {
                            close();
                            edit((current) => movePrepSection(current, section.id, 1));
                          }}
                        >
                          <ChevronDown size={12} />
                          {t("ui.prepBoard.moveSectionDown")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={board.sections.length <= 1}
                          className={cn(MENU_ITEM_CLASS, "text-destructive disabled:opacity-50")}
                          onClick={() => {
                            close();
                            void deleteSection(section);
                          }}
                        >
                          <Trash2 size={12} />
                          {t("ui.prepBoard.deleteSection")}
                        </button>
                      </>
                    )}
                  </MenuButton>
                </div>
                {!isCollapsed && (
                  <>
                    <ul className="mt-0.5 space-y-0.5">
                      {items.map((item) =>
                        editingId === item.id ? (
                          <li key={item.id}>
                            <ItemEditor
                              item={item}
                              onCancel={() => setEditingId(null)}
                              onSave={(patch) => {
                                edit((current) => updatePrepItem(current, item.id, patch, now()));
                                setEditingId(null);
                              }}
                            />
                          </li>
                        ) : (
                          <ItemRow
                            key={item.id}
                            item={item}
                            actions={actions}
                            dragEnabled={!searching}
                            moveLabel={t("ui.prepBoard.moveHandle")}
                          />
                        ),
                      )}
                      {!searching && <SectionEndDrop sectionId={section.id} active={dragging} />}
                    </ul>
                    {!searching && (
                      <AddItemInput
                        sectionTitle={title}
                        onAdd={(text) =>
                          edit((current) =>
                            addPrepItem(current, {
                              id: generateClientId(),
                              sectionId: section.id,
                              text,
                              currentSession,
                              now: now(),
                            }),
                          )
                        }
                      />
                    )}
                  </>
                )}
              </section>
            );
          })}
        </div>
      </DndContext>
      <p className="text-[0.625rem] pointer-coarse:text-[0.6875rem] text-muted-foreground">
        {t("ui.prepBoard.privateNote")}
      </p>
    </div>
  );
}
