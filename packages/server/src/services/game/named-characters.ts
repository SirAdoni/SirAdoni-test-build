import { normalizeTextForMatch } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { characters, chats, messages } from "../../db/schema/index.js";

/**
 * Library characters a Game session has named. The GM receives their cards, and campaign memory registers them as
 * people, so facts, movements and relationships about an NPC or candidate attach to that person even when they
 * were never added to the party.
 */

/** Leading words that are ranks or roles, not part of how people refer to someone in prose. */
const TITLE_WORDS = new Set([
  "lady",
  "lord",
  "sir",
  "dame",
  "captain",
  "commander",
  "general",
  "proctor",
  "proctor-magister",
  "magister",
  "mistress",
  "master",
  "sister",
  "brother",
  "mother",
  "father",
  "elder",
  "countess",
  "count",
  "duchess",
  "duke",
  "baroness",
  "baron",
  "princess",
  "prince",
  "queen",
  "king",
  "crown",
  "first",
  "high",
  "grand",
  "alderwoman",
  "alderman",
  "keeper",
  "steward",
  "warden",
  "warmagus",
  "physician",
  "doctor",
  "abbess",
  "reverend",
  "saint",
  "journeywoman",
  "journeyman",
]);

function coreWords(name: string): string[] {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  let start = 0;
  while (start < words.length - 1 && TITLE_WORDS.has(words[start]!.toLowerCase())) start += 1;
  return words.slice(start);
}

/** How often each distinctive first name occurs across a set of names; a first name is only an alias when unique. */
export function countNamedCharacterFirstNames(names: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) {
    const first = coreWords(name)[0];
    if (first) counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  return counts;
}

/** Ways prose refers to a character: full name, name without titles, and a unique distinctive first name. */
export function namedCharacterAliases(name: string, firstNameCounts: Map<string, number>): string[] {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const core = coreWords(name);
  const aliases = new Set<string>([words.join(" ")]);
  if (core.length > 0) aliases.add(core.join(" "));
  const first = core[0];
  if (first && first.length >= 4 && /^\p{Lu}/u.test(first) && (firstNameCounts.get(first) ?? 0) === 1) {
    aliases.add(first);
  }
  return [...aliases].filter((alias) => alias.length >= 3);
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Pick the library characters named in `texts`, outside the excluded ids and names, in order of first mention.
 * Ordering by first mention keeps the list append-only as a session grows. Matching is case-sensitive because
 * these are proper nouns.
 */
export function selectNamedCharacterIds(args: {
  library: Array<{ id: string; name: string }>;
  excludedIds?: Iterable<string>;
  excludedNames?: Iterable<string>;
  texts: string[];
}): string[] {
  const excludedIds = new Set(args.excludedIds ?? []);
  const excludedNames = new Set([...(args.excludedNames ?? [])].map((name) => normalizeTextForMatch(name)));
  const firstNameCounts = countNamedCharacterFirstNames(args.library.map((entry) => entry.name));
  const joined = args.texts.join("\n");
  const found: Array<{ id: string; at: number }> = [];
  for (const entry of args.library) {
    if (excludedIds.has(entry.id) || excludedNames.has(normalizeTextForMatch(entry.name))) continue;
    const aliases = namedCharacterAliases(entry.name, firstNameCounts);
    if (aliases.length === 0) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}-])(?:${aliases.map(escapePattern).join("|")})(?![\\p{L}\\p{N}-])`,
      "u",
    );
    const match = pattern.exec(joined);
    if (match) found.push({ id: entry.id, at: match.index });
  }
  return found.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).map((entry) => entry.id);
}

export interface NamedCharacterLibraryEntry {
  id: string;
  name: string;
  data: Record<string, unknown>;
}

function parseData(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function readNamedCharacterLibrary(db: DB): Promise<NamedCharacterLibraryEntry[]> {
  const rows = await db.select().from(characters);
  const library: NamedCharacterLibraryEntry[] = [];
  for (const row of rows) {
    const data = parseData(row.data);
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (name) library.push({ id: row.id, name, data });
  }
  return library;
}

const MEMO_TTL_MS = 10_000;
const memo = new Map<string, { at: number; ids: string[] }>();

/**
 * Library characters named anywhere in a chat's messages. Owner validation asks for this once per entity, so the
 * answer is remembered briefly per chat instead of rescanning the whole transcript each time.
 */
export async function readNamedCharacterIds(db: DB, chatId: string): Promise<string[]> {
  const cached = memo.get(chatId);
  if (cached && Date.now() - cached.at < MEMO_TTL_MS) return cached.ids;
  const chatRows = await db.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chatRows[0]) return [];
  const rows = await db.select({ content: messages.content }).from(messages).where(eq(messages.chatId, chatId));
  const ids = selectNamedCharacterIds({
    library: await readNamedCharacterLibrary(db),
    texts: rows.map((row) => (typeof row.content === "string" ? row.content : "")),
  });
  memo.set(chatId, { at: Date.now(), ids });
  return ids;
}

/** Tests and edits that must see a new mention immediately can drop the remembered answer. */
export function forgetNamedCharacterIds(chatId?: string): void {
  if (chatId) memo.delete(chatId);
  else memo.clear();
}
