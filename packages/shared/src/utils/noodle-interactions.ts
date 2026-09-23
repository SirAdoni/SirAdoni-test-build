import type { NoodleAccountKind } from "../types/noodle.js";

interface NoodleReplyManagementInput {
  actorKind: NoodleAccountKind | null | undefined;
  actorAccountId: string;
  personaAccountId: string | null | undefined;
}

/**
 * Users may manage their current persona's replies and replies authored by
 * their characters. Generated random-user replies remain read-only.
 */
export function canManageNoodleReply({
  actorKind,
  actorAccountId,
  personaAccountId,
}: NoodleReplyManagementInput): boolean {
  if (actorKind === "character") return true;
  return actorKind === "persona" && Boolean(personaAccountId) && actorAccountId === personaAccountId;
}
