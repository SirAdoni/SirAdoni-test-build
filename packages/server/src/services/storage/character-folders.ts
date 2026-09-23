// ──────────────────────────────────────────────
// Character folders: nesting rules for character groups
// Character groups double as the Characters panel folders
// (and as "add these characters" presets in chat setup).
// parentId nests them; the tree rules live in shared.
// ──────────────────────────────────────────────
import { checkLibraryFolderParent, planLibraryFolderDelete } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { characterGroups } from "../../db/schema/index.js";
import { LibraryFolderTreeError } from "./library-folders.storage.js";

/**
 * Throws LibraryFolderTreeError when `groupId` (null = a new group) may not live under `parentId`.
 * Pass the transaction handle so the check and the write that follows see the same rows.
 */
export async function assertCharacterGroupParent(
  db: Pick<DB, "select">,
  groupId: string | null,
  parentId: string | null,
) {
  if (parentId === null && groupId === null) return;
  const rows = await db.select({ id: characterGroups.id, parentId: characterGroups.parentId }).from(characterGroups);
  const check = checkLibraryFolderParent(
    rows.map((row) => ({ id: row.id, parentId: row.parentId ?? null })),
    groupId,
    parentId,
  );
  if (!check.ok) throw new LibraryFolderTreeError(check.code, check.reason);
}

/**
 * Delete a group while keeping its subgroups: they move up to its parent (or the
 * root). Its characters simply leave the folder. They are not merged into the
 * parent group, because every group is also a chat setup preset and deleting a
 * subfolder must not change who the parent preset adds to a chat.
 */
export async function removeCharacterGroupKeepingContents(db: DB, id: string) {
  await db.transaction(async (tx) => {
    const rows = await tx.select().from(characterGroups);
    const plan = planLibraryFolderDelete(
      rows.map((row) => ({ id: row.id, parentId: row.parentId ?? null, itemIds: [] })),
      id,
    );
    // updatedAt stays put: groups are listed newest-updated first, and a
    // re-parented subgroup should keep its place instead of jumping to the top.
    for (const childId of plan?.childIds ?? []) {
      await tx.update(characterGroups).set({ parentId: plan!.parentId }).where(eq(characterGroups.id, childId));
    }
    await tx.delete(characterGroups).where(eq(characterGroups.id, id));
  });
}
