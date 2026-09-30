/**
 * The player's own join, as the sign-up scene with the roles swapped: Slurp Support asks, the
 * player answers with a tap. Five short questions that set the same things the old tour did, then
 * straight on to signing someone up, or to the feed for a player who is only here to watch.
 *
 * Scripted, not generated: the player has not picked an AI connection yet, and a join should
 * cost nothing. Pure, so the order and the mapping run in tests.
 */
import { SLURP_ACTIVITY_PRESETS, type SlurpActivityPreset } from "../../modules/creator/slp-activity-presets";

export const SLP_SITE_WELCOME_QUESTIONS = ["who", "pace", "pictures", "nights", "names"] as const;
export type SlpSiteWelcomeQuestion = (typeof SLP_SITE_WELCOME_QUESTIONS)[number];

export const SLP_SITE_WELCOME_OPTIONS = {
  who: ["watch", "run", "both"],
  pace: SLURP_ACTIVITY_PRESETS,
  pictures: ["yes", "no"],
  nights: ["yes", "no"],
  names: ["hinted", "open"],
} as const satisfies Record<SlpSiteWelcomeQuestion, readonly string[]>;

export type SlpSiteWelcomeAnswers = Partial<{
  who: "watch" | "run" | "both";
  pace: SlurpActivityPreset;
  pictures: "yes" | "no";
  nights: "yes" | "no";
  names: "hinted" | "open";
}>;

/** The first question still open, or null when the form is done. */
export function slpSiteWelcomeNext(answers: SlpSiteWelcomeAnswers): SlpSiteWelcomeQuestion | null {
  return SLP_SITE_WELCOME_QUESTIONS.find((question) => answers[question] === undefined) ?? null;
}

/** Where the join leads: a watcher goes to the feed first, everyone else signs someone up. */
export function slpSiteWelcomeLead(answers: SlpSiteWelcomeAnswers): "feed" | "signup" {
  return answers.who === "watch" ? "feed" : "signup";
}

/** The wizard settings one answer changes. "who" only decides where the join leads. */
export function slpSiteWelcomeSetting(
  question: SlpSiteWelcomeQuestion,
  value: string,
):
  | { kind: "pace"; value: SlurpActivityPreset }
  | { kind: "pictures" | "nights"; value: boolean }
  | { kind: "names"; value: "hinted" | "open" }
  | null {
  if (question === "pace") return { kind: "pace", value: value as SlurpActivityPreset };
  if (question === "pictures" || question === "nights") return { kind: question, value: value === "yes" };
  if (question === "names") return { kind: "names", value: value === "open" ? "open" : "hinted" };
  return null;
}
