import { findUnambiguousGameNpcNameMatch, normalizeGameNpcIdentityName, type GameNpc } from "@marinara-engine/shared";

export type JournalNpcLogEntry = { npcName: string; interactions: string[] };

const SYNTHETIC_TRACKED_INTERACTION = /^Tracked(?: at .+)?\.?$/iu;
const REPUTATION_NOTE = /(?:\breputation\b|\bmilestone\b|recruited into the party)/iu;

function isPublicNpcSource(npc: GameNpc): boolean {
  return (
    npc.descriptionSource === "user" || npc.descriptionSource === "library" || npc.descriptionSource === "narration"
  );
}

export function hasGenuineJournalNpcEncounter(
  npcName: string,
  npcLog: readonly JournalNpcLogEntry[],
  rosterNames: readonly string[],
): boolean {
  const targetName = normalizeGameNpcIdentityName(npcName);
  if (!targetName) return false;

  return npcLog.some((entry) => {
    if (!entry.interactions.some((interaction) => !SYNTHETIC_TRACKED_INTERACTION.test(interaction.trim()))) {
      return false;
    }
    if (normalizeGameNpcIdentityName(entry.npcName) === targetName) return true;
    const matchIndex = findUnambiguousGameNpcNameMatch(entry.npcName, rosterNames);
    return matchIndex >= 0 && normalizeGameNpcIdentityName(rosterNames[matchIndex]) === targetName;
  });
}

/** Return presentation-safe description text; setup/model dossiers never qualify. */
export function getJournalNpcPublicDescription(npc: GameNpc): string {
  const observedDescription = npc.observedDescription?.trim();
  if (observedDescription) return observedDescription;
  const observedAppearance = npc.observedAppearance?.trim();
  if (observedAppearance) return observedAppearance;
  return isPublicNpcSource(npc) ? npc.description?.trim() || "" : "";
}

/** Setup locations can be unreached spoilers, so only public-source locations are shown. */
export function getJournalNpcPublicLocation(npc: GameNpc): string {
  return isPublicNpcSource(npc) ? npc.location?.trim() || "" : "";
}

export function shouldShowJournalNpc(
  npc: GameNpc,
  npcLog: readonly JournalNpcLogEntry[],
  rosterNames: readonly string[],
): boolean {
  const hasObservedEvidence = !!npc.observedDescription?.trim() || !!npc.observedAppearance?.trim();
  const hasReputationChange = Number.isFinite(npc.reputation) && npc.reputation !== 0;
  // Setup planning also uses `notes` for private future-role hints. Only the
  // deterministic relationship/recruitment records are evidence that the
  // player has actually established a relationship with this NPC.
  const hasRelationshipNotes = Array.isArray(npc.notes) && npc.notes.some((note) => REPUTATION_NOTE.test(note.trim()));
  const linkedAndEncountered =
    !!npc.characterId?.trim() && hasGenuineJournalNpcEncounter(npc.name, npcLog, rosterNames);
  return (
    isPublicNpcSource(npc) || hasObservedEvidence || linkedAndEncountered || hasReputationChange || hasRelationshipNotes
  );
}

export function findJournalNpcMatchIndex(name: string, npcs: readonly GameNpc[]): number {
  return findUnambiguousGameNpcNameMatch(
    name,
    npcs.map((npc) => npc.name),
  );
}
