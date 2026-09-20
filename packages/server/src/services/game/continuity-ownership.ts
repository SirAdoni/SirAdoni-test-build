import { z } from "zod";

/**
 * Staged promotion: which writer owns the game lorebook once Incremental Game
 * Continuity is active, and from which session number that ownership applies.
 *
 * Absent ownership keeps the historical behaviour: an active continuity mode
 * disables the legacy Lorebook Keeper wholesale.
 */
export const continuityOwnershipSchema = z
  .object({
    lorebook: z.enum(["keeper", "continuity"]),
    fromSession: z.number().int().min(1),
  })
  .strict();

export type ContinuityOwnership = z.infer<typeof continuityOwnershipSchema>;

/** Reads `gameContinuity.ownership` from chat metadata; malformed values read as absent. */
export function readContinuityOwnership(gameContinuity: unknown): ContinuityOwnership | null {
  if (!gameContinuity || typeof gameContinuity !== "object" || Array.isArray(gameContinuity)) return null;
  const parsed = continuityOwnershipSchema.safeParse((gameContinuity as Record<string, unknown>).ownership);
  return parsed.success ? parsed.data : null;
}

/**
 * Decides whether the legacy Lorebook Keeper must stay silent for a concluded session.
 * - continuity not active: Keeper runs.
 * - active, no ownership: Keeper disabled (legacy wholesale gate).
 * - active, lorebook owned by "keeper": Keeper runs.
 * - active, lorebook owned by "continuity": Keeper disabled only for sessions >= fromSession.
 */
export function keeperDisabledByContinuity(args: {
  continuityActive: boolean;
  ownership: ContinuityOwnership | null;
  sessionNumber: number;
}): boolean {
  if (!args.continuityActive) return false;
  if (!args.ownership) return true;
  if (args.ownership.lorebook !== "continuity") return false;
  return args.sessionNumber >= args.ownership.fromSession;
}
