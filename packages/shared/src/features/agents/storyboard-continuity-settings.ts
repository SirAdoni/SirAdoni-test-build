export const VISUAL_CONTEXT_RULES = [
  "Physical continuity contract: earlier conversation establishes ongoing positions, activities, objects and presence; the current completed reply supplies the beats to illustrate.",
  "Do not interpret 'only this narration' as erasing established physical continuity. Earlier user actions already preceding this reply are context, not a future action. Never anticipate messages after this reply.",
  "Opening facts apply before the current reply. Follow its changes in order; closing facts apply only after those changes. Never apply an end-of-turn move to an earlier panel.",
  "Retain ongoing work, held objects, posture and clothing unless explicitly changed. Talking about painting is not painting; a remembered object is not automatically in the room. Sitting ON a table is not sitting AT it.",
  "Use the supplied location identity for the current location, not stale tracker labels or locations remembered in conversation. For a narrated transition use its proper location for each beat; never copy one room's reference into a different room.",
  "Do not invent player choices, actions, feelings or compliance. Uncertain physical facts stay unspecified; do not hide all context with close-up crops. Include the ongoing activity and relevant props when that person is depicted.",
].join("\n");

export interface StoryboardContinuitySettings {
  enabled: boolean;
  reviewEnabled: boolean;
  historyCharacters: number;
  repairAttempts: number;
  rules: string;
  analystPrompt: string;
  reviewPrompt: string;
  repairPrompt: string;
}

export const DEFAULT_STORYBOARD_CONTINUITY: StoryboardContinuitySettings = {
  enabled: true,
  reviewEnabled: true,
  historyCharacters: 64000,
  repairAttempts: 2,
  rules: VISUAL_CONTEXT_RULES,
  analystPrompt:
    "Extract observable scene state, not a story, plot, personality assessment or illustration plan. Carry still-active previous facts with their original citation; replace changed facts and remove concluded activities or departed people. Include concrete working materials and spatial relationships, not only the topic of dialogue. List unresolved contradictions in uncertainties. Player-authored corrections govern their own posture and actions. Do not treat a desire, hypothetical, future plan, quoted story or retrospective discussion as an executed action. Do not turn OOC text into a scene; use explicit physical corrections only.",
  reviewPrompt:
    "Check storyboard shots against the source-grounded physical scene and current narration. Report all material contradictions together. Naming only a subset of visible people does not assert that every other person is absent: a source-grounded unnamed participant may have an unresolved identity. Do not demand identity resolution. Distinguish explicit contradictions from ordinary framing and unspecified incidental detail; an object outside a crop is not destroyed or discarded. Require source evidence, not a preferred composition. Established appearance grounds traits and clothing unless the scene changes it, but does not establish presence, actions or held objects. Cross-check the summary against source messages: reject contradictory locations, changed player posture or activity, invented visible props or people, and missing ongoing activity or essential objects when their owner is shown. Do not reject reasonable framing or off-screen people. Omit unknown details instead of inventing answers. Report all issues together with concrete, minimal repair instructions.",
  repairPrompt:
    "Make the smallest targeted edits to resolve every reported review issue. Preserve all already-correct details, cast, framing, section anchors, current dialogue and requested art style. Do not broaden shots or add actions while fixing an unrelated detail.",
};

export function normalizeStoryboardContinuity(
  value: unknown,
  fallback: StoryboardContinuitySettings = DEFAULT_STORYBOARD_CONTINUITY,
): StoryboardContinuitySettings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const number = (key: "historyCharacters" | "repairAttempts", min: number, max: number) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key])
      ? Math.max(min, Math.min(max, Math.round(raw[key] as number)))
      : fallback[key];
  const prompt = (key: "rules" | "analystPrompt" | "reviewPrompt" | "repairPrompt") =>
    typeof raw[key] === "string" ? raw[key].slice(0, 32000) : fallback[key];
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    reviewEnabled: typeof raw.reviewEnabled === "boolean" ? raw.reviewEnabled : fallback.reviewEnabled,
    historyCharacters: number("historyCharacters", 4000, 256000),
    repairAttempts: number("repairAttempts", 0, 4),
    rules: prompt("rules"),
    analystPrompt: prompt("analystPrompt"),
    reviewPrompt: prompt("reviewPrompt"),
    repairPrompt: prompt("repairPrompt"),
  };
}
