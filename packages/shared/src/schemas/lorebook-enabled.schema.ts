import { z } from "zod";

const lorebookIdsSchema = z
  .array(z.string().trim().min(1).max(256))
  .min(1)
  .max(10_000)
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Lorebook IDs must be unique" });
    }
  });

/** Enable or disable a selection or folder subtree; nonexistent IDs are reported without changes. */
export const setLorebooksEnabledSchema = z.object({
  ids: lorebookIdsSchema,
  enabled: z.boolean(),
});

export type SetLorebooksEnabledInput = z.infer<typeof setLorebooksEnabledSchema>;

/** Only changedIds flipped, so Undo must target exactly those IDs. */
export interface SetLorebooksEnabledResult {
  changedIds: string[];
  unchangedIds: string[];
  missingIds: string[];
}
