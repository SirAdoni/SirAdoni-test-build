// ──────────────────────────────────────────────
// Storage: Library Campaigns
// Derives Game Mode campaigns (session chats sharing a
// gameId) and the characters, personas and lorebooks each
// one uses, then applies the user's manual links.
// ──────────────────────────────────────────────
import type { LibraryCampaign, LibraryCampaignItemType } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { and, eq, inArray } from "../../db/file-query.js";
import {
  characters,
  chats,
  libraryCampaignLinks,
  lorebookCharacterLinks,
  lorebookPersonaLinks,
  lorebooks,
  personas,
} from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";
import { isFeatureEnabled } from "../features/feature-settings.js";

export class CampaignRosterDisabledError extends Error {
  readonly statusCode = 403;
  readonly code = "FEATURE_DISABLED";

  constructor() {
    super("Campaign roster is disabled");
    this.name = "CampaignRosterDisabledError";
  }
}

function assertCampaignRosterEnabled() {
  if (!isFeatureEnabled("campaignRoster")) throw new CampaignRosterDisabledError();
}

const SESSION_SUFFIX = / \u2014 Session \d+$/u;

export type CampaignChatRow = {
  id: string;
  name: string;
  mode: string;
  groupId: string | null;
  personaId: string | null;
  characterIds: string;
  metadata: string;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CampaignLinkRow = {
  campaignId: string;
  itemType: string;
  itemId: string;
  mode: string;
};

export type CampaignDerivationInput = {
  chats: CampaignChatRow[];
  /** Library lorebooks: id, owner links and chat scoping. Hidden (character-embedded) books are skipped. */
  lorebooks: Array<{
    id: string;
    characterId: string | null;
    personaId: string | null;
    chatId: string | null;
    hiddenFromLibrary: string;
  }>;
  lorebookCharacterLinks: Array<{ lorebookId: string; characterId: string }>;
  lorebookPersonaLinks: Array<{ lorebookId: string; personaId: string }>;
  links: CampaignLinkRow[];
  characterIds: ReadonlySet<string>;
  personaIds: ReadonlySet<string>;
};

/** What one session chat references; memoized per chat revision because game metadata is large. */
type ChatUsage = {
  campaignId: string;
  sessionNumber: number;
  characterIds: string[];
  personaIds: string[];
  lorebookIds: string[];
  gmCharacterIds: string[];
  partyCharacterIds: string[];
  npcCharacterIds: string[];
};

type ChatUsageRevision = Pick<
  CampaignChatRow,
  "updatedAt" | "lastMessageAt" | "groupId" | "personaId" | "characterIds" | "metadata"
>;
const usageCache = new Map<string, { revision: ChatUsageRevision; usage: ChatUsage }>();

/**
 * Exact comparison of every field the usage reads. A length or updatedAt token
 * would miss an edit that swaps one id for another of the same length within
 * the same millisecond. Rows are immutable, so an unchanged chat usually hands
 * back the very same strings and the comparison stays cheap.
 */
function sameUsageRevision(a: ChatUsageRevision, b: ChatUsageRevision) {
  return (
    a.updatedAt === b.updatedAt &&
    a.lastMessageAt === b.lastMessageAt &&
    a.groupId === b.groupId &&
    a.personaId === b.personaId &&
    a.characterIds === b.characterIds &&
    a.metadata === b.metadata
  );
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return strings(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item) : [];
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readChatUsage(chat: CampaignChatRow): ChatUsage {
  const revision: ChatUsageRevision = {
    updatedAt: chat.updatedAt,
    lastMessageAt: chat.lastMessageAt,
    groupId: chat.groupId,
    personaId: chat.personaId,
    characterIds: chat.characterIds,
    metadata: chat.metadata,
  };
  const cached = usageCache.get(chat.id);
  if (cached && sameUsageRevision(cached.revision, revision)) return cached.usage;

  const metadata = parseRecord(chat.metadata);
  const setup = (
    metadata.gameSetupConfig && typeof metadata.gameSetupConfig === "object" ? metadata.gameSetupConfig : {}
  ) as Record<string, unknown>;
  const npcs = Array.isArray(metadata.gameNpcs) ? metadata.gameNpcs : [];
  const cardIds = (ids: Array<string | null>) =>
    Array.from(new Set(ids.filter((id): id is string => !!id && !id.startsWith("npc:"))));
  const gmCharacterIds = cardIds([optionalString(metadata.gameGmCharacterId), optionalString(setup.gmCharacterId)]);
  const partyCharacterIds = cardIds([...strings(metadata.gamePartyCharacterIds), ...strings(setup.partyCharacterIds)]);
  const npcCharacterIds = cardIds(
    npcs.map((npc) =>
      npc && typeof npc === "object" ? optionalString((npc as Record<string, unknown>).characterId) : null,
    ),
  );
  const characterIds = cardIds([
    ...strings(chat.characterIds),
    ...partyCharacterIds,
    ...gmCharacterIds,
    ...npcCharacterIds,
  ]);
  const usage: ChatUsage = {
    campaignId: optionalString(metadata.gameId) ?? optionalString(chat.groupId) ?? chat.id,
    sessionNumber:
      typeof metadata.gameSessionNumber === "number" && Number.isFinite(metadata.gameSessionNumber)
        ? metadata.gameSessionNumber
        : 0,
    characterIds,
    gmCharacterIds,
    partyCharacterIds,
    npcCharacterIds,
    personaIds: [optionalString(chat.personaId), optionalString(setup.personaId)].filter((id): id is string => !!id),
    lorebookIds: Array.from(new Set([...strings(metadata.activeLorebookIds), ...strings(setup.activeLorebookIds)])),
  };
  usageCache.set(chat.id, { revision, usage });
  return usage;
}

function laterOf(a: string | null, b: string | null) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function linkKey(itemType: LibraryCampaignItemType | string, itemId: string) {
  return `${itemType}:${itemId}`;
}

/**
 * Pure derivation. A campaign is every Game Mode chat that shares a gameId
 * (falling back to the chat group, then the chat itself, as NPC sync does).
 * It uses the characters and personas its chats reference (party, GM, linked
 * NPC cards), the lorebooks its chats activate or own, and the library
 * lorebooks linked to those characters and personas. Manual "include" links
 * add items; "exclude" links hide derived ones.
 */
export function deriveLibraryCampaigns(input: CampaignDerivationInput): LibraryCampaign[] {
  type Draft = {
    id: string;
    chats: CampaignChatRow[];
    characters: Set<string>;
    personas: Set<string>;
    lorebooks: Set<string>;
    gm: Set<string>;
    party: Set<string>;
    npcs: Set<string>;
    latestSession: { chat: CampaignChatRow; sessionNumber: number } | null;
    lastPlayedAt: string | null;
  };
  const drafts = new Map<string, Draft>();
  const campaignByChatId = new Map<string, string>();
  const liveChatIds = new Set(input.chats.map((chat) => chat.id));
  for (const [chatId] of usageCache) if (!liveChatIds.has(chatId)) usageCache.delete(chatId);

  for (const chat of input.chats) {
    if (chat.mode !== "game") continue;
    const usage = readChatUsage(chat);
    let draft = drafts.get(usage.campaignId);
    if (!draft) {
      draft = {
        id: usage.campaignId,
        chats: [],
        characters: new Set(),
        personas: new Set(),
        lorebooks: new Set(),
        gm: new Set(),
        party: new Set(),
        npcs: new Set(),
        latestSession: null,
        lastPlayedAt: null,
      };
      drafts.set(usage.campaignId, draft);
    }
    draft.chats.push(chat);
    campaignByChatId.set(chat.id, draft.id);
    for (const id of usage.characterIds) draft.characters.add(id);
    for (const id of usage.personaIds) draft.personas.add(id);
    for (const id of usage.lorebookIds) draft.lorebooks.add(id);
    for (const id of usage.gmCharacterIds) draft.gm.add(id);
    for (const id of usage.partyCharacterIds) draft.party.add(id);
    for (const id of usage.npcCharacterIds) draft.npcs.add(id);
    draft.lastPlayedAt = laterOf(draft.lastPlayedAt, laterOf(chat.lastMessageAt, chat.updatedAt));
    const latest = draft.latestSession;
    if (
      !latest ||
      usage.sessionNumber > latest.sessionNumber ||
      (usage.sessionNumber === latest.sessionNumber && chat.updatedAt > latest.chat.updatedAt)
    ) {
      draft.latestSession = { chat, sessionNumber: usage.sessionNumber };
    }
  }

  const visibleLorebooks = input.lorebooks.filter((book) => book.hiddenFromLibrary !== "true");
  const visibleLorebookIds = new Set(visibleLorebooks.map((book) => book.id));
  const lorebooksByCharacter = new Map<string, Set<string>>();
  const lorebooksByPersona = new Map<string, Set<string>>();
  const addTo = (map: Map<string, Set<string>>, key: string | null, lorebookId: string) => {
    if (!key || !visibleLorebookIds.has(lorebookId)) return;
    const set = map.get(key);
    if (set) set.add(lorebookId);
    else map.set(key, new Set([lorebookId]));
  };
  for (const book of visibleLorebooks) {
    addTo(lorebooksByCharacter, book.characterId, book.id);
    addTo(lorebooksByPersona, book.personaId, book.id);
    const campaignId = book.chatId ? campaignByChatId.get(book.chatId) : undefined;
    if (campaignId) drafts.get(campaignId)?.lorebooks.add(book.id);
  }
  for (const link of input.lorebookCharacterLinks) addTo(lorebooksByCharacter, link.characterId, link.lorebookId);
  for (const link of input.lorebookPersonaLinks) addTo(lorebooksByPersona, link.personaId, link.lorebookId);

  const linksByCampaign = new Map<string, CampaignLinkRow[]>();
  for (const link of input.links) {
    const list = linksByCampaign.get(link.campaignId);
    if (list) list.push(link);
    else linksByCampaign.set(link.campaignId, [link]);
  }

  const campaigns: LibraryCampaign[] = [];
  for (const draft of drafts.values()) {
    for (const characterId of draft.characters) {
      for (const lorebookId of lorebooksByCharacter.get(characterId) ?? []) draft.lorebooks.add(lorebookId);
    }
    for (const personaId of draft.personas) {
      for (const lorebookId of lorebooksByPersona.get(personaId) ?? []) draft.lorebooks.add(lorebookId);
    }

    const sets: Record<LibraryCampaignItemType, Set<string>> = {
      character: draft.characters,
      persona: draft.personas,
      lorebook: draft.lorebooks,
    };
    const exists: Record<LibraryCampaignItemType, (id: string) => boolean> = {
      character: (id) => input.characterIds.has(id),
      persona: (id) => input.personaIds.has(id),
      lorebook: (id) => visibleLorebookIds.has(id),
    };
    const manualKeys: string[] = [];
    for (const link of linksByCampaign.get(draft.id) ?? []) {
      const set = sets[link.itemType as LibraryCampaignItemType];
      if (!set) continue;
      if (link.mode === "exclude") {
        set.delete(link.itemId);
      } else if (link.mode === "include") {
        set.add(link.itemId);
        // A deleted item's link row lingers harmlessly, but it is no member.
        if (exists[link.itemType as LibraryCampaignItemType](link.itemId)) {
          manualKeys.push(linkKey(link.itemType, link.itemId));
        }
      }
    }

    const sortedChats = [...draft.chats].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const baseName = (draft.latestSession?.chat.name ?? sortedChats[0]?.name ?? "").replace(SESSION_SUFFIX, "").trim();
    const characterIds = [...draft.characters].filter((id) => input.characterIds.has(id));
    const members = new Set(characterIds);
    const inRoster = (ids: Set<string>) => [...ids].filter((id) => members.has(id));
    campaigns.push({
      id: draft.id,
      name: baseName || sortedChats[0]?.name || "Untitled campaign",
      sessionCount: draft.chats.length,
      lastPlayedAt: draft.lastPlayedAt,
      characterIds,
      personaIds: [...draft.personas].filter((id) => input.personaIds.has(id)),
      lorebookIds: [...draft.lorebooks].filter((id) => visibleLorebookIds.has(id)),
      manualKeys,
      roster: {
        gmCharacterIds: inRoster(draft.gm),
        partyCharacterIds: inRoster(draft.party),
        npcCharacterIds: inRoster(draft.npcs),
      },
    });
  }

  return campaigns.sort(
    (a, b) => (b.lastPlayedAt ?? "").localeCompare(a.lastPlayedAt ?? "") || a.name.localeCompare(b.name),
  );
}

const SOURCE_TABLES = [
  "chats",
  "characters",
  "personas",
  "lorebooks",
  "lorebook_character_links",
  "lorebook_persona_links",
  "library_campaign_links",
] as const;

type CampaignCache = { signature: string; campaigns: LibraryCampaign[] };
const caches = new WeakMap<DB, CampaignCache>();

async function existingLibraryItemIds(db: DB, itemType: LibraryCampaignItemType, ids: string[]) {
  if (ids.length === 0) return new Set<string>();
  if (itemType === "character") {
    const rows = await db.select({ id: characters.id }).from(characters).where(inArray(characters.id, ids));
    return new Set(rows.map((row) => row.id));
  }
  if (itemType === "persona") {
    const rows = await db.select({ id: personas.id }).from(personas).where(inArray(personas.id, ids));
    return new Set(rows.map((row) => row.id));
  }
  const rows = await db
    .select({ id: lorebooks.id })
    .from(lorebooks)
    .where(and(inArray(lorebooks.id, ids), eq(lorebooks.hiddenFromLibrary, "false")));
  return new Set(rows.map((row) => row.id));
}

export function createLibraryCampaignsStorage(db: DB) {
  const signature = () => SOURCE_TABLES.map((table) => db._fileStore.getTableWriteGeneration(table)).join(":");

  async function load(options: { applyManualLinks: boolean }): Promise<LibraryCampaign[]> {
    const [chatRows, characterRows, personaRows, lorebookRows, characterLinkRows, personaLinkRows, linkRows] =
      await Promise.all([
        db
          .select({
            id: chats.id,
            name: chats.name,
            mode: chats.mode,
            groupId: chats.groupId,
            personaId: chats.personaId,
            characterIds: chats.characterIds,
            metadata: chats.metadata,
            lastMessageAt: chats.lastMessageAt,
            createdAt: chats.createdAt,
            updatedAt: chats.updatedAt,
          })
          .from(chats)
          .where(eq(chats.mode, "game")),
        db.select({ id: characters.id }).from(characters),
        db.select({ id: personas.id }).from(personas),
        db
          .select({
            id: lorebooks.id,
            characterId: lorebooks.characterId,
            personaId: lorebooks.personaId,
            chatId: lorebooks.chatId,
            hiddenFromLibrary: lorebooks.hiddenFromLibrary,
          })
          .from(lorebooks),
        db
          .select({ lorebookId: lorebookCharacterLinks.lorebookId, characterId: lorebookCharacterLinks.characterId })
          .from(lorebookCharacterLinks),
        db
          .select({ lorebookId: lorebookPersonaLinks.lorebookId, personaId: lorebookPersonaLinks.personaId })
          .from(lorebookPersonaLinks),
        db.select().from(libraryCampaignLinks),
      ]);
    return deriveLibraryCampaigns({
      chats: chatRows as CampaignChatRow[],
      lorebooks: lorebookRows,
      lorebookCharacterLinks: characterLinkRows,
      lorebookPersonaLinks: personaLinkRows,
      links: options.applyManualLinks ? linkRows : [],
      characterIds: new Set(characterRows.map((row) => row.id)),
      personaIds: new Set(personaRows.map((row) => row.id)),
    });
  }

  /** The campaign's manual rows of one type. Read inside the write transaction so concurrent edits never collide. */
  const readLinks = (handle: Pick<DB, "select">, campaignId: string, itemType: LibraryCampaignItemType) =>
    handle
      .select()
      .from(libraryCampaignLinks)
      .where(and(eq(libraryCampaignLinks.campaignId, campaignId), eq(libraryCampaignLinks.itemType, itemType)));

  /** What the campaign's chats reference on their own, to pick include vs exclude. */
  async function derivedMembership(campaignId: string, itemType: LibraryCampaignItemType) {
    const campaign = (await load({ applyManualLinks: false })).find((candidate) => candidate.id === campaignId);
    if (!campaign) return null;
    const derived = new Set(
      itemType === "character"
        ? campaign.characterIds
        : itemType === "persona"
          ? campaign.personaIds
          : campaign.lorebookIds,
    );
    return { derived };
  }

  async function list(): Promise<LibraryCampaign[]> {
    const cached = caches.get(db);
    const before = signature();
    if (cached?.signature === before) return cached.campaigns;
    const campaigns = await load({ applyManualLinks: true });
    if (signature() === before) caches.set(db, { signature: before, campaigns });
    return campaigns;
  }

  return {
    list,

    /** Library item ids of one type that belong to a campaign, or to any campaign. */
    async memberIds(itemType: LibraryCampaignItemType, campaignId: string | null): Promise<Set<string>> {
      const campaigns = await list();
      const ids = new Set<string>();
      for (const campaign of campaigns) {
        if (campaignId !== null && campaign.id !== campaignId) continue;
        const list =
          itemType === "character"
            ? campaign.characterIds
            : itemType === "persona"
              ? campaign.personaIds
              : campaign.lorebookIds;
        for (const id of list) ids.add(id);
      }
      return ids;
    },

    /** Returns false when the campaign does not exist. */
    async addItems(campaignId: string, itemType: LibraryCampaignItemType, itemIds: string[]) {
      assertCampaignRosterEnabled();
      const membership = await derivedMembership(campaignId, itemType);
      assertCampaignRosterEnabled();
      if (!membership) return false;
      const ids = Array.from(new Set(itemIds));
      const validIds = await existingLibraryItemIds(db, itemType, ids);
      assertCampaignRosterEnabled();
      await db.transaction(async (tx) => {
        const links = await readLinks(tx, campaignId, itemType);
        assertCampaignRosterEnabled();
        const existing = new Set(links.map((link) => link.itemId));
        const toDelete = ids.filter((id) => existing.has(id));
        if (toDelete.length > 0) {
          assertCampaignRosterEnabled();
          await tx
            .delete(libraryCampaignLinks)
            .where(
              and(
                eq(libraryCampaignLinks.campaignId, campaignId),
                eq(libraryCampaignLinks.itemType, itemType),
                inArray(libraryCampaignLinks.itemId, toDelete),
              ),
            );
        }
        const toInclude = ids.filter((id) => validIds.has(id) && !membership.derived.has(id));
        if (toInclude.length > 0) {
          assertCampaignRosterEnabled();
          const timestamp = now();
          await tx.insert(libraryCampaignLinks).values(
            toInclude.map((itemId) => ({
              id: newId(),
              campaignId,
              itemType,
              itemId,
              mode: "include" as const,
              createdAt: timestamp,
            })),
          );
        }
      });
      return true;
    },

    /** Returns false when the campaign does not exist. Derived items are hidden with an exclusion. */
    async removeItems(campaignId: string, itemType: LibraryCampaignItemType, itemIds: string[]) {
      assertCampaignRosterEnabled();
      const membership = await derivedMembership(campaignId, itemType);
      assertCampaignRosterEnabled();
      if (!membership) return false;
      const ids = Array.from(new Set(itemIds));
      await db.transaction(async (tx) => {
        const links = await readLinks(tx, campaignId, itemType);
        assertCampaignRosterEnabled();
        const existing = new Set(links.map((link) => link.itemId));
        const toDelete = ids.filter((id) => existing.has(id));
        if (toDelete.length > 0) {
          assertCampaignRosterEnabled();
          await tx
            .delete(libraryCampaignLinks)
            .where(
              and(
                eq(libraryCampaignLinks.campaignId, campaignId),
                eq(libraryCampaignLinks.itemType, itemType),
                inArray(libraryCampaignLinks.itemId, toDelete),
              ),
            );
        }
        const toExclude = ids.filter((id) => membership.derived.has(id));
        if (toExclude.length > 0) {
          assertCampaignRosterEnabled();
          const timestamp = now();
          await tx.insert(libraryCampaignLinks).values(
            toExclude.map((itemId) => ({
              id: newId(),
              campaignId,
              itemType,
              itemId,
              mode: "exclude" as const,
              createdAt: timestamp,
            })),
          );
        }
      });
      return true;
    },
  };
}
