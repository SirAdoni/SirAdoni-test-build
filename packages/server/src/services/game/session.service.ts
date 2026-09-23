// ──────────────────────────────────────────────
// Game: Session Lifecycle Service
// ──────────────────────────────────────────────

import type { SessionSummary } from "@marinara-engine/shared";
import { stripGmCommandTags } from "./segment-edits.js";

/** Session-local combat state must never leak through a conclusion or into the next chat. */
export function buildSessionCombatResetPatch(): { encounterActive: false; gameCombatState: null } {
  return { encounterActive: false, gameCombatState: null };
}

function normalizeRecapBeat(text: string | null | undefined): string {
  if (!text) return "";

  return stripGmCommandTags(text)
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildLatestSessionContinuity(summaries: SessionSummary[]): string[] {
  const latest = summaries[summaries.length - 1];
  if (!latest) return [];

  return [
    ...(latest.resumePoint ? [`Resume point: ${latest.resumePoint}`] : []),
    ...(latest.partyDynamics ? [`Party dynamics: ${latest.partyDynamics}`] : []),
    ...(latest.keyDiscoveries.length ? [`Key discoveries: ${latest.keyDiscoveries.join("; ")}`] : []),
    ...(latest.characterMoments?.length ? [`Character moments: ${latest.characterMoments.join("; ")}`] : []),
    ...(latest.littleDetails?.length ? [`Little details to recall: ${latest.littleDetails.join("; ")}`] : []),
    ...(latest.npcUpdates?.length ? [`NPC updates: ${latest.npcUpdates.join("; ")}`] : []),
    ...(latest.nextSessionRequest ? [`Player request for this session: ${latest.nextSessionRequest}`] : []),
    ...(latest.statsSnapshot && Object.keys(latest.statsSnapshot).length > 0
      ? [`Stats snapshot: ${JSON.stringify(latest.statsSnapshot)}`]
      : []),
  ];
}

/**
 * Build the context string that is injected into a new session's chat
 * so the GM and agents have continuity from prior sessions.
 */
export function buildSessionCarryoverContext(summaries: SessionSummary[]): string {
  if (summaries.length === 0) return "";

  const sorted = [...summaries].sort((a, b) => a.sessionNumber - b.sessionNumber);
  const latest = sorted[sorted.length - 1]!;

  const sections: string[] = [
    `<previous_session_summaries>`,
    `The following are the full summaries of past sessions. Use them to maintain long-term continuity:`,
  ];

  for (const summary of sorted) {
    sections.push(``, `--- Session ${summary.sessionNumber} ---`, summary.summary);
  }

  sections.push(`</previous_session_summaries>`);
  sections.push(
    `<latest_session_continuity>`,
    `Only the most recently completed session contributes detailed carryover fields for the current session.`,
    `Latest completed session: ${latest.sessionNumber}`,
    ...buildLatestSessionContinuity(sorted),
    `</latest_session_continuity>`,
  );
  return sections.join("\n");
}

/**
 * Create a "Previously on..." recap narration prompt for the GM
 * when starting a new session.
 */
export function buildRecapPrompt(
  summaries: SessionSummary[],
  latestEndingBeat?: string | null,
  rating: "sfw" | "nsfw" = "sfw",
  verifiedMemory?: string | null,
): string {
  const latest = summaries[summaries.length - 1];
  if (!latest) return "";

  const cleanedEndingBeat = normalizeRecapBeat(latestEndingBeat);
  const memory = verifiedMemory?.trim();

  return [
    `Write a faithful "Previously on..." recap for the players. Accuracy and continuity outrank drama, compression, or flourish.`,
    `This is a presentation-only rendering of stored continuity, not new evidence. The supplied summary, resume point, and structured continuity fields are authoritative. Do not add facts, causal links, judgments, or relationship labels.`,
    `Preserve speaker attribution and agency exactly. Never merge or reassign one character's statement, reason, reaction, judgment, or interpretation to another character. Preserve who initiated, requested, chose, consented, refused, promised, or changed course.`,
    `Preserve chronological and epistemic order. Never move a warning, condition, discovery, or disclosure earlier to make a prior choice informed, consensual, defiant, obedient, or knowingly risky.`,
    `Preserve the exact grantor, recipient, and scope of authority or permission. Advice, expertise, responsibility, operational discretion, protective capacity, or the ability to repair harm does not expand a limited delegation.`,
    `Preserve the player character's established canon. Do not invent or imply their thoughts, feelings, motives, morality, competence, dialogue, consent, obedience, decisions, or voluntary actions, including in the transition to the new session.`,
    `If supplied continuity fields conflict, do not invent a reconciliation. Keep the ambiguity explicit, use the resume point for the final location and moment, and do not duplicate an event merely because it appears in more than one field.`,
    `Keep every session-defining choice, correction, promise, relationship milestone, consequence, and unfinished hook. If space is tight, trim technical setup, repeated description, and routine travel first.`,
    ...(rating === "nsfw"
      ? [
          `This is an NSFW campaign. Preserve established consensual adult sexual intimacy plainly but non-graphically when it matters to continuity. Do not euphemize it as "chosen intimacy," "became close," or "remained together privately," and do not invent a relationship label such as "became lovers."`,
        ]
      : []),
    `Base it on this session summary:`,
    ``,
    latest.summary,
    ``,
    ...(latest.resumePoint ? [`Resume point: ${latest.resumePoint}`] : []),
    `Party dynamics: ${latest.partyDynamics}`,
    `Party state: ${latest.partyState}`,
    `Key discoveries: ${latest.keyDiscoveries.join(", ")}`,
    ...(latest.characterMoments?.length ? [`Character moments: ${latest.characterMoments.join("; ")}`] : []),
    ...(latest.littleDetails?.length ? [`Little details to recall: ${latest.littleDetails.join("; ")}`] : []),
    ...(latest.npcUpdates?.length ? [`NPC updates: ${latest.npcUpdates.join("; ")}`] : []),
    ...(latest.nextSessionRequest ? [`Player request for the next session: ${latest.nextSessionRequest}`] : []),
    ...(latest.statsSnapshot && Object.keys(latest.statsSnapshot).length > 0
      ? [`Stats snapshot: ${JSON.stringify(latest.statsSnapshot)}`]
      : []),
    ...(cleanedEndingBeat
      ? [
          ``,
          `The final narrated beat immediately before the session ended was:`,
          cleanedEndingBeat,
          `This ending beat is subordinate context, not independent evidence. Use only details consistent with the authoritative summary and resume point; ignore any conflict rather than restoring rejected or corrected narration.`,
        ]
      : []),
    ...(memory
      ? [
          ``,
          `Verified campaign memory (facts reviewed against the transcript, tagged with the session they come from):`,
          memory,
          `Use this memory only to keep names, relationships, possessions and established facts exact. Where the summary contradicts it, follow the memory; do not recap memory facts the summary does not mention.`,
        ]
      : []),
    ``,
    `Use enough compact paragraphs for a faithful recap (normally 3–6). End at the exact resume point as the immediate scene hook. Do not advance time or state beyond it, and stop before the player character's next voluntary action, dialogue, thought, feeling, intent, or response.`,
  ].join("\n");
}
