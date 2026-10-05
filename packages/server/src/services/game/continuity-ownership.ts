import { z } from "zod";

export const continuityOwnershipSchema = z
  .object({
    lorebook: z.enum(["keeper", "continuity"]),
    fromSession: z.number().int().min(1),
  })
  .strict();

export type ContinuityOwnership = z.infer<typeof continuityOwnershipSchema>;

export function readContinuityOwnership(value: unknown): ContinuityOwnership | null {
  const parsed = continuityOwnershipSchema.safeParse(
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).ownership
      : undefined,
  );
  return parsed.success ? parsed.data : null;
}

export function keeperDisabledByContinuity(args: {
  continuityActive: boolean;
  ownership: ContinuityOwnership | null;
  sessionNumber: number;
}): boolean {
  if (!args.continuityActive) return false;
  if (!args.ownership) return true;
  return args.ownership.lorebook === "continuity" && args.sessionNumber >= args.ownership.fromSession;
}
