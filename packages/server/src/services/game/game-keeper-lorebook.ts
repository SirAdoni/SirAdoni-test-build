import { createHash } from "node:crypto";
import type { DB } from "../../db/connection.js";
import { and, eq, inArray } from "../../db/file-query.js";
import {
  chats,
  lorebookCharacterLinks,
  lorebookEntries,
  lorebookFolders,
  lorebookPersonaLinks,
  lorebooks,
} from "../../db/schema/index.js";
import { GAME_LOREBOOK_KEEPER_SOURCE_ID } from "../lorebook/game-lorebook-scope.js";

const NAME = "Game - Lorebook Keeper";

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function campaignIdentity(chatId: string, metadata: Record<string, unknown>, groupId?: string | null): string {
  const gameId = typeof metadata.gameId === "string" && metadata.gameId.trim() ? metadata.gameId.trim() : null;
  return gameId ?? (groupId?.trim() || chatId);
}

function isBranch(metadata: Record<string, unknown>): boolean {
  return ["branchParentChatId", "branchName"].some((key) => typeof metadata[key] === "string" && metadata[key].trim());
}

function sessionNumber(metadata: Record<string, unknown>): number | null {
  const value = metadata.gameSessionNumber;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export type KeeperConsolidationPlan = {
  campaignId: string;
  canonicalBookId: string | null;
  candidateBookIds: string[];
  migrateEntryIds: string[];
  skippedEntryIds: string[];
  removeBookIds: string[];
  duplicateSessionNumbers: number[];
};

type RawEntry = typeof lorebookEntries.$inferSelect;

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Build an applyable plan without writing. Branches and ambiguous session numbers are excluded. */
export async function planGameKeeperLorebookConsolidation(db: DB, chatId: string): Promise<KeeperConsolidationPlan> {
  const chat = (await db.select().from(chats).where(eq(chats.id, chatId)).limit(1))[0];
  if (!chat) throw new Error("GAME_CHAT_NOT_FOUND");
  const metadata = parseJson(chat.metadata);
  const campaignId = campaignIdentity(chat.id, metadata, chat.groupId);
  const currentIsBranch = isBranch(metadata);
  const allChats = await db.select().from(chats);
  let campaignChats = allChats.filter((candidate) => {
    const candidateMeta = parseJson(candidate.metadata);
    return (
      candidate.mode === "game" &&
      !isBranch(candidateMeta) &&
      campaignIdentity(candidate.id, candidateMeta, candidate.groupId) === campaignId
    );
  });
  if (currentIsBranch) campaignChats = [chat];
  const sessionCounts = new Map<number, number>();
  for (const candidate of campaignChats) {
    const number = sessionNumber(parseJson(candidate.metadata));
    if (number !== null) sessionCounts.set(number, (sessionCounts.get(number) ?? 0) + 1);
  }
  const duplicateSessionNumbers = [...sessionCounts].filter(([, count]) => count > 1).map(([number]) => number);
  const campaignChatIds = campaignChats.map((candidate) => candidate.id);
  const books = (await db.select().from(lorebooks)).filter(
    (book) =>
      book.sourceAgentId === GAME_LOREBOOK_KEEPER_SOURCE_ID &&
      book.isGlobal !== "true" &&
      book.characterId === null &&
      book.personaId === null &&
      book.chatId !== null &&
      campaignChatIds.includes(book.chatId),
  );
  const canonical =
    [...books].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0] ?? null;
  if (!canonical)
    return {
      campaignId,
      canonicalBookId: null,
      candidateBookIds: [],
      migrateEntryIds: [],
      skippedEntryIds: [],
      removeBookIds: [],
      duplicateSessionNumbers,
    };
  const validChatIds = new Set(
    campaignChats
      .filter((candidate) => {
        const number = sessionNumber(parseJson(candidate.metadata));
        return number === null || !duplicateSessionNumbers.includes(number);
      })
      .map((candidate) => candidate.id),
  );
  const entries = await db
    .select()
    .from(lorebookEntries)
    .where(
      inArray(
        lorebookEntries.lorebookId,
        books.map((book) => book.id),
      ),
    );
  const migrateEntryIds: string[] = [];
  const skippedEntryIds: string[] = [];
  for (const entry of entries as RawEntry[]) {
    if (entry.lorebookId === canonical.id) continue;
    const state = parseJson(entry.dynamicState);
    const donorChatId = books.find((book) => book.id === entry.lorebookId)?.chatId;
    const origin =
      typeof state.keeperSourceChatId === "string" && state.keeperSourceChatId.trim()
        ? state.keeperSourceChatId.trim()
        : donorChatId;
    const originChat = origin ? campaignChats.find((candidate) => candidate.id === origin) : null;
    const originSession = originChat ? sessionNumber(parseJson(originChat.metadata)) : null;
    const currentSession = sessionNumber(metadata);
    const eligible = Boolean(
      originChat &&
      validChatIds.has(originChat.id) &&
      (origin === chat.id || (originSession !== null && currentSession !== null && originSession <= currentSession)),
    );
    (eligible ? migrateEntryIds : skippedEntryIds).push(entry.id);
  }
  const removableBookIds = books
    .filter((book) => book.id !== canonical.id)
    .filter((book) => {
      const bookEntryIds = (entries as RawEntry[])
        .filter((entry) => entry.lorebookId === book.id)
        .map((entry) => entry.id);
      return bookEntryIds.every((id) => migrateEntryIds.includes(id));
    })
    .map((book) => book.id);
  const movableEntryIds = migrateEntryIds.filter((entryId) => {
    const ownerBookId = (entries as RawEntry[]).find((entry) => entry.id === entryId)?.lorebookId;
    return ownerBookId === canonical.id || removableBookIds.includes(ownerBookId ?? "");
  });
  return {
    campaignId,
    canonicalBookId: canonical.id,
    candidateBookIds: books.map((book) => book.id),
    migrateEntryIds: movableEntryIds,
    skippedEntryIds: [
      ...new Set([...skippedEntryIds, ...migrateEntryIds.filter((id) => !movableEntryIds.includes(id))]),
    ],
    removeBookIds: removableBookIds,
    duplicateSessionNumbers,
  };
}

/** Apply a previously reviewed consolidation atomically. IDs and entry content are preserved. */
export async function consolidateGameKeeperLorebooks(db: DB, chatId: string, options: { apply?: boolean } = {}) {
  const plan = await planGameKeeperLorebookConsolidation(db, chatId);
  if (!options.apply || !plan.canonicalBookId) return { ...plan, applied: false };
  let appliedPlan = plan;
  await db.transaction(
    async (tx) => {
      // Re-read the plan under the durable transaction gate so a concurrent Keeper
      // write cannot move an entry or delete a book based on stale review data.
      appliedPlan = await planGameKeeperLorebookConsolidation(tx, chatId);
      if (!appliedPlan.canonicalBookId) return;
      const canonicalId = appliedPlan.canonicalBookId;
      const timestamp = new Date().toISOString();
      for (const entryId of appliedPlan.migrateEntryIds) {
        const row = (await tx.select().from(lorebookEntries).where(eq(lorebookEntries.id, entryId)).limit(1))[0];
        if (!row || row.lorebookId === canonicalId) continue;
        const state = parseJson(row.dynamicState);
        if (!state.keeperSourceChatId) {
          const donor = (
            await tx
              .select({ chatId: lorebooks.chatId })
              .from(lorebooks)
              .where(eq(lorebooks.id, row.lorebookId))
              .limit(1)
          )[0];
          state.keeperSourceChatId = donor?.chatId ?? null;
        }
        await tx
          .update(lorebookEntries)
          .set({ lorebookId: canonicalId, dynamicState: JSON.stringify(state) })
          .where(eq(lorebookEntries.id, entryId));
      }
      // A donor book with any ineligible entry must remain intact; moving its
      // folders/links would orphan the skipped entry's book context.
      const removableBookIds = appliedPlan.removeBookIds;
      const allBookEntries = await tx
        .select()
        .from(lorebookEntries)
        .where(inArray(lorebookEntries.lorebookId, removableBookIds));
      const removable = removableBookIds.filter((bookId) =>
        allBookEntries
          .filter((entry) => entry.lorebookId === bookId)
          .every((entry) => appliedPlan.migrateEntryIds.includes(entry.id)),
      );
      const folders = await tx.select().from(lorebookFolders).where(inArray(lorebookFolders.lorebookId, removable));
      for (const folder of folders)
        await tx
          .update(lorebookFolders)
          .set({ lorebookId: canonicalId, updatedAt: timestamp })
          .where(eq(lorebookFolders.id, folder.id));
      for (const bookId of removable) {
        const chars = await tx
          .select()
          .from(lorebookCharacterLinks)
          .where(eq(lorebookCharacterLinks.lorebookId, bookId));
        for (const link of chars) {
          const exists = await tx
            .select()
            .from(lorebookCharacterLinks)
            .where(
              and(
                eq(lorebookCharacterLinks.lorebookId, canonicalId),
                eq(lorebookCharacterLinks.characterId, link.characterId),
              ),
            )
            .limit(1);
          if (!exists[0])
            await tx.insert(lorebookCharacterLinks).values({
              ...link,
              id: createHash("sha256").update(`${canonicalId}:${link.characterId}`).digest("hex").slice(0, 32),
              lorebookId: canonicalId,
            });
        }
        const personas = await tx
          .select()
          .from(lorebookPersonaLinks)
          .where(eq(lorebookPersonaLinks.lorebookId, bookId));
        for (const link of personas) {
          const exists = await tx
            .select()
            .from(lorebookPersonaLinks)
            .where(
              and(eq(lorebookPersonaLinks.lorebookId, canonicalId), eq(lorebookPersonaLinks.personaId, link.personaId)),
            )
            .limit(1);
          if (!exists[0])
            await tx.insert(lorebookPersonaLinks).values({
              ...link,
              id: createHash("sha256").update(`${canonicalId}:p:${link.personaId}`).digest("hex").slice(0, 32),
              lorebookId: canonicalId,
            });
        }
        const remaining = await tx
          .select({ id: lorebookEntries.id })
          .from(lorebookEntries)
          .where(eq(lorebookEntries.lorebookId, bookId));
        if (remaining.length === 0) {
          await tx.delete(lorebookCharacterLinks).where(eq(lorebookCharacterLinks.lorebookId, bookId));
          await tx.delete(lorebookPersonaLinks).where(eq(lorebookPersonaLinks.lorebookId, bookId));
          await tx.delete(lorebooks).where(eq(lorebooks.id, bookId));
        }
      }
      const affectedChats = await tx.select().from(chats);
      for (const affected of affectedChats) {
        const meta = parseJson(affected.metadata);
        let changed = false;
        for (const key of ["activeLorebookIds", "excludedLorebookIds"] as const) {
          if (!Array.isArray(meta[key])) continue;
          const next = [
            ...new Set(
              meta[key]
                .filter((id): id is string => typeof id === "string")
                .map((id) => (removable.includes(id) ? canonicalId : id)),
            ),
          ];
          if (JSON.stringify(next) !== JSON.stringify(meta[key])) {
            meta[key] = next;
            changed = true;
          }
        }
        if (
          typeof meta.gameLorebookKeeperLorebookId === "string" &&
          removable.includes(meta.gameLorebookKeeperLorebookId)
        ) {
          meta.gameLorebookKeeperLorebookId = canonicalId;
          changed = true;
        }
        if (changed)
          await tx
            .update(chats)
            .set({ metadata: JSON.stringify(meta), updatedAt: timestamp })
            .where(eq(chats.id, affected.id));
      }
    },
    { durable: true },
  );
  return { ...appliedPlan, applied: true };
}

/** Fail-closed prompt eligibility for Keeper entries, including legacy rows without an origin stamp. */
export async function filterEligibleGameKeeperEntries<
  T extends { id: string; lorebookId: string; dynamicState?: unknown },
>(
  db: DB,
  currentChatId: string,
  entries: T[],
  books: Array<{ id: string; sourceAgentId?: string | null; chatId?: string | null }>,
): Promise<T[]> {
  const current = (await db.select().from(chats).where(eq(chats.id, currentChatId)).limit(1))[0];
  if (!current) return [];
  const currentMeta = parseJson(current.metadata);
  const currentNumber = sessionNumber(currentMeta);
  const currentIsBranch = isBranch(currentMeta);
  const identity = campaignIdentity(current.id, currentMeta, current.groupId);
  const allChats = await db.select().from(chats);
  const campaignChats = allChats.filter((candidate) => {
    const meta = parseJson(candidate.metadata);
    return (
      candidate.mode === "game" &&
      !isBranch(meta) &&
      campaignIdentity(candidate.id, meta, candidate.groupId) === identity
    );
  });
  const counts = new Map<number, number>();
  for (const candidate of campaignChats) {
    const n = sessionNumber(parseJson(candidate.metadata));
    if (n !== null) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const chatsById = new Map(campaignChats.map((candidate) => [candidate.id, candidate]));
  const booksById = new Map(books.map((book) => [book.id, book]));
  return entries.filter((entry) => {
    const book = booksById.get(entry.lorebookId);
    if (!book || book.sourceAgentId !== GAME_LOREBOOK_KEEPER_SOURCE_ID) return true;
    const state = parseJson(entry.dynamicState);
    const stamped =
      typeof state.keeperSourceChatId === "string" && state.keeperSourceChatId.trim()
        ? state.keeperSourceChatId.trim()
        : null;
    const originId = stamped ?? book.chatId ?? null;
    if (originId === currentChatId) return true;
    if (currentIsBranch) return false;
    if (!originId) return false;
    const origin = chatsById.get(originId);
    if (!origin) return false;
    const originNumber = sessionNumber(parseJson(origin.metadata));
    return (
      currentNumber !== null &&
      originNumber !== null &&
      originNumber <= currentNumber &&
      counts.get(currentNumber) === 1 &&
      counts.get(originNumber) === 1
    );
  });
}

export async function resolveGameKeeperLorebook(tx: DB, chatId: string, metadata: Record<string, unknown>) {
  const chat = (await tx.select().from(chats).where(eq(chats.id, chatId)).limit(1))[0];
  if (!chat) return null;
  const identity = campaignIdentity(chatId, metadata, chat.groupId);
  const currentIsBranch = isBranch(jsonObject(chat.metadata));
  const allChats = await tx.select().from(chats);
  const campaignChatIds = allChats
    .filter((candidate) => {
      const candidateMeta = jsonObject(candidate.metadata);
      return (
        candidate.mode === "game" &&
        !isBranch(candidateMeta) &&
        campaignIdentity(candidate.id, candidateMeta, candidate.groupId) === identity
      );
    })
    .map((candidate) => candidate.id);
  const currentSession = sessionNumber(metadata);
  const ambiguousSession =
    currentSession !== null &&
    allChats.filter(
      (candidate) =>
        campaignChatIds.includes(candidate.id) && sessionNumber(jsonObject(candidate.metadata)) === currentSession,
    ).length > 1;
  const isolatedScope = currentIsBranch || ambiguousSession;
  if (isolatedScope) campaignChatIds.splice(0, campaignChatIds.length, chatId);
  const candidates = (await tx.select().from(lorebooks))
    .filter(
      (book) =>
        book.sourceAgentId === GAME_LOREBOOK_KEEPER_SOURCE_ID &&
        book.isGlobal !== "true" &&
        book.characterId === null &&
        book.personaId === null &&
        book.chatId !== null &&
        campaignChatIds.includes(book.chatId),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const attachKeeperBook = async (bookId: string) => {
    const currentMetadata = jsonObject(chat.metadata);
    const active = Array.isArray(currentMetadata.activeLorebookIds)
      ? currentMetadata.activeLorebookIds.filter((id): id is string => typeof id === "string")
      : [];
    const nextActive = [...new Set([...active, bookId])];
    if (
      JSON.stringify(nextActive) !== JSON.stringify(active) ||
      currentMetadata.gameLorebookKeeperLorebookId !== bookId
    ) {
      await tx
        .update(chats)
        .set({
          metadata: JSON.stringify({
            ...currentMetadata,
            activeLorebookIds: nextActive,
            gameLorebookKeeperLorebookId: bookId,
          }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(chats.id, chatId));
    }
  };
  const canonical = candidates[0];
  if (canonical) {
    await attachKeeperBook(canonical.id);
    return canonical;
  }
  const id = `glk_campaign_${createHash("sha256")
    .update(isolatedScope ? JSON.stringify([identity, chatId]) : identity)
    .digest("hex")
    .slice(0, 32)}`;
  // A book with this deterministic id can survive its owning chat (chat deletion does not remove
  // lorebooks) or outlive a metadata change on that chat. Adopt it instead of inserting a duplicate
  // primary key, which would make every later Keeper write for the campaign fail.
  const existing = (await tx.select().from(lorebooks).where(eq(lorebooks.id, id)).limit(1))[0];
  if (existing) {
    if (existing.sourceAgentId !== GAME_LOREBOOK_KEEPER_SOURCE_ID) return null;
    if (existing.chatId === null || !campaignChatIds.includes(existing.chatId)) {
      await tx.update(lorebooks).set({ chatId, updatedAt: new Date().toISOString() }).where(eq(lorebooks.id, id));
    }
    await attachKeeperBook(id);
    return (await tx.select().from(lorebooks).where(eq(lorebooks.id, id)).limit(1))[0] ?? null;
  }
  const timestamp = new Date().toISOString();
  await tx.insert(lorebooks).values({
    id,
    name: NAME,
    description: "Game-scoped lorebook maintained by the Lorebook Keeper.",
    category: "world",
    chatId,
    enabled: "true",
    generatedBy: "agent",
    sourceAgentId: GAME_LOREBOOK_KEEPER_SOURCE_ID,
    tags: JSON.stringify(["game", "lorebook-keeper", `campaign:${identity}`]),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return (await tx.select().from(lorebooks).where(eq(lorebooks.id, id)).limit(1))[0] ?? null;
}
