// ──────────────────────────────────────────────
// Game: Auto-Journal Service
//
// Builds a structured journal from committed game
// state snapshots — no LLM summarization needed.
// ──────────────────────────────────────────────

import { normalizeGameNpcIdentityName, type GameNpc } from "@marinara-engine/shared";
import { parseGameNpcStatusWord } from "./next-session-plan.js";

// ── Types ──

export interface JournalEntry {
  timestamp: string;
  type: "location" | "npc" | "combat" | "quest" | "item" | "event" | "note";
  title: string;
  content: string;
  readableType?: "note" | "book";
  sourceMessageId?: string;
  sourceSegmentIndex?: number;
}

export interface QuestEntry {
  id: string;
  name: string;
  status: "active" | "completed" | "failed";
  description: string;
  objectives: string[];
  discoveredAt: string;
  completedAt?: string;
}

export interface Journal {
  /** All chronological entries */
  entries: JournalEntry[];
  /** Active and completed quests */
  quests: QuestEntry[];
  /** Locations discovered */
  locations: string[];
  /** NPC interaction log */
  npcLog: Array<{ npcName: string; interactions: string[] }>;
  /** Inventory changes log */
  inventoryLog: Array<{
    item: string;
    action: "acquired" | "used" | "lost" | "removed";
    quantity: number;
    timestamp: string;
  }>;
}

function getReadableEntryKey(title: string, content: string): string {
  return `${title.replace(/\r\n/g, "\n").trim()}\u0000${content.replace(/\r\n/g, "\n").trim()}`;
}

function normalizeReadableTitle(title: string, readableType?: "note" | "book"): string {
  const trimmed = title.trim();
  if (trimmed) return trimmed;
  return readableType === "book" ? "Book" : "Note";
}

function normalizeReadableType(title: string, readableType?: "note" | "book"): "note" | "book" {
  if (readableType === "book" || readableType === "note") return readableType;
  return title.trim().toLowerCase() === "book" ? "book" : "note";
}

// ── Builder Functions ──

/** Create an empty journal. */
export function createJournal(): Journal {
  return {
    entries: [],
    quests: [],
    locations: [],
    npcLog: [],
    inventoryLog: [],
  };
}

/** Remove name-keyed journal history only when no same-named NPC identity remains tracked. */
export function pruneGameNpcJournal(journal: Journal, npcName: string): Journal {
  const target = normalizeGameNpcIdentityName(npcName);
  if (!target) return journal;

  return {
    ...journal,
    npcLog: journal.npcLog.filter((entry) => normalizeGameNpcIdentityName(entry.npcName) !== target),
    entries: journal.entries.filter(
      (entry) => entry.type !== "npc" || normalizeGameNpcIdentityName(entry.title) !== target,
    ),
  };
}

function gameNpcJournalEntryKey(entry: JournalEntry): string {
  return JSON.stringify([
    entry.timestamp,
    entry.type,
    entry.title,
    entry.content,
    entry.readableType ?? null,
    entry.sourceMessageId ?? null,
    entry.sourceSegmentIndex ?? null,
  ]);
}

/** Restore only NPC history removed by a sync result that became stale after persistence. */
export function restorePrunedGameNpcJournal(current: Journal, previous: Journal, npcNames: readonly string[]): Journal {
  const targets = new Set(npcNames.map(normalizeGameNpcIdentityName).filter(Boolean));
  if (targets.size === 0) return current;

  let changed = false;
  const npcLog = current.npcLog.map((entry) => ({ ...entry, interactions: [...entry.interactions] }));
  for (const previousEntry of previous.npcLog) {
    const normalizedName = normalizeGameNpcIdentityName(previousEntry.npcName);
    if (!targets.has(normalizedName)) continue;
    const currentIndex = npcLog.findIndex((entry) => normalizeGameNpcIdentityName(entry.npcName) === normalizedName);
    if (currentIndex < 0) {
      npcLog.push({ ...previousEntry, interactions: [...previousEntry.interactions] });
      changed = true;
      continue;
    }
    const currentEntry = npcLog[currentIndex]!;
    const interactions = [...previousEntry.interactions];
    for (const interaction of currentEntry.interactions) {
      if (!interactions.includes(interaction)) interactions.push(interaction);
    }
    if (interactions.length !== currentEntry.interactions.length) {
      npcLog[currentIndex] = { ...currentEntry, interactions };
      changed = true;
    }
  }

  const entryKeys = new Set(current.entries.map(gameNpcJournalEntryKey));
  const entries = [...current.entries];
  for (const previousEntry of previous.entries) {
    if (
      previousEntry.type !== "npc" ||
      !targets.has(normalizeGameNpcIdentityName(previousEntry.title)) ||
      entryKeys.has(gameNpcJournalEntryKey(previousEntry))
    ) {
      continue;
    }
    entries.push(previousEntry);
    entryKeys.add(gameNpcJournalEntryKey(previousEntry));
    changed = true;
  }
  if (!changed) return current;
  entries.sort((left, right) => {
    const leftTime = Date.parse(left.timestamp);
    const rightTime = Date.parse(right.timestamp);
    return Number.isFinite(leftTime) && Number.isFinite(rightTime) ? leftTime - rightTime : 0;
  });
  return { ...current, entries, npcLog };
}

export interface GameNpcJournalRemovalPatch extends Record<string, unknown> {
  gameNpcs: GameNpc[];
  gameJournal: Journal;
  gameIgnoredNpcIds: string[];
}

/** Build an exact-identity NPC removal against metadata read inside the storage write queue. */
export function buildGameNpcJournalRemovalPatch(
  metadata: Record<string, unknown>,
  npcId: string,
): GameNpcJournalRemovalPatch {
  const normalizedNpcId = npcId.trim();
  const currentNpcs = Array.isArray(metadata.gameNpcs) ? (metadata.gameNpcs as GameNpc[]) : [];
  const removedNpc = currentNpcs.find((npc) => npc.id === normalizedNpcId);
  const gameNpcs = currentNpcs.filter((npc) => npc.id !== normalizedNpcId);
  const currentJournal = (metadata.gameJournal as Journal | null) ?? createJournal();
  const removedName = normalizeGameNpcIdentityName(removedNpc?.name);
  const sameNameStillTracked =
    !!removedName && gameNpcs.some((npc) => normalizeGameNpcIdentityName(npc.name) === removedName);
  const gameIgnoredNpcIds = new Set(
    Array.isArray(metadata.gameIgnoredNpcIds)
      ? (metadata.gameIgnoredNpcIds as unknown[]).filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [],
  );
  gameIgnoredNpcIds.add(normalizedNpcId);

  return {
    gameNpcs,
    gameJournal:
      removedNpc && !sameNameStillTracked ? pruneGameNpcJournal(currentJournal, removedNpc.name) : currentJournal,
    gameIgnoredNpcIds: [...gameIgnoredNpcIds],
  };
}

/** Add a location discovery to the journal. */
export function addLocationEntry(journal: Journal, location: string, description: string = ""): Journal {
  if (journal.locations.includes(location)) return journal;

  return {
    ...journal,
    locations: [...journal.locations, location],
    entries: [
      ...journal.entries,
      {
        timestamp: new Date().toISOString(),
        type: "location",
        title: `Discovered: ${location}`,
        content: description || `The party arrived at ${location}.`,
      },
    ],
  };
}

/** Add an NPC interaction to the journal. */
export function addNpcEntry(journal: Journal, npc: GameNpc, interaction: string): Journal {
  const normalizedInteraction = interaction.trim();
  if (!normalizedInteraction) return journal;

  const existing = journal.npcLog.find((n) => n.npcName === npc.name);
  const updatedLog = existing
    ? journal.npcLog.map((n) =>
        n.npcName === npc.name && !n.interactions.includes(normalizedInteraction)
          ? { ...n, interactions: [...n.interactions, normalizedInteraction] }
          : n,
      )
    : [...journal.npcLog, { npcName: npc.name, interactions: [normalizedInteraction] }];

  const hasEntry = journal.entries.some(
    (entry) =>
      entry.type === "npc" && entry.title === `${npc.emoji} ${npc.name}` && entry.content === normalizedInteraction,
  );

  return {
    ...journal,
    npcLog: updatedLog,
    entries: hasEntry
      ? journal.entries
      : [
          ...journal.entries,
          {
            timestamp: new Date().toISOString(),
            type: "npc",
            title: `${npc.emoji} ${npc.name}`,
            content: normalizedInteraction,
          },
        ],
  };
}

const SYNTHETIC_TRACKED_INTERACTION = /^Tracked(?: at (.+))?\.$/u;

/**
 * The synthetic "Tracked" line for an NPC's current state, or null when none should exist.
 * A dead NPC gets no tracked line, and a status word is never written as a place.
 */
export function buildNpcTrackedInteraction(npc: GameNpc): string | null {
  if (npc.status === "dead") return null;
  const location = npc.location?.trim();
  if (!location || location.toLowerCase() === "unknown") return "Tracked.";
  const locationStatus = parseGameNpcStatusWord(location);
  if (locationStatus === "dead") return null;
  return locationStatus ? "Tracked." : `Tracked at ${location}.`;
}

function isStatusWordTrackedLine(content: string): boolean {
  const match = SYNTHETIC_TRACKED_INTERACTION.exec(content.trim());
  return !!match?.[1] && parseGameNpcStatusWord(match[1]) !== null;
}

/**
 * Keep each NPC's synthetic "Tracked" line in step with its current location and status.
 * Stale tracked lines are replaced in the NPC log rather than accumulated, a dead NPC keeps none,
 * and legacy lines that recorded a status word as a place ("Tracked at Deceased.") are dropped.
 * Chronological entries for genuine past locations stay as history.
 */
export function reconcileNpcTrackedEntries(journal: Journal, npcs: readonly GameNpc[]): Journal {
  let next = journal;
  if (next.entries.some((entry) => entry.type === "npc" && isStatusWordTrackedLine(entry.content))) {
    next = {
      ...next,
      entries: next.entries.filter((entry) => entry.type !== "npc" || !isStatusWordTrackedLine(entry.content)),
    };
  }
  for (const npc of npcs) {
    const interaction = buildNpcTrackedInteraction(npc);
    const isStale = (line: string) => SYNTHETIC_TRACKED_INTERACTION.test(line.trim()) && line.trim() !== interaction;
    if (next.npcLog.some((entry) => entry.npcName === npc.name && entry.interactions.some(isStale))) {
      next = {
        ...next,
        npcLog: next.npcLog.map((entry) =>
          entry.npcName === npc.name
            ? { ...entry, interactions: entry.interactions.filter((line) => !isStale(line)) }
            : entry,
        ),
      };
    }
    if (!interaction) continue;
    const hasInteraction = next.npcLog.some(
      (entry) => entry.npcName === npc.name && entry.interactions.includes(interaction),
    );
    if (!hasInteraction) next = addNpcEntry(next, npc, interaction);
  }
  return next;
}

/**
 * Drop journal entries whose source message was removed from the live transcript or replaced by a
 * regenerated swipe. Returns null when nothing matched, so callers can skip the write.
 */
export function pruneJournalSourceMessages(journal: unknown, messageIds: readonly string[]): Journal | null {
  if (!journal || typeof journal !== "object" || messageIds.length === 0) return null;
  const current = journal as Journal;
  if (!Array.isArray(current.entries)) return null;
  const removed = new Set(messageIds);
  const entries = current.entries.filter((entry) => !entry?.sourceMessageId || !removed.has(entry.sourceMessageId));
  return entries.length === current.entries.length ? null : { ...current, entries };
}

/** Add a combat event to the journal. */
export function addCombatEntry(journal: Journal, description: string, outcome: "victory" | "defeat" | "fled"): Journal {
  return {
    ...journal,
    entries: [
      ...journal.entries,
      {
        timestamp: new Date().toISOString(),
        type: "combat",
        title: `Combat: ${outcome}`,
        content: description,
      },
    ],
  };
}

/** Add or update a quest in the journal. */
export function upsertQuest(
  journal: Journal,
  quest: Omit<QuestEntry, "discoveredAt"> & { discoveredAt?: string },
): Journal {
  const existing = journal.quests.find((q) => q.id === quest.id);

  if (existing) {
    const updated = journal.quests.map((q) =>
      q.id === quest.id
        ? {
            ...q,
            name: quest.name || q.name,
            status: quest.status,
            description: quest.description || q.description,
            objectives: quest.objectives.length > 0 ? quest.objectives : q.objectives,
            completedAt: quest.status === "completed" ? new Date().toISOString() : q.completedAt,
          }
        : q,
    );
    return { ...journal, quests: updated };
  }

  const newQuest: QuestEntry = {
    ...quest,
    discoveredAt: quest.discoveredAt ?? new Date().toISOString(),
  };

  return {
    ...journal,
    quests: [...journal.quests, newQuest],
    entries: [
      ...journal.entries,
      {
        timestamp: new Date().toISOString(),
        type: "quest",
        title: `Quest: ${quest.name}`,
        content: quest.description,
      },
    ],
  };
}

/** Add an inventory change. */
export function addInventoryEntry(
  journal: Journal,
  item: string,
  action: "acquired" | "used" | "lost" | "removed",
  quantity: number = 1,
): Journal {
  const normalizedItem = typeof item === "string" ? item.trim() : "";
  if (!normalizedItem) return journal;

  const now = new Date();
  const lastEntry = journal.inventoryLog[journal.inventoryLog.length - 1];
  if (lastEntry) {
    const lastTime = Date.parse(lastEntry.timestamp);
    const isRecentDuplicate =
      lastEntry.item.trim().toLowerCase() === normalizedItem.toLowerCase() &&
      lastEntry.action === action &&
      lastEntry.quantity === quantity &&
      Number.isFinite(lastTime) &&
      now.getTime() - lastTime <= 10_000;
    if (isRecentDuplicate) return journal;
  }

  const actionLabel =
    action === "acquired" ? "Found" : action === "used" ? "Used" : action === "removed" ? "Removed" : "Lost";

  return {
    ...journal,
    inventoryLog: [...journal.inventoryLog, { item: normalizedItem, action, quantity, timestamp: now.toISOString() }],
    entries: [
      ...journal.entries,
      {
        timestamp: now.toISOString(),
        type: "item",
        title: `${actionLabel}: ${normalizedItem}`,
        content: `${quantity}x ${normalizedItem} ${action}.`,
      },
    ],
  };
}

/** Add a general event entry. */
export function addEventEntry(journal: Journal, title: string, content: string): Journal {
  return {
    ...journal,
    entries: [...journal.entries, { timestamp: new Date().toISOString(), type: "event", title, content }],
  };
}

/** Add or update a readable note or book entry (shown in the Library tab). */
export function addNoteEntry(
  journal: Journal,
  title: string,
  content: string,
  options: {
    readableType?: "note" | "book";
    sourceMessageId?: string;
    sourceSegmentIndex?: number;
  } = {},
): Journal {
  const readableType = normalizeReadableType(title, options.readableType);
  const normalizedTitle = normalizeReadableTitle(title, readableType);
  const normalizedContent = content.replace(/\r\n/g, "\n").trim();
  const sourceMessageId =
    typeof options.sourceMessageId === "string" && options.sourceMessageId.trim()
      ? options.sourceMessageId.trim()
      : undefined;
  const sourceSegmentIndex = Number.isInteger(options.sourceSegmentIndex) ? options.sourceSegmentIndex : undefined;

  const updateExistingEntry = (matcher: (entry: JournalEntry) => boolean): Journal | null => {
    const existingIndex = journal.entries.findIndex((entry) => entry.type === "note" && matcher(entry));
    if (existingIndex < 0) return null;

    const existingEntry = journal.entries[existingIndex]!;
    if (
      existingEntry.title === normalizedTitle &&
      existingEntry.content === normalizedContent &&
      existingEntry.readableType === readableType &&
      existingEntry.sourceMessageId === sourceMessageId &&
      existingEntry.sourceSegmentIndex === sourceSegmentIndex
    ) {
      return journal;
    }

    const nextEntries = [...journal.entries];
    nextEntries[existingIndex] = {
      ...existingEntry,
      title: normalizedTitle,
      content: normalizedContent,
      readableType,
      ...(sourceMessageId ? { sourceMessageId } : {}),
      ...(sourceSegmentIndex != null ? { sourceSegmentIndex } : {}),
    };

    return { ...journal, entries: nextEntries };
  };

  if (sourceMessageId && sourceSegmentIndex != null) {
    const bySource = updateExistingEntry(
      (entry) => entry.sourceMessageId === sourceMessageId && entry.sourceSegmentIndex === sourceSegmentIndex,
    );
    if (bySource) return bySource;
  }

  const nextKey = getReadableEntryKey(normalizedTitle, normalizedContent);
  const byContent = updateExistingEntry((entry) => getReadableEntryKey(entry.title, entry.content) === nextKey);
  if (byContent) return byContent;

  const seenReadableKeys = new Set<string>();
  let removedDuplicates = false;
  const dedupedEntries = journal.entries.filter((entry) => {
    if (entry.type !== "note") return true;
    const key = getReadableEntryKey(entry.title, entry.content);
    if (seenReadableKeys.has(key)) {
      removedDuplicates = true;
      return false;
    }
    seenReadableKeys.add(key);
    return true;
  });

  if (seenReadableKeys.has(nextKey)) {
    return removedDuplicates ? { ...journal, entries: dedupedEntries } : journal;
  }

  return {
    ...journal,
    entries: [
      ...dedupedEntries,
      {
        timestamp: new Date().toISOString(),
        type: "note",
        title: normalizedTitle,
        content: normalizedContent,
        readableType,
        ...(sourceMessageId ? { sourceMessageId } : {}),
        ...(sourceSegmentIndex != null ? { sourceSegmentIndex } : {}),
      },
    ],
  };
}

/**
 * Build a structured session recap from journal data.
 * This replaces the LLM-based session summary for deterministic recaps.
 */
export function buildStructuredRecap(journal: Journal, sessionNumber: number): string {
  const sections: string[] = [`Session ${sessionNumber} Recap:`];

  // Locations
  if (journal.locations.length > 0) {
    sections.push(`\nLocations visited: ${journal.locations.join(", ")}`);
  }

  // Quest progress
  const activeQuests = journal.quests.filter((q) => q.status === "active");
  const completedQuests = journal.quests.filter((q) => q.status === "completed");
  if (completedQuests.length > 0) {
    sections.push(`\nCompleted quests: ${completedQuests.map((q) => q.name).join(", ")}`);
  }
  if (activeQuests.length > 0) {
    sections.push(`\nActive quests: ${activeQuests.map((q) => q.name).join(", ")}`);
  }

  // NPC interactions
  if (journal.npcLog.length > 0) {
    sections.push("\nKey NPC interactions:");
    for (const npc of journal.npcLog) {
      const latest = npc.interactions[npc.interactions.length - 1];
      sections.push(`  - ${npc.npcName}: ${latest}`);
    }
  }

  // Combat events
  const combatEntries = journal.entries.filter((e) => e.type === "combat");
  if (combatEntries.length > 0) {
    sections.push(`\nCombat encounters: ${combatEntries.length}`);
    for (const entry of combatEntries.slice(-3)) {
      sections.push(`  - ${entry.content}`);
    }
  }

  // Notable items
  const acquiredItems = journal.inventoryLog.filter((i) => i.action === "acquired");
  if (acquiredItems.length > 0) {
    sections.push(`\nItems acquired: ${acquiredItems.map((i) => `${i.quantity}x ${i.item}`).join(", ")}`);
  }

  return sections.join("\n");
}
