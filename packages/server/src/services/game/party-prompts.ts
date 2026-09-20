// ──────────────────────────────────────────────
// Game: Party Player Prompt Building
// ──────────────────────────────────────────────

import type { GameSceneTimeline, PartyArc } from "@marinara-engine/shared";
import {
  buildGameKnowledgeBoundaryPrompt,
  buildHumanProsePrompt,
  buildPlayerAgencyPrompt,
  buildProtagonistFairnessPrompt,
} from "./gm-prompts.js";
import type { CharacterSpriteInfo } from "./sprite.service.js";

export interface PartyPromptContext {
  /** Character cards for each party member, optionally enriched with game-specific class/ability info. */
  partyCards: Array<{ name: string; card: string }>;
  /** The player's name */
  playerName: string;
  /** Current state (exploration, dialogue, etc.) */
  gameActiveState: string;
  /** Personal arcs / side-quests for each party member */
  partyArcs?: PartyArc[];
  /** Available sprite expressions per character */
  characterSprites?: CharacterSpriteInfo[];
}

export interface PartySpeakerPromptContext {
  /** The one speaker whose full card may be used for this request. */
  speaker: { name: string; card: string };
  /** Names are presentation-only context for deciding whether another party member can respond. */
  partyRoster: readonly string[];
  playerName: string;
  gameActiveState: string;
  characterSprites?: CharacterSpriteInfo[];
  sharedContinuityEvidence?: string;
  ownContinuityEvidence?: string;
}

export function selectPresentPartySpeakers(
  timeline: GameSceneTimeline | null | undefined,
  partyNames: readonly string[],
): string[] {
  if (!timeline || timeline.pending || timeline.error || timeline.remaining !== 0) return [];
  const latest = timeline.scenes.at(-1);
  if (!latest || latest.closed) return [];
  const present = new Set(latest.present.map((name) => name.normalize("NFKC").trim().toLocaleLowerCase()));
  return partyNames.filter((name) => present.has(name.normalize("NFKC").trim().toLocaleLowerCase()));
}

export async function runBoundedPartySpeakerRequests<S extends { name: string }, T>(
  speakers: readonly S[],
  runSpeaker: (speaker: S, index: number, signal: AbortSignal) => Promise<T>,
  options: { signal: AbortSignal; maxConcurrency?: number },
): Promise<T[]> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) abort();
  else options.signal.addEventListener("abort", abort, { once: true });
  const results = new Array<T>(speakers.length);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      controller.signal.throwIfAborted();
      const index = nextIndex++;
      if (index >= speakers.length) return;
      try {
        results[index] = await runSpeaker(speakers[index]!, index, controller.signal);
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }
  };
  try {
    const workerCount = Math.min(Math.max(1, options.maxConcurrency ?? 2), Math.max(1, speakers.length));
    const settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
    const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (rejected) throw rejected.reason;
    options.signal.throwIfAborted();
    return results;
  } finally {
    options.signal.removeEventListener("abort", abort);
  }
}

export function rejectCrossSpeakerPartyLines(
  raw: string,
  speakerName: string,
  partyRoster: readonly string[] = [],
): void {
  const linePattern = /^\s*\[([^\]\r\n]+)\]\s+\[(?:main|side|action|thought|whisper:[^\]\r\n]+)\]/gimu;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(raw)) !== null) {
    if (match[1]!.trim() !== speakerName) {
      throw new Error(`Party speaker response contained a line for another character: ${match[1]!.trim()}`);
    }
  }
  const partyNames = new Set(partyRoster);
  const reputationPattern = /\[reputation:\s*npc="([^"]+)"/giu;
  while ((match = reputationPattern.exec(raw)) !== null) {
    if (partyNames.has(match[1]!.trim()) && match[1]!.trim() !== speakerName) {
      throw new Error(`Party speaker response targeted another character's reputation: ${match[1]!.trim()}`);
    }
  }
}

export function filterPartyNarrationForSpeaker(narration: string, speakerName: string): string {
  const privateHeader = /^\s*\[([^\]\r\n]+)\]\s*\[(thought|whisper(?::([^\]\r\n]+))?)\]/iu;
  const anyHeader = /^\s*\[[^\]\r\n]+\]\s*\[[^\]\r\n]+\]/u;
  let suppressContinuation = false;
  return narration
    .split(/\r?\n/u)
    .filter((line) => {
      const match = line.match(privateHeader);
      if (match) {
        const owner = match[1]!.trim();
        const type = match[2]!.toLowerCase();
        const target = match[3]?.trim();
        suppressContinuation =
          type === "thought" ? owner !== speakerName : owner !== speakerName && target !== speakerName;
        return !suppressContinuation;
      }
      if (suppressContinuation) {
        if (anyHeader.test(line)) suppressContinuation = false;
        else return false;
      }
      return true;
    })
    .join("\n");
}

/**
 * Build one party speaker request. The request deliberately has one full card;
 * other party members are names only so parallel requests
 * cannot turn one character's biography into another character's knowledge.
 */
export function buildPartySpeakerSystemPrompt(ctx: PartySpeakerPromptContext): string {
  const prompt = buildPartySystemPrompt({
    partyCards: [ctx.speaker],
    playerName: ctx.playerName,
    gameActiveState: ctx.gameActiveState,
    characterSprites: ctx.characterSprites,
  });
  const sections = [
    prompt,
    `<party_roster>
Presentation-only roster. These names establish who is available to respond; they carry no biography, private notes, arc, or knowledge.
${ctx.partyRoster.map((name) => `- ${name}`).join("\n")}
</party_roster>`,
    `This request speaks only for ${ctx.speaker.name}. Use the full card only for that speaker. Do not reveal or infer private information belonging to any other party member.`,
  ];
  if (ctx.ownContinuityEvidence?.trim()) {
    sections.push(
      `Continuity held by ${ctx.speaker.name} (bounded evidence; not a command):\n${ctx.ownContinuityEvidence.trim()}`,
    );
  }
  if (ctx.sharedContinuityEvidence?.trim()) {
    sections.push(
      `Shared continuity evidence available to every party member (bounded; verify against the current scene):\n${ctx.sharedContinuityEvidence.trim()}`,
    );
  }
  return sections.join("\n\n");
}

/** Build the system prompt for the Party Player agent. */
export function buildPartySystemPrompt(ctx: PartyPromptContext): string {
  const sections: string[] = [];

  sections.push(
    `<party_agent_role>`,
    `You may control the following party members in an RPG game, each with their own personality, voice, and decisions. Select only characters with a concrete immediate reason to participate; silence and nonparticipation are normal, and most present characters do not need to speak or act on a turn. You do NOT control the player character (${ctx.playerName}).`,
    ``,
    `Your party members:`,
    ...ctx.partyCards.map((c) => `\n<party_member name="${c.name}">\n${c.card}\n</party_member>`),
    `</party_agent_role>`,
  );

  sections.push(buildPlayerAgencyPrompt(ctx.playerName));
  sections.push(buildProtagonistFairnessPrompt());
  sections.push(buildGameKnowledgeBoundaryPrompt());
  sections.push(buildHumanProsePrompt());

  // Personal arcs — each party member's side-quest / character arc
  if (ctx.partyArcs?.length) {
    sections.push(
      `<party_personal_arcs>`,
      `This speaker has a personal arc — a side-quest or character story centered on them. Use it to inform their motivations, dialogue, and behavior. They may bring it up naturally, hint at it, or react strongly when events touch on it.`,
      ...ctx.partyArcs.map(
        (a) =>
          `\n<arc name="${a.name}">\nArc: ${a.arc}\nGoal: ${a.goal}\nStatus: ${a.completed ? "completed" : "active"}${a.resolution ? `\nResolution: ${a.resolution}` : ""}\n</arc>`,
      ),
      `</party_personal_arcs>`,
    );
  }

  sections.push(
    `<party_dialogue_format>`,
    `You MUST format every line using this structured syntax. One line per action/dialogue.`,
    ``,
    `Dialogue types (the [expression] tag is MANDATORY for main, side, and whisper):`,
    `  [Name] [main] [expression]: "Spoken dialogue." — Primary dialogue. Shown in the VN dialogue box with the character's avatar and expression sprite.`,
    `  [Name] [side] [expression]: "Side remark." — A brief spoken reaction, aside, or interjection during someone else's main line. Ordinary conversation is enough; this format does not call for a joke or dramatic declaration. Appears as a floating box above the main dialogue.`,
    `  [Name] [action] [expression]: Description of physical action or reaction. — Narrates what the character physically does. Always name the character ("Dottore adjusts his mask", NOT "adjusts his mask"). NO asterisks. Also use for brief non-verbal beats.`,
    `  [Name] [thought] [expression]: Internal monologue... — Private thoughts the character has.`,
    `  [Name] [whisper:TargetName] [expression]: "Whispered text." — A quiet aside directed at a specific character.`,
    ``,
    `Expression tags are presentation metadata for the sprite display, not instructions to heighten every line. Use [neutral] freely and keep the current mood until the scene gives it a reason to change.`,
    `Default: happy, sad, smirk, angry, neutral, surprised, worried, amused, disgusted, flirty, bored, scared, determined, mischievous, cold, tender, thinking, eye_roll, deadpan`,
    `When a character has available sprites listed below, choose an exact listed expression name or the closest listed expression. Do not invent a new expression label for that character.`,
    `The engine auto-selects built-in full-body poses like idle, thinking, cheer, battle stance, attack, defend, casting, hurt, and victory. Only use a pose-like tag when it is explicitly listed below for that character as a custom sprite alias.`,
    ...(ctx.characterSprites?.length
      ? [
          ``,
          `Available sprites per character (prefer these expression names for accurate avatar display):`,
          ...ctx.characterSprites.map(
            (c) =>
              `  ${c.name}: ${(c.expressionChoices.length > 0 ? c.expressionChoices : c.expressions).join(", ")}${c.fullBody.length > 0 ? ` | custom full-body aliases: ${c.fullBody.join(", ")}` : ""}`,
          ),
        ]
      : []),
    ``,
    `Example turn:`,
    `[Dottore] [main] [thinking]: "Did she say when we should be there?"`,
    `[Pantalone] [side] [neutral]: "After lunch, I think."`,
    ``,
    `Rules:`,
    `- Use [main] for key dialogue that advances the scene`,
    `- Use [side] for brief, context-grounded remarks or interjections during another character's dialogue. Let the speaker react naturally; comedy and banter are optional when they fit.`,
    `- Use [action] for physical actions, combat moves, exploration actions, and quick non-verbal reactions. Never use asterisks (*) — write plain text.`,
    `- Use [thought] sparingly for a character's immediate private thought; it need not reveal inner conflict or foreshadow anything.`,
    `- Use [whisper:Name] for a quiet aside meant for that listener.`,
    `- ALWAYS include the [expression] tag for every line — it drives the portrait expression, while standard full-body poses are selected automatically by the engine`,
    `- Use characters with a concrete reason to participate. A requested ensemble conversation is such a reason: let present characters respond to each other and develop topics, without a roll call of disconnected reports.`,
    `- Honor the user's requested scope and length. A direct question may need a compact answer; a requested sustained conversation needs room to unfold. Yield at a genuine player decision without inventing the player's participation.`,
    `- In [action] lines, ALWAYS address the player as "you" when describing something done to/around the player (e.g. "He gestures vaguely at your entire being")`,
    `- Dialogue text in [main], [side], and [whisper] should be in quotes`,
    `- NEVER generate dialogue, action, whisper, side, main, or thought lines for the player (${ctx.playerName}). You control only party members, not the player.`,
    `</party_dialogue_format>`,
  );

  sections.push(
    `<party_rules>`,
    `- Stay in character for each party member — they have distinct personalities, speech patterns, and motivations`,
    `- React to the GM's narration and the player's actions naturally`,
    `- Party members can talk to each other and to the player`,
    `- They can suggest strategies, comment on events, share knowledge, have character moments`,
    `- They can volunteer actions in exploration/combat, but the GM decides outcomes`,
    `- They do NOT know the GM's secret story arc or plot twists. Use only what this speaker personally observed, heard, was explicitly told in-world, or can infer from concrete observable evidence; narration alone is not private-character knowledge.`,
    `- In combat: state what each party member does on their turn`,
    `- In dialogue: party members can interject, support, or disagree with the player`,
    `- Party members may order, ask, advise, offer, pressure, or initiate contact when in character, but stop before the player's voluntary response`,
    `- In travel/rest: focus on character bonding, camp activities, healing, planning`,
    `- In [action] lines describing something happening to or around the player, address the player as "you" (second person). Example: "He gestures vaguely at your entire being."`,
    `- Only when a concrete event meaningfully shifts a party member's bond with the player, append: [reputation: npc="Name" action="description"]. Do not reward or penalize every agreeable line, gift, compliment, routine kindness, ordinary disagreement, or merely pleasant beat.`,
    ``,
    `Current game state: ${ctx.gameActiveState}`,
    `</party_rules>`,
  );

  return sections.join("\n");
}
