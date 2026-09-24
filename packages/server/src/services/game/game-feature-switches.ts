import type { GameSceneTimeline } from "@marinara-engine/shared";

/**
 * Scene timeline OFF: party presence comes from the latest tracker snapshot instead of the timeline.
 * Returns a one-scene timeline so the existing presence selector works unchanged. A snapshot that names no
 * party member keeps the whole party available, which is upstream's behaviour (no presence filter).
 */
export function snapshotPresenceTimeline(
  presentCharacters: unknown,
  party: ReadonlyArray<{ id: string; name: string }>,
): GameSceneTimeline {
  const entries = Array.isArray(presentCharacters) ? presentCharacters : [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const key = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();
  for (const entry of entries) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    if (typeof record.characterId === "string" && record.characterId.trim()) ids.add(record.characterId.trim());
    if (typeof record.name === "string" && record.name.trim()) names.add(key(record.name));
  }
  const present = party.filter((member) => ids.has(member.id) || names.has(key(member.name))).map((m) => m.name);
  return {
    scenes: [
      {
        id: "snapshot",
        location: "",
        participants: [],
        present: present.length > 0 ? present : party.map((member) => member.name),
        summary: "",
        closed: false,
        reviewed: false,
        messageIds: [],
      },
    ],
    pending: false,
    error: null,
    remaining: 0,
    reviewableSceneCount: 0,
    needsReview: false,
  };
}
