// One progress model for the whole first-run wizard (design language, step 8): "Step 2 of 5" plus a
// short label that fits 390 px. The tour counts its five screens; the setup counts the steps of the
// lane the player picked, and the lane cards say that count before the choice.
import type { Intro, SetupLane, Step } from "./SlpOnboardingPanel";

/** Short labels, keys under `ui.slurp.wizard.label.*`. */
export const SLP_TOUR_LABELS = ["welcome", "costs", "identity", "locked", "posting"] as const;

export const SLP_SETUP_STEPS: Record<Exclude<SetupLane, null>, readonly { step: Step; label: string }[]> = {
  // The role-play sign-up counts its own moments (SlpSceneOnboarding), not wizard steps.
  scene: [],
  easy: [
    { step: 1, label: "who" },
    { step: 4, label: "review" },
  ],
  customize: [
    { step: 1, label: "who" },
    { step: 2, label: "identity" },
    { step: 3, label: "posting" },
    { step: 4, label: "pictures" },
  ],
};

export interface SlpOnboardingProgress {
  current: number;
  total: number;
  label: string;
}

/** Where the player is, or null on screens outside the count (lane choice, the result). */
export function slpOnboardingProgress(state: {
  intro: Intro;
  setupLane: SetupLane;
  step: Step;
}): SlpOnboardingProgress | null {
  if (state.intro !== null) {
    return { current: state.intro + 1, total: SLP_TOUR_LABELS.length, label: SLP_TOUR_LABELS[state.intro] };
  }
  if (state.setupLane === null) return null;
  const steps = SLP_SETUP_STEPS[state.setupLane];
  const index = steps.findIndex((entry) => entry.step === state.step);
  if (index === -1) return null;
  return { current: index + 1, total: steps.length, label: steps[index].label };
}
