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
  if (chat.mode !== "game") throw new Error("GAME_CHAT_NOT_GAME");
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
  const currentSession = sessionNumber(metadata);
  const isEligibleOrigin = (originChat: (typeof campaignChats)[number] | null | undefined) => {
    if (!originChat || !validChatIds.has(originChat.id)) return false;
    const originSession = sessionNumber(parseJson(originChat.metadata));
    return (
      originChat.id === chat.id ||
      (originSession !== null && currentSession !== null && originSession <= currentSession)
    );
  };
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
    (isEligibleOrigin(originChat) ? migrateEntryIds : skippedEntryIds).push(entry.id);
  }
  const removableBookIds = books
    .filter((book) => book.id !== canonical.id)
    .filter((book) => {
      const ownerChat = book.chatId ? campaignChats.find((candidate) => candidate.id === book.chatId) : null;
      if (!isEligibleOrigin(ownerChat)) return false;
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

/** Apply an eligible consolidation after re-planning under the durable transaction gate. */
export async function consolidateGameKeeperLorebooks(
  db: DB,
  chatId: string,
  options: { apply?: boolean; isEnabled?: () => boolean } = {},
) {
  const plan = await planGameKeeperLorebookConsolidation(db, chatId);
  const assertApplyEnabled = () => {
    if (options.isEnabled && !options.isEnabled()) throw new Error("GAME_KEEPER_CONSOLIDATION_DISABLED");
  };
  if (options.apply) assertApplyEnabled();
  if (!options.apply || !plan.canonicalBookId) return { ...plan, applied: false };
  let appliedPlan = plan;
  let applyConflict: "CANONICAL_BOOK_DISAPPEARED" | undefined;
  await db.transaction(
    async (tx) => {
      // Re-read the plan under the durable transaction gate so a concurrent Keeper
      // write cannot move an entry or delete a book based on stale review data.
      appliedPlan = await planGameKeeperLorebookConsolidation(tx, chatId);
      assertApplyEnabled();
      if (!appliedPlan.canonicalBookId) {
        applyConflict = "CANONICAL_BOOK_DISAPPEARED";
        return;
      }
      // Recheck opt-in after the transaction re-plan and immediately before mutations.
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
        assertApplyEnabled();
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
      for (const folder of folders) {
        assertApplyEnabled();
        await tx
          .update(lorebookFolders)
          .set({ lorebookId: canonicalId, updatedAt: timestamp })
          .where(eq(lorebookFolders.id, folder.id));
      }
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
          if (!exists[0]) {
            assertApplyEnabled();
            await tx.insert(lorebookCharacterLinks).values({
              ...link,
              id: createHash("sha256").update(`${canonicalId}:${link.characterId}`).digest("hex").slice(0, 32),
              lorebookId: canonicalId,
            });
          }
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
          if (!exists[0]) {
            assertApplyEnabled();
            await tx.insert(lorebookPersonaLinks).values({
              ...link,
              id: createHash("sha256").update(`${canonicalId}:p:${link.personaId}`).digest("hex").slice(0, 32),
              lorebookId: canonicalId,
            });
          }
        }
        const remaining = await tx
          .select({ id: lorebookEntries.id })
          .from(lorebookEntries)
          .where(eq(lorebookEntries.lorebookId, bookId));
        if (remaining.length === 0) {
          assertApplyEnabled();
          await tx.delete(lorebookCharacterLinks).where(eq(lorebookCharacterLinks.lorebookId, bookId));
          assertApplyEnabled();
          await tx.delete(lorebookPersonaLinks).where(eq(lorebookPersonaLinks.lorebookId, bookId));
          assertApplyEnabled();
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
        if (changed) {
          assertApplyEnabled();
          await tx
            .update(chats)
            .set({ metadata: JSON.stringify(meta), updatedAt: timestamp })
            .where(eq(chats.id, affected.id));
        }
      }
    },
    { durable: true },
  );
  return applyConflict
    ? { ...appliedPlan, applied: false, conflict: applyConflict }
    : { ...appliedPlan, applied: true };
}
