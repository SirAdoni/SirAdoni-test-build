// The Stir tab's small rules (0.3.1), apart from the screen so they run in tests: which lever an
// "In play" card opens, what a deck card needs first, and where a recent play leads.
import type { SlpActionName } from "../../../../../shared/src/slp/slp-actions.js";
import type { SlpStirLive, SlpStirPlay, SlpStirView } from "../../../../../shared/src/slp/slp-stir.js";
import type { SlpPulseTarget } from "../../base/state/slp-task-store";

/** The lever an "In play" card opens, already on that thread, or null when there is nothing to steer. */
export function slpStirLiveLever(entry: SlpStirLive): { action: SlpActionName; who?: string[]; pick?: string } | null {
  const id = entry.id.slice(entry.id.indexOf(":") + 1);
  const who = entry.who.map((person) => person.id);
  switch (entry.kind) {
    case "couple":
      return { action: "steer-couple", pick: id };
    case "collab":
      return entry.state === "asked" ? { action: "push-collab", pick: id } : null;
    case "rivalry":
      return entry.state === "cooling" ? null : { action: "cool-rivalry", pick: id };
    case "break":
      return { action: "steer-creator", who };
    case "ideas":
      return { action: "add-idea", who };
    default:
      return null;
  }
}

/** What a deck card needs before it can do anything, or null when it is ready (0.3.1). */
export function slpStirDeckNeed(action: SlpActionName, view: SlpStirView | undefined): string | null {
  if (!view) return null;
  switch (action) {
    case "steer-couple":
      return view.couples.length ? null : "couple";
    case "add-to-couple":
    case "couple-page":
      return view.couples.some((couple) => couple.stage === "dating" || couple.stage === "together")
        ? null
        : view.couples.length
          ? "datingCouple"
          : "couple";
    case "push-collab":
      return view.collabs.some((collab) => collab.status === "asked") ? null : "collab";
    case "cool-rivalry":
      return view.rivalries.some((rivalry) => rivalry.stage !== "cooling") ? null : "rivalry";
    case "steer-storyline":
      return view.storylines.length ? null : "storyline";
    case "start-event":
      return view.events.length ? null : "event";
    default:
      return null;
  }
}

/** Where a recent play leads: the post it wrote, or the first Creator it touched. */
export function slpStirPlayTarget(play: SlpStirPlay): SlpPulseTarget | null {
  for (const step of play.steps) {
    const accountId = ["accountId", "aId", "fromId", "hostId"]
      .map((key) => step.input[key])
      .find((value): value is string => typeof value === "string");
    if (accountId) return { accountId, postId: step.ref?.postId ?? null };
  }
  return null;
}
