import { z } from "zod";

const libraryFolderIdSchema = z.string().min(1).max(256);
const libraryFolderItemIdsSchema = z
  .array(libraryFolderIdSchema)
  .max(10_000)
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Item IDs must be unique" });
    }
  });
const nonEmptyLibraryFolderItemIdsSchema = z
  .array(libraryFolderIdSchema)
  .min(1)
  .max(10_000)
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Item IDs must be unique" });
    }
  });

export const libraryFolderScopeSchema = z.enum(["lorebooks", "presets", "agents"]);

export const libraryFolderScopeParamsSchema = z.object({
  scope: libraryFolderScopeSchema,
});

export const libraryFolderParamsSchema = libraryFolderScopeParamsSchema.extend({
  id: libraryFolderIdSchema,
});

export const createLibraryFolderSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** Parent folder for a nested folder; omitted or null creates a root folder. */
  parentId: libraryFolderIdSchema.nullable().optional(),
});

export const updateLibraryFolderSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  collapsed: z.boolean().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
  itemIds: libraryFolderItemIdsSchema.optional(),
  /** Move the folder under another folder, or to the root with null. */
  parentId: libraryFolderIdSchema.nullable().optional(),
});

export const moveLibraryItemsSchema = z.object({
  itemIds: nonEmptyLibraryFolderItemIdsSchema,
  folderId: libraryFolderIdSchema.nullable(),
});

export const migrateLibraryFolderSchema = z.object({
  id: libraryFolderIdSchema,
  name: z.string().trim().min(1).max(200),
  collapsed: z.boolean().optional().default(false),
  sortOrder: z.number().int().nonnegative(),
  itemIds: libraryFolderItemIdsSchema,
});

export const migrateLibraryFoldersSchema = z
  .object({
    folders: z.array(migrateLibraryFolderSchema).max(1_000),
  })
  .superRefine(({ folders }, ctx) => {
    const seen = new Set<string>();
    folders.forEach((folder, index) => {
      if (seen.has(folder.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["folders", index, "id"],
          message: "Folder IDs must be unique",
        });
      }
      seen.add(folder.id);
    });
  });

/** Enable or disable many lorebooks at once (a library folder's subtree); ids that do not exist are skipped. */
export const setLorebooksEnabledSchema = z.object({
  ids: libraryFolderItemIdsSchema.refine((ids) => ids.length > 0, "Pick at least one lorebook"),
  enabled: z.boolean(),
});

export type LibraryFolderScope = z.infer<typeof libraryFolderScopeSchema>;
export type CreateLibraryFolderInput = z.infer<typeof createLibraryFolderSchema>;
export type UpdateLibraryFolderInput = z.infer<typeof updateLibraryFolderSchema>;
export type MoveLibraryItemsInput = z.infer<typeof moveLibraryItemsSchema>;
export type MigrateLibraryFolderInput = z.infer<typeof migrateLibraryFolderSchema>;
export type MigrateLibraryFoldersInput = z.infer<typeof migrateLibraryFoldersSchema>;
export type SetLorebooksEnabledInput = z.infer<typeof setLorebooksEnabledSchema>;

/** Result of a bulk enable/disable: only `changedIds` flipped, so undo flips exactly those back. */
export interface SetLorebooksEnabledResult {
  changedIds: string[];
  unchangedIds: string[];
  missingIds: string[];
}
