import { GameSceneTimeline } from "./GameSceneTimeline";
// ──────────────────────────────────────────────
// Game: Journal Viewer
//
// Browsable auto-journal panel showing
// NPC notes, locations, inventory, and events —
// all assembled from committed snapshots, no LLM.
// ──────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  X,
  MapPin,
  Swords,
  ScrollText,
  Package,
  Users,
  PenLine,
  BookOpen,
  Trash2,
  Loader2,
  Wand2,
  Check,
  Database,
  Search,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { api, ApiError } from "../../lib/api-client";
import { toast } from "sonner";
import { cleanNpcAvatarDisplayName, normalizeNpcAvatarName } from "../../lib/game-npc-avatar";
import {
  findJournalNpcMatchIndex,
  getJournalNpcPublicDescription,
  getJournalNpcPublicLocation,
  shouldShowJournalNpc,
} from "../../lib/game-journal-npcs";
import { applyInlineMarkdown, renderMarkdownBlocks } from "../../lib/markdown";
import { showConfirmDialog } from "../../lib/app-dialogs";
import { AnimatedText } from "./AnimatedText";
import { CharacterPhoto } from "../ui/CharacterPhoto";

import type { GameNpc } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";

interface JournalEntry {
  timestamp: string;
  type: "location" | "npc" | "combat" | "quest" | "item" | "event" | "note";
  title: string;
  content: string;
  readableType?: "note" | "book";
  sourceMessageId?: string;
  sourceSegmentIndex?: number;
}

interface QuestEntry {
  id: string;
  name: string;
  status: "active" | "completed" | "failed";
  description: string;
  objectives: string[];
}

export interface Journal {
  entries: JournalEntry[];
  quests: QuestEntry[];
  locations: string[];
  npcLog: Array<{ npcName: string; interactions: string[] }>;
  inventoryLog: Array<{
    item: string;
    action: "acquired" | "used" | "lost" | "removed";
    quantity: number;
    timestamp: string;
  }>;
}

interface GameJournalProps {
  chatId: string;
  npcs?: GameNpc[];
  onClose: () => void;
  onNpcPortraitClick?: (npcName: string, npcId?: string | null) => void;
  onNpcPortraitGenerate?: (npcName: string, npcId?: string | null) => void;
  onNpcPortraitLoadError?: (npcName: string, npcId?: string | null) => void;
  onNpcCharacterOpen?: (characterId: string) => void;
  npcPortraitGenerationEnabled?: boolean;
  generatingNpcPortraitNames?: Set<string>;
  onNpcRemove?: (npcId: string, npcName: string) => Promise<Journal | void> | Journal | void;
  embedded?: boolean;
  onOpenCampaignWiki?: () => void;
}

type TabId = "all" | "npcs" | "locations" | "inventory" | "library" | "notes" | "campaignWiki";

const TABS: Array<{ id: TabId; label: string; icon: typeof ScrollText }> = [
  { id: "all", label: "Timeline", icon: ScrollText },
  { id: "npcs", label: "NPCs", icon: Users },
  { id: "locations", label: "Map", icon: MapPin },
  { id: "inventory", label: "Items", icon: Package },
  { id: "library", label: "Library", icon: BookOpen },
  { id: "notes", label: "Notes", icon: PenLine },
  { id: "campaignWiki", label: "Campaign Wiki", icon: Database },
];

const TYPE_ICONS: Record<string, typeof ScrollText> = {
  location: MapPin,
  combat: Swords,
  quest: ScrollText,
  item: Package,
  npc: Users,
  event: ScrollText,
  note: ScrollText,
};

function isMobileGameViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

function normalizeNpcName(value: string): string {
  return normalizeNpcAvatarName(value);
}

function cleanNpcDisplayName(value: string): string {
  return cleanNpcAvatarDisplayName(value);
}

function normalizeNpcEntryTitle(value: string): string {
  const title = value.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return normalizeNpcName(cleanNpcDisplayName(title));
}

function dedupeNpcInteractions(interactions: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const interaction of interactions) {
    const trimmed = interaction.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    deduped.push(trimmed);
  }
  return deduped;
}

function isDuplicateInventoryEntry(
  left: { item: string; action: string; quantity: number; timestamp: string },
  right: { item: string; action: string; quantity: number; timestamp: string },
): boolean {
  if (normalizeNpcName(left.item) !== normalizeNpcName(right.item)) return false;
  if (left.action !== right.action || left.quantity !== right.quantity) return false;
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return true;
  return Math.abs(leftTime - rightTime) <= 10_000;
}

type JournalEntryExpectation = { timestamp?: string; type?: string; title?: string };

function entryExpectation(entry: JournalEntry): JournalEntryExpectation {
  return { timestamp: entry.timestamp, type: entry.type, title: entry.title };
}

function matchesExpectation(entry: JournalEntry, expected: JournalEntryExpectation): boolean {
  return (
    (expected.timestamp === undefined || entry.timestamp === expected.timestamp) &&
    (expected.type === undefined || entry.type === expected.type) &&
    (expected.title === undefined || entry.title === expected.title)
  );
}

function isEntryMovedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "JOURNAL_ENTRY_MOVED";
}

/** Lowercase, accent-free text used for journal search matching. */
function foldSearchText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

function entryKey(entry: JournalEntry, allEntries: JournalEntry[]): string {
  return String(allEntries.indexOf(entry)) + ":" + entry.timestamp;
}

function JournalMarkdown({ text, className }: { text: string; className?: string }) {
  const rendered = useMemo(() => renderMarkdownBlocks(text, applyInlineMarkdown, "game-journal"), [text]);
  return <div className={cn("mari-message-content whitespace-pre-wrap", className)}>{rendered}</div>;
}

function dedupeAdjacentInventoryEntries<
  T extends { item: string; action: string; quantity: number; timestamp: string },
>(items: T[]): T[] {
  const deduped: T[] = [];
  for (const item of items) {
    const previous = deduped[deduped.length - 1];
    if (previous && isDuplicateInventoryEntry(previous, item)) continue;
    deduped.push(item);
  }
  return deduped;
}

export function GameJournal({
  chatId,
  npcs,
  onClose,
  onNpcPortraitClick,
  onNpcPortraitGenerate,
  onNpcPortraitLoadError,
  onNpcCharacterOpen,
  npcPortraitGenerationEnabled = false,
  generatingNpcPortraitNames,
  onNpcRemove,
  onOpenCampaignWiki,
  embedded = false,
}: GameJournalProps) {
  const { t: localizeUi } = useUiTranslation();
  const [journal, setJournal] = useState<Journal | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("all");
  const [playerNotes, setPlayerNotes] = useState("");
  const [notesSaved, setNotesSaved] = useState(true);
  const [notesSaveFailed, setNotesSaveFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [removingNpcName, setRemovingNpcName] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<{
    index: number;
    expected: JournalEntryExpectation;
    title: string;
    content: string;
  } | null>(null);
  const [entrySaving, setEntrySaving] = useState(false);
  const [deletingEntryIndex, setDeletingEntryIndex] = useState<number | null>(null);
  const [entrySaveFailed, setEntrySaveFailed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const editReturnFocusRef = useRef<HTMLElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestNotesRef = useRef("");
  const npcRemovalPendingRef = useRef(false);

  useEffect(() => {
    let current = true;
    setLoadFailed(false);
    api
      .get<{ journal: Journal; playerNotes?: string }>(`/game/${chatId}/journal`)
      .then((res) => {
        if (!current) return;
        setJournal(res.journal);
        setPlayerNotes(res.playerNotes ?? "");
      })
      .catch(() => {
        if (current) setLoadFailed(true);
      });
    return () => {
      current = false;
    };
  }, [chatId, loadAttempt]);

  const saveNotes = useCallback(
    (text: string) => {
      api
        .put(`/game/${chatId}/notes`, { notes: text })
        .then(() => {
          setNotesSaved(true);
          setNotesSaveFailed(false);
        })
        // Shown in the notes header; the next change saves the whole text again.
        .catch(() => setNotesSaveFailed(true));
    },
    [chatId],
  );

  const handleNotesChange = useCallback(
    (text: string) => {
      setPlayerNotes(text);
      latestNotesRef.current = text;
      setNotesSaved(false);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => saveNotes(text), 800);
    },
    [saveNotes],
  );

  // Flush unsaved notes on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        saveNotes(latestNotesRef.current);
      }
    };
  }, [saveNotes]);

  const handleRemoveNpc = useCallback(
    async (npcId: string, npcName: string) => {
      if (!onNpcRemove || npcRemovalPendingRef.current) return;
      npcRemovalPendingRef.current = true;
      setRemovingNpcName(npcId);
      try {
        const updatedJournal = await onNpcRemove(npcId, npcName);
        if (updatedJournal) setJournal(updatedJournal);
      } catch {
        // The parent already showed the error toast.
      } finally {
        npcRemovalPendingRef.current = false;
        setRemovingNpcName(null);
      }
    },
    [onNpcRemove],
  );

  const beginEditingEntry = useCallback(
    (entry: JournalEntry) => {
      const index = journal?.entries.indexOf(entry) ?? -1;
      if (index < 0) return;
      setEntrySaveFailed(false);
      editReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setEditingEntry({ index, expected: entryExpectation(entry), title: entry.title, content: entry.content });
    },
    [journal],
  );

  const closeEntryEditor = useCallback(() => {
    setEditingEntry(null);
    const returnTo = editReturnFocusRef.current;
    editReturnFocusRef.current = null;
    if (returnTo?.isConnected) requestAnimationFrame(() => returnTo.focus());
  }, []);

  /** Reload only the journal (not player notes, which may have unsaved edits). */
  const reloadJournal = useCallback(async (): Promise<Journal | null> => {
    try {
      const res = await api.get<{ journal: Journal }>(`/game/${chatId}/journal`);
      setJournal(res.journal);
      return res.journal;
    } catch {
      return null;
    }
  }, [chatId]);

  const handleEntryMoved = useCallback(async () => {
    toast.error(localizeUi("ui.game.gamejournal.entryMoved"));
    return reloadJournal();
  }, [localizeUi, reloadJournal]);

  const saveJournalEntry = useCallback(async () => {
    if (!editingEntry || !editingEntry.title.trim() || entrySaving) return;
    setEntrySaving(true);
    setEntrySaveFailed(false);
    try {
      const result = await api.put<{ journal: Journal }>(`/game/${chatId}/journal/entries/${editingEntry.index}`, {
        title: editingEntry.title,
        content: editingEntry.content,
        expected: editingEntry.expected,
      });
      setJournal(result.journal);
      closeEntryEditor();
    } catch (error) {
      if (isEntryMovedError(error)) {
        const fresh = await handleEntryMoved();
        // Keep the user's text: point the editor at the entry's new position if it still exists.
        const newIndex = fresh
          ? fresh.entries.findIndex((entry) => matchesExpectation(entry, editingEntry.expected))
          : -1;
        if (newIndex >= 0) {
          setEditingEntry((current) => (current ? { ...current, index: newIndex } : current));
        } else {
          closeEntryEditor();
        }
      } else {
        setEntrySaveFailed(true);
      }
    } finally {
      setEntrySaving(false);
    }
  }, [chatId, closeEntryEditor, editingEntry, entrySaving, handleEntryMoved]);

  const deleteJournalEntry = useCallback(
    async (entry: JournalEntry) => {
      const index = journal?.entries.indexOf(entry) ?? -1;
      if (index < 0 || deletingEntryIndex !== null) return;
      const confirmed = await showConfirmDialog({
        title: localizeUi("ui.game.gamejournal.deleteJournalEntry"),
        message: localizeUi("ui.game.gamejournal.deleteJournalEntryConfirmation", { title: entry.title }),
        confirmLabel: localizeUi("ui.game.gamejournal.deleteEntry"),
        tone: "destructive",
      });
      if (!confirmed) return;

      setDeletingEntryIndex(index);
      try {
        // api.delete sends no body, so the expected entry goes in the query string.
        const params = new URLSearchParams({
          expectedTimestamp: entry.timestamp,
          expectedType: entry.type,
          expectedTitle: entry.title,
        });
        const result = await api.delete<{ journal: Journal }>(
          `/game/${chatId}/journal/entries/${index}?${params.toString()}`,
        );
        setJournal(result.journal);
        toast.success(localizeUi("ui.game.gamejournal.entryDeleted"));
      } catch (error) {
        if (isEntryMovedError(error)) {
          await handleEntryMoved();
        } else {
          toast.error(localizeUi("ui.game.gamejournal.entryDeleteFailed"));
        }
      } finally {
        setDeletingEntryIndex(null);
      }
    },
    [chatId, deletingEntryIndex, handleEntryMoved, journal, localizeUi],
  );

  const journalNpcs = useMemo(() => {
    const roster = npcs ?? [];
    const rosterNames = roster.map((npc) => npc.name);
    return roster.filter((npc) => shouldShowJournalNpc(npc, journal?.npcLog ?? [], rosterNames));
  }, [journal?.npcLog, npcs]);

  const trackedNpcNames = useMemo(() => {
    const names = new Set<string>();
    for (const npc of journalNpcs) {
      const key = normalizeNpcName(cleanNpcDisplayName(npc.name));
      if (key) names.add(key);
    }
    for (const entry of journal?.npcLog ?? []) {
      if (findJournalNpcMatchIndex(entry.npcName, journalNpcs) >= 0) {
        const key = normalizeNpcName(cleanNpcDisplayName(entry.npcName));
        if (key) names.add(key);
      }
    }
    return names;
  }, [journal?.npcLog, journalNpcs]);

  const visibleEntries = useMemo(
    () =>
      (journal?.entries ?? []).filter(
        (entry) => entry.type !== "npc" || trackedNpcNames.has(normalizeNpcEntryTitle(entry.title)),
      ),
    [journal?.entries, trackedNpcNames],
  );

  const foldedSearchQuery = useMemo(() => foldSearchText(searchQuery).trim(), [searchQuery]);
  const searchedEntries = useMemo(() => {
    if (!foldedSearchQuery) return visibleEntries;
    const terms = foldedSearchQuery.split(/\s+/).filter(Boolean);
    return visibleEntries.filter((entry) => {
      const haystack = foldSearchText(entry.title + "\n" + entry.content);
      return terms.every((term) => haystack.includes(term));
    });
  }, [foldedSearchQuery, visibleEntries]);
  const libraryEntries = useMemo(() => visibleEntries.filter((e) => e.type === "note"), [visibleEntries]);
  const searchedLibraryEntries = useMemo(() => searchedEntries.filter((e) => e.type === "note"), [searchedEntries]);

  if (!journal) {
    return (
      <div
        className={
          embedded
            ? "flex min-h-40 items-center justify-center"
            : "absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm"
        }
      >
        {loadFailed ? (
          <div className="flex flex-col items-center gap-2 text-sm text-[var(--muted-foreground)]">
            <p>{localizeUi("ui.game.gamejournal.loadFailed")}</p>
            <button
              type="button"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] hover:bg-[var(--accent)]"
            >
              {localizeUi("ui.game.contactBook.retry")}
            </button>
          </div>
        ) : (
          <div className="text-sm text-[var(--muted-foreground)]">
            {localizeUi("ui.game.gamejournal.loadingJournal")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={
        embedded
          ? "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-transparent"
          : "absolute inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-black/85 backdrop-blur-md"
      }
    >
      {/* Header */}
      {!embedded && (
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-bold text-white/90">{localizeUi("ui.game.gamejournal.adventureJournal")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={localizeUi("ui.game.gamejournal.closeJournal")}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Tabs — horizontally scrollable on mobile */}
      <div className="overflow-x-auto border-b border-white/10 px-4 py-2 scrollbar-hide [-webkit-overflow-scrolling:touch]">
        <div className="flex gap-1 w-max min-w-full">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  if (tab.id === "campaignWiki") {
                    onOpenCampaignWiki?.();
                    onClose();
                    return;
                  }
                  setActiveTab(tab.id);
                }}
                aria-pressed={activeTab === tab.id}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[0.625rem] font-medium transition-colors",
                  activeTab === tab.id
                    ? "bg-white/10 text-white/85"
                    : "text-white/50 hover:bg-white/5 hover:text-white/70",
                )}
              >
                <Icon size={12} />
                {tab.id === "campaignWiki" ? localizeUi("ui.game.campaignWiki.tab") : tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div
        data-game-journal-scroll
        className="relative min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain p-4 [-webkit-overflow-scrolling:touch]"
      >
        {activeTab === "all" && (
          <>
            <GameSceneTimeline chatId={chatId} />
            {visibleEntries.length > 0 && (
              <JournalSearchBox
                value={searchQuery}
                onChange={setSearchQuery}
                matchCount={searchedEntries.length}
                totalCount={visibleEntries.length}
              />
            )}
            {foldedSearchQuery && searchedEntries.length === 0 && visibleEntries.length > 0 ? (
              <div className="text-center text-xs text-white/40">
                {localizeUi("ui.game.gamejournal.noSearchMatches")}
              </div>
            ) : (
              <TimelineView
                entries={searchedEntries}
                onEdit={beginEditingEntry}
                onDelete={deleteJournalEntry}
                deletingEntryIndex={deletingEntryIndex}
                allEntries={journal.entries}
              />
            )}
          </>
        )}
        {activeTab === "npcs" && (
          <NpcsView
            npcLog={journal.npcLog}
            npcs={journalNpcs}
            onNpcPortraitClick={onNpcPortraitClick}
            onNpcPortraitGenerate={onNpcPortraitGenerate}
            onNpcPortraitLoadError={onNpcPortraitLoadError}
            onNpcCharacterOpen={onNpcCharacterOpen}
            npcPortraitGenerationEnabled={npcPortraitGenerationEnabled}
            generatingNpcPortraitNames={generatingNpcPortraitNames}
            onNpcRemove={onNpcRemove ? handleRemoveNpc : undefined}
            removingNpcName={removingNpcName}
          />
        )}
        {activeTab === "locations" && <LocationsView locations={journal.locations} />}
        {activeTab === "inventory" && <InventoryView items={journal.inventoryLog} />}
        {activeTab === "library" && (
          <>
            {libraryEntries.length > 0 && (
              <JournalSearchBox
                value={searchQuery}
                onChange={setSearchQuery}
                matchCount={searchedLibraryEntries.length}
                totalCount={libraryEntries.length}
              />
            )}
            {foldedSearchQuery && searchedLibraryEntries.length === 0 && libraryEntries.length > 0 ? (
              <div className="text-center text-xs text-white/40">
                {localizeUi("ui.game.gamejournal.noSearchMatches")}
              </div>
            ) : (
              <LibraryView
                entries={searchedLibraryEntries}
                onEdit={beginEditingEntry}
                onDelete={deleteJournalEntry}
                deletingEntryIndex={deletingEntryIndex}
                allEntries={journal.entries}
              />
            )}
          </>
        )}
        {activeTab === "notes" && (
          <NotesView notes={playerNotes} onChange={handleNotesChange} saved={notesSaved} failed={notesSaveFailed} />
        )}
      </div>

      {editingEntry && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="game-journal-edit-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (!entrySaving) closeEntryEditor();
              } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void saveJournalEntry();
              }
            }}
            className="flex max-h-full w-full max-w-xl flex-col gap-3 overflow-y-auto rounded-xl border border-white/15 bg-[var(--background)] p-3 shadow-2xl sm:p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 id="game-journal-edit-title" className="text-sm font-semibold text-[var(--foreground)]">
                {localizeUi("ui.game.gamejournal.editJournalEntry")}
              </h3>
              <button
                type="button"
                onClick={closeEntryEditor}
                disabled={entrySaving}
                aria-label={localizeUi("ui.game.gamejournal.cancelEntryEdit")}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-50"
              >
                <X size={14} />
              </button>
            </div>
            <label className="flex flex-col gap-1 text-xs text-[var(--muted-foreground)]">
              {localizeUi("ui.game.gamejournal.entryTitle")}
              <input
                value={editingEntry.title}
                onChange={(event) =>
                  setEditingEntry((current) => (current ? { ...current, title: event.target.value } : current))
                }
                readOnly={editingEntry.expected.type === "npc"}
                autoFocus={editingEntry.expected.type !== "npc"}
                maxLength={500}
                className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
              />
            </label>
            <label className="flex min-h-0 flex-1 flex-col gap-1 text-xs text-[var(--muted-foreground)]">
              {localizeUi("ui.game.gamejournal.entryContent")}
              <textarea
                value={editingEntry.content}
                onChange={(event) =>
                  setEditingEntry((current) => (current ? { ...current, content: event.target.value } : current))
                }
                maxLength={20_000}
                autoFocus={editingEntry.expected.type === "npc"}
                className="min-h-32 resize-y sm:min-h-48 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
              />
            </label>
            {entrySaveFailed && (
              <p className="text-xs text-[var(--destructive)]">{localizeUi("ui.game.gamejournal.entrySaveFailed")}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeEntryEditor}
                disabled={entrySaving}
                className="rounded-lg px-3 py-2 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-50"
              >
                {localizeUi("ui.game.gamejournal.cancelEntryEdit")}
              </button>
              <button
                type="button"
                onClick={() => void saveJournalEntry()}
                disabled={entrySaving || !editingEntry.title.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-2 text-xs font-semibold text-[var(--primary-foreground)] transition-opacity disabled:opacity-50"
              >
                {entrySaving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {entrySaving
                  ? localizeUi("ui.game.gamejournal.savingEntry")
                  : localizeUi("ui.game.gamejournal.saveEntry")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function JournalSearchBox({
  value,
  onChange,
  matchCount,
  totalCount,
}: {
  value: string;
  onChange: (value: string) => void;
  matchCount: number;
  totalCount: number;
}) {
  const { t: localizeUi } = useUiTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const active = value.trim().length > 0;
  return (
    <div className="mb-2 flex min-w-0 items-center gap-1.5 rounded-lg border border-white/10 bg-black/30 px-2 focus-within:border-white/25">
      <Search size={12} className="shrink-0 text-white/40" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Escape clears first; only an empty box lets Escape bubble up to close panels.
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
        placeholder={localizeUi("ui.game.gamejournal.searchEntries")}
        aria-label={localizeUi("ui.game.gamejournal.searchEntries")}
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent py-1.5 text-base text-white/80 outline-none placeholder:text-white/30 sm:text-xs [&::-webkit-search-cancel-button]:hidden"
      />
      {active && (
        <span className="shrink-0 text-[0.625rem] tabular-nums text-white/40" aria-live="polite">
          {localizeUi("ui.game.gamejournal.searchMatchCount", { shown: matchCount, total: totalCount })}
        </span>
      )}
      {active && (
        <button
          type="button"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          title={localizeUi("ui.game.gamejournal.clearSearch")}
          aria-label={localizeUi("ui.game.gamejournal.clearSearch")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function TimelineView({
  entries,
  onEdit,
  onDelete,
  deletingEntryIndex,
  allEntries,
}: {
  entries: JournalEntry[];
  onEdit: (entry: JournalEntry) => void;
  onDelete: (entry: JournalEntry) => void;
  deletingEntryIndex: number | null;
  allEntries: JournalEntry[];
}) {
  const { t: localizeUi } = useUiTranslation();
  if (entries.length === 0) {
    return (
      <div className="text-center text-xs text-white/40">{localizeUi("ui.game.timelineview.noJournalEntriesYet")}</div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {[...entries].reverse().map((entry) => {
        const Icon = TYPE_ICONS[entry.type] ?? ScrollText;
        return (
          <div
            key={entryKey(entry, allEntries)}
            className="group relative flex gap-3 rounded-lg border border-white/5 bg-white/3 px-3 py-2"
          >
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10">
              <Icon size={12} className="text-white/60" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="break-words pr-14 text-xs font-medium text-white/80">{entry.title}</div>
              <AnimatedText html={entry.content} className="mt-0.5 text-[0.625rem] text-white/50" />
            </div>
            <div className="absolute right-2 top-2 flex items-center gap-0.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
              <button
                type="button"
                onClick={() => onEdit(entry)}
                title={localizeUi("ui.game.gamejournal.editEntry")}
                aria-label={localizeUi("ui.game.gamejournal.editEntry")}
                className="flex h-6 w-6 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/10 hover:text-white"
              >
                <PenLine size={12} />
              </button>
              <button
                type="button"
                onClick={() => onDelete(entry)}
                disabled={deletingEntryIndex === allEntries.indexOf(entry)}
                title={localizeUi("ui.game.gamejournal.deleteEntry")}
                aria-label={localizeUi("ui.game.gamejournal.deleteEntry")}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--destructive)]/70 transition-colors hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)] disabled:opacity-40"
              >
                {deletingEntryIndex === allEntries.indexOf(entry) ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Trash2 size={12} />
                )}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Thresholds must match getReputationTier in packages/server/src/services/game/reputation.service.ts
function reputationLabel(rep: number): { text: string; color: string } {
  if (rep >= 80) return { text: "Devoted", color: "text-emerald-300" };
  if (rep >= 50) return { text: "Allied", color: "text-emerald-400" };
  if (rep >= 20) return { text: "Friendly", color: "text-green-400" };
  if (rep >= -20) return { text: "Neutral", color: "text-gray-400" };
  if (rep >= -50) return { text: "Unfriendly", color: "text-amber-400" };
  if (rep >= -80) return { text: "Hostile", color: "text-orange-400" };
  return { text: "Enemy", color: "text-red-400" };
}

function NpcsView({
  npcLog,
  npcs,
  onNpcPortraitClick,
  onNpcPortraitGenerate,
  onNpcPortraitLoadError,
  onNpcCharacterOpen,
  npcPortraitGenerationEnabled,
  generatingNpcPortraitNames,
  onNpcRemove,
  removingNpcName,
}: {
  npcLog: Array<{ npcName: string; interactions: string[] }>;
  npcs?: GameNpc[];
  onNpcPortraitClick?: (npcName: string, npcId?: string | null) => void;
  onNpcPortraitGenerate?: (npcName: string, npcId?: string | null) => void;
  onNpcPortraitLoadError?: (npcName: string, npcId?: string | null) => void;
  onNpcCharacterOpen?: (characterId: string) => void;
  npcPortraitGenerationEnabled?: boolean;
  generatingNpcPortraitNames?: Set<string>;
  onNpcRemove?: (npcId: string, npcName: string) => void;
  removingNpcName?: string | null;
}) {
  const { t: localizeUi } = useUiTranslation();
  const trackedNpcs = npcs ?? [];
  const hasContent = trackedNpcs.length > 0;
  const [mobilePortraitActionsNpc, setMobilePortraitActionsNpc] = useState<string | null>(null);

  const handleNpcPortraitAvatarClick = useCallback(
    (npc: GameNpc) => {
      if (isMobileGameViewport() && onNpcPortraitGenerate && npcPortraitGenerationEnabled === true) {
        const npcKey = npc.id?.trim() || `name:${normalizeNpcName(npc.name)}`;
        setMobilePortraitActionsNpc((current) => (current === npcKey ? null : npcKey));
        return;
      }

      onNpcPortraitClick?.(npc.name, npc.id);
    },
    [npcPortraitGenerationEnabled, onNpcPortraitClick, onNpcPortraitGenerate],
  );

  if (!hasContent) {
    return (
      <div className="text-center text-xs text-white/40">{localizeUi("ui.game.npcsview.noNpcsEncounteredYet")}</div>
    );
  }

  const npcMap = new Map<string, { npc: GameNpc; interactions: string[]; displayName: string; originalName: string }>();
  const npcIdsByName = new Map<string, string[]>();
  for (const [index, n] of trackedNpcs.entries()) {
    const displayName = cleanNpcDisplayName(n.name);
    const nameKey = normalizeNpcName(displayName);
    if (!nameKey) continue;
    const npcKey = n.id?.trim() || `name:${nameKey}:${index}`;
    npcMap.set(npcKey, { npc: n, interactions: [], displayName, originalName: n.name });
    npcIdsByName.set(nameKey, [...(npcIdsByName.get(nameKey) ?? []), npcKey]);
  }
  for (const entry of npcLog) {
    const displayName = cleanNpcDisplayName(entry.npcName);
    const nameKey = normalizeNpcName(displayName);
    if (!nameKey) continue;
    let matchingNpcIds = npcIdsByName.get(nameKey) ?? [];
    if (matchingNpcIds.length === 0) {
      const aliasIndex = findJournalNpcMatchIndex(entry.npcName, trackedNpcs);
      if (aliasIndex >= 0) {
        const aliasNpc = trackedNpcs[aliasIndex]!;
        const aliasDisplayName = cleanNpcDisplayName(aliasNpc.name);
        matchingNpcIds = npcIdsByName.get(normalizeNpcName(aliasDisplayName)) ?? [];
      }
    }
    if (matchingNpcIds.length !== 1) continue;
    const existing = npcMap.get(matchingNpcIds[0]!);
    const interactions = dedupeNpcInteractions(entry.interactions);
    if (existing) {
      existing.interactions = dedupeNpcInteractions([...existing.interactions, ...interactions]);
    }
  }
  const entries = [...npcMap.values()].sort((left, right) => {
    const repDelta = Math.abs(right.npc.reputation) - Math.abs(left.npc.reputation);
    if (repDelta !== 0) return repDelta;
    return left.displayName.localeCompare(right.displayName);
  });

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => {
        const name = cleanNpcDisplayName(entry.npc.name);
        const rep = reputationLabel(entry.npc.reputation);
        const showReputation = entry.npc.reputation !== 0;
        const canUploadPortrait = !!onNpcPortraitClick;
        const canGeneratePortrait = !!onNpcPortraitGenerate && npcPortraitGenerationEnabled === true;
        const portraitGenerating = generatingNpcPortraitNames?.has(normalizeNpcName(entry.npc.name)) ?? false;
        const publicDescription = getJournalNpcPublicDescription(entry.npc);
        const publicLocation = getJournalNpcPublicLocation(entry.npc);
        const portraitActionKey = entry.npc.id?.trim() || `name:${normalizeNpcName(entry.npc.name)}`;
        return (
          <div
            key={entry.npc.id || normalizeNpcName(name)}
            className="rounded-lg border border-white/5 bg-white/3 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              {canUploadPortrait ? (
                <div className="group/journal-avatar relative shrink-0">
                  {entry.npc.avatarUrl ? (
                    <CharacterPhoto
                      src={entry.npc.avatarUrl}
                      name={name}
                      className="rounded-full transition-transform hover:scale-[1.05] focus:outline-none focus:ring-2 focus:ring-white/20"
                      onUpdate={() => handleNpcPortraitAvatarClick(entry.npc)}
                      updateLabel={localizeUi("ui.game.npcsview.uploadOrReplaceNpcPortrait")}
                    >
                      <img
                        src={entry.npc.avatarUrl}
                        alt={name}
                        onError={() => onNpcPortraitLoadError?.(entry.npc.name, entry.npc.id)}
                        className="h-6 w-6 rounded-full object-cover ring-1 ring-white/10 transition-colors hover:ring-white/25"
                      />
                    </CharacterPhoto>
                  ) : (
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-[0.6rem] font-semibold text-white/60 ring-1 ring-white/10 transition-colors hover:ring-white/25">
                      {name[0]?.toUpperCase() ?? "?"}
                    </div>
                  )}
                  {canGeneratePortrait && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onNpcPortraitGenerate?.(entry.npc.name, entry.npc.id);
                      }}
                      disabled={portraitGenerating}
                      className={cn(
                        "absolute -right-1 -top-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-black/75 text-white/75 opacity-0 ring-1 ring-white/15 transition-opacity disabled:cursor-wait md:group-hover/journal-avatar:opacity-100",
                        (portraitGenerating || mobilePortraitActionsNpc === portraitActionKey) && "max-md:opacity-100",
                      )}
                      title={localizeUi("ui.game.npcsview.generateNpcPortrait")}
                    >
                      {portraitGenerating ? (
                        <Loader2 size="0.6rem" className="animate-spin" />
                      ) : (
                        <Wand2 size="0.6rem" />
                      )}
                    </button>
                  )}
                </div>
              ) : entry.npc.avatarUrl ? (
                <CharacterPhoto src={entry.npc.avatarUrl} name={name} className="h-6 w-6 shrink-0 rounded-full">
                  <img
                    src={entry.npc.avatarUrl}
                    alt={name}
                    onError={() => onNpcPortraitLoadError?.(entry.npc.name, entry.npc.id)}
                    className="h-full w-full rounded-full object-cover"
                  />
                </CharacterPhoto>
              ) : (
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[0.6rem] font-semibold text-white/60">
                  {name[0]?.toUpperCase() ?? "?"}
                </div>
              )}
              <span className="min-w-0 flex-1 break-words text-xs font-medium text-white/80">
                {entry.npc.emoji ? localizeUi("ui.game.npcsview.value1", { value1: entry.npc.emoji }) : ""}
                {name}
              </span>
              {showReputation && <span className={cn("text-[10px] font-medium", rep.color)}>{rep.text}</span>}
              {entry.npc.status === "dead" && (
                <span className="text-[10px] font-medium text-gray-400">{localizeUi("ui.game.npcsview.deceased")}</span>
              )}
              {entry.npc.characterId && onNpcCharacterOpen && (
                <button
                  type="button"
                  onClick={() => onNpcCharacterOpen(entry.npc.characterId!)}
                  title={localizeUi("ui.game.npcsview.openCharacterCard")}
                  aria-label={localizeUi("ui.game.npcsview.openCharacterCard")}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                >
                  <BookOpen size={12} />
                </button>
              )}
              {onNpcRemove && (
                <button
                  type="button"
                  onClick={() => onNpcRemove(entry.npc.id, entry.originalName)}
                  disabled={removingNpcName !== null}
                  title={localizeUi("ui.game.npcsview.removeThisNpcFromTheJournal")}
                  className="rounded p-1 text-white/35 transition-colors hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40"
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
            {publicDescription && <div className="mt-1 text-[0.6rem] text-white/40">{publicDescription}</div>}
            {publicLocation && <div className="mt-0.5 text-[0.6rem] text-white/30">📍 {publicLocation}</div>}
          </div>
        );
      })}
    </div>
  );
}

function LocationsView({ locations }: { locations: string[] }) {
  const { t: localizeUi } = useUiTranslation();
  if (locations.length === 0) {
    return (
      <div className="text-center text-xs text-white/40">
        {localizeUi("ui.game.locationsview.noLocationsDiscoveredYet")}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {locations.map((loc, i) => (
        <div key={i} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5">
          <MapPin size={10} className="text-white/40" />
          <span className="text-xs text-white/70">{loc}</span>
        </div>
      ))}
    </div>
  );
}

function InventoryView({
  items,
}: {
  items: Array<{
    item: string;
    action: "acquired" | "used" | "lost" | "removed";
    quantity: number;
    timestamp: string;
  }>;
}) {
  const { t: localizeUi } = useUiTranslation();
  const visibleItems = dedupeAdjacentInventoryEntries(items);

  if (visibleItems.length === 0) {
    return (
      <div className="text-center text-xs text-white/40">
        {localizeUi("ui.game.inventoryview.noItemsInInventoryLog")}
      </div>
    );
  }

  const actionColors: Record<string, string> = {
    acquired: "text-emerald-400",
    used: "text-amber-400",
    lost: "text-red-400",
    removed: "text-red-300",
  };

  return (
    <div className="flex flex-col gap-1">
      {[...visibleItems].reverse().map((item, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded-lg border border-white/5 bg-white/3 px-3 py-1.5"
        >
          <span className="text-xs text-white/70">
            {item.quantity > 1 ? localizeUi("ui.game.inventoryview.value1X", { value1: item.quantity }) : ""}
            {item.item}
          </span>
          <span className={cn("text-[0.625rem] font-medium", actionColors[item.action])}>{item.action}</span>
        </div>
      ))}
    </div>
  );
}

function LibraryView({
  entries,
  onEdit,
  onDelete,
  deletingEntryIndex,
  allEntries,
}: {
  entries: JournalEntry[];
  onEdit: (entry: JournalEntry) => void;
  onDelete: (entry: JournalEntry) => void;
  deletingEntryIndex: number | null;
  allEntries: JournalEntry[];
}) {
  const { t: localizeUi } = useUiTranslation();
  if (entries.length === 0) {
    return (
      <div className="text-center text-xs text-white/40">
        {localizeUi("ui.game.libraryview.noBooksOrNotesFoundYet")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {[...entries].reverse().map((entry) => {
        const isBook = entry.readableType === "book" || entry.title.toLowerCase() === "book";
        const text = entry.content;
        return (
          <div
            key={entryKey(entry, allEntries)}
            className="group relative rounded-lg border border-white/5 bg-white/3 px-3 py-2"
          >
            <div className="flex items-center gap-1.5">
              <BookOpen size={11} className={isBook ? "text-amber-400/70" : "text-blue-400/70"} />
              <span
                className={cn(
                  "text-[0.625rem] font-semibold uppercase tracking-wide",
                  isBook ? "text-amber-400/70" : "text-blue-400/70",
                )}
              >
                {isBook ? localizeUi("ui.game.libraryview.book") : localizeUi("ui.game.libraryview.note")}
              </span>
              <span className="ml-auto pr-14 text-[0.5625rem] text-white/30">{entry.timestamp}</span>
            </div>
            <JournalMarkdown text={text} className="mt-1.5 text-xs leading-relaxed text-white/70" />
            <div className="absolute right-2 top-2 flex items-center gap-0.5 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
              <button
                type="button"
                onClick={() => onEdit(entry)}
                title={localizeUi("ui.game.gamejournal.editEntry")}
                aria-label={localizeUi("ui.game.gamejournal.editEntry")}
                className="flex h-6 w-6 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/10 hover:text-white"
              >
                <PenLine size={12} />
              </button>
              <button
                type="button"
                onClick={() => onDelete(entry)}
                disabled={deletingEntryIndex === allEntries.indexOf(entry)}
                title={localizeUi("ui.game.gamejournal.deleteEntry")}
                aria-label={localizeUi("ui.game.gamejournal.deleteEntry")}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--destructive)]/70 transition-colors hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)] disabled:opacity-40"
              >
                {deletingEntryIndex === allEntries.indexOf(entry) ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Trash2 size={12} />
                )}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NotesView({
  notes,
  onChange,
  saved,
  failed,
}: {
  notes: string;
  onChange: (text: string) => void;
  saved: boolean;
  failed: boolean;
}) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[0.625rem] text-white/40">{localizeUi("ui.game.notesview.sentToGameMasterDisclosure")}</p>
        <span
          className={cn(
            "text-[0.5625rem] transition-opacity",
            failed ? "text-red-400/80" : saved ? "text-emerald-400/60" : "text-amber-400/60",
          )}
        >
          {failed
            ? localizeUi("ui.game.gamejournal.notesSaveFailed")
            : saved
              ? localizeUi("chat.settings.inlineEditor.saved")
              : localizeUi("ui.noodle.stageprofileform.saving")}
        </span>
      </div>
      <div className="grid min-h-0 flex-1 gap-2 md:grid-cols-2">
        <textarea
          value={notes}
          onChange={(e) => onChange(e.target.value)}
          maxLength={10_000}
          placeholder={localizeUi("ui.game.notesview.writeYourNotesHereTrackCluesPlansNpcNames")}
          className="min-h-44 resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-xs leading-relaxed text-white/80 outline-none placeholder:text-white/25 focus:border-white/20 md:min-h-0"
          spellCheck={false}
        />
        <div className="min-h-44 overflow-auto rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 md:min-h-0">
          {notes.trim() ? (
            <JournalMarkdown text={notes} className="text-xs leading-relaxed text-white/75" />
          ) : (
            <div className="text-xs text-white/30">{localizeUi("ui.game.notesview.nothingWrittenYet")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
