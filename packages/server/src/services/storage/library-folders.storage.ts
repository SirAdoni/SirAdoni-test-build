// ──────────────────────────────────────────────
// Storage: Resource Library Folders
// ──────────────────────────────────────────────
import {
  checkLibraryFolderParent,
  planLibraryFolderDelete,
  type CreateLibraryFolderInput,
  type LibraryFolderMoveErrorCode,
  type LibraryFolderScope,
  type MigrateLibraryFoldersInput,
  type MoveLibraryItemsInput,
  type UpdateLibraryFolderInput,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { libraryFolders } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";

type LibraryFolderRow = typeof libraryFolders.$inferSelect;

/** A rejected nesting change (missing parent, cycle or too deep); routes answer 400. */
export class LibraryFolderTreeError extends Error {
  constructor(
    readonly code: LibraryFolderMoveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LibraryFolderTreeError";
  }
}

function assertParent(rows: LibraryFolderRow[], folderId: string | null, parentId: string | null) {
  const check = checkLibraryFolderParent(
    rows.map((row) => ({ id: row.id, parentId: row.parentId ?? null })),
    folderId,
    parentId,
  );
  if (!check.ok) throw new LibraryFolderTreeError(check.code, check.reason);
}

function parseItemIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function mapFolder(row: LibraryFolderRow) {
  return {
    id: row.id,
    scope: row.scope as LibraryFolderScope,
    name: row.name,
    collapsed: row.collapsed === "true",
    sortOrder: row.sortOrder,
    itemIds: parseItemIds(row.itemIds),
    parentId: row.parentId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Drop deleted items from every folder of a scope, inside the caller's transaction when given one. */
export async function removeItemsFromLibraryFolders(
  db: Pick<DB, "select" | "update">,
  scope: LibraryFolderScope,
  itemIds: readonly string[],
) {
  if (itemIds.length === 0) return;
  const removing = new Set(itemIds);
  const rows = await db.select().from(libraryFolders).where(eq(libraryFolders.scope, scope));
  const timestamp = now();
  for (const row of rows) {
    const current = parseItemIds(row.itemIds);
    const next = current.filter((id) => !removing.has(id));
    if (next.length === current.length) continue;
    await db
      .update(libraryFolders)
      .set({ itemIds: JSON.stringify(next), updatedAt: timestamp })
      .where(eq(libraryFolders.id, row.id));
  }
}

export function createLibraryFoldersStorage(db: DB) {
  const listRows = (scope: LibraryFolderScope, handle: Pick<DB, "select"> = db) =>
    handle.select().from(libraryFolders).where(eq(libraryFolders.scope, scope)).orderBy(libraryFolders.sortOrder);

  return {
    async list(scope: LibraryFolderScope) {
      return (await listRows(scope)).map(mapFolder);
    },

    async getById(scope: LibraryFolderScope, id: string) {
      const rows = await db.select().from(libraryFolders).where(eq(libraryFolders.id, id));
      const row = rows.find((candidate) => candidate.scope === scope);
      return row ? mapFolder(row) : null;
    },

    async create(scope: LibraryFolderScope, input: CreateLibraryFolderInput) {
      const id = newId();
      const timestamp = now();
      const parentId = input.parentId ?? null;
      // Check and write in one transaction: a concurrent move or delete must not
      // slip in between and leave the new folder under a vanished parent.
      await db.transaction(async (tx) => {
        const existing = await listRows(scope, tx);
        assertParent(existing, null, parentId);
        const nextSortOrder = existing.reduce((maximum, folder) => Math.max(maximum, folder.sortOrder), -1) + 1;
        await tx.insert(libraryFolders).values({
          id,
          scope,
          name: input.name,
          collapsed: "false",
          sortOrder: nextSortOrder,
          itemIds: "[]",
          parentId,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      });
      return this.getById(scope, id);
    },

    async update(scope: LibraryFolderScope, id: string, input: UpdateLibraryFolderInput) {
      // Check and write in one transaction: two concurrent moves (A under B, B
      // under A) would each pass the cycle check on their own and form a loop.
      const updated = await db.transaction(async (tx) => {
        const rows = await listRows(scope, tx);
        if (!rows.some((row) => row.id === id)) return false;
        if (input.parentId !== undefined) assertParent(rows, id, input.parentId);
        await tx
          .update(libraryFolders)
          .set({
            ...(input.name !== undefined && { name: input.name }),
            ...(input.collapsed !== undefined && { collapsed: input.collapsed ? "true" : "false" }),
            ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
            ...(input.itemIds !== undefined && { itemIds: JSON.stringify(input.itemIds) }),
            ...(input.parentId !== undefined && { parentId: input.parentId }),
            updatedAt: now(),
          })
          .where(eq(libraryFolders.id, id));
        return true;
      });
      return updated ? this.getById(scope, id) : null;
    },

    async remove(scope: LibraryFolderScope, id: string) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(libraryFolders)
          .where(eq(libraryFolders.scope, scope))
          .orderBy(libraryFolders.sortOrder);
        const plan = planLibraryFolderDelete(
          rows.map((row) => ({ id: row.id, parentId: row.parentId ?? null, itemIds: parseItemIds(row.itemIds) })),
          id,
        );
        if (!plan) return false;
        // Subfolders and items move up one level instead of disappearing with the folder.
        const timestamp = now();
        for (const childId of plan.childIds) {
          await tx
            .update(libraryFolders)
            .set({ parentId: plan.parentId, updatedAt: timestamp })
            .where(eq(libraryFolders.id, childId));
        }
        const parentRow = plan.parentId ? rows.find((row) => row.id === plan.parentId) : undefined;
        if (parentRow && plan.itemIdsForParent.length > 0) {
          await tx
            .update(libraryFolders)
            .set({
              itemIds: JSON.stringify([...parseItemIds(parentRow.itemIds), ...plan.itemIdsForParent]),
              updatedAt: timestamp,
            })
            .where(eq(libraryFolders.id, parentRow.id));
        }
        await tx.delete(libraryFolders).where(eq(libraryFolders.id, id));
        return true;
      });
    },

    async moveItems(scope: LibraryFolderScope, input: MoveLibraryItemsInput) {
      const movingIds = new Set(input.itemIds);
      const timestamp = now();
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(libraryFolders)
          .where(eq(libraryFolders.scope, scope))
          .orderBy(libraryFolders.sortOrder);
        if (input.folderId !== null && !rows.some((folder) => folder.id === input.folderId)) return false;

        for (const folder of rows) {
          const currentIds = parseItemIds(folder.itemIds);
          const nextIds = currentIds.filter((id) => !movingIds.has(id));
          if (folder.id === input.folderId) nextIds.push(...input.itemIds);
          if (folder.id !== input.folderId && nextIds.length === currentIds.length) continue;
          await tx
            .update(libraryFolders)
            .set({ itemIds: JSON.stringify(nextIds), updatedAt: timestamp })
            .where(eq(libraryFolders.id, folder.id));
        }
        return true;
      });
    },

    async migrate(scope: LibraryFolderScope, input: MigrateLibraryFoldersInput) {
      const existing = await listRows(scope);
      if (existing.length > 0 || input.folders.length === 0) {
        return { imported: false, folders: existing.map(mapFolder) };
      }

      const timestamp = now();
      await db.transaction(async (tx) => {
        for (const folder of input.folders) {
          await tx.insert(libraryFolders).values({
            id: folder.id,
            scope,
            name: folder.name,
            collapsed: folder.collapsed ? "true" : "false",
            sortOrder: folder.sortOrder,
            itemIds: JSON.stringify(folder.itemIds),
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        }
      });
      return { imported: true, folders: (await listRows(scope)).map(mapFolder) };
    },
  };
}
