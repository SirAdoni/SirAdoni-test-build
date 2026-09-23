// ──────────────────────────────────────────────
// Storage: Chat Folders
// ──────────────────────────────────────────────
import { eq } from "../../db/file-query.js";
import type { CreateChatFolderInput, UpdateFolderInput } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { chatFolders, chats } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";

export function createChatFoldersStorage(db: DB) {
  return {
    async list() {
      return db.select().from(chatFolders).orderBy(chatFolders.sortOrder);
    },

    async getById(id: string) {
      const rows = await db.select().from(chatFolders).where(eq(chatFolders.id, id));
      return rows[0] ?? null;
    },

    async create(input: CreateChatFolderInput) {
      const id = newId();
      const timestamp = now();
      // Shift existing folders down and place new folder at the top.
      // Atomic so a partial failure can't leave the sort_order column in a
      // half-shifted state with no new folder.
      await db.transaction(async (tx) => {
        const existing = await tx.select().from(chatFolders);
        for (const folder of existing) {
          await tx
            .update(chatFolders)
            .set({ sortOrder: folder.sortOrder + 1 })
            .where(eq(chatFolders.id, folder.id));
        }
        await tx.insert(chatFolders).values({
          id,
          name: input.name,
          mode: input.mode,
          color: input.color ?? "",
          sortOrder: 0,
          collapsed: "false",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      });
      return this.getById(id);
    },

    async update(id: string, data: UpdateFolderInput) {
      await db
        .update(chatFolders)
        .set({
          ...(data.name !== undefined && { name: data.name }),
          ...(data.color !== undefined && { color: data.color }),
          ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
          ...(data.collapsed !== undefined && { collapsed: data.collapsed ? "true" : "false" }),
          updatedAt: now(),
        })
        .where(eq(chatFolders.id, id));
      return this.getById(id);
    },

    async remove(id: string) {
      // Unfile all chats in this folder (move back to root)
      await db.update(chats).set({ folderId: null }).where(eq(chats.folderId, id));
      await db.delete(chatFolders).where(eq(chatFolders.id, id));
    },

    async reorder(orderedIds: string[]) {
      // Atomic: a partial failure mid-loop would leave the folder list with
      // mixed sort orders. Folder counts are O(dozens) per user, well below
      // the size that would make a single storage operation excessively large.
      const timestamp = now();
      await db.transaction(async (tx) => {
        for (let index = 0; index < orderedIds.length; index++) {
          await tx
            .update(chatFolders)
            .set({ sortOrder: index, updatedAt: timestamp })
            .where(eq(chatFolders.id, orderedIds[index]!));
        }
      });
    },
  };
}
