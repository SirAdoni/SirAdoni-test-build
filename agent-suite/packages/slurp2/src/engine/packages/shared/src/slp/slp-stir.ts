/**
 * Stir (W): one lever system over the action layer. Three ways in (the Stir tab, the ✦ sheet on a
 * Creator or post, plain words in the box or in a Slurp Support thread), one preview, one "Do it".
 * These are the shapes both sides share: a preview card, a planned step, a play in the ledger, and
 * what the Stir tab shows ("In play", suggestions). See docs/architecture/README.md ("Stir").
 */
import { z } from "zod";
import type { SlpActionName } from "./slp-actions.js";

/** When a play shows in the world. */
export type SlpStirWhen = "now" | "nextPost" | "nextLook" | "ongoing";

/**
 * A fit note from the Creator's card, or a conflict with what is going on. The app words it
 * (`ui.slurp.stir.note.<kind>`, with `name`); `kind` is never shown raw.
 */
export type SlpStirNote = {
  kind:
    | "awkward"
    | "reluctant"
    | "complicated"
    | "mayDecline"
    | "noCollabs"
    | "notDramatic"
    | "onBreak"
    | "ideasFull"
    | "capped"
    | "alreadyRunning"
    | "notAutomatic"
    // Brand deals (R): the product is spicier than the page, the Creator dislikes ads, not their thing.
    | "spice"
    | "noAds"
    | "offBrand"
    // The Support desk: a shady move raises the Creator's suspicion.
    | "shady";
  name?: string;
};

/**
 * What an action would do, without doing it. `error` is a code (`ui.slurp.stir.cant.<code>`): the
 * card says why it cannot happen and "Do it" leaves it out. `detail` holds the few values the app
 * needs to word the card ("date", the idea, the event's name). `summary` is plain English for an
 * outside helper (Professor Mari); the app never shows it.
 */
export type SlpActionPreview = {
  action: SlpActionName;
  input: Record<string, unknown>;
  who: { id: string; name: string; avatarUrl: string | null }[];
  detail: Record<string, string | number | boolean | null>;
  summary: string;
  when: SlpStirWhen;
  /** "ai": running it calls the AI connection now. Plays themselves are free (a sandbox). */
  cost: "free" | "ai";
  notes: SlpStirNote[];
  error: string | null;
  refusable: boolean;
  reversible: boolean;
};

/** One step of a plan: an action and its input, as the planner or a card produced it. */
export const slpStirStepSchema = z
  .object({
    action: z.string().trim().min(1).max(80),
    input: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type SlpStirStep = z.infer<typeof slpStirStepSchema>;

/** At most this many steps per play: a plan is a beat, not a season. */
export const SLP_STIR_STEPS_MAX = 8;
export const SLP_STIR_TEXT_MAX = 600;

/** Where a play came from, for the ledger and the Undo toast. */
export const SLP_STIR_ORIGINS = ["deck", "sheet", "words", "support", "suggested", "mari"] as const;
export type SlpStirOrigin = (typeof SLP_STIR_ORIGINS)[number];

export const slpStirPlaySchema = z
  .object({
    steps: z.array(slpStirStepSchema).min(1).max(SLP_STIR_STEPS_MAX),
    origin: z.enum(SLP_STIR_ORIGINS).default("deck"),
    /** A Support thread's plan: the Creator's reply that proposed it (marked as played). */
    supportMessageId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const slpStirPlanRequestSchema = z
  .object({
    text: z.string().trim().min(2).max(SLP_STIR_TEXT_MAX),
    /** The Creator the ✦ sheet is about: the plan defaults to them. */
    creatorId: z.string().trim().min(1).max(200).optional(),
    /** The post the ✦ sheet came from. */
    postId: z.string().trim().min(1).max(200).optional(),
    /** The persona playing: only their pages are "the player's own" (0.3.1). */
    personaId: z.string().trim().min(1).max(200).optional(),
    /** The planner asked a question about `text`; this is the player's answer (0.3.1). */
    followUp: z
      .object({
        question: z.string().trim().min(1).max(300),
        answer: z.string().trim().min(1).max(SLP_STIR_TEXT_MAX),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SlpStirPlanRequest = z.infer<typeof slpStirPlanRequestSchema>;

/** The planner's answer: cards to preview, a question when the words were unclear, and what it cannot do. */
export type SlpStirPlan = {
  cards: SlpActionPreview[];
  question: string | null;
  cant: string[];
};

/** A play in the ledger: what ran, when, from where, and whether one Undo can still take it back. */
export type SlpStirPlay = {
  id: string;
  at: string;
  origin: SlpStirOrigin;
  /** The action name as asked (an unknown one stays as it was, with its error). */
  steps: {
    action: string;
    input: Record<string, unknown>;
    ok: boolean;
    error: string | null;
    /** What the step made or touched, for a link from the ledger (a post, a couple, an event…). */
    ref?: Record<string, string>;
  }[];
  undoable: boolean;
  undone: boolean;
};

/** One live thread in the world, for the "In play" strip. */
export type SlpStirLive = {
  id: string;
  kind: "couple" | "collab" | "rivalry" | "event" | "break" | "ideas" | "storyline";
  who: { id: string; name: string; avatarUrl: string | null }[];
  /** The stage or status, worded by the app (`ui.slurp.stir.live.<kind>.<state>`). */
  state: string;
  label: string | null;
  until: string | null;
};

/** A play Slurp suggests from what is going on (code only, no AI call). */
export type SlpStirSuggestion = {
  id: string;
  kind: "quiet" | "sparks" | "rocky" | "owedAd" | "event" | "cooling" | "firstPlay" | "match";
  who: { id: string; name: string; avatarUrl: string | null }[];
  label: string | null;
  step: SlpStirStep | null;
};

/** What the Stir tab reads in one request. */
export type SlpStirView = {
  live: SlpStirLive[];
  suggestions: SlpStirSuggestion[];
  plays: SlpStirPlay[];
  creators: {
    id: string;
    name: string;
    handle: string;
    avatarUrl: string | null;
    automatic: boolean;
    own: boolean;
    /** A couple's shared page: not a Creator to set up or pair. */
    couplePage: boolean;
  }[];
  events: { id: string; name: string; running: boolean }[];
  couples: {
    id: string;
    aId: string;
    bId: string;
    /** Polyamory (0.3.5): more partners. */
    moreIds?: string[];
    stage: string;
    page: "open" | "closed" | null;
  }[];
  collabs: { id: string; hostId: string; partnerId: string; status: string }[];
  rivalries: { id: string; fromId: string; toId: string; stage: string }[];
  storylines: { accountId: string; projectId: string; title: string; chapter: string; held: boolean }[];
};
