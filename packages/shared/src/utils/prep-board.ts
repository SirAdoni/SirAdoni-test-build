// ──────────────────────────────────────────────
// GM prep board (pure logic)
//
// A private, per-game planning board for the player acting as GM: sections in
// the spirit of Lazy DM prep, items with a done box, an optional link to a card
// or lorebook entry, and tags. Everything here is pure (no ids or clocks are
// made up inside), so the server, the client and the regressions share it.
// The board is never part of a prompt; nothing in prompt assembly reads it.
// ──────────────────────────────────────────────

export const PREP_BOARD_SCHEMA_VERSION = 1;
export const PREP_BOARD_EXPORT_FORMAT = "marinara-prep-board";

/** Guards against a runaway import, not design limits. */
export const PREP_BOARD_LIMITS = {
  sections: 40,
  items: 2000,
  sectionTitle: 120,
  itemText: 4000,
  tags: 20,
  tag: 60,
  linkLabel: 200,
  id: 120,
} as const;

/** The default sections. A preset section shows its localized name until the GM renames it. */
export const PREP_BOARD_DEFAULT_SECTIONS = [
  "strong_start",
  "scenes",
  "secrets",
  "threads",
  "npcs",
  "locations",
  "treasure",
  "notes",
] as const;
export type PrepBoardPreset = (typeof PREP_BOARD_DEFAULT_SECTIONS)[number];

/** English names, used by exports and anywhere a localized name is not at hand. */
export const PREP_BOARD_PRESET_TITLES: Record<PrepBoardPreset, string> = {
  strong_start: "Strong start",
  scenes: "Scenes",
  secrets: "Secrets and clues",
  threads: "Open threads",
  npcs: "NPCs to feature",
  locations: "Locations",
  treasure: "Treasure and rewards",
  notes: "Notes",
};

export type PrepBoardLinkKind = "character" | "lorebook_entry";

export interface PrepBoardLink {
  kind: PrepBoardLinkKind;
  id: string;
  /** The entry's lorebook; required to open a lorebook entry. */
  lorebookId?: string;
  /** Name at link time, shown when the target is not loaded. */
  label: string;
}

export interface PrepBoardSection {
  id: string;
  /** "" shows the preset's localized name (or "Untitled" for a custom section). */
  title: string;
  preset: PrepBoardPreset | null;
}

export interface PrepBoardItem {
  id: string;
  sectionId: string;
  text: string;
  done: boolean;
  archived: boolean;
  tags: string[];
  link: PrepBoardLink | null;
  /** The session the item is planned for. */
  session: number | null;
  /** The game session the GM was in when the item was written. */
  createdSession: number | null;
  /** The game session the item was checked off in. */
  usedSession: number | null;
  /** How many times carry-over moved it forward. */
  carried: number;
  createdAt: string;
  updatedAt: string;
}

export interface PrepBoard {
  version: number;
  /** The session being planned. */
  session: number;
  sections: PrepBoardSection[];
  /** Order within a section is the order here. */
  items: PrepBoardItem[];
}

export interface PrepBoardExport {
  format: typeof PREP_BOARD_EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  gameName?: string;
  board: PrepBoard;
}

// ── Sanitizing ──

function cleanString(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";
}

function cleanSession(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 0 && number < 1_000_000 ? number : null;
}

export function normalizePrepTag(value: unknown): string {
  return cleanString(value, PREP_BOARD_LIMITS.tag).replace(/^#+/, "").replace(/\s+/g, " ").trim();
}

/** Tags from free text ("heist, #npc  villain") or an array, deduplicated case-insensitively. */
export function parsePrepTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of raw) {
    const tag = normalizePrepTag(entry);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= PREP_BOARD_LIMITS.tags) break;
  }
  return tags;
}

function sanitizeLink(value: unknown): PrepBoardLink | null {
  if (!value || typeof value !== "object") return null;
  const link = value as Record<string, unknown>;
  const kind = link.kind === "character" || link.kind === "lorebook_entry" ? link.kind : null;
  const id = cleanString(link.id, PREP_BOARD_LIMITS.id);
  if (!kind || !id) return null;
  const lorebookId = cleanString(link.lorebookId, PREP_BOARD_LIMITS.id);
  if (kind === "lorebook_entry" && !lorebookId) return null;
  return {
    kind,
    id,
    ...(kind === "lorebook_entry" && { lorebookId }),
    label: cleanString(link.label, PREP_BOARD_LIMITS.linkLabel),
  };
}

function isPreset(value: unknown): value is PrepBoardPreset {
  return typeof value === "string" && (PREP_BOARD_DEFAULT_SECTIONS as readonly string[]).includes(value);
}

/** A fresh board with the default sections, planning `session`. */
export function createDefaultPrepBoard(session = 1): PrepBoard {
  return {
    version: PREP_BOARD_SCHEMA_VERSION,
    session: Math.max(0, cleanSession(session) ?? 1),
    sections: PREP_BOARD_DEFAULT_SECTIONS.map((preset) => ({ id: preset, title: "", preset })),
    items: [],
  };
}

/**
 * Make any stored or imported value a valid board: known fields only, clamped
 * sizes, unique ids, every item in an existing section. Never throws.
 */
export function sanitizePrepBoard(value: unknown, fallbackSession = 1): PrepBoard {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const sections: PrepBoardSection[] = [];
  const sectionIds = new Set<string>();
  for (const raw of Array.isArray(source.sections) ? source.sections : []) {
    if (!raw || typeof raw !== "object") continue;
    const section = raw as Record<string, unknown>;
    const id = cleanString(section.id, PREP_BOARD_LIMITS.id);
    if (!id || sectionIds.has(id)) continue;
    sectionIds.add(id);
    sections.push({
      id,
      title: cleanString(section.title, PREP_BOARD_LIMITS.sectionTitle).replace(/\s+/g, " "),
      preset: isPreset(section.preset) ? section.preset : null,
    });
    if (sections.length >= PREP_BOARD_LIMITS.sections) break;
  }
  if (sections.length === 0) sections.push(...createDefaultPrepBoard().sections);
  const knownSections = new Set(sections.map((section) => section.id));

  const items: PrepBoardItem[] = [];
  const itemIds = new Set<string>();
  for (const raw of Array.isArray(source.items) ? source.items : []) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = cleanString(item.id, PREP_BOARD_LIMITS.id);
    const text = cleanString(item.text, PREP_BOARD_LIMITS.itemText);
    if (!id || itemIds.has(id) || !text) continue;
    itemIds.add(id);
    const sectionId = cleanString(item.sectionId, PREP_BOARD_LIMITS.id);
    const createdAt = cleanString(item.createdAt, 40);
    items.push({
      id,
      sectionId: knownSections.has(sectionId) ? sectionId : sections[sections.length - 1]!.id,
      text,
      done: item.done === true,
      archived: item.archived === true,
      tags: parsePrepTags(item.tags),
      link: sanitizeLink(item.link),
      session: cleanSession(item.session),
      createdSession: cleanSession(item.createdSession),
      usedSession: item.done === true ? cleanSession(item.usedSession) : null,
      carried: Math.min(1000, Math.max(0, cleanSession(item.carried) ?? 0)),
      createdAt,
      updatedAt: cleanString(item.updatedAt, 40) || createdAt,
    });
    if (items.length >= PREP_BOARD_LIMITS.items) break;
  }

  return {
    version: PREP_BOARD_SCHEMA_VERSION,
    session: cleanSession(source.session) ?? Math.max(0, cleanSession(fallbackSession) ?? 1),
    sections,
    items,
  };
}

// ── Queries ──

/** Items of a section in board order; archived ones only when asked. */
export function prepSectionItems(board: PrepBoard, sectionId: string, includeArchived = false): PrepBoardItem[] {
  return board.items.filter((item) => item.sectionId === sectionId && (includeArchived || !item.archived));
}

export function prepSectionTitle(section: PrepBoardSection, presetTitle?: (preset: PrepBoardPreset) => string) {
  if (section.title) return section.title;
  if (section.preset) return presetTitle ? presetTitle(section.preset) : PREP_BOARD_PRESET_TITLES[section.preset];
  return "";
}

/**
 * Ids of the items matching a search: every word must appear in the text, a tag,
 * the link's name or the section's name. Blank queries match nothing (callers
 * show the whole board then).
 */
export function searchPrepBoard(
  board: PrepBoard,
  query: string,
  presetTitle?: (preset: PrepBoardPreset) => string,
): Set<string> {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = new Set<string>();
  if (words.length === 0) return matches;
  const sectionTitles = new Map(board.sections.map((section) => [section.id, prepSectionTitle(section, presetTitle)]));
  for (const item of board.items) {
    const haystack = [
      item.text,
      ...item.tags.map((tag) => `#${tag}`),
      item.link?.label ?? "",
      sectionTitles.get(item.sectionId) ?? "",
    ]
      .join("\n")
      .toLocaleLowerCase();
    if (words.every((word) => haystack.includes(word))) matches.add(item.id);
  }
  return matches;
}

export function countPrepItems(board: PrepBoard) {
  let open = 0;
  let done = 0;
  let archived = 0;
  for (const item of board.items) {
    if (item.archived) archived += 1;
    else if (item.done) done += 1;
    else open += 1;
  }
  return { open, done, archived };
}

// ── Item edits ──

export interface NewPrepItem {
  id: string;
  sectionId: string;
  text: string;
  tags?: unknown;
  link?: PrepBoardLink | null;
  /** The game session the GM is in now. */
  currentSession: number | null;
  now: string;
}

/** Append an item to the end of its section. Unknown sections and blank text leave the board as is. */
export function addPrepItem(board: PrepBoard, input: NewPrepItem): PrepBoard {
  const text = cleanString(input.text, PREP_BOARD_LIMITS.itemText);
  if (!text || !board.sections.some((section) => section.id === input.sectionId)) return board;
  if (board.items.length >= PREP_BOARD_LIMITS.items || board.items.some((item) => item.id === input.id)) return board;
  const item: PrepBoardItem = {
    id: input.id,
    sectionId: input.sectionId,
    text,
    done: false,
    archived: false,
    tags: parsePrepTags(input.tags),
    link: sanitizeLink(input.link),
    session: board.session,
    createdSession: cleanSession(input.currentSession),
    usedSession: null,
    carried: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return { ...board, items: insertAtSectionEnd(board.items, item) };
}

/** Insert after the section's last item (archived included) so board order stays grouped. */
function insertAtSectionEnd(items: PrepBoardItem[], ...added: PrepBoardItem[]): PrepBoardItem[] {
  const sectionId = added[0]?.sectionId;
  let insertAt = items.length;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.sectionId === sectionId) {
      insertAt = index + 1;
      break;
    }
  }
  const next = [...items];
  next.splice(insertAt, 0, ...added);
  return next;
}

export interface PrepItemPatch {
  text?: string;
  tags?: unknown;
  link?: PrepBoardLink | null;
}

export function updatePrepItem(board: PrepBoard, itemId: string, patch: PrepItemPatch, now: string): PrepBoard {
  let changed = false;
  const items = board.items.map((item) => {
    if (item.id !== itemId) return item;
    const text = patch.text === undefined ? item.text : cleanString(patch.text, PREP_BOARD_LIMITS.itemText);
    if (!text) return item;
    changed = true;
    return {
      ...item,
      text,
      ...(patch.tags !== undefined && { tags: parsePrepTags(patch.tags) }),
      ...(patch.link !== undefined && { link: sanitizeLink(patch.link) }),
      updatedAt: now,
    };
  });
  return changed ? { ...board, items } : board;
}

/** Check or uncheck an item; checking records the session it was used in. */
export function setPrepItemDone(
  board: PrepBoard,
  itemId: string,
  done: boolean,
  currentSession: number | null,
  now: string,
): PrepBoard {
  return {
    ...board,
    items: board.items.map((item) =>
      item.id === itemId
        ? { ...item, done, usedSession: done ? cleanSession(currentSession) : null, updatedAt: now }
        : item,
    ),
  };
}

export function setPrepItemArchived(board: PrepBoard, itemId: string, archived: boolean, now: string): PrepBoard {
  return {
    ...board,
    items: board.items.map((item) => (item.id === itemId ? { ...item, archived, updatedAt: now } : item)),
  };
}

export function removePrepItem(board: PrepBoard, itemId: string): PrepBoard {
  return { ...board, items: board.items.filter((item) => item.id !== itemId) };
}

/** Archive every checked item that is still on the board. */
export function archiveUsedPrepItems(board: PrepBoard, now: string): { board: PrepBoard; archived: number } {
  let archived = 0;
  const items = board.items.map((item) => {
    if (!item.done || item.archived) return item;
    archived += 1;
    return { ...item, archived: true, updatedAt: now };
  });
  return { board: archived ? { ...board, items } : board, archived };
}

// ── Ordering ──

/**
 * Move an item to `toIndex` among the visible (not archived) items of
 * `toSectionId`, counted without the moved item itself. An index past the end
 * appends. Archived items keep their places relative to their neighbours.
 */
export function movePrepItem(board: PrepBoard, itemId: string, toSectionId: string, toIndex: number): PrepBoard {
  const moving = board.items.find((item) => item.id === itemId);
  if (!moving || !board.sections.some((section) => section.id === toSectionId)) return board;
  const rest = board.items.filter((item) => item.id !== itemId);
  const targets = rest.filter((item) => item.sectionId === toSectionId && !item.archived);
  const index = Math.max(0, Math.min(Math.floor(toIndex), targets.length));
  const moved = moving.sectionId === toSectionId ? moving : { ...moving, sectionId: toSectionId };
  let insertAt: number;
  if (index < targets.length) {
    insertAt = rest.indexOf(targets[index]!);
  } else if (targets.length > 0) {
    insertAt = rest.indexOf(targets[targets.length - 1]!) + 1;
  } else {
    // Empty section: after its last archived item, else after the previous sections' items.
    const sectionOrder = board.sections.map((section) => section.id);
    const targetRank = sectionOrder.indexOf(toSectionId);
    insertAt = rest.length;
    for (let position = rest.length - 1; position >= 0; position -= 1) {
      if (sectionOrder.indexOf(rest[position]!.sectionId) <= targetRank) {
        insertAt = position + 1;
        break;
      }
      insertAt = position;
    }
  }
  const items = [...rest];
  items.splice(insertAt, 0, moved);
  const unchanged = items.every((item, position) => item === board.items[position]);
  return unchanged ? board : { ...board, items };
}

/**
 * Keyboard move: one step up or down among a section's visible items. Past the
 * first or last item it crosses into the neighbouring section (to its end when
 * moving up, its start when moving down). Returns the board unchanged at the
 * very top or bottom.
 */
export function stepPrepItem(board: PrepBoard, itemId: string, direction: -1 | 1): PrepBoard {
  const item = board.items.find((entry) => entry.id === itemId);
  if (!item || item.archived) return board;
  const visible = prepSectionItems(board, item.sectionId);
  const position = visible.findIndex((entry) => entry.id === itemId);
  const next = position + direction;
  if (next >= 0 && next < visible.length) return movePrepItem(board, itemId, item.sectionId, next);
  const sectionIndex = board.sections.findIndex((section) => section.id === item.sectionId);
  const neighbour = board.sections[sectionIndex + direction];
  if (!neighbour) return board;
  const neighbourCount = prepSectionItems(board, neighbour.id).length;
  return movePrepItem(board, itemId, neighbour.id, direction < 0 ? neighbourCount : 0);
}

// ── Carry-over ──

export interface PrepCarryOverResult {
  board: PrepBoard;
  /** Unfinished items moved to the next session. */
  carried: number;
  /** Checked items archived on the way. */
  archived: number;
}

/**
 * Close the planned session: the board moves on to the next one (or `toSession`
 * when given and later), every unfinished item goes with it, and the used ones
 * are archived with the session they were used in kept on them.
 */
export function carryOverPrepBoard(board: PrepBoard, now: string, toSession?: number | null): PrepCarryOverResult {
  const requested = cleanSession(toSession);
  const next = Math.max(board.session + 1, requested ?? 0);
  let carried = 0;
  let archived = 0;
  const items = board.items.map((item) => {
    if (item.archived) return item;
    if (item.done) {
      archived += 1;
      return { ...item, archived: true, updatedAt: now };
    }
    carried += 1;
    const wasPlanned = item.session !== null && item.session < next;
    return { ...item, session: next, carried: item.carried + (wasPlanned ? 1 : 0), updatedAt: now };
  });
  return { board: { ...board, session: next, items }, carried, archived };
}

// ── Sections ──

export function addPrepSection(board: PrepBoard, id: string, title: string): PrepBoard {
  const clean = cleanString(title, PREP_BOARD_LIMITS.sectionTitle).replace(/\s+/g, " ");
  if (!clean || !id || board.sections.length >= PREP_BOARD_LIMITS.sections) return board;
  if (board.sections.some((section) => section.id === id)) return board;
  return { ...board, sections: [...board.sections, { id, title: clean, preset: null }] };
}

/** Rename a section; a blank name restores a preset's default name. */
export function renamePrepSection(board: PrepBoard, sectionId: string, title: string): PrepBoard {
  const clean = cleanString(title, PREP_BOARD_LIMITS.sectionTitle).replace(/\s+/g, " ");
  return {
    ...board,
    sections: board.sections.map((section) => {
      if (section.id !== sectionId) return section;
      if (!clean && !section.preset) return section;
      return {
        ...section,
        title: clean && section.preset && clean === PREP_BOARD_PRESET_TITLES[section.preset] ? "" : clean,
      };
    }),
  };
}

export function movePrepSection(board: PrepBoard, sectionId: string, direction: -1 | 1): PrepBoard {
  const index = board.sections.findIndex((section) => section.id === sectionId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= board.sections.length) return board;
  const sections = [...board.sections];
  [sections[index], sections[target]] = [sections[target]!, sections[index]!];
  // Keep items grouped in section order so movePrepItem's placement stays predictable.
  const rank = new Map(sections.map((section, position) => [section.id, position]));
  const items = [...board.items].sort(
    (left, right) => (rank.get(left.sectionId) ?? 0) - (rank.get(right.sectionId) ?? 0),
  );
  return { ...board, sections, items };
}

/**
 * Remove a section. Its items (archived ones too) move to the end of
 * `moveItemsTo`, or the first remaining section. The last section stays.
 */
export function removePrepSection(board: PrepBoard, sectionId: string, moveItemsTo?: string): PrepBoard {
  if (board.sections.length <= 1 || !board.sections.some((section) => section.id === sectionId)) return board;
  const sections = board.sections.filter((section) => section.id !== sectionId);
  const target = sections.some((section) => section.id === moveItemsTo) ? moveItemsTo! : sections[0]!.id;
  const moved = board.items
    .filter((item) => item.sectionId === sectionId)
    .map((item) => ({ ...item, sectionId: target }));
  const kept = board.items.filter((item) => item.sectionId !== sectionId);
  return { ...board, sections, items: moved.length ? insertAtSectionEnd(kept, ...moved) : kept };
}

// ── Export / import ──

export function buildPrepBoardExport(board: PrepBoard, exportedAt: string, gameName?: string): PrepBoardExport {
  return {
    format: PREP_BOARD_EXPORT_FORMAT,
    version: PREP_BOARD_SCHEMA_VERSION,
    exportedAt,
    ...(gameName && { gameName }),
    board: sanitizePrepBoard(board),
  };
}

/** Read an export file (or a bare board). Null when it is neither. */
export function parsePrepBoardImport(value: unknown): PrepBoard | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const source = record.format === PREP_BOARD_EXPORT_FORMAT ? record.board : record;
  if (!source || typeof source !== "object") return null;
  const candidate = source as Record<string, unknown>;
  if (!Array.isArray(candidate.sections) && !Array.isArray(candidate.items)) return null;
  return sanitizePrepBoard(source);
}

/**
 * Merge an imported board into the current one: sections match by id or by
 * name, new ones are appended, and imported items get fresh ids from `newId`
 * so importing the same file twice never collides.
 */
export function mergePrepBoards(
  current: PrepBoard,
  incoming: PrepBoard,
  newId: () => string,
): { board: PrepBoard; added: number } {
  const sections = [...current.sections];
  const sectionMap = new Map<string, string>();
  const titleKey = (section: PrepBoardSection) => prepSectionTitle(section).toLocaleLowerCase();
  for (const section of incoming.sections) {
    const match =
      sections.find((existing) => existing.id === section.id) ??
      sections.find((existing) => titleKey(existing) === titleKey(section) && titleKey(section) !== "");
    if (match) {
      sectionMap.set(section.id, match.id);
    } else if (sections.length < PREP_BOARD_LIMITS.sections) {
      const id = sections.some((existing) => existing.id === section.id) ? newId() : section.id;
      sections.push({ ...section, id });
      sectionMap.set(section.id, id);
    }
  }
  let items = current.items;
  let added = 0;
  for (const item of incoming.items) {
    if (items.length >= PREP_BOARD_LIMITS.items) break;
    const sectionId = sectionMap.get(item.sectionId) ?? sections[sections.length - 1]!.id;
    items = insertAtSectionEnd(items, { ...item, id: newId(), sectionId });
    added += 1;
  }
  return { board: { ...current, sections, items }, added };
}
