import type { GameSceneTimeline } from "@marinara-engine/shared";
import { isGameSceneTimelineEnabled } from "@marinara-engine/shared";
import { isCampaignOptInEnabled } from "../features/campaign-opt-in.js";

export function isSceneTimelineEnabled(metadata: Record<string, unknown> | null | undefined): boolean {
  return isCampaignOptInEnabled("sceneTimeline") && isGameSceneTimelineEnabled(metadata);
}

/** When timeline tracking is disabled, preserve upstream snapshot-based party presence. */
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
  const present = party
    .filter((member) => ids.has(member.id) || names.has(key(member.name)))
    .map((member) => member.name);
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
