// ──────────────────────────────────────────────
// Character usage: which chats and games each character is in
//
// Built from chat ROWS only (characterIds plus Game Mode party, NPC and GM
// metadata), never from messages, so the index costs one pass over the chat
// list. Each chat's contribution is cached against the row fields it was read
// from; a request re-reads only chats whose row changed and rebuilds the
// per-character map only when something did, so an edit, a new session or a
// deleted chat shows up on the next request without any explicit hook.
//
// Message counts are the one expensive part (they load a chat's messages), so
// they are opt-in, capped, and cached per chat until its row changes.
// ──────────────────────────────────────────────
import { PROFESSOR_MARI_ID, getCharacterLibraryCategory, resolveEffectiveGameId } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { characters, chats, messages } from "../../db/schema/index.js";
import { isInternalAssistantChat } from "../chat-insights/chat-insights.service.js";

type ChatRow = typeof chats.$inferSelect;

export type CharacterUsageRole = "member" | "persona" | "party" | "npc" | "gm";
export type CharacterUsageMode = "conversation" | "roleplay" | "game";

export interface CharacterChatUsage {
  chatId: string;
  chatName: string;
  mode: CharacterUsageMode;
  roles: CharacterUsageRole[];
  /** Campaign identity for Game Mode chats, null otherwise. */
  gameId: string | null;
  gameName: string | null;
  /** Newest message, or the chat's last update when it has none yet. */
  lastActivityAt: string;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface CharacterGameUsage {
  gameId: string;
  gameName: string;
  sessions: number;
  roles: CharacterUsageRole[];
  lastActivityAt: string;
}

export interface CharacterUsageSummaryEntry {
  chats: number;
  games: number;
  lastActivityAt: string | null;
}

/** Most chats one detail request will count messages for. */
export const MESSAGE_COUNT_LIMIT = 50;

const ROLE_ORDER: CharacterUsageRole[] = ["member", "persona", "party", "npc", "gm"];
const SESSION_SUFFIX = /\s+(?:—|-|–)\s+Session\s+\d+$/i;

function parseRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseIds(raw: unknown): string[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

function isMode(value: unknown): value is CharacterUsageMode {
  return value === "conversation" || value === "roleplay" || value === "game";
}

export function gameNameFromChatName(name: string): string {
  return name.replace(SESSION_SUFFIX, "").trim() || name;
}

/** Everyone a chat row names, with the part each plays. Pure: reads the row, nothing else. */
export function extractChatCharacterRoles(chat: {
  id: string;
  mode: string;
  characterIds: unknown;
  personaCharacterId?: unknown;
  metadata: unknown;
}): Map<string, Set<CharacterUsageRole>> {
  const roles = new Map<string, Set<CharacterUsageRole>>();
  const add = (id: unknown, role: CharacterUsageRole) => {
    if (typeof id !== "string" || !id || id.startsWith("npc:") || id === PROFESSOR_MARI_ID) return;
    let set = roles.get(id);
    if (!set) roles.set(id, (set = new Set()));
    set.add(role);
  };
  for (const id of parseIds(chat.characterIds)) add(id, "member");
  add(chat.personaCharacterId, "persona");
  if (chat.mode === "game") {
    const metadata = parseRecord(chat.metadata);
    for (const id of parseIds(metadata.gamePartyCharacterIds)) add(id, "party");
    if (Array.isArray(metadata.gameNpcs)) {
      for (const npc of metadata.gameNpcs) {
        if (npc && typeof npc === "object") add((npc as { characterId?: unknown }).characterId, "npc");
      }
    }
    if (metadata.gameGmMode === "character") add(metadata.gameGmCharacterId, "gm");
  }
  return roles;
}

interface CachedChat {
  // The row fields the entry was derived from.
  name: string;
  mode: string;
  characterIds: string;
  personaCharacterId: string | null;
  metadata: string;
  groupId: string | null;
  updatedAt: string;
  lastMessageAt: string | null;
  usages: Array<{ characterId: string; usage: CharacterChatUsage }>;
}

function sameRow(cached: CachedChat, row: ChatRow): boolean {
  return (
    cached.updatedAt === row.updatedAt &&
    cached.lastMessageAt === (row.lastMessageAt ?? null) &&
    cached.name === row.name &&
    cached.mode === row.mode &&
    cached.groupId === (row.groupId ?? null) &&
    cached.characterIds === row.characterIds &&
    cached.personaCharacterId === (row.personaCharacterId ?? null) &&
    cached.metadata === row.metadata
  );
}

function deriveChat(row: ChatRow): CachedChat {
  const base: CachedChat = {
    name: row.name,
    mode: row.mode,
    characterIds: row.characterIds,
    personaCharacterId: row.personaCharacterId ?? null,
    metadata: row.metadata,
    groupId: row.groupId ?? null,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt ?? null,
    usages: [],
  };
  if (!isMode(row.mode) || isInternalAssistantChat(row)) return base;
  const roles = extractChatCharacterRoles(row);
  if (roles.size === 0) return base;
  const isGame = row.mode === "game";
  const gameId = isGame ? resolveEffectiveGameId(parseRecord(row.metadata).gameId, row.groupId, row.id) : null;
  for (const [characterId, set] of roles) {
    base.usages.push({
      characterId,
      usage: {
        chatId: row.id,
        chatName: row.name,
        mode: row.mode,
        roles: ROLE_ORDER.filter((role) => set.has(role)),
        gameId,
        gameName: isGame ? gameNameFromChatName(row.name) : null,
        lastActivityAt: row.lastMessageAt || row.updatedAt || row.createdAt,
        lastMessageAt: row.lastMessageAt ?? null,
        createdAt: row.createdAt,
      },
    });
  }
  return base;
}

function byRecent(left: CharacterChatUsage, right: CharacterChatUsage) {
  return right.lastActivityAt.localeCompare(left.lastActivityAt) || left.chatId.localeCompare(right.chatId);
}

/** Collapse a character's game session chats into one line per campaign. */
export function groupGameUsage(usages: readonly CharacterChatUsage[]): CharacterGameUsage[] {
  const games = new Map<string, CharacterGameUsage & { roleSet: Set<CharacterUsageRole> }>();
  for (const usage of usages) {
    if (!usage.gameId) continue;
    let game = games.get(usage.gameId);
    if (!game) {
      game = {
        gameId: usage.gameId,
        gameName: usage.gameName ?? usage.chatName,
        sessions: 0,
        roles: [],
        lastActivityAt: usage.lastActivityAt,
        roleSet: new Set(),
      };
      games.set(usage.gameId, game);
    }
    game.sessions += 1;
    for (const role of usage.roles) game.roleSet.add(role);
    if (usage.lastActivityAt > game.lastActivityAt) {
      game.lastActivityAt = usage.lastActivityAt;
      // The newest session's name is the campaign's current name.
      game.gameName = usage.gameName ?? game.gameName;
    }
  }
  return [...games.values()]
    .map(({ roleSet, ...game }) => ({ ...game, roles: ROLE_ORDER.filter((role) => roleSet.has(role)) }))
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
}

type MessageStoreProbe = {
  getTableWriteGeneration?: (table: string) => number;
  getResidentChatUnits?: () => ReadonlySet<string>;
};

export function createCharacterUsageIndex() {
  const perChat = new Map<string, CachedChat>();
  let byCharacter = new Map<string, CharacterChatUsage[]>();
  let builds = 0;
  // `generation` is the messages table write generation when the count was taken. Deleting,
  // trashing or restoring an earlier message leaves the chat row untouched, so the row key
  // alone would keep a stale count; a changed generation forces a recount unless the chat's
  // unit is not resident (every message write loads its chat's unit first).
  const messageCounts = new Map<string, { key: string; generation: number; count: number }>();

  async function refresh(db: DB) {
    const rows = (await db.select().from(chats)) as ChatRow[];
    let changed = rows.length !== perChat.size || builds === 0;
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      const cached = perChat.get(row.id);
      if (cached && sameRow(cached, row)) continue;
      perChat.set(row.id, deriveChat(row));
      changed = true;
    }
    for (const id of [...perChat.keys()]) {
      if (!seen.has(id)) {
        perChat.delete(id);
        messageCounts.delete(id);
        changed = true;
      }
    }
    if (!changed) return byCharacter;
    const next = new Map<string, CharacterChatUsage[]>();
    for (const entry of perChat.values()) {
      for (const { characterId, usage } of entry.usages) {
        const list = next.get(characterId);
        if (list) list.push(usage);
        else next.set(characterId, [usage]);
      }
    }
    for (const list of next.values()) list.sort(byRecent);
    byCharacter = next;
    builds += 1;
    return byCharacter;
  }

  return {
    /** How many times the per-character map was rebuilt; for tests. */
    get builds() {
      return builds;
    },

    async summary(db: DB): Promise<Record<string, CharacterUsageSummaryEntry>> {
      const index = await refresh(db);
      const result: Record<string, CharacterUsageSummaryEntry> = {};
      for (const [characterId, usages] of index) {
        const games = new Set(usages.map((usage) => usage.gameId).filter(Boolean));
        result[characterId] = {
          chats: usages.length,
          games: games.size,
          lastActivityAt: usages[0]?.lastActivityAt ?? null,
        };
      }
      return result;
    },

    async forCharacter(db: DB, characterId: string) {
      const usages = (await refresh(db)).get(characterId) ?? [];
      return { chats: usages, games: groupGameUsage(usages) };
    },

    /** Message counts for up to MESSAGE_COUNT_LIMIT of the given chats, newest first. */
    async countMessages(db: DB, usages: readonly CharacterChatUsage[]) {
      const counts: Record<string, number> = {};
      const store = (db as { _fileStore?: MessageStoreProbe })._fileStore;
      const generation = store?.getTableWriteGeneration?.("messages") ?? -1;
      const resident = store?.getResidentChatUnits?.() ?? null;
      for (const usage of usages.slice(0, MESSAGE_COUNT_LIMIT)) {
        const row = perChat.get(usage.chatId);
        const key = `${row?.updatedAt ?? ""}|${row?.lastMessageAt ?? ""}`;
        const cached = messageCounts.get(usage.chatId);
        if (
          cached &&
          cached.key === key &&
          generation >= 0 &&
          (cached.generation === generation || (resident !== null && !resident.has(usage.chatId)))
        ) {
          counts[usage.chatId] = cached.count;
          continue;
        }
        const count = await db.count(messages, eq(messages.chatId, usage.chatId));
        messageCounts.set(usage.chatId, { key, generation, count });
        counts[usage.chatId] = count;
      }
      return { counts, truncated: usages.length > MESSAGE_COUNT_LIMIT };
    },
  };
}

export type CharacterUsageIndex = ReturnType<typeof createCharacterUsageIndex>;

/** Library characters that no chat names in any role, newest first. */
export async function listUnusedCharacters(db: DB, summary: Record<string, CharacterUsageSummaryEntry>) {
  const rows = (await db.select().from(characters)) as Array<typeof characters.$inferSelect>;
  const unused = [];
  for (const row of rows) {
    if (row.id === PROFESSOR_MARI_ID || summary[row.id]) continue;
    const data = parseRecord(row.data);
    unused.push({
      id: row.id,
      name: typeof data.name === "string" ? data.name : "",
      avatarPath: row.avatarPath ?? null,
      category: getCharacterLibraryCategory(data),
      createdAt: row.createdAt,
    });
  }
  return unused.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
