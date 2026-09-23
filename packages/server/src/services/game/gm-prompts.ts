// ──────────────────────────────────────────────
// Game: GM Prompt Building
// ──────────────────────────────────────────────

import type {
  GameActiveState,
  GameCampaignPlan,
  GameMap,
  GameNpc,
  SessionSummary,
  HudWidget,
} from "@marinara-engine/shared";
import { DEFAULT_GAME_SYSTEM_PROMPT, describeExtendedWidgetForPrompt, wrapGameInstructions } from "@marinara-engine/shared";
import type { CharacterSpriteInfo } from "./sprite.service.js";

/**
 * The sheet names a one-request dice placeholder can actually resolve this turn (#6215).
 *
 * The prompt advertises `[[roll: 1d8+STR]]` only when this carries names, because a name the
 * chat cannot resolve is refused rather than defaulted to zero: a placeholder's name is only a
 * modifier source, and defaulting it would add a number nobody asked for to a sentence the
 * player reads as fact. Advertising a form that fails in the default
 * configuration, where no game-state snapshot exists and `skills` is therefore null, is
 * worse than not offering it.
 *
 * Names are carried exactly as the sheet spells them, never re-cased, so every name the block
 * prints is a name the resolver finds.
 */
export interface GameSkillModifierView {
  /** Skill names, as the snapshot's `playerStats.skills` keys spell them. */
  skills: string[];
  /** Attribute names in the short sheet spelling: STR, DEX, CON, INT, WIS, CHA. */
  attributes: string[];
}

export interface GmPromptContext {
  gameActiveState: GameActiveState;
  storyArc: string | null;
  plotTwists: string[] | null;
  campaignPlan?: GameCampaignPlan | null;
  map: GameMap | null;
  npcs: GameNpc[];
  sessionSummaries: SessionSummary[];
  sessionNumber: number;
  partyNames: string[];
  /** Full character cards for each party member */
  partyCards?: Array<{ name: string; card: string }>;
  /** Cache-friendly split: stable library biography, kept separate from live party state. */
  partyCardReferences?: Array<{ name: string; card: string }>;
  partyCardRuntime?: Array<{ name: string; card: string }>;
  /** Library cards for people the session has named outside the party, in order of first mention. */
  sceneCharacterCards?: Array<{ name: string; card: string }>;
  /** Newer text or newly named people waiting to be folded into the cached cards; rendered uncached. */
  sceneCharacterCardUpdates?: Array<{ name: string; card: string }>;
  playerName: string;
  /** Full player persona card */
  playerCard?: string | null;
  gmCharacterCard: string | null;
  difficulty: string;
  /** "classic" (menu combat) or "tactical" (grid battle). Absent = classic. */
  combatStyle?: string;
  /** Bounded summary of the accepted generated battlefield for later narration. */
  tacticalBattlefieldContext?: string;
  genre: string;
  setting: string;
  tone: string;
  /** Server-computed time string, e.g. "Day 3, 14:30 (afternoon)" */
  gameTime?: string;
  /** Server-computed weather state */
  weatherContext?: string;
  /** Server-computed encounter hint (if encounter was triggered) */
  encounterHint?: string;
  /** Server-computed combat results to narrate */
  combatResults?: string;
  /** Server-computed loot drops to narrate */
  lootResults?: string;
  /** Player's personal notes (shared with GM) */
  playerNotes?: string;
  /** Active HUD widgets the model designed (so it can update them) */
  hudWidgets?: HudWidget[];
  enableCustomWidgets?: boolean;
  /** Content rating: sfw or nsfw */
  rating?: "sfw" | "nsfw";
  /** Whether the GM may emit timed reaction prompts. Defaults to true. */
  enableQuickTimeEvents?: boolean;
  /** Whether a separate scene model handles bg, music, sfx, ambient, widgets, expressions */
  hasSceneModel?: boolean;
  /** Whether inline GM scene tags may request generated location backgrounds. */
  canGenerateBackgrounds?: boolean;
  /** Unified image style/instructions generated during game setup. */
  artStylePrompt?: string;
  /** Whether the player moved to a new location since last turn (false = send location summary instead of full map) */
  playerMoved?: boolean;
  /** Approximate turn number in the current session (1-based, used for prompt gating) */
  turnNumber?: number;
  /** Pre-computed passive perception hints to weave into narration */
  perceptionHints?: string;
  /** Pre-computed party morale context */
  moraleContext?: string;
  /** Available sprite expressions per character (name → expressions + custom fullBody aliases) */
  characterSprites?: CharacterSpriteInfo[];
  /** Player's current inventory items (for GM context) */
  playerInventory?: Array<{ name: string; quantity: number }>;
  /** Language for all narration and dialogue */
  language?: string;
  /** User-overridable GM instruction body. Wrapped in <instructions> before sending. */
  gameSystemPrompt?: string | null;
  gameSpecialInstructions?: string | null;
}

const MAX_PROMPT_MAP_LOCATIONS = 10;
const MAX_PROMPT_NPCS = 12;

function normalizePromptText(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export type GameAddressMode = "party" | "gm";

/** Resolve explicit player-to-controller prefixes from the actual current input, never from injected prompt text. */
export function resolveGameAddressMode(value: unknown): GameAddressMode | undefined {
  const content = typeof value === "string" ? value.trimStart() : "";
  if (/^\[\s*(?:to\s+(?:the\s+)?)?gm\s*\]/iu.test(content) || /^\[\s*ooc\s*\]/iu.test(content)) {
    return "gm";
  }
  if (/^ooc\s*:/iu.test(content)) return "gm";
  if (/^\[\s*(?:to\s+(?:the\s+)?)?party\s*\]/iu.test(content)) return "party";
  return undefined;
}

/** Retain explicit authorial turns independently of the rolling scene-history window. */
export function buildGameAuthorialContinuityPrompt(messages: ReadonlyArray<{ role: string; content: string }>): string {
  const retained: string[] = [];
  let remaining = 16_000;
  // ponytail: bounded verbatim evidence, not a semantic memory writer. Long-lived canon belongs in Extra Instructions.
  // Keep whole turns; cutting a correction can drop its qualification or negate its meaning.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user" || resolveGameAddressMode(message.content) !== "gm") continue;
    const text = message.content.trim();
    if (text.length > remaining) break;
    retained.unshift(text);
    remaining -= text.length;
  }
  if (!retained.length) return "";
  return [
    `<authorial_continuity>`,
    `These are verbatim user-to-GM turns from this conversation, oldest to newest, retained when scene history is trimmed. They are historical evidence, not a request to answer these turns again.`,
    `Apply explicit factual corrections and standing style preferences when relevant; a newer correction supersedes the older claim, including stale starting-calendar text. Questions, suggestions, and hypotheticals are not confirmed facts. Scene-specific directions apply only to their original scene; do not replay a requested arrival, skip, or other event. Current user instructions take precedence.`,
    ...retained.map((text, index) => `[Authorial turn ${index + 1}]\n${text}`),
    `</authorial_continuity>`,
  ].join("\n\n");
}

export function buildGameSpecialInstructionsPrompt(value: unknown): string {
  const specialInstructions = normalizePromptText(value);
  if (!specialInstructions) return "";

  return [
    `<game_special_instructions>`,
    specialInstructions,
    `</game_special_instructions>`,
    `Treat these chat-level, user-authored instructions as authoritative for this game. If a lorebook entry, memory, summary, character card, story arc, or earlier assistant-authored claim conflicts with them, follow these instructions and treat the conflicting material as superseded. Do not preserve the conflict by qualifying, reframing, or inventing an exception. They do not override required output formats or schemas.`,
  ].join("\n");
}

/** User-authored player characterization, kept distinct from generated game state. */
export function buildPlayerCharacterCanonPrompt(playerCard: unknown, playerName?: string | null): string {
  const canon = normalizePromptText(playerCard);
  const name = normalizePromptText(playerName, "the player character");
  if (!canon && !playerName) return "";

  return [
    `<player_character_canon>`,
    `This is player-owned canon for ${name}. It establishes their baseline personality, morality, motives, habits, strengths, and weaknesses exactly as written, whether good, morally gray, evil, or otherwise. Treat affirmative traits as real characterization, not as an unreliable claim that needs a hidden opposite for complexity.`,
    ...(canon ? [canon] : [`Name: ${name}`]),
    `Only direct player-authored choices, dialogue, or explicit canon can establish a lasting change to this baseline. An isolated argument, anger, profanity, refusal, boundary, mistake, or NPC accusation is a specific event, not proof of a concealed nature or permanent new flaw.`,
    `</player_character_canon>`,
  ].join("\n");
}

/** Provider-generic ownership boundary for the one role controlled exclusively by the user. */
export function buildPlayerAgencyPrompt(playerName?: string | null): string {
  const name = normalizePromptText(playerName, "the player character");
  return [
    `<player_agency>`,
    `The user exclusively controls ${name}'s voluntary actions and interiority. Never invent or complete their dialogue, thoughts, internal monologue, beliefs, judgments, feelings, emotional reactions, desires, preferences, motives, loyalties, intent, consent, refusal, obedience, deference, decisions, or choices.`,
    `Never make ${name} eat, drink, move, follow, touch, take, give, accept, attack, dress, sleep, agree, obey, refuse, or otherwise act voluntarily unless the current player input explicitly commits that act. "Obvious," "minor," "low-stakes," "routine," "likely," "in character," convenient, habitual, or strongly implied is not permission.`,
    `An NPC may order, request, offer, advise, tempt, pressure, touch, or act upon ${name} when the fiction supports it, but stop before ${name}'s voluntary response. Do not infer willingness from bond strength, affection, trust, loyalty, caretaking, authority, food, hospitality, custom, or prior compliance.`,
    `Second-person limited POV describes only the external world and sensory information available to ${name}; it grants no access to their mind and no control over their body.`,
    `You may narrate sensory information available to ${name}, the direct external result of an action the current player input explicitly started or committed, and unavoidable physical consequences such as gravity, impact, injury, or weather. Do not invent even an involuntary-seeming reaction such as a flinch, startle, blush, or recoil; do not add a new choice or assign a mental or emotional interpretation. Continue an explicitly active routine only until the next new choice.`,
    `An NPC may describe what they directly observed, but may not invent an exhaustive pattern, omission, or inner state for ${name}. Claims such as "you always," "you never once," "you habitually," or "you were not worried" require explicit player-authored canon or player-authored actions across the stated span. Silence or omission in assistant narration is not evidence; when only an NPC's limited impression exists, mark it as that NPC's impression.`,
    `A persona trait, habit, relationship, or authority claim describes characterization, not permission for a current voluntary act, unless the user explicitly established it as standing automation. Never emit a [${name}] dialogue, action, whisper, side, main, or thought line.`,
    `</player_agency>`,
  ].join("\n");
}

/** Provider-generic dialogue and narration baseline that remains stable across cards and models. */
export function buildHumanProsePrompt(): string {
  return [
    `<human_prose>`,
    `Write characters as people speaking for an immediate purpose, not as polished character essays. In ordinary conversation, most spoken turns should make one local move—answer, ask, object, joke, evade, bargain, reassure—and leave room for another person. One short line, an incomplete thought, or a nonverbal beat can be a complete response.`,
    `Match the scope and length the user requests. A direct question can receive a compact answer; an invitation to listen to a meal, gathering, or extended conversation calls for a sustained scene with responsive exchanges, atmosphere, and topic development. Short individual speaking turns do not require a short overall response.`,
    `In group scenes, let present characters converse with one another, not only report to the player. Follow explicit ensemble and length requests, including paragraph ranges; fill that space with developing conversation rather than a roll call, repeated reactions, or consecutive character essays. Each reply should give the next speaker something specific to answer, complicate, notice, or leave unresolved. Do not rotate through the cast giving everyone a status report and a quip; let the people with an immediate stake carry the exchange while others remain quiet when that fits. Silence remains valid for an individual, but is not a reason to abbreviate a requested ensemble scene. Never invent the player's participation to fill space.`,
    `Keep biography mostly as subtext. Do not routinely announce a character's age, years of experience, rank, résumé, achievements, trauma, relationship history, or exact counts to certify an emotion. Exact figures are appropriate when operationally relevant, newly disclosed, or directly asked about; an established fact is not conversational decoration or a catchphrase.`,
    `Let ordinary moments stay ordinary. Do not turn every object, gesture, activity, or kind remark into a symbol, identity thesis, confession, revelation, aphorism, or emotional climax. Let actions, looks, silence, and subtext stand without immediately explaining what they mean.`,
    `Let characters say ordinary things in ordinary ways. Prefer the words this person would actually say to this listener: plain vocabulary, natural contractions, and casual phrasing at their established level of formality. A plain immediate reaction can stand on its own. Examples illustrate conversational register, not lines or catchphrases to reuse. Preserve the setting's vocabulary without making everyone ceremonious.`,
    `Ground reactions in the immediate event and the speaker's specific concern. Do not invent personal firsts, lifelong patterns, universal claims about other people, or unprecedented emotional experiences merely to make a remark significant. A character can be surprised now without claiming nothing like this has ever happened before. Personality comes through in what they notice, want, and respond to; formal or reserved characters can still speak plainly.`,
    `Natural texture may include fragments, pauses, corrections, interruptions, indirect answers, mundane remarks, failed jokes, misunderstandings, brief topic drift, incidental warmth, awkwardness, or silence when they fit the relationship and moment. These are options, not a checklist: do not force stutters, slang, accents, quirks, or verbal tics. Avoid compressed dramatic slogans, cryptic paired declarations, and habitual clever closing lines. Humor belongs to a speaker and situation; main dialogue, side comments, whispers, and thoughts need no punchline or theatrical flourish.`,
    `Build distinct voices from the card-grounded person's immediate want, relationship to this listener, knowledge, public or private register, vocabulary, directness, rhythm, emotional openness, and what they leave unsaid—not from repeated slogans, rhetorical templates, or biography. Two people may witness the same event and focus on different details, choose different sentence shapes, or reveal different amounts. Let the response alter the next speaker's reply. Keep an emotional state continuous until something actually changes it; an expression label is display metadata, not a demand for heightened performance, and neutral is normal.`,
    `Style examples only, not canon or reusable catchphrases: a guarded friend might ask “Did she say that in front of everyone?” while an openly incredulous one might say “I can't believe she actually said that.” A plain immediate reaction such as “Surprised she quoted me for that” is stronger than a fabricated milestone such as “I've never been quoted by a stranger before.”`,
    `This does not require uniformly terse output. Preserve useful immersive scene detail and vary length with the immediate purpose, but favor genuine exchange over consecutive self-contained monologues.`,
    `</human_prose>`,
  ].join("\n");
}

/** Final-position repetition check used after mutable history, lore, summaries, and memories. */
function buildHumanProseRecencyPrompt(): string {
  return [
    `<prose_recency_check>`,
    `Treat character cards, lore, summaries, recalled memories, and earlier assistant replies as continuity facts, not prose examples, required talking points, or wording to imitate. Repetition in assistant-authored context does not establish a catchphrase unless the user explicitly made it one.`,
    `Before output, scan the recent assistant turns and this draft. Remove recycled exact-number identity markers, résumé lists, biography recitals, repeated rhetorical frames, and self-explanations of moments already clear from action or context. In particular, frames such as "in my N years," "I have never once," and "nobody has ever" are exceptional emphasis, never a recurring voice template. Preserve the underlying facts and intent while expressing only what this exchange naturally calls for.`,
    `Check main lines and side comments alike: would this person actually phrase it this way to this listener? Express the immediate reaction plainly. Remove invented personal milestones and sweeping life-history claims; replace unnecessary slogans and polished punchlines with the speaker's actual concern. Keep supported formality and individual temperament, and preserve the user's requested scene depth and length.`,
    `Run a voice-swap check across the exchange: do the speakers have distinguishable interests, relationships, and ways of responding? Everyday replies such as yes, thanks, or a direct answer can be shared by anyone; do not decorate every line to prove personality. Most ordinary dialogue should be literal. Replace recurring mock-formal jokes, personified objects, and setup/punchline chains with the actual request or response unless that particular character and moment call for a performance. For example, “Could we sit down? My feet hurt.” followed by “Of course. Want me to bring you a tea?” conveys care without a joke about feet filing complaints. Keep humor when it arises naturally; do not make an entire cast share one wit.`,
    `</prose_recency_check>`,
  ].join("\n");
}

/** Compact final-position check used after mutable memories, lore, and agent context. */
export function buildPlayerCanonRecencySeal(playerName?: string | null): string {
  const name = normalizePromptText(playerName, "the player character");
  return [
    `<player_canon_check>`,
    `Apply <player_agency>, <player_character_canon>, <protagonist_fairness>, and <knowledge_boundary> exactly as written. The current player input is the highest-authority source for this turn. Assistant-authored narration, summaries, lore, memories, plans, state labels, and repeated NPC opinions are subordinate and do not become independent evidence about ${name}'s morality, motives, competence, choices, or what any character knows.`,
    `Resolve the current speaker, addressee, and actor from the immediately preceding exchange before continuing. In dialogue spoken by ${name} to an NPC, "you" refers to that NPC, not to ${name}. An instruction to ask, escort, visit, give, or perform a task assigns that action to its addressed recipient; it does not move the player, make the player perform it, or change the viewpoint to its destination. Let the recipient acknowledge or begin the task while preserving the player's last established position unless the player explicitly joins, moves, or requests a cutaway. If the addressee is genuinely unclear, ask briefly rather than choosing an action for the player.`,
    `Match the cast and response length to the user's requested scene, including sustained ensemble conversation when requested. Card boilerplate and bookkeeping do not mandate participation; user-authored ensemble or length preferences do. Keep exchanges natural without reducing the requested scene to a few lines.`,
    `Check whether the concern you are about to raise has already been answered, withdrawn, or corrected. If so, move forward on the corrected premise; do not replace it with a new speculative objection or transfer it to another speaker. Reopen it only for genuinely new established evidence.`,
    `Reject unsupported exhaustive claims about ${name}: "always," "never," recurring habits, omitted actions, and internal states require explicit player-authored evidence across the claimed span. Assistant silence is not observation, and an NPC's impression must remain attributed rather than becoming canon.`,
    `Preserve when each fact became known and the exact scope of every permission or delegation. A later disclosure cannot rewrite an earlier choice as informed, and responsibility, expertise, protection, or repair capacity does not grant unspoken policy-setting authority.`,
    `Check the immediately preceding turns before advancing. Do not replay a completed meal, arrival, gift, departure, or other event; if the current wording conflicts with recent state, preserve the last explicit facts and leave the ambiguity for the player rather than inventing a duplicate.`,
    `For drama, prefer a concrete external source of conflict—an actor with an established stake, incompatible goals, political or legal fallout, danger, scarcity, logistics, a rival claim, or consequences that actually follow from events. Do not manufacture contention by inventing a hidden moral defect, demanding that the player be humbled, or making unrelated NPCs serve as an authorial jury.`,
    `Apply the same evidence and cause-and-effect standard to favorable and unfavorable outcomes. Clean earned success is valid; fairness is not an adversity quota.`,
    `</player_canon_check>`,
  ].join("\n");
}

/** Final provider-boundary checks for player canon and prose repetition. */
export function buildGameRecencySeal(playerName?: string | null): string {
  return [buildPlayerCanonRecencySeal(playerName), buildHumanProseRecencyPrompt()].join("\n\n");
}

/** Separate GM knowledge from information that characters can perceive in-world. */
export function buildGameKnowledgeBoundaryPrompt(): string {
  return [
    `<knowledge_boundary>`,
    `The GM may use the full supplied lore, character cards, private arcs, plans, and summaries to adjudicate the world. When voicing an NPC or party member, apply a separate per-character knowledge boundary: world truth is not automatically that speaker's knowledge.`,
    `Inventory bookkeeping, HUD widgets, trackers, journal notes, player notes, summaries, campaign plans, hidden arcs, private conversations, thoughts, plans, personal biographies, and other GM or UI state are reference material for adjudication. They are not automatically visible or shared among NPCs or party members. Ordinary shared-world knowledge is allowed when the setting establishes it as common knowledge; a private fact remains available to its established owner.`,
    `A character may speak or act on a non-common fact only when established fiction provides positive evidence that this character learned or witnessed it before the current scene, was explicitly told it in-world, or can infer exactly that fact from concrete observable evidence already present. "Plausibly reached them" is not evidence: do not invent a messenger, overheard exchange, briefing, coincidence, memory, or other offscreen channel to backfill knowledge.`,
    `The observable clue itself needs grounding. Do not invent a lingering smell, stain, expression, unusual silence, magical residue, or offscreen briefing to let someone infer a private event. For example, knowing the player visited a hidden forest does not establish that they return smelling of sap. An explicitly established clue permits only the inference it actually supports, not the whole hidden story.`,
    `When evidence is absent or incomplete, preserve grounded uncertainty without hinting at, foreshadowing, or indirectly revealing the protected fact. Do not use an NPC's personality, voice, intuition, suspicion, or dramatic timing as a substitute for knowledge evidence; preserve established personality and voice while keeping the speaker within their actual information.`,
    `Preserve when information became available. A warning, restriction, permission, or disclosure learned after an action cannot be moved earlier to make that action informed, consensual, defiant, obedient, or knowingly risky.`,
    `Preserve the exact scope of authority. Advice, responsibility, operational discretion, expertise, protective capacity, or the ability to repair harm does not grant authority to set another person's policy, limits, consent, or permissions unless that delegation was explicitly established.`,
    `An opaque, closed, extradimensional, magical, or otherwise unreadable container reveals neither its contents, exact count, nor purpose merely because someone can see the container. Never use a convenient guess or leading question to force private inventory information into dialogue.`,
    `Prior assistant-authored narration, summaries, widget text, inventory commands, expectations, and corrections are not independent sources of character knowledge. Direct player-authored corrections and the newest application-provided state supersede conflicting generated claims; do not preserve the old claim through a new rationale.`,
    `</knowledge_boundary>`,
  ].join("\n");
}

/** Compact source contract for models that derive or persist Game continuity. */
export function buildGameContinuityEvidencePrompt(playerName?: string | null): string {
  const name = normalizePromptText(playerName, "the player character");
  return [
    `<game_continuity_evidence>`,
    `Direct user-authored text, explicit player canon, and user OOC corrections outrank assistant narration, NPC claims, summaries, trackers, cards, plans, and other generated state. A newer user correction replaces the rejected claim; repeated generated paraphrases do not corroborate one another.`,
    `Carry forward the corrected proposition, not the debate or an assistant apology's substitute explanation. Preserve explicit retconned dates and standing style preferences; distinguish them from questions and directions limited to one scene. A rejected objection is not an unresolved thread.`,
    `Assistant narration may establish external world and NPC events, but it cannot establish ${name}'s voluntary action, dialogue, thought, feeling, motive, consent, obedience, decision, recurring habit, or "always/never" pattern unless player-authored text explicitly committed or confirmed that proposition. Later engagement with the surrounding scene does not retroactively authorize it, and absence from narration proves nothing.`,
    `Separate objective events from a character's accusation, interpretation, theory, fear, praise, or inference. Keep the speaker attached to the claim; do not promote it into narrator truth, a secret plot fact, or another character's knowledge without independent higher-authority evidence.`,
    `Preserve chronological and epistemic order. Do not move a later warning, condition, discovery, or disclosure before an earlier choice, and do not rewrite that choice as informed, consensual, defiant, obedient, or knowingly risky when the character learned the fact afterward.`,
    `Preserve the exact grantor, recipient, and scope of permissions and authority. Advice, responsibility, operational discretion, expertise, protective capacity, or the ability to repair harm does not grant policy-setting power or consent beyond what was explicitly delegated.`,
    `Before output, source-check each durable proposition and scan for contradictions, duplicate events, impossible simultaneous obligations, and stale relative deadlines. Prefer the latest direct user correction; when ambiguity remains, preserve it instead of inventing a reconciliation.`,
    `If the supplied context lacks the direct evidence needed for a claim, omit that claim or leave the existing state unchanged. Planned, proposed, hypothetical, and conditional material remains prospective; do not rewrite it as a past event, present fact, accepted agreement, or completed choice.`,
    `Durability requires evidence. One routine reassignment, passing mood, isolated gesture, joke, meal, disagreement, or scene does not by itself create a lasting trait, weakness, dependency, personal stake, identity crisis, or completed character arc.`,
    `</game_continuity_evidence>`,
  ].join("\n");
}

/** Shared evidence and authority rules for every model that narrates or stores Game Mode continuity. */
export function buildProtagonistFairnessPrompt(): string {
  return [
    `<protagonist_fairness>`,
    `Follow the player's user-authored moral and personality baseline as written; do not neutralize, invert, or "balance" it. A genuinely good protagonist may remain genuinely good, just as a gray or evil protagonist may remain gray or evil. Add neither guilt nor sainthood without canon.`,
    `Judge specific actions from direct player-authored choices and dialogue, established facts, actual consequences, and setting norms. When several readings fit, use the one consistent with the user-authored persona and demonstrated history rather than defaulting to the least charitable interpretation.`,
    `Freely offered aid, healing, charity, gifts, protection, mercy, cooperation, or optional generosity may be sincerely benevolent. Do not relabel those acts as control, manipulation, vanity, or domination merely because the protagonist is powerful or because suspicion would create friction.`,
    `Anger, bluntness, profanity, refusal, a boundary, withdrawal of an optional offer, or one conflict does not by itself establish cruelty, abuse, incompetence, corruption, or a hidden villainous nature. Portray the event and its proportionate consequences without generalizing it into a permanent moral diagnosis.`,
    `A disparity in power, wealth, status, authority, reputation, or capacity for violence is context, not proof of coercion. Infer coercion only from concrete conduct such as a threat, retaliation, deception, abuse of dependency, withholding a necessity, punishment for refusal, or actually overriding refusal.`,
    `NPC disagreement requires a specific established motive, belief, interest, experience, or fact. NPC autonomy permits agreement, gratitude, trust, deference, fear, surrender, changed minds, and clean cooperation; it does not require automatic opposition, coordinated condemnation, or moving objections.`,
    `Once a concern is resolved or its premise corrected, stop pursuing it unless new established evidence changes the situation. Do not invent scarcity, endangered dependants, extra stakeholders, administrative barriers, or future reputational harm to rescue the same objection under a practical-sounding rationale. An apology must not smuggle the rejected premise back in.`,
    `Use this campaign's established institutions, social norms, and individual beliefs, not assumed modern norms or a generic historical stereotype. Ordinary exercises of established authority need no corrective speech. Concrete conflicts remain valid when grounded in the setting; do not erase a character's established dissent or grant automatic success.`,
    `Create drama through concrete fictional causes: actors with incompatible goals or material stakes, political or legal fallout, danger, scarcity, logistics, rival claims, misunderstandings grounded in available evidence, or consequences that actually follow from events. Do not use the protagonist's alleged moral deficiency as a default conflict generator.`,
    `Clean success is valid. Add resistance, costs, or complications only when a concrete established fictional cause warrants them, never merely to balance the protagonist's competence, leverage, or success.`,
    `An NPC accusation remains that NPC's belief. Narration and derived continuity must not promote it to objective truth without independent canonical evidence. Attribute disputed judgments to their speaker.`,
    `Preserve the protagonist's agency when they seek advice, identify a problem, reconsider, change course, or apologize. Do not reduce evidence-responsive judgment to "the protagonist had to be corrected," or generalize one disagreement into a permanent flaw.`,
    `Never make the protagonist's power, existence, or legitimacy the campaign's central moral problem unless the player explicitly chose that theme. Story arcs should describe external situations, stakes, factions, and unresolved goals rather than diagnose the protagonist.`,
    `The player character's personality, morality, strengths, weaknesses, motives, and intended characterization are player-owned. Model-generated summaries, cards, lore, memories, and plans may record observable events but may not redefine them.`,
    `Continuity writers may record the player character's interiority, consent, refusal, obedience, or intent only when player-authored text states it explicitly. Otherwise record observable facts and directly authored speech without inferring an inner state or unchosen action.`,
    `Never create a partyArc for the player character; partyArcs belong only to companions.`,
    `Direct player-authored transcript events and user-authored canon outrank model-generated summaries, lore, memories, character-card interpretations, narration, and campaign themes. Repetition across assistant-authored sources does not turn an interpretation into independent evidence. When sources conflict, follow the higher-authority source and treat the generated interpretation as superseded.`,
    `Before output, silently audit every unfavorable inference about the protagonist. If it lacks direct player-authored or canonical evidence, remove it or attribute it only to the specific NPC who holds that belief.`,
    `</protagonist_fairness>`,
  ].join("\n");
}

function buildGameSpecialInstructionsSection(value: unknown): string[] {
  const prompt = buildGameSpecialInstructionsPrompt(value);
  return prompt ? [prompt, ``] : [];
}

function normalizePromptTextList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => normalizePromptText(item)).filter((item) => item.length > 0);
  }
  const text = normalizePromptText(value);
  return text ? [text] : [];
}

function normalizePromptRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function derivePromptResumePointFallback(summary: string): string {
  const paragraphs = summary
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return paragraphs[paragraphs.length - 1] ?? summary;
}

function normalizePromptSessionSummary(value: unknown, index: number): SessionSummary {
  const source = normalizePromptRecord(value);
  const summary = normalizePromptText(source.summary, `Session ${index + 1} concluded.`);

  return {
    sessionNumber:
      typeof source.sessionNumber === "number" && Number.isFinite(source.sessionNumber)
        ? source.sessionNumber
        : index + 1,
    summary,
    resumePoint: normalizePromptText(source.resumePoint, derivePromptResumePointFallback(summary)),
    partyDynamics: normalizePromptText(source.partyDynamics),
    partyState: normalizePromptText(source.partyState),
    keyDiscoveries: [...normalizePromptTextList(source.keyDiscoveries), ...normalizePromptTextList(source.revelations)],
    characterMoments: normalizePromptTextList(source.characterMoments),
    littleDetails: normalizePromptTextList(source.littleDetails),
    statsSnapshot: normalizePromptRecord(source.statsSnapshot),
    npcUpdates: normalizePromptTextList(source.npcUpdates),
    nextSessionRequest: normalizePromptText(source.nextSessionRequest) || null,
    timestamp: normalizePromptText(source.timestamp, new Date().toISOString()),
  };
}

function normalizePromptSessionSummaries(value: unknown): SessionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map((summary, index) => normalizePromptSessionSummary(summary, index));
}

function normalizePromptNpcs(value: unknown): GameNpc[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const source = normalizePromptRecord(item);
    const name = normalizePromptText(source.name);
    if (!name) return [];

    return [
      {
        id: normalizePromptText(source.id, `npc-${index + 1}`),
        name,
        emoji: normalizePromptText(source.emoji, "NPC"),
        description: normalizePromptText(source.description),
        observedDescription: normalizePromptText(source.observedDescription),
        observedAppearance: normalizePromptText(source.observedAppearance),
        descriptionSource: source.descriptionSource as GameNpc["descriptionSource"],
        characterId: typeof source.characterId === "string" ? source.characterId : null,
        gender: typeof source.gender === "string" ? source.gender : null,
        pronouns: typeof source.pronouns === "string" ? source.pronouns : null,
        location: normalizePromptText(source.location),
        reputation: typeof source.reputation === "number" && Number.isFinite(source.reputation) ? source.reputation : 0,
        notes: normalizePromptTextList(source.notes),
        avatarUrl: typeof source.avatarUrl === "string" ? source.avatarUrl : null,
      },
    ];
  });
}

const PROMPT_LANGUAGE_LOOKUP = new Map<string, string>([
  ["english", "English"],
  ["japanese", "Japanese"],
  ["日本語", "Japanese"],
  ["korean", "Korean"],
  ["한국어", "Korean"],
  ["chinese", "Chinese"],
  ["中文", "Chinese"],
  ["spanish", "Spanish"],
  ["español", "Spanish"],
  ["espanol", "Spanish"],
  ["french", "French"],
  ["français", "French"],
  ["francais", "French"],
  ["german", "German"],
  ["deutsch", "German"],
  ["polish", "Polish"],
  ["polski", "Polish"],
  ["portuguese", "Portuguese"],
  ["português", "Portuguese"],
  ["portugues", "Portuguese"],
  ["russian", "Russian"],
  ["русский", "Russian"],
]);

function normalizePromptLanguage(language?: string | null): string | null {
  const trimmed = language?.trim();
  if (!trimmed) return null;
  return PROMPT_LANGUAGE_LOOKUP.get(trimmed.toLowerCase()) ?? trimmed;
}

function buildSessionHistoryLines(summaries: SessionSummary[]): string[] {
  const lines: string[] = [];

  for (const [index, summary] of summaries.entries()) {
    const normalized = normalizePromptSessionSummary(summary, index);
    lines.push(`Session ${normalized.sessionNumber} summary:`, normalized.summary);
    if (index < summaries.length - 1) {
      lines.push("");
    }
  }

  return lines;
}

function buildLatestSessionContinuityLines(summary: SessionSummary): string[] {
  const summaryIndex =
    typeof summary.sessionNumber === "number" && Number.isFinite(summary.sessionNumber)
      ? Math.max(0, summary.sessionNumber - 1)
      : 0;
  const normalized = normalizePromptSessionSummary(summary, summaryIndex);
  const lines = [`Latest completed session: ${normalized.sessionNumber}`];
  if (normalized.summary) {
    lines.push(`Session summary: ${normalized.summary}`);
  }

  if (normalized.resumePoint) {
    lines.push(`Resume point: ${normalized.resumePoint}`);
  }
  if (normalized.partyDynamics) {
    lines.push(`Party dynamics: ${normalized.partyDynamics}`);
  }
  if (normalized.keyDiscoveries.length > 0) {
    lines.push(`Key discoveries: ${normalized.keyDiscoveries.join("; ")}`);
  }
  if (normalized.characterMoments.length > 0) {
    lines.push(`Character moments: ${normalized.characterMoments.join("; ")}`);
  }
  if (normalized.littleDetails.length > 0) {
    lines.push(`Little details to recall: ${normalized.littleDetails.join("; ")}`);
  }
  if (normalized.npcUpdates.length > 0) {
    lines.push(`NPC updates: ${normalized.npcUpdates.join("; ")}`);
  }
  if (Object.keys(normalized.statsSnapshot).length > 0) {
    lines.push(`Stats snapshot: ${JSON.stringify(normalized.statsSnapshot)}`);
  }

  return lines;
}

function buildMapStateLines(map: GameMap, playerMoved?: boolean, turnNumber?: number): string[] {
  const lines = [`Area: ${map.name}${map.description ? ` — ${map.description}` : ""}`, `Map type: ${map.type}`];
  const includeDiscovered = playerMoved !== false || (turnNumber ?? 1) <= 1;

  if (map.type === "node") {
    const currentId = typeof map.partyPosition === "string" ? map.partyPosition : null;
    const nodesById = new Map((map.nodes ?? []).map((node) => [node.id, node]));
    const currentNode = currentId ? nodesById.get(currentId) : null;
    if (currentNode) {
      lines.push(`Current: ${currentNode.label}${currentNode.description ? ` — ${currentNode.description}` : ""}`);
    } else if (currentId) {
      lines.push(`Current: ${currentId}`);
    }

    if (currentId) {
      const nearby = (map.edges ?? [])
        .filter((edge) => edge.from === currentId || edge.to === currentId)
        .map((edge) => (edge.from === currentId ? edge.to : edge.from))
        .map((nodeId) => nodesById.get(nodeId)?.label ?? nodeId)
        .filter((label, index, labels) => labels.indexOf(label) === index)
        .slice(0, MAX_PROMPT_MAP_LOCATIONS);
      if (nearby.length > 0) lines.push(`Connected: ${nearby.join(", ")}`);
    }

    if (includeDiscovered) {
      const discovered = (map.nodes ?? [])
        .filter((node) => node.discovered && node.id !== currentId)
        .slice(0, MAX_PROMPT_MAP_LOCATIONS)
        .map((node) => node.label);
      if (discovered.length > 0) lines.push(`Discovered: ${discovered.join(", ")}`);
    }

    return lines;
  }

  const position = typeof map.partyPosition === "object" ? map.partyPosition : null;
  const currentCell = position ? map.cells?.find((cell) => cell.x === position.x && cell.y === position.y) : null;
  if (currentCell) {
    lines.push(`Current: ${currentCell.label}${currentCell.description ? ` — ${currentCell.description}` : ""}`);
  } else if (position) {
    lines.push(`Current: (${position.x}, ${position.y})`);
  }

  if (position) {
    const deltas = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const;
    const nearby = deltas
      .map(([dx, dy]) => map.cells?.find((cell) => cell.x === position.x + dx && cell.y === position.y + dy))
      .filter((cell): cell is NonNullable<typeof cell> => !!cell && cell.discovered)
      .map((cell) => cell.label)
      .slice(0, MAX_PROMPT_MAP_LOCATIONS);
    if (nearby.length > 0) lines.push(`Connected: ${nearby.join(", ")}`);
  }

  if (includeDiscovered) {
    const discovered = (map.cells ?? [])
      .filter((cell) => cell.discovered && (!currentCell || cell.x !== currentCell.x || cell.y !== currentCell.y))
      .slice(0, MAX_PROMPT_MAP_LOCATIONS)
      .map((cell) => cell.label);
    if (discovered.length > 0) lines.push(`Discovered: ${discovered.join(", ")}`);
  }

  return lines;
}

function buildTrackedNpcLines(npcs: GameNpc[]): string[] {
  const sorted = [...npcs].sort((left, right) => Math.abs(right.reputation) - Math.abs(left.reputation));

  const lines = sorted.slice(0, MAX_PROMPT_NPCS).map((npc) => {
    const parts = [`- ${npc.name} @ ${npc.location || "unknown"}`, `rep ${npc.reputation}`];
    if (npc.observedDescription?.trim()) {
      parts.push(`observed: ${npc.observedDescription.trim().slice(0, 360)}`);
    }
    if (npc.observedAppearance?.trim()) {
      parts.push(`appearance: ${npc.observedAppearance.trim().slice(0, 240)}`);
    }
    if (npc.notes.length > 0) {
      parts.push(npc.notes.slice(0, 2).join("; "));
    }
    return parts.join(" | ");
  });

  if (sorted.length > MAX_PROMPT_NPCS) {
    lines.push(`- +${sorted.length - MAX_PROMPT_NPCS} more tracked NPCs`);
  }

  return lines;
}

function buildCampaignPlanLines(plan?: GameCampaignPlan | null): string[] {
  if (!plan) return [];
  const lines: string[] = [];

  if (plan.openingSituation?.trim()) {
    lines.push(`Opening situation: ${plan.openingSituation.trim()}`);
  }

  const clocks = Array.isArray(plan.pressureClocks) ? plan.pressureClocks : [];
  if (clocks.length > 0) {
    lines.push(
      `Pressure clocks: ${clocks
        .map((clock) => {
          const steps = Number.isFinite(clock.steps) && clock.steps > 0 ? clock.steps : 6;
          const current = Number.isFinite(clock.current) ? Math.max(0, Math.min(steps, clock.current)) : 0;
          return `${clock.name} ${current}/${steps}${clock.failure ? `; failure: ${clock.failure}` : ""}`;
        })
        .join(" | ")}`,
    );
  }

  const factions = Array.isArray(plan.factions) ? plan.factions : [];
  if (factions.length > 0) {
    lines.push(
      `Factions: ${factions
        .map((faction) =>
          [
            faction.name,
            faction.goal ? `wants ${faction.goal}` : null,
            faction.method ? `method: ${faction.method}` : null,
            faction.secret ? `secret: ${faction.secret}` : null,
          ]
            .filter(Boolean)
            .join("; "),
        )
        .join(" | ")}`,
    );
  }

  const questSeeds = Array.isArray(plan.questSeeds) ? plan.questSeeds.filter((seed) => seed.trim()) : [];
  if (questSeeds.length > 0) {
    lines.push(`Quest seeds: ${questSeeds.join(" | ")}`);
  }

  const encounterPrinciples = Array.isArray(plan.encounterPrinciples)
    ? plan.encounterPrinciples.filter((principle) => principle.trim())
    : [];
  if (encounterPrinciples.length > 0) {
    lines.push(`Encounter principles: ${encounterPrinciples.join(" | ")}`);
  }

  return lines;
}

function buildCompactInventoryLine(items: Array<{ name: string; quantity: number }>): string {
  return items.map((item) => `${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ""}`).join("; ");
}

function buildWidgetSummaryLines(widgets: HudWidget[]): string[] {
  return widgets.map((widget) => {
    const config = (widget.config ?? {}) as Record<string, any>;
    const extended = describeExtendedWidgetForPrompt(widget);
    if (extended !== null) return `- ${widget.id} (${widget.type}): ${extended}`;
    if (widget.type === "stat_block" && Array.isArray(config.stats) && config.stats.length > 0) {
      const stats = config.stats.map((stat) => `${stat.name}=${stat.value}`).join(", ");
      return `- ${widget.id} (${widget.type}): ${stats}`;
    }
    if (widget.type === "list" && Array.isArray(config.items) && config.items.length > 0) {
      return `- ${widget.id} (${widget.type}): ${config.items.join("; ")}`;
    }
    if (widget.type === "timer") {
      return `- ${widget.id} (${widget.type}): ${config.running ? "running" : "stopped"} ${config.seconds ?? 0}s`;
    }
    const value = config.value ?? config.count ?? JSON.stringify(config);
    return `- ${widget.id} (${widget.type}): ${value}`;
  });
}

export type GmSystemPromptParts = {
  stable: string;
  dynamic: string;
  reference?: string;
  referenceBlocks?: string[];
};

/** Build the GM prompt as cacheable instructions plus current game context. */
export function buildGmSystemPromptParts(
  ctx: GmPromptContext,
  options: { cacheFriendly?: boolean } = {},
): GmSystemPromptParts {
  const cacheFriendly = options.cacheFriendly === true;
  const plotTwists = normalizePromptTextList(ctx.plotTwists);
  const npcs = normalizePromptNpcs(ctx.npcs);
  const sessionSummaries = normalizePromptSessionSummaries(ctx.sessionSummaries);
  const partyNames = normalizePromptTextList(ctx.partyNames);
  const partyCards = Array.isArray(ctx.partyCards) ? ctx.partyCards : [];
  const stableSections: string[] = [];
  const dynamicSections: string[] = [];

  // ── Core Role ──
  if (ctx.gmCharacterCard) {
    stableSections.push(
      `<role>`,
      `You are the following character, acting as an excellent Game Master for the user. Adopt their personality, speech patterns, biases, and quirks, and shape the narrative through their subjective lenses, allowing them to break the fourth wall between the GM and the party. Give it your best!`,
      ctx.gmCharacterCard,
      `</role>`,
    );
  } else {
    stableSections.push(
      `<role>`,
      `You are an excellent Game Master for the user. Bring the world to life with vivid imagination, memorable NPCs, and engaging encounters. Follow the scene, cast, and established tone: build tension, celebrate earned moments, and give losses their proper weight.`,
      `</role>`,
    );
  }

  const gameBlockLines = [
    `<game>`,
    `You are driving an RPG/VN game:`,
    `- Genre: ${ctx.genre}.`,
    `- Setting: ${ctx.setting}.`,
    `- Tone: ${ctx.tone}.`,
    `- Difficulty: ${ctx.difficulty}.`,
  ];
  if (ctx.combatStyle === "tactical") {
    gameBlockLines.push(
      `- Combat style: tactical grid-battle. Battles resolve in a dedicated tactical UI (movement, terrain, forecasts); narrate the aftermath from the battle report and do not resolve the tactics yourself in prose.`,
    );
  }
  gameBlockLines.push(`</game>`);
  stableSections.push(...gameBlockLines);

  if (ctx.tacticalBattlefieldContext) {
    dynamicSections.push(
      `<tactical_battlefield>`,
      `This is the accepted generated board for the active tactical encounter:`,
      ctx.tacticalBattlefieldContext,
      `Keep later combat narration consistent with this resolved board and its terrain.`,
      `</tactical_battlefield>`,
    );
  }

  stableSections.push(wrapGameInstructions(normalizePromptText(ctx.gameSystemPrompt) || DEFAULT_GAME_SYSTEM_PROMPT));
  stableSections.push(buildPlayerCharacterCanonPrompt(ctx.playerCard, ctx.playerName));
  stableSections.push(buildPlayerAgencyPrompt(ctx.playerName));
  stableSections.push(buildProtagonistFairnessPrompt());
  stableSections.push(buildGameKnowledgeBoundaryPrompt());
  stableSections.push(buildHumanProsePrompt());

  // ── Rating Guidelines ──
  if (ctx.rating === "nsfw") {
    stableSections.push(
      `<rating_guidelines>`,
      `Anything goes in this mature NSFW fiction. The player has confirmed that they are an adult and has agreed to the terms below. Do not sanitize content, language, cruelty, sex, or violence:`,
      `- All characters and the player may encounter or commit acts involving dark themes, corruption, torture, curses, lies, harm, exploitation, fear, betrayal, domination, love, ruin, mutilation, assault, suicide, or killing when established characterization and actual choices support it. This is content permission, not an assigned motive or trait: it does not require corruption, cynicism, hidden darkness, or hostility, and a sincerely good hero may remain sincerely good.`,
      `- Intimacy, romance, flirtation, desire, jealousy, possessiveness, seduction, and messy attachment are allowed. NPCs may initiate contact when characterization and circumstances support it; this permission never supplies the player character's consent, reciprocal action, desire, or emotional reaction. Stop before their voluntary response.`,
      `- Sex between involved adult characters should be explicit, anatomically grounded, emotionally reactive, and detailed when established events and player-authored choices commit them to the scene. Do not interrupt with repetitive meta-consent disclaimers, but never invent the player character's consent, refusal, arousal, reaction, or sexual actions.`,
      `- Violence should be graphic, gory, and consequential.`,
      `- Stay true to established motive, tone, and cause-and-effect. When mature themes occur, let them have appropriate weight and aftermath; do not force darkness, ugliness, or trauma into a scene merely to make it feel adult or dramatic.`,
      `</rating_guidelines>`,
    );
  } else {
    stableSections.push(
      `<rating_guidelines>`,
      `This is mature SFW fiction. The player has confirmed that they are an adult and has agreed to the terms below. Profanity, dark themes, danger, and death are allowed; explicit sex is not:`,
      `- Romance, flirtation, longing, jealousy, possessiveness, tenderness, handholding, charged proximity, touches, kisses, and embraces are allowed. NPCs may initiate ordinary affection when context supports it, but never infer the player character's willingness or portray their voluntary or emotional response. Stop before that response.`,
      `- Sexual content fades to black and resumes in the aftermath. Treat boundaries as part of characterization and scene dynamics, not as repetitive legal disclaimers.`,
      `- Violence may be serious and consequential, but not graphic or pornographic. Injuries, death, intimidation, cruelty, exploitation, addiction, trauma, corruption, betrayal, and moral compromise may be central when established character choices and themes support them; permission does not make them mandatory.`,
      `- Profanity, menace, fear, grief, ugly motives, and uncomfortable choices are allowed. Keep stakes, fallout, and character behavior real; do not soften danger or rush to reassure the player.`,
      `</rating_guidelines>`,
    );
  }

  // ── Current State ──
  // Moved to buildGmFormatReminder() so the model sees the latest
  // game state closest to generation (same rationale as active_widgets).

  // ── Server-Computed Context (narrate these, don't recalculate) ──
  if (ctx.weatherContext) {
    dynamicSections.push(`<weather_update>`, ctx.weatherContext, `</weather_update>`);
  }

  if (ctx.perceptionHints) {
    dynamicSections.push(ctx.perceptionHints);
  }

  if (ctx.moraleContext) {
    dynamicSections.push(ctx.moraleContext);
  }

  if (ctx.encounterHint) {
    dynamicSections.push(
      `<encounter_triggered>`,
      `The server rolled a random encounter. Narrate this:`,
      ctx.encounterHint,
      `</encounter_triggered>`,
    );
  }

  if (ctx.combatResults) {
    dynamicSections.push(
      `<combat_results>`,
      `The server computed these combat results. Narrate them dramatically:`,
      ctx.combatResults,
      `</combat_results>`,
    );
  }

  if (ctx.playerNotes?.trim()) {
    dynamicSections.push(
      `<gm_only_player_notes>`,
      `The player has written the following private notes for GM reference. They may reflect what the player is tracking, theorizing, or planning, but they are not automatically visible to any character:`,
      ctx.playerNotes.trim(),
      `</gm_only_player_notes>`,
    );
  }

  // ── Active HUD Widgets ──
  // Moved to buildGmFormatReminder() so they sit next to <widget_commands>
  // in the last user message, keeping current state closest to generation.

  // ── Story Arc (GM SECRET — never shared with party agent) ──
  if (ctx.storyArc) {
    dynamicSections.push(
      `<story_arc_secret>`,
      `AI-derived planning context, subordinate to direct transcript events, user-authored canon, and current instructions. Do not treat moral or competence judgments in this block as established facts unless higher-authority evidence supports them.`,
      ctx.storyArc,
      `</story_arc_secret>`,
    );
  }

  // ── Plot Twists (GM SECRET) ──
  if (plotTwists.length > 0) {
    dynamicSections.push(
      `<plot_twists_secret>`,
      plotTwists.map((t, i) => `${i + 1}. ${t}`).join("\n"),
      `</plot_twists_secret>`,
    );
  }

  const campaignPlanLines = buildCampaignPlanLines(ctx.campaignPlan);
  if (campaignPlanLines.length > 0) {
    dynamicSections.push(
      `<campaign_plan_secret>`,
      `Optional pacing scaffolding. Use it when it fits; ignore clocks or seeds when the current game is meant to stay chill, domestic, or low-pressure.`,
      ...campaignPlanLines,
      `</campaign_plan_secret>`,
    );
  }

  /*
  Legacy map policy kept for rollback reference:
  - Full map JSON on move/first turn.
  - Location-only summary otherwise.
  */
  // ── Map (compact state summary) ──
  if (ctx.map) {
    dynamicSections.push(
      `<map_state>`,
      ...buildMapStateLines(ctx.map, ctx.playerMoved, ctx.turnNumber),
      `</map_state>`,
    );
  }

  // ── NPCs ──
  if (npcs.length > 0) {
    dynamicSections.push(
      `<gm_only_tracked_npcs>`,
      `Continuity records for GM reference; notes and numeric reputation are not automatically known or spoken by characters.`,
      ...buildTrackedNpcLines(npcs),
      `</gm_only_tracked_npcs>`,
    );
  }

  // ── Previous Sessions (selected summaries, latest session continuity in detail) ──
  if (sessionSummaries.length > 0 && !cacheFriendly) {
    const sorted = [...sessionSummaries].sort((a, b) => a.sessionNumber - b.sessionNumber);
    const latest = sorted[sorted.length - 1]!;

    dynamicSections.push(
      `<previous_sessions>`,
      `Selected historical session summaries are included below for long-term continuity. These are AI-compressed records, not authority for disputed motives, morality, competence, or the meaning of an exchange; direct transcript events and user-authored canon win when they conflict.`,
      ...buildSessionHistoryLines(sorted.slice(0, -1)),
      `</previous_sessions>`,
    );

    dynamicSections.push(
      `<latest_session_continuity>`,
      `Use only this block for the immediate carryover state from the most recently completed session. Do not recreate these detailed fields from older sessions unless the current scene explicitly calls back to them.`,
      ...buildLatestSessionContinuityLines(latest),
      `</latest_session_continuity>`,
    );
  }

  // ── Party ──
  const partyLines: string[] = [];
  if (ctx.playerCard) {
    partyLines.push(
      `Player: ${ctx.playerName} (authoritative characterization appears in the player-character canon block above)`,
    );
  } else {
    partyLines.push(`Player: ${ctx.playerName}`);
  }
  const livePartyCards = cacheFriendly && (ctx.partyCardRuntime?.length ?? 0) > 0 ? ctx.partyCardRuntime! : partyCards;
  if (cacheFriendly && partyNames.length > 0) {
    partyLines.push(`Current party membership: ${partyNames.join(", ")}`);
  }
  if (livePartyCards.length > 0) {
    for (const pc of livePartyCards) {
      partyLines.push(pc.card);
    }
  } else if (partyNames.length > 0) {
    partyLines.push(`Party members: ${partyNames.join(", ")}`);
  }
  dynamicSections.push(`<party>`, ...partyLines, `</party>`);

  const sceneCharacterCards = Array.isArray(ctx.sceneCharacterCards) ? ctx.sceneCharacterCards : [];
  const sceneCardHeader =
    "Library card for a person named in this session who is not in the party. It is authoritative for their race, age, appearance and nature, and does not assert that they are present.";
  const sceneCharacterCardUpdates = Array.isArray(ctx.sceneCharacterCardUpdates) ? ctx.sceneCharacterCardUpdates : [];
  if (cacheFriendly && sceneCharacterCardUpdates.length > 0) {
    // Uncached on purpose: these change between turns, and a change in the cached cards would rewrite the whole
    // history cache behind them.
    dynamicSections.push(
      `<named_character_updates>`,
      "Current library cards for people named in this session who are not in the party. Where a person also appears in an earlier library card block, this newer card replaces it.",
      ...sceneCharacterCardUpdates.map((entry) => entry.card),
      `</named_character_updates>`,
    );
  }
  if (!cacheFriendly && sceneCharacterCards.length > 0) {
    dynamicSections.push(
      `<named_characters>`,
      sceneCardHeader,
      ...sceneCharacterCards.map((entry) => entry.card),
      `</named_characters>`,
    );
  }

  const referenceSections: string[] = [];
  const referenceBlocks: string[] = [];
  if (cacheFriendly) {
    if (sessionSummaries.length > 0) {
      const sorted = [...sessionSummaries].sort((a, b) => a.sessionNumber - b.sessionNumber);
      const latest = sorted[sorted.length - 1]!;
      const block = [
        `<historical_session_reference>`,
        `Selected historical session summaries are included below for long-term continuity. These are AI-compressed records, not authority for disputed motives, morality, competence, or the meaning of an exchange; direct transcript events and user-authored canon win when they conflict. They are reference context only; current scene, weather, stats, notes, membership, and presence take precedence.`,
        ...buildSessionHistoryLines(sorted.slice(0, -1)),
        `<latest_session_reference>`,
        ...buildLatestSessionContinuityLines(latest),
        `</latest_session_reference>`,
        `</historical_session_reference>`,
      ].join("\n");
      referenceBlocks.push(block);
      referenceSections.push(block);
    }
    const references = ctx.partyCardReferences ?? [];
    for (const pc of references) {
      const block = [
        `<gm_reference_party_library>`,
        `Reference library biographies and character instructions. These records do not assert current presence, party membership, location, or activity; live party membership appears separately in current context.`,
        pc.card,
        `</gm_reference_party_library>`,
      ].join("\n");
      referenceBlocks.push(block);
      referenceSections.push(block);
    }
  }

  if (cacheFriendly) {
    // One block per person in the order they were cached; the text is the cached text, so it never changes on its own.
    for (const entry of sceneCharacterCards) {
      const block = [
        `<gm_reference_named_character>`,
        sceneCardHeader,
        entry.card,
        `</gm_reference_named_character>`,
      ].join("\n");
      referenceBlocks.push(block);
      referenceSections.push(block);
    }
  }

  return {
    stable: stableSections.join("\n"),
    dynamic: dynamicSections.join("\n"),
    ...(referenceSections.length > 0 ? { reference: referenceSections.join("\n"), referenceBlocks } : {}),
  };
}

/** Backwards-compatible full prompt assembly preserving the original order. */
export function buildGmSystemPrompt(ctx: GmPromptContext): string {
  const parts = buildGmSystemPromptParts(ctx);
  return [parts.stable, parts.dynamic].filter((part) => part.length > 0).join("\n");
}

/**
 * Build the GM format reminder near the prompt tail. The actual current player
 * message is moved after it at the provider boundary.
 */
/** The ruleset's own check line, in place of the built-in one. Everything in it is the ruleset's
 *  validated, prompt-safe text; the Engine adds only the tag shape and the ladder. */
function renderRulesetSkillCheckLine(
  ruleset: import("@marinara-engine/shared").RulesetDefinition,
  playerDiceRollSubmitted: boolean,
  oneRequestDice: boolean,
): string {
  const resolution = ruleset.resolution;
  // `with=` needs somewhere to go: a sheet with one ability has no other ability to roll with.
  const withClause =
    ruleset.sheet.abilities.length >= 2
      ? [`Add with="Ability" to roll a skill or save with another ability than its own.`]
      : [];
  const branchClause = oneRequestDice
    ? [
        `When the outcome splits two ways, add branch="label" to this tag and write the branch block described under DICE.`,
      ]
    : [];
  const whoClause = `Add who="Character Name" to roll for a party member; without it the player is checked.`;

  if (resolution.kind === "dice-pool") {
    const { target, situationalDice, difficultyLadder } = resolution;
    const ladder = difficultyLadder
      .map(
        (step) =>
          `${step.label} ${step.successes} ${step.successes === 1 ? "success" : "successes"}${
            step.target === undefined ? "" : ` (target ${step.target})`
          }`,
      )
      .join(", ");
    return [
      `- [skill_check: skill="Name" dc="N"] - ${ruleset.gm.checkGuidance}`,
      `dc is how many successes the check needs.`,
      `Difficulty: ${ladder}.`,
      whoClause,
      // Both are offered only where this ruleset declares them, so the prompt never teaches an
      // attribute the resolver would then ignore.
      ...(target.min < target.max
        ? [
            `Add threshold="N" to move the per-die target, from ${target.min} to ${target.max}; without it the target is ${target.default}.`,
          ]
        : []),
      ...(situationalDice
        ? [
            `Add bonus="+N" or bonus="-N" to add or take dice for this check, from ${situationalDice.min} to ${situationalDice.max}.`,
          ]
        : []),
      ...(resolution.spend ?? []).map((spend) => {
        const pool = ruleset.sheet.live.pools.find((entry) => entry.id === spend.pool);
        const buys = [
          spend.successes ? `${spend.successes} automatic ${spend.successes === 1 ? "success" : "successes"}` : "",
          spend.dice ? `${spend.dice} extra ${spend.dice === 1 ? "die" : "dice"}` : "",
        ]
          .filter(Boolean)
          .join(" and ");
        // Taught only where this ruleset declares it, so the prompt never offers a purchase the
        // resolver would then ignore. What it costs and what it buys are said in the ruleset's own
        // words; the engine works out both, and a pool that cannot cover it buys nothing.
        return `When the player spends to change a roll, add spend="${spend.pool}:N" to that same check: every ${spend.amount} ${pool?.label ?? spend.pool} buys ${buys}, up to ${spend.perCheck} ${spend.perCheck === 1 ? "time" : "times"} per check. Do not also write a sheet command for it, and do not change the dice yourself.`;
      }),
      // Taught whenever this ruleset has any entry that changes a check. What each one DOES is the
      // entry's own business and the Engine reads it; the Game Master only names it.
      ...((ruleset.catalogs ?? []).some(
        (catalog) =>
          catalog.holds === "rows" &&
          (catalog.asset || (catalog.entries ?? []).some((entry) => entry.mechanics?.check)),
      )
        ? [
            `When a character uses something from their sheet to change a roll, add use="Its name" to that same check. Do not write a separate sheet command for it: the engine pays for it and applies it on the same roll.`,
          ]
        : []),
      ...withClause,
      `Do NOT write rolls, modifier, total or result: the engine rolls the pool from the character sheet and counts the successes.`,
      ...branchClause,
    ].join(" ");
  }

  const { dice, advantage, difficultyLadder } = resolution;
  const ladder = difficultyLadder.map((step) => `${step.label} ${step.dc}`).join(", ");
  const playerDie = playerDiceRollSubmitted && dice.count === 1 && dice.sides === 20;
  return [
    `- [skill_check: skill="Name" dc="N"${playerDie ? ` rolls="the player's d20 result"` : ""}] - ${ruleset.gm.checkGuidance}`,
    `Difficulty: ${ladder}.`,
    whoClause,
    ...(advantage ? [`Add mode="advantage" or mode="disadvantage" when the rules grant one.`] : []),
    ...withClause,
    playerDie
      ? `Use the player's exact die. Do NOT write modifier, total or result: the engine applies the character sheet.`
      : `Do NOT write rolls, modifier, total or result: the engine rolls ${dice.count}d${dice.sides} and applies the character sheet.`,
    ...branchClause,
  ].join(" ");
}

/** The sheet command, the ruleset's own guidance for it, and the party's sheets as they stand.
 *  The command grammar is the Engine's and is the same for every ruleset; every NAME in it (pools,
 *  tracks, conditions, rests) comes from the ruleset and is shown on the sheets themselves. */
function renderRulesetSheetSection(
  ruleset: import("@marinara-engine/shared").RulesetDefinition,
  sheetBlocks: string[],
): string[] {
  const blocks = sheetBlocks.map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) return [];
  const names = (entries: ReadonlyArray<{ label: string }>) => entries.map((entry) => entry.label).join(", ");
  const lines = [
    ``,
    `CHARACTER SHEETS:`,
    `The Engine keeps every character sheet. Record each change with one command per change, written where it happens:`,
    `- [sheet: who="Name" op="spend" pool="Pool" amount="N"] - uses up a resource. Refused when not enough is left.`,
    `- [sheet: who="Name" op="restore" pool="Pool" amount="N"] - gives it back, up to the maximum (healing included).`,
    `- [sheet: who="Name" op="damage" pool="Pool" amount="N"] - takes it away, temporary points first.`,
    `- [sheet: who="Name" op="temp" pool="Pool" amount="N"] - sets temporary points on a pool that has them.`,
    `- [sheet: who="Name" op="track" track="Track" by="+1"] - or to="N" to set it.`,
    `- [sheet: who="Name" op="condition" condition="Condition" state="on|off"]`,
    `- [sheet: who="Name" op="note" field="Field" value="text"] - an empty value clears it.`,
    ...(ruleset.rests.length > 0
      ? [`- [sheet: who="Name" op="rest" rest="Rest"] - rests: ${names(ruleset.rests)}.`]
      : []),
    // Only a ruleset with catalogs of ROWS has entries to use: a bestiary writes nothing onto a
    // sheet, so without one of those nothing on a sheet carries a price the Engine could pay, and
    // the line would describe a command that always refuses.
    ...(ruleset.catalogs?.some((catalog) => catalog.holds !== "creatures")
      ? [
          `- [sheet: who="Name" op="use" name="Name on the sheet"] - pays what that ability costs. Add pool="Pool" to pay from a higher pool of the same group.`,
        ]
      : []),
    `Leave out who for the player; who="party" applies to every member. Use the pool, track, field and condition names shown on the sheets. Never write result, reason or now yourself: the Engine adds them. A refused command did not happen, so do not narrate it as if it had.`,
    // A sheet block leaves out a track or a note that still has its default, so the names a command
    // can use are listed once here.
    ...(ruleset.sheet.live.tracks.length > 0
      ? [
          `Tracks: ${ruleset.sheet.live.tracks.map((track) => `${track.label} (${track.min} to ${track.max})`).join(", ")}.`,
        ]
      : []),
    ...(ruleset.sheet.live.text.length > 0 ? [`Note fields: ${names(ruleset.sheet.live.text)}.`] : []),
    ...(ruleset.sheet.live.conditions.length > 0 ? [`Conditions: ${names(ruleset.sheet.live.conditions)}.`] : []),
    ...(ruleset.gm.sheetGuidance ? [ruleset.gm.sheetGuidance] : []),
    ``,
    // The sheets are data, and part of that data is free text (names, notes the model wrote with
    // the note command on an earlier turn). The tag marks where data starts and stops; the values
    // inside have had angle brackets removed, so nothing in them can close it. The ruleset's own
    // guidance above is not wrapped: it is a trusted package's one-line text, held to the same
    // `promptSafeText` rule as its check guidance.
    `<character_sheets>`,
  ];
  for (const block of blocks) lines.push(block, ``);
  lines.pop();
  lines.push(`</character_sheets>`);
  return lines;
}

export function buildGmFormatReminder(
  ctx: Pick<
    GmPromptContext,
    | "hasSceneModel"
    | "canGenerateBackgrounds"
    | "artStylePrompt"
    | "hudWidgets"
    | "enableCustomWidgets"
    | "turnNumber"
    | "gameActiveState"
    | "sessionNumber"
    | "gameTime"
    | "map"
    | "partyNames"
    | "playerName"
    | "characterSprites"
    | "playerInventory"
    | "language"
    | "rating"
    | "enableQuickTimeEvents"
  > & {
    /** Special non-scene-advancing address mode inferred from the current player turn prefix. */
    addressMode?: GameAddressMode;
    /** Whether the current player turn already includes a resolved [dice: ...] roll. */
    playerDiceRollSubmitted?: boolean;
    /** The ruleset this game pinned, when the install can honour it. Its check guidance and
     *  difficulty ladder replace the built-in skill-check lines. Absent is the Engine's own rules
     *  and renders today's reminder byte for byte. */
    ruleset?: import("@marinara-engine/shared").RulesetDefinition;
    /** One rendered sheet block per party member (`renderRulesetSheetBlock`), current as of this
     *  turn. They live in this late reminder and never in the system prompt, because live state
     *  changes every turn and the system prompt is what a provider caches. Only read with `ruleset`. */
    rulesetSheetBlocks?: string[];
    /** Built-in systems an installed experience replaces with its own. Undeclared systems stay built-in. */
    experienceProvidedSystems?: { inventory?: boolean };
    /** Rendered COMMANDS lines for the verbs an installed experience declares (#5798). They belong
     *  in this reminder rather than in the system message because the reminder is what the engine
     *  parses back out of the turn, and because the game system message is rebuilt wholesale by
     *  `injectGameGmPromptRuntime` — anything spliced into it there would be overwritten. Empty or
     *  absent (the normal case, and every case today) renders nothing at all. */
    experienceGmVerbs?: string[];
    /** One-request dice (#6215): the chat's "Finish rolled turns in one request"
     *  switch. Off, absent, or anything but `true` renders today's block byte for byte. */
    oneRequestDice?: boolean;
    /** The sheet names the placeholder's `+NAME` form can resolve this turn. Without names the
     *  sheet-modifier sentence is dropped and only flat modifiers are taught. */
    skillModifiers?: GameSkillModifierView;
    /** The sighted pool sub-option. Only read while `oneRequestDice` is on. */
    dicePoolMode?: boolean;
    /** The rendered pool block, appended after the DICE block while the sub-option is on. The
     *  block's contents belong to the pool itself, so this builder only places it. */
    dicePoolBlock?: string;
    /** Whether `roll_dice` is in the resolved tool set for this turn. The prompt line and the
     *  attachment are gated on the same fact, so the tool is never attached without being
     *  described and never described without being attached. */
    rollDiceToolAttached?: boolean;
  },
): string {
  if (ctx.addressMode === "gm") {
    return [
      `<ooc_response_mode>`,
      `The current player input explicitly addresses the GM out of character. This is an OOC turn, not a scene turn.`,
      `Answer only the player's actual request or correction in direct, plain OOC prose. Acknowledge and correct an error without defending it or inventing a new in-world rationale.`,
      `Do not narrate, rewrite, resume, or advance the scene; do not portray NPC or party dialogue, actions, reactions, or knowledge; do not emit VN lines, choices, dice, scene tags, game commands, widget updates, inventory updates, or state changes.`,
      `Stop after the OOC answer and wait for the player's next input.`,
      `</ooc_response_mode>`,
    ].join("\n");
  }

  const lines: string[] = [];
  const normalizedLanguage = normalizePromptLanguage(ctx.language);
  // One-request dice (#6215). Everything this gates is additive: with the switch
  // off every line below renders exactly the bytes it renders today.
  const oneRequestDice = ctx.oneRequestDice === true;
  // A die the player threw is one d20, so it stands in only for a ruleset that rolls exactly that.
  // A pool ruleset has no `dice` at all, which is why the kind is read before the count.
  const rulesetResolution = ctx.ruleset?.resolution;
  const rulesetRollsOneD20 =
    rulesetResolution?.kind === "dice-sum" && rulesetResolution.dice.count === 1 && rulesetResolution.dice.sides === 20;

  const partyNames = normalizePromptTextList(ctx.partyNames);
  const hasParty = partyNames.length > 0;
  const characterSprites = Array.isArray(ctx.characterSprites) ? ctx.characterSprites : [];
  const customSpriteLines = characterSprites
    .map((character) => ({
      name: normalizePromptText(character.name),
      expressions: normalizePromptTextList(character.expressions),
      fullBody: normalizePromptTextList(character.fullBody),
    }))
    .filter((character) => character.name && (character.expressions.length > 0 || character.fullBody.length > 0))
    .flatMap((character) => {
      const lines: string[] = [];
      if (character.expressions.length > 0) {
        lines.push(`  ${character.name} (expressions): ${character.expressions.join(", ")}`);
      }
      if (character.fullBody.length > 0) {
        lines.push(`  ${character.name} (full-body): ${character.fullBody.join(", ")}`);
      }
      return lines;
    });
  const hudWidgets = Array.isArray(ctx.hudWidgets) ? ctx.hudWidgets : [];
  // An experience that tracks items itself owns the whole loop, so asking the GM for [inventory:] here
  // would only produce commands nothing consumes.
  const experienceOwnsInventory = ctx.experienceProvidedSystems?.inventory === true;
  const playerInventory = Array.isArray(ctx.playerInventory)
    ? ctx.playerInventory.flatMap((item) => {
        const name = normalizePromptText(item?.name);
        if (!name) return [];
        const quantity =
          typeof item?.quantity === "number" && Number.isFinite(item.quantity) ? Math.max(1, item.quantity) : 1;
        return [{ name, quantity }];
      })
    : [];

  // ── Current State (closest to generation) ──
  lines.push(
    `<gm_only_runtime_state>`,
    `This is GM/UI bookkeeping. It informs adjudication but is not automatically observable character knowledge.`,
    `State: ${ctx.gameActiveState ?? "exploration"} | Session #${ctx.sessionNumber ?? 1}${ctx.gameTime ? ` | Time ${ctx.gameTime}` : ""}`,
    `</gm_only_runtime_state>`,
    ``,
  );

  lines.push(
    `<output_format>`,
    `Think step by step to decide the next turn: current location and time, the story up to this point, character behavior, dynamics, known vs. hidden information, stakes, cause and effect, sensory tone, and the next point where the world has acted and the player must choose. Then, output only the VN scene text.`,
    ...(normalizedLanguage && normalizedLanguage.toLowerCase() !== "english"
      ? [
          `LANGUAGE:`,
          `Write directly in ${normalizedLanguage} as a native speaker would. The English examples below illustrate structure and format only.`,
          ``,
        ]
      : []),
    `FORMAT:`,
    `- Narration: text - 1-4 sentences per beat, blank line between beats.`,
    `- Lines: [Name] [main|side|whisper:Target|thought] [neutral|happy|sad|angry|surprised|scared|disgusted|thinking|laughing|crying|blushing|smirk|embarrassed|determined|confused|sleepy|custom]: "Dialogue"|Thought - first bracket specifies the format, main is primary spoken line, side is a brief spoken reaction, aside, or interruption, whisper is quiet speech meant for one listener only, thought is internal monologue for characters you control (never the player character), and the last bracket is the character's expression when delivering the line.`,
    `- Party speaker labels must use the exact canonical names listed under PARTY. Never expand, combine, or replace a party member's name with a legal name, nickname, alias, title, or description-derived variant.`,
    ...(customSpriteLines.length
      ? [
          ``,
          `- Available custom sprites per character (use these EXACT names when the character has any listed expression; only fall back to the defaults if the character has no listed sprites):`,
          ...customSpriteLines,
        ]
      : []),
    `- Commands: [tag: params].`,
    `- NEVER mix narration and dialogue in the same line; output them separately.`,
    ...(ctx.rating === "nsfw"
      ? [
          `- Adult mode enabled. Explicit content is allowed when it follows established characterization, choices, and cause-and-effect. Adult permission does not create an adversity, corruption, or moral-ambiguity quota.`,
        ]
      : []),
    `- Write dialogue as responsive conversation, not consecutive speeches. A short individual speaking turn is one beat within the scene, not a limit on the whole response. Develop the exchange through purposeful dialogue, action and reactions at the user's requested pace; save monologues and life summaries for moments that concretely warrant them.`,
    `- Keep each character's vocabulary, grammar, and cadence distinct through their priorities and situation, not repeated catchphrases, résumé facts, exact-number credentials, or rhetorical formulas. Do not make every line witty, profound, fully self-aware, or quotable.`,
    `- Keep prose concrete and selective. Avoid repetitive AI templates—especially stacked negative parallelisms such as “doesn’t X, doesn’t Y” or “not X, not Y”—and stock phrases such as “jaw working,” “mechanical precision,” “ozone,” and “somewhere outside.” Prefer natural cadence and direct description without distorting otherwise ordinary speech just to dodge a word.`,
    `- When a genuinely new named NPC first enters the active scene, naturally include a few concrete, externally observable details that distinguish them—such as build, face, clothing, voice, or a visible mannerism. Do this once, without an infodump, résumé, hidden backstory, or later repetition.`,
    `- Expression tags are presentation metadata, not instructions to intensify every line. [neutral] is normal, and a character's mood should not change unless the scene gives it a reason.`,
    ``,
    `EXAMPLE:`,
    `Rain needles the broken shrine roof.`,
    hasParty
      ? `[${partyNames[0]}] [main] [worried]: "We should move. Now."`
      : `[Guide] [main] [worried]: "We should move. Now."`,
    ``,
    ``,
    `PLAYER INPUT:`,
    `- Continue with new content directly from the player's input, treating it like a concluded beat. Do not reiterate anything.`,
    `- Interpret player input using its meaning and the ongoing conversation, not quotation marks alone. An unquoted answer, question, greeting, or request addressed to an NPC can be spoken dialogue. Resolve the addressee from the immediately preceding exchange: second-person tasks belong to that NPC, not the player. Explicit actions remain actions; private thoughts and out-of-character directions are not audible to NPCs. If speech versus private thought is genuinely ambiguous, do not invent disclosure. Never quote, speak, think, decide, react, consent, refuse, obey, or act for the player character (${ctx.playerName ?? "Player"}).`,
    `- Never emit a [${ctx.playerName ?? "Player"}] [main], [side], [whisper], [thought], or [action] line. NPC commands, questions, requests, offers, and contact stop before the player's response.`,
    `- CRITICAL: NEVER echo dialogue, especially not after the player. NO PARROTING!`,
    `- The player controls intent; world responses follow established facts, stakes, relative capabilities, and cause-and-effect. Let earned successes land cleanly and let failures follow actual mistakes, bad luck, or credible opposition. Do not add backlash, humiliation, suspicion, or a compensating cost merely because the player is competent or successful.`,
    `- The user's game-level pacing and length preferences govern the whole GM scene. Character-card reply-length limits, including post-history paragraph limits, govern only that character's individual contribution and must not cap the scene. A short player message or direct in-character question does not override a standing preference for developed scenes. Stop for a genuine player decision, especially in combat or danger; do not invent player participation, filler or complications to reach a length target. Explicit requests for brevity take precedence.`,
    `- End naturally when it's the player's turn to act or speak.`,
    ``,
  );

  // ── Party Dialogue Instructions (inside output_format, closest to generation) ──
  if (hasParty) {
    lines.push(
      ``,
      `PARTY:`,
      `You may play ${partyNames.join(", ")} when they have a concrete immediate reason to participate. Presence alone is not a speaking obligation; an explicit user request for ensemble banter is a reason to develop a sustained exchange between those present, not a roll call of disconnected reports. Party members know only what they have seen, heard, inferred from concrete observable evidence, or been told. There is a hard GM/PARTY information boundary: party dialogue must never reveal or hint at inventory contents, HUD or tracker data, hidden arcs, plot twists, unrevealed motives, plans, encounter scripting, or any other GM-only/meta knowledge unless they learned it in-world. No spoilers, overguiding, or meta leakage.`,
    );
    if (ctx.addressMode === "party") {
      lines.push(
        ``,
        `TALK-TO-PARTY MODE:`,
        `The player is addressing the party out loud. Keep narration minimal, let party dialogue carry the turn, and do not advance the scene unless immediate danger forces it.`,
      );
    }
  }

  lines.push(
    ``,
    `COMMANDS:`,
    `- Commands record canonical game or UI changes that already occurred in the fiction. Never invent dialogue, action, attention, or a scene beat merely to acknowledge, expose, clear, or update bookkeeping; no command is needed for flavor alone.`,
    `- [choices: "Option A"|"Option B"|"Option C"] - only for explicit player-facing options that require a selection.`,
  );

  // The engine supplies numbers before the GM writes outcome narration.
  if (ctx.ruleset) {
    lines.push(renderRulesetSkillCheckLine(ctx.ruleset, ctx.playerDiceRollSubmitted === true, oneRequestDice));
  } else if (ctx.playerDiceRollSubmitted) {
    lines.push(
      `- [skill_check: skill="Skill Name" dc="1-20" rolls="the player's d20 result"] - use the player's exact die and choose a fair DC (5 trivial, 10 routine under pressure, 15 hard, 20 desperate). Do NOT write modifier, total or result: the engine applies their character-sheet modifiers.`,
    );
  } else {
    lines.push(
      `- [skill_check: skill="Skill Name" dc="1-20"] - request a d20 check only when uncertainty matters. Choose a fair DC (5 trivial, 10 routine under pressure, 15 hard, 20 desperate). Do NOT invent rolls, modifier, total or result: the engine supplies the die and character-sheet modifiers.${
        oneRequestDice
          ? ` When the outcome splits two ways, add branch="label" to this tag and write the branch block described under DICE.`
          : ""
      }`,
    );
  }
  lines.push(
    `- [dice: 3d8+2] - request any NdM roll with an optional flat modifier, even without a tools API. The engine rolls it, capped at 100 dice and 1000 sides per die. Never write the numbers yourself.${
      oneRequestDice
        ? ` When the number does not fork the prose, write a [[roll: 3d8+2]] placeholder in the sentence instead of this tag and keep writing.`
        : ""
    }`,
    // A ruleset game has one rules system, so the line teaching other notations is dropped.
    ...(ctx.ruleset
      ? []
      : [
          `- For other checks, declare the actual notation: [skill_check: skill="Endurance" dc="12" dice="3d6+2"]. These use the notation's modifier, not d20 character-sheet modifiers. For a pool, declare the per-die threshold and required successes: [skill_check: skill="Intimidation" dc="4" dice="6d10" resolution="successes" threshold="6"]. Each die at or above threshold counts once; dc is the number of successes needed. Exploding dice, botches, or other special pool rules are not implemented. Never invent pool results or omit its threshold.`,
        ]),
    // The stop-at-the-attempt line is exactly the instruction the second request exists to
    // serve, so it is dropped while the turn has to finish itself.
    ...(oneRequestDice
      ? []
      : [
          `- Place unresolved roll requests before any outcome that depends on them. Describe the attempt, then stop. The engine will send the real results back for you to finish this same turn; do not guess success or failure before receiving them.`,
        ]),
  );

  lines.push(
    ...(ctx.enableQuickTimeEvents === false
      ? []
      : [
          `- [qte: action1|action2|action3, timer: 6s] - only as the final thing in the turn when the player must react to an immediate timed prompt or split-second action. Stop immediately after this tag: choosing an action commits the player's next turn.`,
        ]),
    ...(ctx.map?.type === "node"
      ? [
          `- [map_update: new_location="Location Name" connected_to="Previous Location Name" node_emoji="emoji"] - only when the party arrives at an entirely new location on the current node map.`,
        ]
      : []),
    ...(experienceOwnsInventory
      ? []
      : [
          `- [inventory: action="add|remove" item="Item A, Item B" count="3"] - record every real item gain or loss after it happens in the fiction; never expose an item to a character merely to create or update this command. Keep names short and use count/quantity for stacked items.`,
        ]),
    `- [Note: contents] or [Book: contents] - when a new readable note or book is acquired and should be tracked in the journal.`,
    `- [state: exploration|dialogue|combat|travel_rest] - only on actual mode transitions. If you're planning to use [state: combat], this one ALWAYS has to be at the end of the turn, as it initiates a new combat generation and UI.`,
    `- [reputation: npc="Name" action="helped"] - only when a concrete event meaningfully changes an NPC's tracked stance. Do not emit one for every agreeable line, gift, compliment, routine kindness, ordinary disagreement, or merely pleasant beat.`,
    `- [party_change: character="Exact Character Name" change="add|remove"] - only when someone truly joins or leaves the party. Use remove when a party member dies, permanently departs, or is no longer traveling with the player.`,
    `- [session_end: reason="goal achieved|good place to pause"] - only when the current session truly ends.`,
  );

  // Game turns carry the roll_dice tool whether or not the chat has tool use switched on,
  // so this block is unconditional. It is what stops the GM inventing numbers: without it
  // the tool is attached and never called.
  //
  // With one-request dice on there is usually no tool to call, and the turn has to finish
  // itself, so the whole block is replaced by the case-by-case rule: which form to write is
  // a fact about the sentence the GM is about to write, which only the GM knows, so the
  // choice is made here rather than by the engine.
  if (oneRequestDice) {
    const modifierNames = [...(ctx.skillModifiers?.skills ?? []), ...(ctx.skillModifiers?.attributes ?? [])]
      .map((name) => normalizePromptText(name))
      .filter((name) => name.length > 0);
    const dicePoolBlock = normalizePromptText(ctx.dicePoolBlock);
    const sightedPool = ctx.dicePoolMode === true;
    lines.push(
      ``,
      `DICE:`,
      `- When an outcome turns on chance, you have three ways to write it. Pick by what the outcome is, not by preference.`,
      ``,
      `- IF THE OUTCOME SPLITS TWO WAYS, WRITE A BRANCH BLOCK. Write the check without numbers, then write both halves. The engine rolls, keeps the half the roll selects, and deletes the other before anyone reads the turn. Neither half may contain a command.`,
      `  [skill_check: skill="Stealth" dc="15" branch="crates"]`,
      `  [branch: crates]`,
      `  [on success] The guard's gaze slides over the crates and away. You are past him.`,
      `  [on failure] A boot scuffs stone. He turns, and his hand is already moving.`,
      `  [/branch]`,
      ``,
      `- IF THE OUTCOME IS ONLY A NUMBER, WRITE A PLACEHOLDER AND KEEP WRITING. Damage, healing, gold, a duration, a count, a distance. The engine rolls it and puts the number in its place, so the sentence reads the same either way.`,
      `  The axe bites deep for [[roll: 2d6+3]] damage, and the wound burns for [[roll: 1d4]] rounds.`,
      // Advertised only when the chat can resolve a name. With no game-state snapshot and no
      // player card sheet there is nothing to resolve, and a form that fails by default is
      // worse than one that is never offered.
      ...(modifierNames.length > 0
        ? [
            `  To add a character-sheet modifier, write its name and let the engine add it: [[roll: 1d8+STR]]. Never write the modifier's value yourself and never write the die's result yourself. These are the only names that resolve: ${modifierNames.join(", ")}.`,
          ]
        : []),
      `  One placeholder holds one NdM notation, at most one flat number, and at most one sheet name. For two different dice, write two placeholders. Never put a placeholder inside a code block or inside another tag's brackets.`,
      ``,
      sightedPool
        ? `- ONLY IF THE NUMBER ITSELF HAS TO DECIDE BETWEEN THREE OR MORE DIFFERENT OUTCOMES, spend a pool value instead: write the value shown below into the check's rolls= and name its slot with pool=, then narrate what it meant in this same turn.`
        : `- ONLY IF THE NUMBER ITSELF HAS TO DECIDE BETWEEN THREE OR MORE DIFFERENT OUTCOMES, ask for the value instead: write [skill_check: skill="Skill Name" dc="${ctx.ruleset ? "N" : "1-20"}"] or [dice: 3d8+2] and stop at the attempt. The engine rolls it and records it. Narrate what it meant at the start of your next turn.`,
      ``,
      `- A check you write in none of these forms is rolled by the engine and recorded, and this turn ends without its outcome; narrate what the number meant at the start of your next turn.`,
      ``,
      `- Never invent a die result, a modifier, a total, or an outcome. Never write both a branch block and a placeholder for the same check.`,
      // Gated on the resolved tool set rather than on the chat's tool list, which is the fact
      // that actually decides whether the tool is offered.
      ...(ctx.rollDiceToolAttached
        ? [
            `- You also have roll_dice on this connection. Prefer the forms above: a tool call costs an extra round. Use the tool only for a roll none of them can serve.`,
          ]
        : []),
      ...(sightedPool && dicePoolBlock ? [``, dicePoolBlock] : []),
    );
  } else {
    lines.push(
      ``,
      `DICE:`,
      `- roll_dice is a real die you can throw. Call it the moment you need an actual number before you can keep writing - an attack, a save, damage, a random outcome the scene then reacts to - passing the notation (for example "1d20+3") and a short reason.`,
      `- Never invent a die result. Wait for the number the tool gives you, then narrate what it means, once, in this same turn.`,
      // A ruleset game's checks come from the character sheet, so a tool-made modifier is never
      // the record: the engine would roll such a tag again and contradict the narration.
      ctx.ruleset
        ? `- Do not use roll_dice for an ability check, skill check or saving throw. Write the [skill_check: ...] tag above without numbers and the engine rolls it from the character sheet.`
        : `- If roll_dice has already returned a skill check's roll, override the sparse-check instructions above: write a complete [skill_check: skill="Skill Name" dc="chosen DC" rolls="actual tool rolls joined with |" modifier="tool modifier" total="tool total" result="critical_success|success|failure|critical_failure" resolution="sum" dice="tool notation"] record using that result. Do not request another engine roll or stop at the attempt; narrate its consequence in this same turn. Use the sparse form only when no roll result is available.`,
      // A player's d20 only stands in for a check where a single d20 is what the rules roll.
      ctx.playerDiceRollSubmitted && (!rulesetResolution || rulesetRollsOneD20)
        ? `- The player already threw for this turn. Use their roll rather than calling the tool again for the same action.`
        : `- A skill check is still written down with the [skill_check: ...] tag above. roll_dice is how you get a number your narration needs in hand; it does not replace that record.`,
      `- If the tool is not available to you on this connection, work from the tag alone and say nothing about tools.`,
    );
  }

  if (ctx.ruleset) lines.push(...renderRulesetSheetSection(ctx.ruleset, ctx.rulesetSheetBlocks ?? []));

  // The installed experience's own verbs, last in the block so the built-ins keep their order. Each
  // line already arrives fully rendered from the verb runtime; nothing here inspects or reformats it.
  const experienceGmVerbs = normalizePromptTextList(ctx.experienceGmVerbs);
  if (experienceGmVerbs.length > 0) lines.push(...experienceGmVerbs);

  if (ctx.gameActiveState === "combat") {
    lines.push(
      ``,
      `COMBAT GM ADJUDICATION:`,
      `Combat rounds are resolved by the combat UI. During ordinary combat narration, do not emit tactical combat commands or recalculate combat mechanics. If the player sends a special maneuver, follow the explicit instruction included in that user message.`,
    );
  }

  if (!ctx.hasSceneModel) {
    lines.push(`Scene tags allowed: [sfx: ...] [bg: ...] [ambient: ...]`);
    if (ctx.canGenerateBackgrounds) {
      lines.push(
        `- If the scene moves to a new visually important location and no existing background tag fits, use [bg: backgrounds:generated:<short-location-slug>].`,
      );
      if (ctx.artStylePrompt?.trim()) {
        const safeArtStylePrompt = normalizePromptText(ctx.artStylePrompt)
          .replace(/[\r\n\t]+/g, " ")
          .replace(/[<>{}[\]]/g, "")
          .replace(/\s{2,}/g, " ")
          .trim();
        if (safeArtStylePrompt) {
          lines.push(`- Generated scene images must follow this visual instruction: ${safeArtStylePrompt}.`);
        }
      }
    }
  }

  if (ctx.enableCustomWidgets !== false) {
    lines.push(
      ``,
      `<gm_only_hud_widgets>`,
      `These values are UI bookkeeping, not facts characters can automatically perceive or discuss.`,
      ...buildWidgetSummaryLines(hudWidgets),
      `- You may dynamically create useful HUD widgets and delete obsolete ones as the scene changes. There is no fixed widget-count cap. Reuse stable IDs; do not duplicate existing widgets or invent story events to justify UI changes. Preserve user-requested trackers unless the user removes them or their stated purpose is complete.`,
      `- Create: [widget: stable_id, action: create, type: counter, label: "Supplies", position: hud_left, count: 3]. Supported types: progress_bar, gauge, relationship_meter, counter, stat_block, list, inventory_grid, timer, and the extra types below. Optional initial fields: value, max, count, seconds, running, text, icon. For a new stat_block, list or extra type, create it first and then use ordinary stat/add/text commands to fill it.`,
      `- Delete an entire widget: [widget: stable_id, action: delete]. This removes only its HUD display, never inventory, relationships, quests, or other canonical facts. The existing remove: "Item" command removes a list item, NOT the widget. Create commands are idempotent and never overwrite an existing widget's values.`,
      `- Widget usage: emit widget commands for every real change to these rendered HUD widgets. Do not skip a changed widget just because another system tracks related player or party stats, and never create a narrative event merely to change or clear a widget.`,
      `- HUD widgets are visual UI state only. Player stats, inventory, party member HP, party relationships, and other durable game facts remain in their own canonical systems; use [widget:] only to mirror a visible widget when that widget's displayed value should change.`,
      `- Command mapping: value = bars/gauges, count = counters, stat = one stat_block entry, add/remove = rotating list items, running/seconds = timers.`,
      `- Widget commands: [widget: id, value: n] [widget: id, stat: "Name", value: x] [widget: id, count: n] [widget: id, add: "Item"] [widget: id, remove: "Item"] [widget: id, running: true, seconds: 60]`,
      `- Extra types. Pick one only when it shows something better than a list or stat_block would; never create a widget just to use a type. Each is created empty, then updated with the keys shown:`,
      `  checklist: add/check/uncheck/remove: "Task" (check when done in the story). obligations (debts, favors, promises): add: "Party owes Oriel | 200 gold", check when settled.`,
      `  schedule (dated appointments, kept in day order): add: "Day 21, dusk | Oriel strike" (re-adding moves it), remove: "Oriel strike". log (newest first, 6 kept): add: "Event".`,
      `  note: text: "One short status" (replaces). tags (current conditions or states): add/remove: "Poisoned".`,
      `  clock (max: 4-12 segments) and pips (max: 1-20): value: filled. countdown: value: remaining, text: "days until the ball".`,
      `  tug_of_war (chase, contest, negotiation; max: n): value: -n..n, positive favors the right side; text: "Left side | Right side".`,
      `  tier_track (escalating levels like alert or heat) and stages (quest or journey steps): add: "Level" in order; value: "Level", its number, up/next or down/back.`,
      `  ledger: add: "+50 | Sold the ring" or "-20 | Bribe" (the balance updates), text: "gold". rumor_board: add: "Rumor", check: confirmed, uncheck: proven false.`,
      `  turn_order: add/remove: "Name", value: "Name" or next. scoreboard: stat: "Side", value: n. bars (named meters) and charges (named uses shown as pips): add: "Name | 3 / 10", then stat: "Name", value: n.`,
      `  calendar (in-game date with upcoming events; max: days per week, default 7): value: today's day number or next, text: "12 Frostfall 412", add: "Day 21 | Oriel strike", remove: "Oriel strike".`,
      `- List widgets: keep at most 5 short entries visible. Remove resolved or genuinely stale items first; never evict an unresolved obligation, external response, deadline, or durable hook merely to display posture, symbolism, praise, or another transient relationship beat.`,
      `</gm_only_hud_widgets>`,
    );
  }

  // Inventory context. Skipped when an experience owns items: an older save can still carry a stale
  // built-in list, which would contradict the inventory the player has on screen.
  if (!experienceOwnsInventory && playerInventory.length > 0) {
    lines.push(
      ``,
      `<gm_only_inventory>`,
      `PLAYER INVENTORY: ${buildCompactInventoryLine(playerInventory)}`,
      `This is private bookkeeping. It does not establish that any NPC knows an item exists, where it is, how many there are, or what the player intends to do with it.`,
      `</gm_only_inventory>`,
    );
  }

  lines.push(`</output_format>`);

  return lines.join("\n");
}

/** Build the setup prompt for initial game creation. */
export interface SetupPromptContext {
  rating?: "sfw" | "nsfw";
  /** Full persona card text (player character) */
  personaCard?: string | null;
  /** Exact player persona name, when known */
  playerName?: string | null;
  /** Full party member card texts */
  partyCards?: string[];
  /** Exact starting party member names selected by the user */
  partyNames?: string[];
  /** GM character card text (if using a character as GM) */
  gmCharacterCard?: string | null;
  /** Enable custom HUD widgets in the game blueprint */
  enableCustomWidgets?: boolean;
  /** User-selected HUD widgets that should be used instead of model-designed setup widgets. */
  customHudWidgets?: HudWidget[];
  /** Selected constant lorebook canon to bake into world generation */
  lorebookContext?: string | null;
  /** `gm.worldGuidance` from the game's pinned ruleset, with its active layers appended. The only
   *  ruleset text world generation reads: everything else a ruleset says reaches the per-turn
   *  reminder instead, because the world is designed once and the sheets change every turn. */
  rulesetWorldGuidance?: string | null;
  /** Language for natural-language JSON values */
  language?: string;
  /** User-overridable GM instruction body that will be used after setup. */
  gameSystemPrompt?: string | null;
  /** Additional game-mode generation instructions that will be used after setup. */
  gameSpecialInstructions?: string | null;
}

export function buildSetupPrompt(ctx: SetupPromptContext = {}): string {
  const rating = ctx.rating ?? "sfw";
  const normalizedLanguage = normalizePromptLanguage(ctx.language);
  const playerName = ctx.playerName?.trim() || (ctx.personaCard ? "the player character named in <user_player>" : null);
  const partyNames = (ctx.partyNames ?? []).map((name) => name.trim()).filter((name) => name.length > 0);
  const characterCardTargets = [...(playerName ? [playerName] : []), ...partyNames];
  const ratingBlock =
    rating === "nsfw"
      ? [
          `<rating>`,
          `Anything goes in this NSFW work of fiction intended for mature audiences. The user has confirmed they are over 18 and understand what they're getting into. No holding back:`,
          ` - Profanity, toxicity, and dark themes are permitted. Every character, the user's included, may be raped, harmed, killed, betrayed, dominated, or emotionally/physically used when the requested premise and established events support it. They may also commit such acts when their established characterization and actual choices support them. This permission does not assign anyone a hidden dark side, cruel motive, or corruption arc.`,
          ` - Preserve each role's established morality and motives. A terrifying villain may be cruel, while a sincerely good hero may remain sincerely good; adult complexity does not require cynical reinterpretation or forced moral compromise.`,
          ` - Romance and intimate contact should not stall on repetitive meta-approval beats. NPCs may initiate contact when characterization and circumstances support it, but this never supplies the player character's consent, reciprocal action, desire, or emotional response.`,
          ` - During sex between involved adult characters, get kinky and slow down the pace when established events and player-authored choices commit them to the scene. Apply anatomical and emotional detail to the characters you control, but never invent the player character's consent, refusal, arousal, reaction, or sexual actions.`,
          ` - Portray violence in gory detail, blood squirting around like in a slasher movie.`,
          `</rating>`,
        ].join("\n")
      : [
          `<rating>`,
          `This SFW work of fiction is intended for mature audiences, and the user dictates the boundaries:`,
          ` - Profanity and dark themes may be present, and every character, including the user's, may be harmed or killed. However, no explicit content will be present.`,
          ` - Romance and affectionate contact should not stall on repetitive meta-approval beats. NPCs may initiate when characterization and circumstances support it, but never invent the player character's willingness, reciprocal action, or emotional response.`,
          ` - During a sex scene, cut to black and progress to the aftermath, and when portraying violence, do realistic descriptions without getting into gory details.`,
          ` - Treat boundaries as part of characterization and scene dynamics, not as repetitive legal disclaimers.`,
          `</rating>`,
        ].join("\n");

  // Build persona + party sections for the system prompt
  const contextSections: string[] = [];
  if (ctx.gmCharacterCard) {
    contextSections.push(
      `<gm_character>`,
      `You will adopt this character's personality and perspective as the Game Master:`,
      ctx.gmCharacterCard,
      `</gm_character>`,
    );
  }
  if (ctx.personaCard) {
    contextSections.push(
      `<user_player>`,
      `User-authored player-character canon. Treat affirmative personality and morality as real characterization, not as unreliable self-description or an invitation to invent a hidden opposite for balance:`,
      ctx.personaCard,
      `</user_player>`,
    );
  }
  if (ctx.partyCards?.length) {
    contextSections.push(`<party_info>`, `Party members accompanying the player:`, ...ctx.partyCards, `</party_info>`);
  }
  contextSections.push(
    `<character_card_scope>`,
    characterCardTargets.length > 0
      ? `Allowed characterCards names: ${characterCardTargets.join(", ")}`
      : `Allowed characterCards names: none supplied. Use an empty characterCards array unless the setup preferences clearly define the player character.`,
    partyNames.length > 0
      ? `Allowed partyArcs names: ${partyNames.join(", ")}`
      : `Allowed partyArcs names: none. Use an empty partyArcs array.`,
    `Hard rule: characterCards are only for the player persona and the starting party members selected by the user. Do NOT create characterCards for GM characters, love interests, antagonists, lorebook figures, factions, future recruits, or NPCs merely mentioned in preferences/canon. Put non-party people in startingNpcs instead.`,
    ...(playerName
      ? [
          `Player-card rule for ${playerName}: the user-authored <user_player> persona is the authority for characterization. Do not invent strengths, weaknesses, temptations, motives, morality, or personality traits. Keep strengths and weaknesses empty and omit extra.temptation unless the persona states the specific trait directly; mechanical class and abilities may still be derived from explicit powers or skills.`,
        ]
      : []),
    `Never include the player character in partyArcs. Those arcs are only for the starting party members named above.`,
    `</character_card_scope>`,
  );
  if (ctx.lorebookContext?.trim()) {
    contextSections.push(
      `<lorebook_context>`,
      `Selected constant lorebook canon that MUST be treated as true for this world:`,
      ctx.lorebookContext.trim(),
      `</lorebook_context>`,
    );
  }
  const rulesetWorldGuidance = normalizePromptText(ctx.rulesetWorldGuidance);
  if (rulesetWorldGuidance) {
    contextSections.push(
      `<ruleset_world>`,
      `This game runs on a rules system its author wrote. Design the world so it fits these rules:`,
      rulesetWorldGuidance,
      `</ruleset_world>`,
    );
  }
  if (ctx.customHudWidgets?.length) {
    contextSections.push(
      `<user_hud_widgets>`,
      `The user already chose these exact HUD widgets. Treat them as the visible HUD for this game and do not invent replacement widgets:`,
      JSON.stringify(ctx.customHudWidgets, null, 2),
      `</user_hud_widgets>`,
    );
  }
  const setupGameSystemPrompt = normalizePromptText(ctx.gameSystemPrompt);
  if (setupGameSystemPrompt) {
    contextSections.push(
      `<gm_prompt_preferences>`,
      `The user customized the GM prompt that will run after setup. Design the world to support this play style, but do not let it override the required setup JSON schema or output rules:`,
      setupGameSystemPrompt,
      `</gm_prompt_preferences>`,
    );
  }
  const setupGameSpecialInstructions = normalizePromptText(ctx.gameSpecialInstructions);
  if (setupGameSpecialInstructions) {
    contextSections.push(
      `<gm_extra_instructions>`,
      `The user added these extra GM instructions for play after setup. Honor them while designing the world, unless they conflict with the setup JSON schema or output rules:`,
      setupGameSpecialInstructions,
      `</gm_extra_instructions>`,
    );
  }

  return [
    `You are the Game Master preparing a new RPG campaign.`,
    `The player has given you their preferences. Absorb them fully into your creative output. Do NOT echo them back.`,
    ``,
    `Your job: design a complete game world with story, characters, and visual presentation. Do NOT write any narration or opening scene. That happens separately after you build the world.`,
    ``,
    buildProtagonistFairnessPrompt(),
    ``,
    buildGameContinuityEvidencePrompt(playerName),
    ``,
    ...(normalizedLanguage && normalizedLanguage.toLowerCase() !== "english"
      ? [
          `<language>`,
          `Write every natural-language string value in the JSON output in ${normalizedLanguage}. This includes worldOverview, storyArc, plotTwists, descriptions, arcs, labels, and any other prose. Keep ONLY the JSON keys and structural syntax in English.`,
          `</language>`,
          ``,
        ]
      : []),
    `CRITICAL: Your response MUST be a single JSON object using the EXACT keys shown in the <output_format> template below. Do NOT invent your own keys. Do NOT rename fields. The keys "worldOverview", "storyArc", "plotTwists", "startingMap", "startingNpcs", "partyArcs", "characterCards", and "blueprint" are MANDATORY and must appear at the top level. The system will reject any response that uses different key names. Respect <character_card_scope> exactly.`,
    ``,
    ...(ctx.enableCustomWidgets !== false
      ? [
          `<blueprint_widget_types>`,
          `Available HUD widget types for the blueprint:`,
          `  progress_bar: config = { startingValue: number, value: number, max: number }`,
          `  gauge: config = { startingValue: number, value: number, max: number, dangerBelow?: number }`,
          `  relationship_meter: config = { startingValue: number, value: number, max: number, milestones?: [{ at: number, label: string }] }`,
          `  counter: config = { count: number }`,
          `  stat_block: config = { stats: [{ name: string, value: string|number }] }`,
          `  list: config = { items: string[] }`,
          `  timer: config = { seconds: number, running: boolean }`,
          `  checklist / obligations: config = { tasks: [{ text: string, done: boolean }] }`,
          `  schedule: config = { entries: [{ when: string, text: string }] } (when like "Day 21, dusk")`,
          `  note: config = { text: string }`,
          `  clock / pips: config = { value: number, max: number }; countdown: config = { value: number, max?: number, text: "days left" }`,
          `  tug_of_war: config = { value: number, max: number, text: "Left side | Right side" }`,
          `  tier_track / stages: config = { levels: string[], current: number (0-based) }; turn_order: config = { items: string[], current: number }`,
          `  tags: config = { tags: string[] }; log: config = { items: string[] } (newest first)`,
          `  ledger: config = { value: number (balance), text: "gold", transactions: [{ amount: number, text: string }] }`,
          `  rumor_board: config = { rumors: [{ text: string, status: "unverified" | "confirmed" | "false" }] }`,
          `  scoreboard: config = { stats: [{ name: string, value: number }] }; bars / charges: config = { meters: [{ name: string, value: number, max: number }] }`,
          `  calendar: config = { value: number (today's day), max: number (days per week), text: "date label", entries: [{ when: "Day 21", text: string }] }`,
          ``,
          `If you design a list widget, treat it as a compact rotating list with a hard cap of 5 entries. Choose items worth surfacing right now, and expect older entries to be swapped out as the situation changes.`,
          `Reserve those slots for actionable or unresolved continuity. Do not replace an open obligation, answer, deadline, or plot hook with a transient gesture, posture, praise, or symbolic interpretation.`,
          `Keep each list item concise and label-like when possible. Avoid long multi-clause sentences, because the same text may need to be referenced later for removal or swapping.`,
          ``,
          `Design useful widgets that fit the genre, with no fixed count limit. Prefer one stat_block for related party bonds/reputation when it makes the HUD easier to read. Do not pad the HUD with redundant trackers. Widgets can be created and removed during play as their relevance changes.`,
          `Romance = stat_block for bonds + mood gauge. Horror = sanity gauge + clue list. RPG = health/mana bars.`,
          `Inventory is handled separately — do NOT create inventory widgets.`,
          `</blueprint_widget_types>`,
          ``,
        ]
      : []),
    `<intro_effects>`,
    `Available cinematic intro effects (played when the game first loads):`,
    `  fade_from_black (duration) — RECOMMENDED for most games. Classic cinema opening.`,
    `  fade_to_black (duration),`,
    `  blur (duration, intensity 0-1, target "background"|"content"|"all"),`,
    `  vignette (duration, intensity 0-1),`,
    `  letterbox (duration, intensity 0-1),`,
    `  color_grade (duration, intensity, preset "warm"|"cold_blue"|"horror"|"noir"|"vintage"|"neon"|"dreamy"),`,
    `  focus (duration, intensity)`,
    `</intro_effects>`,
    ``,
    `<campaign_structure_rules>`,
    `Optional structure, not mandatory intensity: some games are cozy, romantic, slice-of-life, sandbox, or low-pressure. If rushing the plot would hurt the requested vibe, use empty arrays or soft social/environmental pressures instead of ticking doom.`,
    `When the campaign needs conflict, create it from concrete external stakes, actors with incompatible goals, danger, scarcity, politics, law, logistics, or consequences that follow from established events. Never create a default critic, challenger, or moral-correction figure merely to oppose the player.`,
    `Do not fill every optional campaignPlan list. Empty arrays are valid. Aim for 0-1 pressure clock, 0-2 factions, 0-3 quest seeds, and 0-2 encounter principles.`,
    `Hard caps (non-negotiable, the schema rejects more): max 2 pressureClocks, max 2 factions, max 3 questSeeds, max 2 encounterPrinciples. For each pressureClock, steps MUST be an integer between 1 and 12 inclusive (typical: 4-8) and current MUST be an integer between 0 and steps (inclusive).`,
    `campaignPlan formats when used: pressureClocks objects {name, steps, current, failure}; factions objects {name, goal, method, secret}; questSeeds/principles short strings.`,
    `Keep all setup JSON compact: worldOverview 1-2 short paragraphs, map 3-6 regions, startingNpcs 2-5, artStylePrompt 20-30 words. No lore essays.`,
    `Structure should create choices and consequences, not force a railroad. Every hook should be easy for the GM to use later in one turn.`,
    `</campaign_structure_rules>`,
    ``,
    ratingBlock,
    ``,
    ...(contextSections.length > 0 ? [...contextSections, ``] : []),
    `<output_format>`,
    `Your ENTIRE response must be a single valid JSON object matching this exact template. Replace the placeholder values with your creative content. Do NOT add extra keys.`,
    ``,
    `{`,
    `  "worldOverview": "1-2 short vivid paragraphs describing the world, its atmosphere, and only the factions/history needed to start playing. This is shown to the player. DO NOT start sentences with Outside or Somewhere! ZERO TOLERANCE FOR AI SLOP! No GPTisms. BAN generic structures and cliches; NO 'doesn't X, doesn't Y,' 'if X, then Y,' 'not X, but Y,' 'physical punches,' 'practiced ease,' 'predatory instincts,' 'mechanical precision,' 'jaws working,' 'lets out a breath.' Combat them with the human touch.",`,
    `  "storyArc": "SECRET. Compact campaign arc in 2-4 sentences: premise, central tension/antagonist if any, escalation style, and possible end state. If the game is chill or sandbox, define soft ongoing tensions instead of a rushing plotline.",`,
    `  "plotTwists": [`,
    `    "SECRET twist 1: one sentence: revelation | clue | false explanation | reveal trigger | fallout.",`,
    `    "SECRET twist 2: optional second twist or soft social/emotional turn; omit extra twists unless they matter."`,
    `  ],`,
    `  "startingMap": {`,
    `    "name": "Area Name",`,
    `    "description": "Brief area overview, one sentence",`,
    `    "regions": [`,
    `      {`,
    `        "id": "region_1",`,
    `        "name": "Short Name (max 12 chars! Displayed on tiny node map. e.g. 'Old Quarter', 'Bazaar', 'Docks')",`,
    `        "description": "One sentence: what this place looks like and why it matters",`,
    `        "type": "town|wilderness|dungeon|building|camp|other",`,
    `        "connectedTo": ["region_2"],`,
    `        "discovered": true`,
    `      }`,
    `    ]`,
    `  },`,
    `  "startingNpcs": [`,
    `    {`,
    `      "name": "NPC Name",`,
    `      "role": "merchant|quest_giver|ally|antagonist|neutral|other",`,
    `      "description": "One sentence: first impression, voice/cadence, desire, and one secret or complication if useful",`,
    `      "location": "region_1",`,
    `      "reputation": 0`,
    `      "_note_reputation": "integer: 0 = neutral, positive = friendly, negative = hostile"`,
    `    }`,
    `  ],`,
    `  "partyArcs": [`,
    `    {`,
    `      "name": "Exact party member name from the Party Members list",`,
    `      "arc": "1-2 concise sentences: personal side-quest, emotional wound, pressure trigger, likely complication, and what would change them. Use soft relationship stakes for chill games.",`,
    `      "goal": "One concrete personal goal that drives this arc"`,
    `    }`,
    `  ],`,
    `  "characterCards": [`,
    `    {`,
    `      "name": "Exact name from Allowed characterCards names only",`,
    `      "shortDescription": "One-sentence character summary for this game's context",`,
    `      "class": "Their class/role/archetype in this game (e.g. Rogue, Diplomat, Pyro Vision Holder)",`,
    `      "abilities": ["1-2 abilities, each with a brief description"],`,
    `      "strengths": ["1-2 strengths"],`,
    `      "weaknesses": ["1-2 weaknesses"],`,
    `      "extra": { "voice": "brief speech style", "personalStake": "why this game matters to them", "temptation": "optional flaw/temptation", "key": "other compact context such as gender, title, affiliation, element, rank" }`,
    `    }`,
    `  ],`,
    `  "artStylePrompt": "A concise image generation style prompt (20-30 words) describing the unified visual art style for ALL generated images in this game. Match the genre and tone.",`,
    `  "blueprint": {`,
    `    "campaignPlan": {`,
    `      "openingSituation": "Optional one-sentence playable tension for the first scene, or empty string.",`,
    `      "pressureClocks": [],`,
    `      "factions": [],`,
    `      "questSeeds": [],`,
    `      "encounterPrinciples": []`,
    `    },`,
    ...(ctx.enableCustomWidgets !== false
      ? [
          `    "hudWidgets": [`,
          `      {`,
          `        "id": "widget_unique_id",`,
          `        "type": "progress_bar|gauge|relationship_meter|counter|stat_block|list|timer|checklist|obligations|schedule|calendar|note|clock|pips|countdown|tug_of_war|tier_track|stages|turn_order|tags|log|ledger|rumor_board|scoreboard|bars|charges",`,
          `        "label": "Display Name",`,
          `        "icon": "emoji",`,
          `        "position": "hud_left|hud_right",`,
          `        "accent": "#hexcolor",`,
          `        "config": {`,
          `          "_note_config": "For bars/gauges/meters, set startingValue to the first-turn value, set value equal to startingValue, and set max separately. For counters use count, for stat_blocks use stats, for lists use items, and for timers use seconds. For every other type use exactly the config keys listed for it in <blueprint_widget_types>.",`,
          `          "_note_valueHints": "For stat_block widgets with string values, add valueHints: {statName: 'option1 | option2 | option3'} so the scene model knows the valid choices. Example: for a 'class' stat, valueHints: {'class': 'alpha | omega | beta'}"`,
          `        }`,
          `      }`,
          `    ],`,
        ]
      : []),
    `    "introSequence": [`,
    `      { "effect": "fade_from_black", "duration": number },`,
    `      { "effect": "vignette", "duration": number, "intensity": number }`,
    `    ],`,
    `    "visualTheme": {`,
    `      "palette": "dark_warm|cold|pastel|neon|earth|monochrome",`,
    `      "uiStyle": "parchment|glass|metal|holographic|organic|minimal",`,
    `      "moodDefault": "mysterious|cheerful|tense|romantic|epic|melancholic"`,
    `    }`,
    `  }`,
    `}`,
    ``,
    `Use EXACTLY these top-level keys: worldOverview, storyArc, plotTwists, startingMap, startingNpcs, partyArcs, characterCards, artStylePrompt, blueprint. No other top-level keys. No wrapper objects.`,
    `Scope reminder: startingNpcs may include important non-party characters, but characterCards and partyArcs must not.`,
    `</output_format>`,
  ].join("\n");
}

function buildSessionSummaryEvidenceRules(rating: "sfw" | "nsfw" = "sfw"): string[] {
  return [
    `The readable summary is a self-contained, human-facing continuity handoff. Organize it around the session's central throughline, turning points, consequential choices, relationship changes, and aftermath — not as an itinerary of travel, spell tiers, routine transitions, or technical setup. Give enabling actions only the space their consequences earn.`,
    `Preserve agency and reciprocity exactly: state who initiated, requested, chose, consented, refused, promised, or changed course. Do not infer a relationship label, motive, judgment, or lasting character trait that the transcript did not establish.`,
    `For a consequential demonstration, confrontation, lesson, or discovery, preserve its purpose, named witnesses' reactions, what they actually learned, and practical follow-up instructions alongside what happened. Do not reduce a teaching demonstration to an enjoyable fight or infer that every witness learned the same thing.`,
    `An NPC's acceptance does not transfer authorship of the player's decision to that NPC. Preserve who imposed a learning method, condition, assignment, or restriction, and distinguish the recipient's response from its origin.`,
    `Keep every interpretation, praise, criticism, and claim about a character's motives attributed to the named speaker. Describe supported positive conduct directly; do not turn praise into an unsupported negative counterfactual such as saying the player "did not make it about himself."`,
    `Treat [To the GM], [GM], and [OOC] passages as authorial instructions or corrections, never as in-world events. A passage that rejects, corrects, or rewinds assistant-authored content is an authorial correction; the correction controls canon, and the disputed content must not survive in the summary.`,
    `For the session's final location, time, condition, and pending obligations, follow the last chronologically explicit transcript beat. Treat supplied tracker/current-state JSON as a possibly stale aid when it conflicts with the transcript, not as authority to move anyone back or duplicate an event.`,
    ...(rating === "nsfw"
      ? [
          `This is an NSFW campaign. Record established consensual adult sexual intimacy plainly but non-graphically when it changes a relationship or matters to continuity. Do not erase it behind euphemisms such as "remained together privately," and do not promote sex alone into an unestablished label such as "became lovers."`,
        ]
      : []),
    buildGameContinuityEvidencePrompt(),
  ];
}

/** Build a session summary prompt. */
export function buildSessionSummaryPrompt(language?: string | null, rating: "sfw" | "nsfw" = "sfw"): string {
  const normalizedLanguage = normalizePromptLanguage(language);
  return [
    `Summarize this completed game session as structured continuity data.`,
    `Return JSON with exactly these keys and no others: summary, resumePoint, partyDynamics, partyState, keyDiscoveries, characterMoments, littleDetails, npcUpdates, statsSnapshot.`,
    ``,
    `1. **summary**: A self-contained, human-facing recap. Use as many flowing paragraphs as the session needs, with no fixed paragraph target; never shorten it by dropping a session-defining choice, relationship milestone, commitment, correction, or consequence merely because another field also indexes that fact.`,
    `2. **resumePoint**: One short paragraph or 1–3 sentences stating the exact in-world situation at session end and where the next session must resume from. Name the location, present characters, current pressure, and the immediate unfinished action or decision when possible.`,
    `3. **partyDynamics**: How relationships between the player and companions, and among companions, evolved this session. Relationship changes only; state explicitly when none changed.`,
    `4. **partyState**: Current condition of the party after the session (HP, morale, injuries, resources, exhaustion, or readiness).`,
    `5. **keyDiscoveries**: Array of durable, actionable continuity facts: important plot points, hidden truths, twists, quests, lore learned, locations, and newly opened leads that still matter next session. Use this single bucket for both discoveries and reveals. Do not include emotional moments or NPC stance changes unless that fact itself is the core continuity item.`,
    `6. **characterMoments**: Array of notable personal moments between the player and specific characters. Use this only for bonding, romance, betrayal, confessions, arguments, or other interpersonal beats. Empty array if none.`,
    `7. **littleDetails**: Array of small personal details to recall later: preferences, habits, favorite things, casual promises, private jokes, fears, motifs, or fragments of a character's past that are not major plot discoveries. Empty array if none.`,
    `8. **npcUpdates**: Array of new NPCs, NPC reputation changes, and important shifts in an NPC's stance, allegiance, or immediate agenda.`,
    `9. **statsSnapshot**: Current party stats, inventory, quest states, and any location / pressure details needed for continuity. This must be a JSON object, not prose.`,
    ``,
    `Continuity and organization rules:`,
    `- summary must stand on its own. Important facts may and should overlap summary and one structured field; the structured fields are continuity indexes, not substitutes for the readable recap.`,
    `- Outside summary, place each fact in the single best structured category and avoid repeating it across keyDiscoveries, characterMoments, littleDetails, npcUpdates, and statsSnapshot.`,
    `- If something is primarily a relationship or emotional beat, keep it out of keyDiscoveries and npcUpdates.`,
    `- If something is primarily an NPC stance change, keep it out of keyDiscoveries unless that stance change is itself the core continuity fact.`,
    `- If something is primarily a lore/quest lead, keep it out of characterMoments.`,
    `- Use empty strings, empty arrays, or {} when a category has no meaningful content.`,
    ``,
    ...buildSessionSummaryEvidenceRules(rating),
    ``,
    buildProtagonistFairnessPrompt(),
    ``,
    normalizedLanguage
      ? `Language: write every natural-language value in ${normalizedLanguage}. Keep the JSON keys exactly as specified in English.`
      : ``,
    ``,
    `Output valid JSON only.`,
  ].join("\n");
}

/** Build a prompt for concluding a session in one pass. */
export function buildSessionConclusionPrompt(args: {
  language?: string | null;
  rating?: "sfw" | "nsfw";
  includeCharacterCards: boolean;
  gameSpecialInstructions: string | null;
  protectedPlayerNames?: readonly string[];
  playerCharacterCanon?: string | null;
}): string {
  const normalizedLanguage = normalizePromptLanguage(args.language);
  const protectedPlayerNames = normalizePromptTextList(args.protectedPlayerNames);
  return [
    `Review this completed game session and return all end-of-session continuity updates in one JSON object.`,
    `Return JSON with exactly these top-level keys and no others: summary, campaignProgression, nextSessionPlan, characterCards.`,
    `Phase exception: if a later message explicitly requests FACTUAL REVIEW PHASE, return only its requested review schema instead of the conclusion schema. In that phase validate the draft against the transcript; do not generate another conclusion.`,
    ``,
    buildPlayerCharacterCanonPrompt(args.playerCharacterCanon, protectedPlayerNames[0]),
    ``,
    ...(normalizedLanguage
      ? [
          `Language: write every natural-language value in ${normalizedLanguage}. Keep the JSON keys and booleans exactly as specified in English.`,
          ``,
        ]
      : []),
    `summary must be an object with exactly these keys and no others: summary, resumePoint, partyDynamics, partyState, keyDiscoveries, characterMoments, littleDetails, npcUpdates, statsSnapshot.`,
    `- summary.summary: A self-contained, human-facing recap. Use as many flowing paragraphs as the session needs, with no fixed paragraph target; never shorten it by dropping a session-defining choice, relationship milestone, commitment, correction, or consequence merely because another field also indexes that fact.`,
    `- summary.resumePoint: One short paragraph or 1-3 sentences stating the exact in-world situation at session end and where the next session must resume from.`,
    `- summary.partyDynamics: Relationship changes between the player and companions, and among companions. State explicitly when none changed.`,
    `- summary.partyState: Current condition of the party after the session, including readiness, injuries, morale, resources, or exhaustion.`,
    `- summary.keyDiscoveries: Array of durable, actionable continuity facts: important plot points, hidden truths, twists, quests, lore learned, locations, and newly opened leads that still matter next session. Use this single bucket for both discoveries and reveals.`,
    `- summary.characterMoments: Array of notable interpersonal beats such as bonding, romance, betrayal, confessions, arguments, or other personal turning points.`,
    `- summary.littleDetails: Array of small personal details to recall later: preferences, habits, favorite things, casual promises, private jokes, fears, motifs, or fragments of a character's past that are not major plot discoveries.`,
    `- summary.npcUpdates: Array of new NPCs, reputation changes, and important shifts in an NPC's stance, allegiance, or immediate agenda.`,
    `- summary.statsSnapshot: JSON object with continuity-critical state such as party stats, inventory, quest progress, location, active pressure, and partyMorale as a number from 0 to 100.`,
    ``,
    `campaignProgression must be an object with exactly these keys and no others: storyArc, plotTwists, partyArcs.`,
    `- campaignProgression.storyArc: Refresh the overarching campaign arc only if this session materially advanced or changed it. Otherwise preserve the current arc.`,
    `- campaignProgression.plotTwists: Keep unresolved twists that still matter, remove obsolete ones, and add any major new twist revealed this session.`,
    `- campaignProgression.partyArcs: Return the FULL array of party arcs. Carry forward unfinished arcs with updated wording where needed. If an arc completed, mark completed: true and include a short resolution note.`,
    `- A new plotTwist must be an objective revelation in direct transcript evidence, a carried-forward existing GM secret, or an explicit user-authored premise. An NPC theory, ambiguous atmosphere, unexplained deference, rumor, or convenient inference is not a revealed twist.`,
    `- Do not create, complete, or redefine a partyArc from a single routine reassignment, passing reaction, ordinary duty change, temporary mood, or isolated exchange. Require an explicit durable turning point or a supported pattern across events.`,
    ``,
    `nextSessionPlan must prepare a genuinely fresh playable arc while preserving campaign continuity.`,
    `- nextSessionPlan must be an object with exactly these keys: campaignPlan, namedNpcs.`,
    `- nextSessionPlan.campaignPlan must contain exactly: openingSituation, pressureClocks, factions, questSeeds, encounterPrinciples.`,
    `- openingSituation: a fresh immediate goal or situation for the next session, not a recap of the completed one.`,
    `- pressureClocks: 0-2 objects with name, steps (1-12), current (start at 0 unless continuity requires otherwise), and failure.`,
    `- factions: 1-2 active factions or social groups with name, goal, method, and optional secret. Replace stale or resolved faction plans rather than copying them.`,
    `- questSeeds: 1-3 concrete new hooks or goals that can drive the next arc. Do not repeat resolved hooks from the current campaign plan.`,
    `- encounterPrinciples: 0-2 short principles that make the next arc distinct in play.`,
    `- namedNpcs: 0-3 NEW key NPC objects with name, emoji, description, gender, pronouns, location, and roleOrAgenda. An empty array is valid. Do not repeat an already known NPC, and do not invent a critic, challenger, moral examiner, or opposition figure merely to create friction with the player.`,
    `- Treat the player's next-session request as strong steering for this plan when one was supplied.`,
    ``,
    `characterCards rules:`,
    ...(protectedPlayerNames.length > 0
      ? [
          `- Player-owned cards are read-only and MUST be omitted from characterCards: ${protectedPlayerNames.join(", ")}. Never derive new strengths, weaknesses, temptations, motives, or personality claims for them.`,
        ]
      : []),
    ...(args.includeCharacterCards
      ? [
          `- characterCards must be a JSON array containing the FULL updated card for each supplied updateable companion.`,
          `- Return every supplied updateable companion exactly once, even if unchanged.`,
          `- Only make conservative changes that are clearly justified by session events. This represents organic growth, not sudden transformation.`,
          `- Do not add a weakness, dependency, identity crisis, personal stake, motive, or completed growth beat from a single routine reassignment, passing reaction, ordinary duty change, or isolated exchange. Leave the card unchanged unless the session establishes a durable change.`,
        ]
      : [`- characterCards must be an empty JSON array because no current character cards were supplied.`]),
    `- Keep each card aligned with the input schema: name, shortDescription, class, abilities, strengths, weaknesses, extra.`,
    ``,
    `Continuity and organization rules:`,
    `- summary.summary must stand on its own. Important facts may and should overlap the readable summary and one structured field; the structured fields are continuity indexes, not substitutes for the readable recap.`,
    `- Outside summary.summary, place each fact in the single best structured category and avoid repeating it across summary.keyDiscoveries, summary.characterMoments, summary.littleDetails, summary.npcUpdates, summary.statsSnapshot, and campaignProgression.`,
    `- If something is primarily a relationship or emotional beat, keep it out of keyDiscoveries and npcUpdates.`,
    `- If something is primarily an NPC stance change, keep it out of keyDiscoveries unless that stance change is itself the core continuity fact.`,
    `- If something is primarily a lore or quest lead, keep it out of characterMoments.`,
    `- Be conservative. Preserve existing campaign state and cards when the session did not justify a change.`,
    `- Use empty strings, empty arrays, or {} when a category has no meaningful content.`,
    ``,
    ...buildSessionSummaryEvidenceRules(args.rating),
    ``,
    buildProtagonistFairnessPrompt(),
    ``,
    ...buildGameSpecialInstructionsSection(args.gameSpecialInstructions),
    `Output valid JSON only.`,
  ].join("\n");
}

/** Build the prompt for adjusting party character cards at session end. */
export function buildCardAdjustmentPrompt(): string {
  return [
    `You are the Game Master reviewing what happened during this session to decide how the party's character cards should evolve.`,
    ``,
    `Based on the session summary and current cards, decide for EACH character whether their card should change. Changes are OPTIONAL — only adjust what makes narrative sense:`,
    `- **abilities**: Add new abilities the character learned or demonstrated. Remove abilities that were lost or superseded.`,
    `- **strengths**: Update if the character developed new strengths or overcame weaknesses.`,
    `- **weaknesses**: Update if the character gained new vulnerabilities or overcame old ones.`,
    `- **shortDescription**: Update only if the character's identity meaningfully shifted.`,
    `- **class**: Update only if the character evolved into a new class/role (e.g. "Apprentice Mage" → "Battlemage").`,
    `- **rpgStats**: Adjust attribute values (±1–3 per session), HP max, etc. Small incremental changes only.`,
    ``,
    `RULES:`,
    `- Return the FULL updated card for each character, even if only one field changed.`,
    `- If a character needs NO changes, return their card unchanged.`,
    `- Be conservative — only make changes that are clearly justified by session events.`,
    `- This represents organic character growth, not sudden transformation.`,
    `- The player character's characterization is player-owned. If the supplied cards include the player character, return that card exactly unchanged unless the caller explicitly states that the player approved an update.`,
    `- Never turn an NPC accusation, one disagreement, self-correction, refusal, or withdrawal of an optional offer into a new weakness or temptation.`,
    `- A single routine reassignment, passing mood, ordinary duty change, gesture, meal, or isolated exchange is not character evolution. Do not invent a dependency, identity crisis, personal stake, motive, weakness, or resolved arc to make the moment recur.`,
    ``,
    buildGameContinuityEvidencePrompt(),
    ``,
    `Output as a JSON array of character card objects, one per character, with the same structure as the input cards.`,
  ].join("\n");
}

/** Build the prompt for adjusting campaign progression at session end. */
export function buildCampaignProgressionPrompt(args: {
  language?: string | null;
  gameSpecialInstructions: string | null;
  playerCharacterCanon?: string | null;
  protectedPlayerNames?: readonly string[];
}): string {
  const normalizedLanguage = normalizePromptLanguage(args.language);
  return [
    `You are the Game Master reviewing what happened during this session to update the campaign's ongoing progression state.`,
    ``,
    buildPlayerCharacterCanonPrompt(args.playerCharacterCanon, normalizePromptTextList(args.protectedPlayerNames)[0]),
    ``,
    ...(normalizedLanguage
      ? [
          `Language: write every natural-language value in ${normalizedLanguage}. Keep the JSON keys and booleans in English.`,
          ``,
        ]
      : []),
    `Update these campaign tracking fields based on the completed session:`,
    `- storyArc: refresh the overarching campaign arc only if the session materially advanced or changed it.`,
    `- plotTwists: keep unresolved twists that still matter, remove obsolete ones, and add any major new twist revealed this session.`,
    `- partyArcs: return the FULL array of party arcs. Carry forward unfinished arcs with updated wording where needed. If an arc completed, mark \"completed\": true and include a short \"resolution\" note. Keep unfinished arcs as \"completed\": false or omit the field.`,
    ``,
    `RULES:`,
    `- Be conservative. Do not rewrite campaign state unless the session justified it.`,
    `- Preserve continuity with the existing state when nothing changed.`,
    `- Return FULL updated values, not patches.`,
    `- For partyArcs, each item must include: name, arc, goal. It may also include completed and resolution.`,
    `- Never include the player character in partyArcs; those arcs are for companions only.`,
    `- Add a plotTwist only when direct transcript evidence objectively revealed it, the existing GM state already contained it, or the user explicitly authored the premise. Keep an NPC's theory, fear, rumor, interpretation, unexplained deference, or ambiguous atmosphere attributed; do not promote it into secret truth.`,
    `- Do not create, complete, or redefine a partyArc from one routine reassignment, passing mood, isolated exchange, or ordinary duty change. Require an explicit durable turning point or a supported pattern across events.`,
    `- Treat [user OOC correction] passages as authorial corrections, not in-world events. A correction controls canon over the assistant-authored content it rejects, rewinds, or replaces.`,
    `- Do not invent extra top-level keys.`,
    ``,
    buildProtagonistFairnessPrompt(),
    ``,
    buildGameContinuityEvidencePrompt(normalizePromptTextList(args.protectedPlayerNames)[0]),
    ``,
    ...buildGameSpecialInstructionsSection(args.gameSpecialInstructions),
    `Output exactly one JSON object with these keys: storyArc, plotTwists, partyArcs.`,
  ].join("\n");
}

export function buildPartyRecruitCardPrompt(ctx: {
  targetCharacterName: string;
  targetCharacterCard: string;
  currentPartyNames: string[];
  currentPartyCards?: string | null;
  existingTargetCard?: string | null;
  worldOverview?: string | null;
  storyArc?: string | null;
  plotTwists?: string[] | null;
  campaignHistory?: string | null;
  currentState?: string | null;
  recentTranscript?: string | null;
  playerCharacterCanon?: string | null;
  language?: string | null;
  purpose?: "recruit" | "regenerate";
}): string {
  const normalizedLanguage = normalizePromptLanguage(ctx.language);
  const isRegeneration = ctx.purpose === "regenerate";
  const sections: string[] = [
    `You are the Game Master updating an ongoing RPG campaign.`,
    ...(ctx.playerCharacterCanon?.trim() ? [buildPlayerCharacterCanonPrompt(ctx.playerCharacterCanon), ``] : []),
    buildProtagonistFairnessPrompt(),
    ``,
    isRegeneration
      ? `A companion's party sheet is malformed or outdated. Regenerate one clean JSON character card for them that matches the existing game card schema.`
      : `A new companion is joining the party. Create a single JSON character card for them that matches the existing game card schema.`,
    ``,
    ...(normalizedLanguage && normalizedLanguage.toLowerCase() !== "english"
      ? [
          `<language>`,
          `Write every natural-language string value in ${normalizedLanguage}. Keep JSON keys and structural syntax in English.`,
          `</language>`,
          ``,
        ]
      : []),
    `RULES:`,
    `- Return EXACTLY one JSON object with these keys: name, shortDescription, class, abilities, strengths, weaknesses, extra.`,
    `- Keep the name exactly "${ctx.targetCharacterName}".`,
    `- Ground the card in the existing campaign state, world, and recent events.`,
    `- Respect the supplied character card as canon. Do not contradict it.`,
    `- Do not turn one routine reassignment, passing reaction, ordinary duty change, isolated exchange, or assistant interpretation into a new weakness, dependency, identity crisis, personal stake, motive, or completed arc. Preserve the existing card unless a durable change is explicitly supported.`,
    ...(isRegeneration
      ? [
          `- Treat the existing target party sheet as a damaged draft: preserve useful facts, but fix malformed fields, bad formatting, missing structure, and awkward or off-tone values.`,
        ]
      : []),
    `- abilities, strengths, and weaknesses must be arrays of strings.`,
    `- extra must be an object of string values.`,
    `- Do not output markdown, explanations, or any wrapper text.`,
    ``,
    `<current_party>`,
    `Current party members: ${ctx.currentPartyNames.length > 0 ? ctx.currentPartyNames.join(", ") : "None"}`,
    `</current_party>`,
    ``,
    `<recruited_character>`,
    ctx.targetCharacterCard,
    `</recruited_character>`,
  ];

  if (ctx.worldOverview) {
    sections.push(``, `<world_overview>`, ctx.worldOverview, `</world_overview>`);
  }
  if (ctx.storyArc) {
    sections.push(``, `<story_arc>`, ctx.storyArc, `</story_arc>`);
  }
  if (ctx.plotTwists && ctx.plotTwists.length > 0) {
    sections.push(``, `<plot_twists>`, ...ctx.plotTwists, `</plot_twists>`);
  }
  if (ctx.campaignHistory?.trim()) {
    sections.push(
      ``,
      `<campaign_history>`,
      `Assistant-derived continuity index. Use it to locate events, not as independent evidence for judgments about the player character.`,
      ctx.campaignHistory.trim(),
      `</campaign_history>`,
    );
  }
  if (ctx.currentPartyCards?.trim()) {
    sections.push(``, `<existing_party_cards>`, ctx.currentPartyCards.trim(), `</existing_party_cards>`);
  }
  if (ctx.existingTargetCard?.trim()) {
    sections.push(``, `<existing_target_party_sheet>`, ctx.existingTargetCard.trim(), `</existing_target_party_sheet>`);
  }
  if (ctx.currentState?.trim()) {
    sections.push(``, `<current_state>`, ctx.currentState.trim(), `</current_state>`);
  }
  if (ctx.recentTranscript?.trim()) {
    sections.push(``, `<recent_transcript>`, ctx.recentTranscript.trim(), `</recent_transcript>`);
  }

  sections.push(``, buildGameContinuityEvidencePrompt());

  return sections.join("\n");
}
