// ──────────────────────────────────────────────
// Lorebook: Activation Backlinks and Stale Entries
// Pure helpers behind the activation statistics: the small bounded list of
// chats each entry fired in, and the "stale entries" finder (entries that did
// not fire in the last N days while their lorebook was firing).
// ──────────────────────────────────────────────

/** How many chats one entry remembers. The least recently fired chat drops off first. */
export const MAX_RECENT_CHATS_PER_ENTRY = 20;

export interface LorebookEntryRecentChat {
  chatId: string;
  /** Generations in this chat that injected the entry (0 when only known from pre-backlink stats). */
  count: number;
  lastActivatedAt: string | null;
}

/**
 * Read the stored recent-chats list. Tolerates rows written before the column
 * existed: a missing or broken value falls back to the old single lastChatId.
 */
export function parseRecentChats(
  raw: unknown,
  legacy?: { lastChatId?: string | null; lastActivatedAt?: string | null },
): LorebookEntryRecentChat[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const result: LorebookEntryRecentChat[] = [];
  const seen = new Set<string>();
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const chatId = (item as { chatId?: unknown }).chatId;
      if (typeof chatId !== "string" || !chatId || seen.has(chatId)) continue;
      const count = Number((item as { count?: unknown }).count);
      const at = (item as { lastActivatedAt?: unknown }).lastActivatedAt;
      seen.add(chatId);
      result.push({
        chatId,
        count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
        lastActivatedAt: typeof at === "string" && at ? at : null,
      });
    }
    return sortRecentChats(result).slice(0, MAX_RECENT_CHATS_PER_ENTRY);
  }
  if (legacy?.lastChatId) {
    return [{ chatId: legacy.lastChatId, count: 0, lastActivatedAt: legacy.lastActivatedAt ?? null }];
  }
  return [];
}

/** Add new per-chat counts to an existing list, newest first, capped. */
export function mergeRecentChats(
  existing: readonly LorebookEntryRecentChat[],
  additions: ReadonlyMap<string, { count: number; lastActivatedAt: string }>,
  cap = MAX_RECENT_CHATS_PER_ENTRY,
): LorebookEntryRecentChat[] {
  const byChat = new Map(existing.map((item) => [item.chatId, { ...item }]));
  for (const [chatId, addition] of additions) {
    const current = byChat.get(chatId);
    byChat.set(chatId, {
      chatId,
      count: (current?.count ?? 0) + addition.count,
      lastActivatedAt: laterOf(current?.lastActivatedAt ?? null, addition.lastActivatedAt),
    });
  }
  return sortRecentChats(Array.from(byChat.values())).slice(0, Math.max(0, cap));
}

function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function sortRecentChats(items: LorebookEntryRecentChat[]): LorebookEntryRecentChat[] {
  return items.sort((a, b) => (b.lastActivatedAt ?? "").localeCompare(a.lastActivatedAt ?? "") || b.count - a.count);
}

// ── Stale entries ──

export const DEFAULT_STALE_DAYS = 30;
export const MAX_STALE_DAYS = 3650;

export interface StaleEntryInput {
  id: string;
  enabled?: unknown;
  folderId?: string | null;
  createdAt?: string | null;
}

export interface StaleEntriesResult {
  days: number;
  cutoff: string;
  /** Newest activation of any entry in this lorebook, or null when nothing ever fired. */
  lorebookLastActivatedAt: string | null;
  /** False when the lorebook itself did not fire in the window, so nothing can be called stale. */
  lorebookActive: boolean;
  entries: Array<{ entryId: string; lastActivatedAt: string | null }>;
}

export function clampStaleDays(value: unknown): number {
  const days = Math.floor(Number(value));
  if (!Number.isFinite(days) || days < 1) return DEFAULT_STALE_DAYS;
  return Math.min(days, MAX_STALE_DAYS);
}

function isEnabled(value: unknown): boolean {
  return value !== false && value !== "false" && value !== 0;
}

/**
 * Entries that did not fire in the last `days` days although their lorebook
 * did. Disabled entries, entries in disabled folders and entries created
 * inside the window are left out: they had no fair chance to fire.
 */
export function findStaleEntries(input: {
  entries: readonly StaleEntryInput[];
  stats: ReadonlyArray<{ entryId: string; lastActivatedAt: string | null }>;
  disabledFolderIds?: ReadonlySet<string>;
  days?: unknown;
  now?: Date;
}): StaleEntriesResult {
  const days = clampStaleDays(input.days);
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const lastById = new Map(input.stats.map((stat) => [stat.entryId, stat.lastActivatedAt]));
  let lorebookLastActivatedAt: string | null = null;
  for (const stat of input.stats) {
    lorebookLastActivatedAt = laterOf(lorebookLastActivatedAt, stat.lastActivatedAt);
  }
  const lorebookActive = !!lorebookLastActivatedAt && lorebookLastActivatedAt >= cutoff;
  const entries: StaleEntriesResult["entries"] = [];
  if (lorebookActive) {
    for (const entry of input.entries) {
      if (!isEnabled(entry.enabled)) continue;
      if (entry.folderId && input.disabledFolderIds?.has(entry.folderId)) continue;
      if (entry.createdAt && entry.createdAt > cutoff) continue;
      const last = lastById.get(entry.id) ?? null;
      if (last && last >= cutoff) continue;
      entries.push({ entryId: entry.id, lastActivatedAt: last });
    }
    // Longest silent first; never fired sorts before everything.
    entries.sort((a, b) => (a.lastActivatedAt ?? "").localeCompare(b.lastActivatedAt ?? ""));
  }
  return { days, cutoff, lorebookLastActivatedAt, lorebookActive, entries };
}
