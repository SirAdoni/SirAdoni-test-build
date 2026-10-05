import { z } from "zod";
import type { ChatMessage } from "../llm/base-provider.js";
import { jsonishLooksTruncated, parseGameJsonish } from "./jsonish.js";

export class SessionSummaryReviewError extends Error {
  readonly statusCode = 422;

  constructor(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    super(`Session summary factual review failed: ${message}`, { cause: error });
    this.name = "SessionSummaryReviewError";
  }
}

const summarySchema = z.object({
  summary: z.string().min(1),
  resumePoint: z.string(),
  partyDynamics: z.string(),
  partyState: z.string(),
  keyDiscoveries: z.array(z.string()),
  characterMoments: z.array(z.string()),
  littleDetails: z.array(z.string()),
  npcUpdates: z.array(z.string()),
  statsSnapshot: z.record(z.string(), z.unknown()),
});
const evidenceSchema = z.object({
  path: z
    .array(z.union([z.string().min(1), z.number().int().nonnegative()]))
    .min(2)
    .max(12),
  reason: z.string().trim().min(1),
  quote: z.string().trim().min(1),
});
const reviewSchema = z
  .object({
    corrections: z.array(evidenceSchema.extend({ before: z.string().min(1), after: z.string() })),
    additions: z.array(evidenceSchema.extend({ value: z.string().trim().min(1) })),
    decisionChecks: z
      .array(z.object({ id: z.number().int().nonnegative(), quote: z.string().trim().min(1) }))
      .default([]),
  })
  .strict();
const summaryLists = new Set(["keyDiscoveries", "characterMoments", "littleDetails", "npcUpdates"]);

export const SESSION_SUMMARY_REVIEW_INSTRUCTIONS = [
  "FACTUAL REVIEW PHASE. Review the draft against the session transcript above. Do not generate a new conclusion, rewrite the whole summary, plan new events, or redesign character cards.",
  'Return ONLY {"corrections":[],"additions":[],"decisionChecks":[]}. Each correction is {path,before,after,reason,quote}. path is an array of keys/indices rooted at "summary" or "relatedContinuity"; before is a short exact excerpt occurring ONCE in that string field, after its minimally corrected replacement, and quote is a verbatim supporting transcript quote. Use after="" to remove an unsupported claim. Do not return an entire rewritten summary.',
  "For EVERY indexed decision claim, return one decisionChecks entry {id,quote}. The quote must show who actually made that decision, not an adjacent hobby, an unrelated acceptance, or the draft's own claim. Compare the claimed actor with the source actor and add corrections wherever they differ. If a claim lacks support, remove or qualify it with a correction. Do not silently skip a claim because other errors seem more important.",
  "Each quote must be ONE SHORT CONTIGUOUS verbatim excerpt. Do not concatenate separate turns or distant passages, omit words inside a quote, or silently remove intervening speaker labels. Prefer the shortest decisive source sentence; surrounding context remains available in the full transcript.",
  'Each addition is {path,value,reason,quote}. It appends one missing supported fact to a summary list, e.g. path:["summary","keyDiscoveries"]. To restore an important omission in the readable summary too, replace an existing relevant sentence with that sentence plus the missing consequence. Return empty arrays when the draft is already faithful.',
  "Check every decision's actor and recipient: who chose, ordered, requested, offered, agreed, or refused. An NPC accepting a player's decision does not mean the NPC proposed or requested it. Preserve both actors explicitly when necessary.",
  "Audit every characterMoments entry and decision claim inside SessionSummary for decision ownership, even when the readable summary is correct. Use the player-turn index to locate decisions, then consult their surrounding transcript for the recipient and response. The index is an excerpt of the same source, not independent corroboration.",
  "Check consequential scenes for event, purpose, witnessed reactions, lesson learned, and resulting practical instructions. Preserve supported detail in SessionSummary fields without inventing lasting personality changes.",
  "Check relatedContinuity for the same factual errors in party arcs, character cards, and plans so they cannot reintroduce a corrected claim. Only replace erroneous text; do not invent new traits or arcs or change unrelated planning material.",
  "Check quantities and comparisons against their actual referents. Do not attach an ambiguous multiplier to a convenient character. Preserve corrections and distinguish plans, offers, consent, signed agreements, and completed actions. Do not invent legal formalities or treat the absence of a narrated signature as a refusal or unresolved decision.",
  "User OOC corrections override rejected narration. Old recaps, widgets, trackers, future plans, and the draft itself are not independent evidence. Do not turn an instruction to everyone present into a claim about absent people, or one observer's reaction into knowledge shared by everyone.",
  "Keep accurate detail and the original language. Repair mistakes and meaningful omissions across the summary fields; preserve unaffected wording. No invented quotes, motives, consent, diagnoses, or player interiority. If evidence cannot settle a claim, preserve uncertainty rather than inventing a resolution.",
].join("\n");

function locate(
  root: Record<string, unknown>,
  path: Array<string | number>,
): { parent: Record<string | number, unknown>; key: string | number } {
  if (path[0] !== "summary" && (path[0] !== "relatedContinuity" || !Object.hasOwn(root, "relatedContinuity")))
    throw new Error("Invalid review target root");
  let parent: unknown = root;
  for (const [index, key] of path.entries()) {
    if (
      ["__proto__", "prototype", "constructor"].includes(String(key)) ||
      !parent ||
      typeof parent !== "object" ||
      !Object.hasOwn(parent, key) ||
      (Array.isArray(parent) && typeof key !== "number")
    ) {
      throw new Error("Session summary review targets nonexistent continuity; nothing was saved.");
    }
    if (index === path.length - 1) return { parent: parent as Record<string | number, unknown>, key };
    parent = (parent as Record<string | number, unknown>)[key];
  }
  throw new Error("Empty review target");
}

/** Evidence-backed edits, applied to a copy only after the full audit validates. */
export async function reviewSessionSummary(args: {
  messages: ChatMessage[];
  transcript: string;
  draft: unknown;
  relatedContinuity?: Record<string, unknown>;
  complete: (messages: ChatMessage[]) => Promise<string>;
}) {
  if (!args.transcript.trim() || !args.messages.some((message) => message.content.includes(args.transcript))) {
    throw new SessionSummaryReviewError(
      new Error("The full session transcript is required for factual review; no summary was saved."),
    );
  }
  const original = {
    summary: summarySchema.parse(args.draft),
    ...(args.relatedContinuity ? { relatedContinuity: args.relatedContinuity } : {}),
  };
  const decisions: Array<{ id: number; path: Array<string | number>; claim: string }> = [];
  const collectDecisions = (value: unknown, path: Array<string | number>) => {
    if (typeof value === "string") {
      // ponytail: English verb coverage supplements the general multilingual review; extend for other summary languages.
      for (const sentence of value.match(/[^.!?\n]+[.!?]?/g) ?? []) {
        if (/\b(?:asked|chose|decided|required|instructed|insisted|requested|ordered)\b/i.test(sentence))
          decisions.push({ id: decisions.length, path, claim: sentence.trim() });
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => collectDecisions(item, [...path, index]));
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) collectDecisions(item, [...path, key]);
    }
  };
  // The summary describes this session; older arcs may legitimately lack fresh source evidence.
  collectDecisions(original.summary, ["summary"]);
  // Repeat player turns near the draft so short decisions are not buried in long GM narration.
  const playerTurns = args.transcript
    .split(/\n\n(?=\[(?:user(?: OOC correction)?|assistant(?: OOC acknowledgement)?|narrator|system)\] )/)
    .filter((turn) => /^\[user(?: OOC correction)?\] /.test(turn))
    .join("\n\n");
  // Preserve the original request prefix for provider caching.
  const messages: ChatMessage[] = [
    ...args.messages,
    { role: "assistant", content: JSON.stringify(original) },
    {
      role: "user",
      content: `${playerTurns ? `PLAYER-TURN SOURCE INDEX (chronological excerpts; surrounding context remains in the full transcript):\n${playerTurns}\n\n` : ""}${SESSION_SUMMARY_REVIEW_INSTRUCTIONS}\n\nREQUIRED DECISION CLAIM CHECKS:\n${JSON.stringify(decisions)}`,
    },
  ];
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const transcript = normalize(args.transcript);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await args.complete(messages);
    try {
      if (jsonishLooksTruncated(raw))
        throw new Error("The review was cut off; return only compact edits, not a rewritten summary.");
      const result = reviewSchema.parse(parseGameJsonish(raw));
      const errors: string[] = [];
      if (
        result.decisionChecks.length !== decisions.length ||
        new Set(result.decisionChecks.map((check) => check.id)).size !== decisions.length ||
        result.decisionChecks.some((check) => !decisions[check.id])
      ) {
        errors.push(
          "The decision audit is incomplete. Return one source-backed decisionChecks entry for EVERY indexed claim.",
        );
      }
      const updated = structuredClone(original);
      for (const item of [...result.corrections, ...result.additions, ...result.decisionChecks]) {
        if (!transcript.includes(normalize(item.quote)))
          errors.push(`Review evidence is not in the transcript: ${JSON.stringify(item.quote)}; nothing was saved.`);
      }
      for (const item of result.corrections) {
        const target = locate(updated, item.path);
        const value = target.parent[target.key];
        if (typeof value !== "string" || value.split(item.before).length !== 2) {
          errors.push(
            `Review target excerpt must occur exactly once at ${JSON.stringify(item.path)}; nothing was saved. Requested excerpt: ${JSON.stringify(item.before)}. Current exact field: ${JSON.stringify(value)}. Copy from that field without paraphrasing; avoid overlapping corrections to the same text.`,
          );
          continue;
        }
        target.parent[target.key] = value.replace(item.before, () => item.after);
      }
      for (const item of result.additions) {
        if (item.path.length !== 2 || item.path[0] !== "summary" || !summaryLists.has(String(item.path[1])))
          throw new Error("Review additions must target a summary fact list");
        const target = locate(updated, item.path);
        const list = target.parent[target.key] as string[];
        if (!list.includes(item.value)) list.push(item.value);
      }
      if (errors.length) throw new Error(errors.join("\n"));
      return {
        summary: summarySchema.parse(updated.summary),
        relatedContinuity: updated.relatedContinuity,
        corrections: [...result.corrections, ...result.additions],
        relatedCorrections: result.corrections.filter((item) => item.path[0] === "relatedContinuity"),
        decisionChecks: result.decisionChecks.map((check) => ({ ...decisions[check.id], quote: check.quote })),
      };
    } catch (error) {
      if (attempt === 1) throw new SessionSummaryReviewError(error);
      messages.push(
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `The review failed validation: ${error instanceof Error ? error.message : String(error)}. Return the complete compact corrections/additions/decisionChecks JSON again. Copy exact source quotes and target excerpts. Do not drop a genuine correction merely to pass validation.`,
        },
      );
    }
  }
  throw new Error("Session summary review did not complete; nothing was saved.");
}
