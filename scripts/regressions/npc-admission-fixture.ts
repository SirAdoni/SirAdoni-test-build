import {
  syncGameNpcCharacters as sync,
  type GameNpcCharacterCandidate,
} from "../../packages/server/src/services/game/npc-character-sync.js";

/** These storage lifecycle suites begin AFTER AI admission; admission itself is tested in npc-profile. */
export function syncGameNpcCharacters(input: Parameters<typeof sync>[0]) {
  return sync({
    ...input,
    candidates: input.candidates.map(
      (c): GameNpcCharacterCandidate => ({
        ...c,
        identityVerified: true,
        profile: c.profile ?? {
          npcId: c.npcId,
          name: c.name,
          description: c.description,
          appearance: c.appearance,
          personality: "",
          backstory: "",
          creativeAdditions: "",
          sourceKey: "admitted-test-fixture",
          sourceMessageId: "admitted-test-turn",
        },
      }),
    ),
  });
}
