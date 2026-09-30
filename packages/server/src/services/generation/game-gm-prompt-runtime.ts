import { layoutNamedCards, type NamedCard } from "../game/named-card-cache.js";
import { isFeatureEnabled } from "../features/feature-settings.js";
import { selectNamedCharacterIds } from "../game/named-characters.js";
import { currentRoomGeneration, roomHostIdentity } from "../multiplayer/generation-policy.js";
import {
  GAME_GM_BUILT_IN_PROMPT_TEMPLATES,
  composeGameTimeLine,
  findGameNpcByNameDerivedId,
  normalizeAgentPromptTemplateOptions,
  normalizeTextForMatch,
  resolveGameSetupArtStylePrompt,
  summarizeTacticalBattlefield,
  type GameActiveState,
  type GameCampaignPlan,
  type GameMap,
  type GameNpc,
  type CharacterMacroProfile,
  type MacroContext,
  type SessionSummary,
} from "@marinara-engine/shared";
import { isGameExtendedWidgetsEnabled } from "@marinara-engine/shared";
import { buildGmSystemPromptParts, type GmPromptContext } from "../game/gm-prompts.js";
import {
  parseGamePromptTextReplacements,
  replaceGamePromptText,
  type GamePromptTextReplacement,
} from "../game/game-prompt-text-replacements.js";
import { listPartySprites } from "../game/sprite.service.js";
import { generatePerceptionHints, formatPerceptionHints, type PerceptionContext } from "../game/perception.service.js";
import { getMoraleTier, formatMoraleContext } from "../game/morale.service.js";
import { sidecarModelService } from "../sidecar/sidecar-model.service.js";
import { isInferenceAvailable as isSidecarInferenceAvailable } from "../sidecar/sidecar-inference.service.js";
import { cardPromptText } from "../prompt/card-text.js";
import { isPartyNpcId } from "./game-party-utils.js";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import {
  buildCampaignMemoryContextFromStorage,
  type CampaignMemoryContextResult,
} from "../game/campaign-memory-context.js";

type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  contextKind?: "prompt" | "history" | "injection";
  providerMetadata?: Record<string, unknown>;
};

type CharactersStore = {
  getById(id: string): Promise<{ data: unknown } | null>;
  getPersona(id: string): Promise<any | null>;
  /** The whole character library; lets the GM see the card of anyone named in the session, party or not. */
  list?(): Promise<Array<{ id: string; data: unknown }>>;
};

type ChatsStore = {
  getById(id: string): Promise<{ metadata?: unknown } | null>;
  updateMetadata(chatId: string, metadata: Record<string, unknown>): Promise<unknown>;
};

// Campaign scope merges every earlier session, so the block needs room for more than one scene of records.
export const DEFAULT_CAMPAIGN_MEMORY_MAX_CHARACTERS = 10000;

type ChatLike = {
  personaId?: string | null;
};

type PromptMappedMessage = {
  role: string;
  content?: unknown;
  contextKind?: "prompt" | "history" | "injection";
};

function hasNameBoundary(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u").test(text);
}

function partyNameAliases(name: string): string[] {
  const normalized = normalizeTextForMatch(name);
  const words = normalized.split(" ").filter(Boolean);
  const titlePattern =
    /^(?:mr|mrs|ms|miss|mx|dr|sir|dame|lady|lord|capt|captain|prof|warmagus|princess|prince|countess|count|duke|duchess|baron|baroness|viscount|viscountess|earl|marquis|marchioness)$/u;
  let firstNameIndex = 0;
  while (firstNameIndex < words.length && titlePattern.test(words[firstNameIndex]!)) firstNameIndex += 1;
  const titleStripped = words.slice(firstNameIndex).join(" ");
  const firstName = words[firstNameIndex] ?? "";
  return [...new Set([normalized, titleStripped, firstName].filter(Boolean))];
}

/** Limit only the prompt projection; the full metadata history remains unchanged. */
export function limitGameGmSessionSummaries(summaries: SessionSummary[], limit: unknown): SessionSummary[] {
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) return summaries;
  if (summaries.length <= limit) return summaries;
  return [...summaries].sort((left, right) => left.sessionNumber - right.sessionNumber).slice(-limit);
}

/**
 * Select party IDs with direct current-scene or recent-message evidence. An empty
 * result deliberately means that the caller should keep all detailed references.
 */
export function selectFocusedGamePartyIds(args: {
  party: Array<{ id: string; name: string }>;
  presentCharacters: unknown;
  mappedMessages: PromptMappedMessage[];
  recentMessageCount?: number;
}): Set<string> {
  const partyById = new Map(args.party.map((member) => [member.id, member]));
  const partyByName = new Map(args.party.map((member) => [normalizeTextForMatch(member.name), member]));
  const aliases = new Map<string, string[]>();
  const aliasOwners = new Map<string, string[]>();
  for (const member of args.party) {
    const memberAliases = partyNameAliases(member.name);
    aliases.set(member.id, memberAliases);
    for (const alias of memberAliases) {
      const owners = aliasOwners.get(alias) ?? [];
      owners.push(member.id);
      aliasOwners.set(alias, owners);
    }
  }
  const selected = new Set<string>();
  const present = Array.isArray(args.presentCharacters) ? args.presentCharacters : [];
  for (const value of present) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const id =
      typeof record.characterId === "string" && partyById.has(record.characterId) ? record.characterId : undefined;
    if (id) selected.add(id);
    const presentName = typeof record.name === "string" ? normalizeTextForMatch(record.name) : "";
    const name = partyByName.get(presentName);
    if (name) selected.add(name.id);
    for (const [memberId, memberAliases] of aliases) {
      if (memberAliases.some((alias) => alias === presentName && (aliasOwners.get(alias)?.length ?? 0) === 1)) {
        selected.add(memberId);
      }
    }
  }
  const recentMessages = args.mappedMessages
    .filter(
      (message) => message.role !== "system" && message.contextKind !== "injection" && message.contextKind !== "prompt",
    )
    .slice(-(args.recentMessageCount ?? 8));
  for (const message of recentMessages) {
    const content = typeof message.content === "string" ? normalizeTextForMatch(message.content) : "";
    if (!content) continue;
    for (const [memberId, memberAliases] of aliases) {
      if (
        memberAliases.some((alias) => (aliasOwners.get(alias)?.length ?? 0) === 1 && hasNameBoundary(content, alias))
      ) {
        selected.add(memberId);
      }
    }
  }
  return selected;
}

export type GameGmPromptRuntime = {
  gmCtx: GmPromptContext;
  gameActiveState: string;
  sessionNumber: number;
  gameTurnNumber: number;
  gameTime: string | undefined;
  gameMap: GameMap | null;
  hasSceneModel: boolean;
};

/** Explicit per-character boundary: what each present character may use from the block above. */
export function formatGameGmCharacterBoundary(context: CampaignMemoryContextResult): string {
  const lines = ["<character_boundary>"];
  if (!context.characterBoundaries) {
    lines.push(
      "Scene presence was unavailable for this request. Every record above is GM-only: no character may reference it unless established fiction shows they learned it on-screen.",
    );
  } else {
    lines.push(
      "Presence comes from the current scene state. A present character may use only the record IDs listed for it, plus what it witnesses on-screen from now on.",
    );
    for (const boundary of context.characterBoundaries) {
      const aliases = boundary.aliases.length ? ` aliases=${boundary.aliases.join(",")}` : "";
      lines.push(
        `[may-use holder=${boundary.entityId}${aliases}] ${boundary.mayUseIds.length ? boundary.mayUseIds.join(", ") : "(nothing listed)"}`,
      );
    }
    if (!context.characterBoundaries.length)
      lines.push("No campaign-memory character is present in the current scene.");
    lines.push("Everything else above is GM-only: no character may reference it unless they learn it on-screen.");
  }
  lines.push("</character_boundary>");
  return lines.join("\n");
}

/** Compact omission accounting so nothing is dropped silently. */
export function formatGameGmMemoryOmissions(context: CampaignMemoryContextResult): string {
  const omissions = context.omissions ?? { budgetOmitted: 0, duplicatesMerged: 0, mergedIds: [] };
  return `[memory_omissions] ${omissions.budgetOmitted} records omitted for budget; ${omissions.duplicatesMerged} duplicates merged into continuity receipts`;
}

/** Fixed precedence rule at the head of the runtime block; it never enters the stable cache prefix. */
export const GAME_GM_CAMPAIGN_MEMORY_PRECEDENCE =
  "Precedence: current state and verified facts in this block override any conflicting character card, persona, or lore text; when they conflict, use this block.";

/** Append the GM-only campaign-memory projection as a dynamic injection suffix. */
export function appendGameGmCampaignMemory(
  messages: PromptMessage[],
  context: CampaignMemoryContextResult,
  rules: readonly GamePromptTextReplacement[] = [],
): void {
  if (!context.text.trim() && !context.degraded) return;
  const availability = context.degraded
    ? "Some campaign memory was excluded by validation or budget. Absence is not evidence that a fact never happened. Use current verified records over stale descriptions; respect each listed knowledge holder."
    : "These are current verified campaign records. World truth is not automatic character knowledge; only listed holders have the attributed knowledge.";
  const body = [
    replaceGamePromptText(GAME_GM_CAMPAIGN_MEMORY_PRECEDENCE, rules),
    replaceGamePromptText(availability, rules),
    context.text,
    formatGameGmCharacterBoundary(context),
    formatGameGmMemoryOmissions(context),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
  messages.push({
    role: "system",
    content: `${replaceGamePromptText('<campaign_memory audience="gm">', rules)}\n${body}\n${replaceGamePromptText("</campaign_memory>", rules)}`,
    contextKind: "injection",
    providerMetadata: {
      // Producer-owned current records may be archived only as a scoped turn snapshot.
      marinaraPromptHistoryReplaySnapshot: true,
      marinaraRuntimeContext: true,
      marinaraCampaignMemory: {
        audience: "gm",
        includedIds: context.includedIds,
        exclusions: context.exclusions,
        degraded: context.degraded,
        cutoffOrder: null,
        characterBoundaries: context.characterBoundaries ?? null,
        omissions: context.omissions ?? null,
        precedence: "campaign-memory-over-cards",
        currentStateCount: context.currentStateCount ?? 0,
      },
    },
  });
}

function parseExtra(extra: unknown): Record<string, unknown> {
  if (!extra) return {};
  try {
    return typeof extra === "string" ? JSON.parse(extra) : (extra as Record<string, unknown>);
  } catch {
    return {};
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// A GM block containing unresolved prompt macros is request-dependent after
// expansion. Keep the whole block in the runtime region so the stable cache
// prefix remains byte-for-byte unchanged.
function hasPromptMacroSyntax(value: string): boolean {
  return /\{\{[^{}]+\}\}/u.test(value);
}

export function hasUnstableReferenceMacroSyntax(value: string): boolean {
  const macros = value.match(/\{\{\s*([^{}]+?)\s*\}\}/gu) ?? [];
  return macros.some((macro) => !/^\{\{\s*user(?:name)?\s*\}\}$/iu.test(macro));
}

export function resolveGameGmPromptTemplate(
  chatMetadata: Record<string, unknown>,
  setupConfig?: Record<string, unknown> | null,
): string | null {
  const explicitPrompt = typeof chatMetadata.gameSystemPrompt === "string" ? chatMetadata.gameSystemPrompt.trim() : "";
  if (explicitPrompt) return explicitPrompt;

  const selectedId =
    typeof chatMetadata.gameGmPromptTemplateId === "string" && chatMetadata.gameGmPromptTemplateId.trim()
      ? chatMetadata.gameGmPromptTemplateId.trim()
      : typeof setupConfig?.gameGmPromptTemplateId === "string"
        ? setupConfig.gameGmPromptTemplateId.trim()
        : "";
  if (!selectedId) return null;

  const options = [
    ...GAME_GM_BUILT_IN_PROMPT_TEMPLATES,
    ...normalizeAgentPromptTemplateOptions(chatMetadata.gameGmPromptTemplates),
  ];
  return options.find((option) => option.id === selectedId)?.promptTemplate.trim() || null;
}

/**
 * The authored text the GM prompt resolves macros in, so decision statements in it can
 * be asked before the prompt is built (#6569): the GM prompt template, or the preset's
 * Game prompt when the chat chose none (as generation applies it), special instructions
 * and the custom GM prompt.
 */
export function gameGmPromptDecisionTexts(chatMetadata: Record<string, unknown>, presetGamePrompt: string): string[] {
  const setupConfig =
    chatMetadata.gameSetupConfig &&
    typeof chatMetadata.gameSetupConfig === "object" &&
    !Array.isArray(chatMetadata.gameSetupConfig)
      ? (chatMetadata.gameSetupConfig as Record<string, unknown>)
      : null;
  const template = resolveGameGmPromptTemplate(chatMetadata, setupConfig);
  const chosenNone =
    !(typeof chatMetadata.gameSystemPrompt === "string" && chatMetadata.gameSystemPrompt.trim()) &&
    !(typeof chatMetadata.gameGmPromptTemplateId === "string" && chatMetadata.gameGmPromptTemplateId.trim());
  return [
    (chosenNone && presetGamePrompt ? presetGamePrompt : template) ?? "",
    typeof chatMetadata.gameSpecialInstructions === "string" ? chatMetadata.gameSpecialInstructions : "",
    typeof chatMetadata.customGmPrompt === "string" ? chatMetadata.customGmPrompt : "",
  ];
}

export function appendGameCardDetails(
  parts: string[],
  card: Record<string, unknown> | undefined,
  options: { includeInterpretiveFields?: boolean } = {},
): void {
  if (!card) return;
  if (card.class) parts.push(`Class: ${card.class}`);
  if ((card.abilities as string[])?.length) parts.push(`Abilities: ${(card.abilities as string[]).join(", ")}`);
  if (options.includeInterpretiveFields === false) return;
  if ((card.strengths as string[])?.length) parts.push(`Strengths: ${(card.strengths as string[]).join(", ")}`);
  if ((card.weaknesses as string[])?.length) parts.push(`Weaknesses: ${(card.weaknesses as string[]).join(", ")}`);
  const extra = card.extra as Record<string, string> | undefined;
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      parts.push(`${key}: ${value}`);
    }
  }
}

function buildLibraryCardParts(
  data: any,
  fallbackName = "Unknown",
): { name: string; parts: string[]; macroProfile: CharacterMacroProfile } {
  const name = data.name || fallbackName;
  const parts = [`Name: ${name}`];
  const personality = cardPromptText(data.personality);
  const description = cardPromptText(data.description);
  const backstory = cardPromptText(data.extensions?.backstory || data.backstory);
  const appearance = cardPromptText(data.extensions?.appearance || data.appearance);
  const scenario = cardPromptText(data.scenario);
  const example = cardPromptText(data.mes_example);
  const systemPrompt = cardPromptText(data.system_prompt);
  const postHistoryInstructions = cardPromptText(data.post_history_instructions);
  if (description) parts.push(`Description: ${description}`);
  if (personality) parts.push(`Personality: ${personality}`);
  if (backstory) parts.push(`Backstory: ${backstory}`);
  if (appearance) parts.push(`Appearance: ${appearance}`);
  if (systemPrompt) parts.push(`Character System Instructions: ${systemPrompt}`);
  return {
    name,
    parts,
    macroProfile: {
      name,
      phoneticName: cardPromptText(data.extensions?.phoneticName),
      description,
      personality,
      backstory,
      appearance,
      scenario,
      example,
      systemPrompt,
      postHistoryInstructions,
    },
  };
}

/** Library characters named in the session, outside the party, in order of first mention. */
export const selectSceneCharacterCardIds = selectNamedCharacterIds;

function buildSceneCharacterCardText(data: any): { card: string; macroProfile: CharacterMacroProfile } {
  const { name, macroProfile } = buildLibraryCardParts(data);
  const parts = [`Name: ${name}`];
  if (macroProfile.description) parts.push(`Description: ${macroProfile.description}`);
  if (macroProfile.personality) parts.push(`Personality: ${macroProfile.personality}`);
  if (macroProfile.backstory) parts.push(`Backstory: ${macroProfile.backstory}`);
  if (macroProfile.appearance) parts.push(`Appearance: ${macroProfile.appearance}`);
  // Race, age and other identity facts often live only in the creator notes.
  const notes = cardPromptText(data.creator_notes);
  if (notes) parts.push(`Card notes: ${notes}`);
  return { card: parts.join("\n"), macroProfile };
}

function trackedNpcMacroProfile(npc: GameNpc): CharacterMacroProfile {
  return {
    name: npc.name || "Unknown",
    description: cardPromptText(npc.description),
    personality: "",
    backstory: "",
    appearance: "",
    scenario: "",
    example: "",
    systemPrompt: "",
    postHistoryInstructions: "",
  };
}

/** Resolve only card-local character macros; the final prompt pass owns all ordered side effects and conditionals. */
export function resolveGameCharacterCardMacros(
  template: string,
  profile: CharacterMacroProfile,
  baseContext: Pick<MacroContext, "characters" | "groupCharacters">,
  depth = 0,
): string {
  const resolveField = (
    field:
      | "description"
      | "personality"
      | "backstory"
      | "appearance"
      | "scenario"
      | "example"
      | "systemPrompt"
      | "postHistoryInstructions",
  ): string => {
    const value = profile[field] ?? "";
    return value && depth < 4 ? resolveGameCharacterCardMacros(value, profile, baseContext, depth + 1) : "";
  };
  const profileName = normalizeTextForMatch(profile.name);
  const group = (baseContext.groupCharacters ?? baseContext.characters)
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && normalizeTextForMatch(name) !== profileName)
    .join(", ");

  return template
    .replace(/\{\{\s*char(?:Name)?\s*\}\}/gi, () => profile.name)
    .replace(/\{\{\s*char(?:Name)?Phonetic\s*\}\}/gi, () => profile.phoneticName ?? profile.name)
    .replace(/\{\{\s*group\s*\}\}/gi, () => group)
    .replace(/\{\{\s*description\s*\}\}/gi, () => resolveField("description"))
    .replace(/\{\{\s*personality\s*\}\}/gi, () => resolveField("personality"))
    .replace(/\{\{\s*backstory\s*\}\}/gi, () => resolveField("backstory"))
    .replace(/\{\{\s*appearance\s*\}\}/gi, () => resolveField("appearance"))
    .replace(/\{\{\s*scenario\s*\}\}/gi, () => resolveField("scenario"))
    .replace(/\{\{\s*example\s*\}\}/gi, () => resolveField("example"))
    .replace(/\{\{\s*charSysInfo\s*\}\}/gi, () => resolveField("systemPrompt"))
    .replace(/\{\{\s*charPostHistory\s*\}\}/gi, () => resolveField("postHistoryInstructions"));
}

/** Build the user-owned player canon shared by the live GM and continuity writers. */
export function buildPlayerPersonaCanonText(persona: any, gameCard?: Record<string, unknown>): string | null {
  if (!persona) return null;
  const parts = [`Name: ${persona.name || "Player"}`];
  const description = cardPromptText(persona.description);
  const personality = cardPromptText(persona.personality);
  const backstory = cardPromptText(persona.backstory);
  const appearance = cardPromptText(persona.appearance);
  if (description) parts.push(`Description: ${description}`);
  if (personality) parts.push(`Personality: ${personality}`);
  if (backstory) parts.push(`Backstory: ${backstory}`);
  if (appearance) parts.push(`Appearance: ${appearance}`);
  // Generated game cards may contribute mechanics, but never generated interpretations of
  // the player's personality, morality, strengths, weaknesses, or motives.
  appendGameCardDetails(parts, gameCard, { includeInterpretiveFields: false });
  return parts.join("\n");
}

export async function injectGameGmPromptRuntime(args: {
  /** The live app database. Omit only for callers that intentionally disable campaign memory. */
  db?: DB;
  messages: PromptMessage[];
  chatId: string;
  chat: ChatLike;
  chatMetadata: Record<string, unknown>;
  characterIds: string[];
  chars: CharactersStore;
  chats: ChatsStore;
  selectedGameStateSnapshotPromise: Promise<any | null>;
  mappedMessages: PromptMappedMessage[];
  personaName: string;
  resolvePromptMacros(value: string): string;
  resolveCharacterPromptMacros(value: string, profile: CharacterMacroProfile): string;
  cacheFriendlyLayout?: boolean;
  /** Replay already caches carried updates; avoid counting that text as uncached rent. */
  preserveReplayPrefix?: boolean;
  campaignMemoryMaxCharacters?: number;
  /** Only live current requests may read the latest durable campaign memory. */
  campaignMemoryRequestMode?: "live-current";
}): Promise<GameGmPromptRuntime> {
  const setupConfig =
    args.chatMetadata.gameSetupConfig &&
    typeof args.chatMetadata.gameSetupConfig === "object" &&
    !Array.isArray(args.chatMetadata.gameSetupConfig)
      ? (args.chatMetadata.gameSetupConfig as Record<string, unknown>)
      : null;
  const roomGeneration = currentRoomGeneration();
  const approvedRoomCharacterIds = new Set(roomGeneration?.characterIds ?? []);
  const mayLoadCharacter = (id: string) => !roomGeneration || approvedRoomCharacterIds.has(id);

  const gameActiveState = (args.chatMetadata.gameActiveState as string) || "exploration";
  const sessionNumber = (args.chatMetadata.gameSessionNumber as number) || 1;
  const storyArc = (args.chatMetadata.gameStoryArc as string) || null;
  const plotTwists = Array.isArray(args.chatMetadata.gamePlotTwists)
    ? (args.chatMetadata.gamePlotTwists as string[])
    : null;
  const gameBlueprint =
    args.chatMetadata.gameBlueprint &&
    typeof args.chatMetadata.gameBlueprint === "object" &&
    !Array.isArray(args.chatMetadata.gameBlueprint)
      ? (args.chatMetadata.gameBlueprint as { campaignPlan?: GameCampaignPlan; hudWidgets?: unknown })
      : null;
  const gameMap = (args.chatMetadata.gameMap as GameMap) || null;
  const gameNpcs = Array.isArray(args.chatMetadata.gameNpcs) ? (args.chatMetadata.gameNpcs as GameNpc[]) : [];
  const storedSessionSummaries = Array.isArray(args.chatMetadata.gamePreviousSessionSummaries)
    ? (args.chatMetadata.gamePreviousSessionSummaries as SessionSummary[])
    : [];
  const sessionSummaries = limitGameGmSessionSummaries(
    storedSessionSummaries,
    args.chatMetadata.gamePromptRecentSessionLimit,
  );
  const playerNotes =
    typeof args.chatMetadata.gamePlayerNotes === "string" ? args.chatMetadata.gamePlayerNotes.trim() : undefined;

  let gmCharacterCard: string | null = null;
  const gmCharId = args.chatMetadata.gameGmCharacterId as string | null;
  if (gmCharId && mayLoadCharacter(gmCharId)) {
    try {
      const gmChar = await args.chars.getById(gmCharId);
      if (gmChar) {
        const gmData = parseMaybeJson(gmChar.data) as any;
        const { parts, macroProfile } = buildLibraryCardParts(gmData);
        gmCharacterCard = args.resolveCharacterPromptMacros(parts.join("\n"), macroProfile);
      }
    } catch {
      /* ignore */
    }
  }

  const partyCharIds = Array.isArray(args.chatMetadata.gamePartyCharacterIds)
    ? (args.chatMetadata.gamePartyCharacterIds as string[])
    : args.characterIds;
  const partyNames: string[] = [];
  const partyCards: Array<{ name: string; card: string }> = [];
  const partyCardReferences: Array<{ name: string; card: string }> = [];
  const partyCardRuntime: Array<{ name: string; card: string }> = [];
  const partyCardIds: string[] = [];
  const partyCardReferenceIds: string[] = [];
  const partyCardRuntimeIds: string[] = [];
  const partyIdNamePairs: Array<{ id: string; name: string }> = [];
  const gameCharCards = Array.isArray(args.chatMetadata.gameCharacterCards)
    ? (args.chatMetadata.gameCharacterCards as Array<Record<string, unknown>>)
    : [];
  const gameCardByName = new Map<string, Record<string, unknown>>();
  for (const card of gameCharCards) {
    if (card.name) gameCardByName.set(normalizeTextForMatch(card.name), card);
  }

  for (const pcId of partyCharIds) {
    if (isPartyNpcId(pcId)) continue;
    if (!mayLoadCharacter(pcId)) continue;

    try {
      const pc = await args.chars.getById(pcId);
      if (pc) {
        const pcData = parseMaybeJson(pc.data) as any;
        const { name, parts, macroProfile } = buildLibraryCardParts(pcData);
        partyNames.push(name);
        partyIdNamePairs.push({ id: pcId, name });
        const gameCard = gameCardByName.get(normalizeTextForMatch(name));
        const referenceParts = [...parts];
        appendGameCardDetails(parts, gameCard);
        const runtimeParts = [`Name: ${name}`];
        appendGameCardDetails(runtimeParts, gameCard);
        partyCardReferences.push({
          name,
          card: args.resolveCharacterPromptMacros(referenceParts.join("\n"), macroProfile),
        });
        partyCardReferenceIds.push(pcId);
        partyCardRuntime.push({
          name,
          card: args.resolveCharacterPromptMacros(runtimeParts.join("\n"), macroProfile),
        });
        partyCardRuntimeIds.push(pcId);
        partyCards.push({
          name,
          card: args.resolveCharacterPromptMacros(parts.join("\n"), macroProfile),
        });
        partyCardIds.push(pcId);
      }
    } catch {
      /* ignore */
    }
  }

  for (const npcId of partyCharIds) {
    if (!isPartyNpcId(npcId)) continue;
    const npc = findGameNpcByNameDerivedId(npcId, gameNpcs, (candidate) => candidate.name);
    if (!npc) continue;
    const name = npc.name || "Unknown";
    partyNames.push(name);
    partyIdNamePairs.push({ id: npcId, name });
    const parts = [`Name: ${name}`, "Source: Tracked NPC companion, not a character-library card"];
    if (npc.description) parts.push(`Description: ${npc.description}`);
    if (npc.location) parts.push(`Last Known Location: ${npc.location}`);
    if (npc.notes?.length) parts.push(`Notes: ${npc.notes.join("; ")}`);
    appendGameCardDetails(parts, gameCardByName.get(normalizeTextForMatch(name)));
    partyCardRuntime.push({
      name,
      card: args.resolveCharacterPromptMacros(parts.join("\n"), trackedNpcMacroProfile(npc)),
    });
    partyCardRuntimeIds.push(npcId);
    partyCards.push({
      name,
      card: args.resolveCharacterPromptMacros(parts.join("\n"), trackedNpcMacroProfile(npc)),
    });
    partyCardIds.push(npcId);
  }

  if (args.chatMetadata.gamePromptFocusedCharacterReferences === true) {
    let presentCharacters: unknown = null;
    let snapshotFailed = false;
    try {
      presentCharacters = (await args.selectedGameStateSnapshotPromise)?.presentCharacters;
      presentCharacters = parseMaybeJson(presentCharacters);
    } catch (error) {
      snapshotFailed = true;
      logger.warn(
        error,
        "Focused Game GM references could not read the selected game-state snapshot; retaining all party details",
      );
    }
    const focusedIds = selectFocusedGamePartyIds({
      party: partyIdNamePairs,
      presentCharacters,
      mappedMessages: args.mappedMessages,
    });
    if (!snapshotFailed && focusedIds.size > 0) {
      const filterById = <T>(entries: T[], ids: string[]) =>
        entries.filter((_, index) => focusedIds.has(ids[index] ?? ""));
      partyCards.splice(0, partyCards.length, ...filterById(partyCards, partyCardIds));
      partyCardReferences.splice(
        0,
        partyCardReferences.length,
        ...filterById(partyCardReferences, partyCardReferenceIds),
      );
      partyCardRuntime.splice(0, partyCardRuntime.length, ...filterById(partyCardRuntime, partyCardRuntimeIds));
    }
  }

  // Library cards for anyone the session has named who is not in the party: NPCs, candidates, visitors.
  // Without this the GM only has a name and invents race, age and looks.
  let sceneCharacterCards: Array<{ name: string; card: string }> = [];
  let sceneCharacterCardUpdates: Array<{ name: string; card: string }> = [];
  let sceneCharacterCardUpdatesFrozen = false;
  if (
    args.chatMetadata.gameSceneCharacterCards !== false &&
    (roomGeneration || typeof args.chars.list === "function")
  ) {
    try {
      const rows: Array<{ id: string; data: unknown }> = [];
      if (roomGeneration) {
        for (const id of approvedRoomCharacterIds) {
          const card = await args.chars.getById(id);
          if (card) rows.push({ id, data: card.data });
        }
      } else {
        rows.push(...(await args.chars.list!()));
      }
      const library: Array<{ id: string; name: string; data: any }> = [];
      for (const row of rows) {
        const data = parseMaybeJson(row.data) as any;
        const name = typeof data?.name === "string" ? data.name.trim() : "";
        if (name) library.push({ id: row.id, name, data });
      }
      const texts = args.mappedMessages
        .filter((message) => message.contextKind === undefined || message.contextKind === "history")
        .map((message) => (typeof message.content === "string" ? message.content : ""));
      try {
        const present = parseMaybeJson((await args.selectedGameStateSnapshotPromise)?.presentCharacters);
        if (Array.isArray(present)) {
          for (const entry of present) {
            const name = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : null;
            if (typeof name === "string") texts.push(name);
          }
        }
      } catch {
        /* presence is optional */
      }
      const ids = selectSceneCharacterCardIds({
        library,
        excludedIds: [...partyCharIds, ...(gmCharId ? [gmCharId] : [])],
        excludedNames: [args.personaName, ...partyNames],
        texts,
      });
      const byId = new Map(library.map((entry) => [entry.id, entry]));
      const current: NamedCard[] = [];
      for (const id of ids) {
        const entry = byId.get(id);
        if (!entry) continue;
        const { card, macroProfile } = buildSceneCharacterCardText(entry.data);
        current.push({ id, name: entry.name, card: args.resolveCharacterPromptMacros(card, macroProfile) });
      }
      if (args.cacheFriendlyLayout) {
        // Cached cards keep the exact text they were cached with; new people and rewritten cards ride uncached.
        // Settings > Features "Session-frozen NPC cards": cached cards stay frozen for the session and later changes
        // ride uncached as changed lines, folded in at the next session or once they cost more than a rebuild.
        const freeze = isFeatureEnabled("gameFreezeNpcCardsPerSession")
          ? (() => {
              const history = args.mappedMessages.filter((message) => message.contextKind === "history");
              return {
                sessionKey: String(sessionNumber),
                preserveReplayPrefix: args.preserveReplayPrefix === true,
                turnKey: history.length,
                suffixChars: history.reduce(
                  (sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0),
                  0,
                ),
              };
            })()
          : undefined;
        const layout = await layoutNamedCards(args.chatId, current, freeze);
        sceneCharacterCards = layout.stable.map(({ name, card }) => ({ name, card }));
        sceneCharacterCardUpdates = layout.updates.map(({ name, card }) => ({ name, card }));
        if (freeze) sceneCharacterCardUpdatesFrozen = true;
      } else {
        sceneCharacterCards = current.map(({ name, card }) => ({ name, card }));
      }
    } catch (error) {
      logger.warn(error, "Scene character cards could not be read; continuing without them");
    }
  }

  let playerCard: string | null = null;
  const playerPersonaId = (args.chat.personaId || setupConfig?.personaId) as string | null | undefined;
  const roomPersona = roomHostIdentity();
  if (playerPersonaId || roomPersona) {
    try {
      const persona = roomPersona ?? (await args.chars.getPersona(playerPersonaId!));
      if (persona) {
        playerCard = buildPlayerPersonaCanonText(persona, gameCardByName.get(normalizeTextForMatch(persona.name)));
      }
    } catch {
      /* ignore */
    }
  }

  for (const participant of currentRoomGeneration()?.participants ?? []) {
    if (participant.isHost) continue;
    const name = participant.persona.name;
    const parts = [
      `Name: ${name}`,
      "Human-controlled persona: only this participant may choose their actions or dialogue.",
      participant.persona.description,
    ];
    appendGameCardDetails(parts, gameCardByName.get(normalizeTextForMatch(name)));
    partyNames.push(name);
    partyIdNamePairs.push({ id: participant.id, name });
    partyCards.push({ name, card: parts.join("\n") });
  }

  let weatherContext: string | undefined;
  let gameTime: string | undefined;
  try {
    const snap = await args.selectedGameStateSnapshotPromise;
    if (snap) {
      if (snap.weather)
        weatherContext = `Current weather: ${snap.weather}${snap.temperature ? `, ${snap.temperature}` : ""}`;
    }
    // Byte-identical "date, time" without a calendar; with one, its date line replaces the free-text date.
    gameTime = composeGameTimeLine(snap, args.chatMetadata);
  } catch {
    /* ignore */
  }

  const sceneConnectionId = (setupConfig?.sceneConnectionId as string) || null;
  const sidecarCfg = sidecarModelService.getConfig();
  const sidecarHandlesScene = sidecarCfg.useForGameScene && (await isSidecarInferenceAvailable());
  const hasSceneModel = !!sceneConnectionId || sidecarHandlesScene;
  const gameTurnNumber = args.mappedMessages.filter((message) => message.role === "user").length + 1;

  const combatSnapshot =
    args.chatMetadata.gameCombatState &&
    typeof args.chatMetadata.gameCombatState === "object" &&
    !Array.isArray(args.chatMetadata.gameCombatState)
      ? (args.chatMetadata.gameCombatState as Record<string, unknown>)
      : null;
  const snapshotCombatStyle = combatSnapshot?.combatStyle;
  const pinnedCombatStyle =
    gameActiveState === "combat" && (snapshotCombatStyle === "classic" || snapshotCombatStyle === "tactical")
      ? snapshotCombatStyle
      : null;
  const legacyTacticalCombatStyle =
    gameActiveState === "combat" &&
    !pinnedCombatStyle &&
    args.chatMetadata.gameTacticalCombatSnapshot &&
    typeof args.chatMetadata.gameTacticalCombatSnapshot === "object" &&
    !Array.isArray(args.chatMetadata.gameTacticalCombatSnapshot)
      ? "tactical"
      : null;
  const resolvedCombatStyle =
    pinnedCombatStyle ??
    legacyTacticalCombatStyle ??
    ((args.chatMetadata.gameCombatStyle as string) || (setupConfig?.combatStyle as string) || "classic");

  const lastMapPos = args.chatMetadata.lastMapPosition as string | { x: number; y: number } | undefined;
  const currentMapPos = gameMap?.partyPosition;
  const playerMoved = !lastMapPos || !currentMapPos || JSON.stringify(lastMapPos) !== JSON.stringify(currentMapPos);
  if (currentMapPos && JSON.stringify(lastMapPos) !== JSON.stringify(currentMapPos)) {
    args.chatMetadata.lastMapPosition = currentMapPos;
    const freshChat = await args.chats.getById(args.chatId);
    const freshMeta = freshChat ? parseExtra(freshChat.metadata) : args.chatMetadata;
    await args.chats.updateMetadata(args.chatId, { ...freshMeta, lastMapPosition: currentMapPos });
  }

  let perceptionHintsBlock: string | undefined;
  try {
    const latestSnapshot = await args.selectedGameStateSnapshotPromise;
    const parsedPlayerStats = latestSnapshot?.playerStats ? parseMaybeJson(latestSnapshot.playerStats) : null;
    const playerStats =
      parsedPlayerStats && typeof parsedPlayerStats === "object" && !Array.isArray(parsedPlayerStats)
        ? (parsedPlayerStats as Record<string, any>)
        : null;
    if (playerStats) {
      const parsedPresentCharacters = latestSnapshot?.presentCharacters
        ? parseMaybeJson(latestSnapshot.presentCharacters)
        : null;
      const presentNpcs = Array.isArray(parsedPresentCharacters)
        ? parsedPresentCharacters
            .map((character: { name?: string }) => character.name)
            .filter((name): name is string => typeof name === "string" && name.length > 0)
        : [];
      const perceptionContext: PerceptionContext = {
        perceptionMod: playerStats.skills?.Perception ?? playerStats.skills?.perception ?? 0,
        wisdomScore: playerStats.attributes?.wis ?? 10,
        gameState: gameActiveState,
        location: latestSnapshot?.location ?? null,
        weather: latestSnapshot?.weather ?? null,
        timeOfDay: latestSnapshot?.time ?? null,
        presentNpcNames: presentNpcs,
      };
      const hints = generatePerceptionHints(perceptionContext);
      if (hints.length > 0) {
        perceptionHintsBlock = formatPerceptionHints(hints);
      }
    }
  } catch {
    /* non-fatal */
  }

  const gmCtx: GmPromptContext = {
    gameActiveState: gameActiveState as GameActiveState,
    storyArc,
    plotTwists,
    map: gameMap,
    npcs: gameNpcs,
    sessionSummaries,
    sessionNumber,
    partyNames,
    partyCards,
    partyCardReferences,
    partyCardRuntime,
    sceneCharacterCards,
    sceneCharacterCardUpdates,
    ...(sceneCharacterCardUpdatesFrozen ? { sceneCharacterCardUpdatesFrozen: true } : {}),
    playerName: args.personaName,
    playerCard,
    gmCharacterCard,
    difficulty: (setupConfig?.difficulty as string) || "normal",
    // An active encounter keeps the style it started with. Legacy snapshots did
    // not store that pin, so an existing tactical state is the next-best proof.
    // Outside combat, the runtime drawer remains the preference for the next battle.
    combatStyle: resolvedCombatStyle,
    tacticalBattlefieldContext:
      gameActiveState === "combat" && resolvedCombatStyle === "tactical"
        ? summarizeTacticalBattlefield(args.chatMetadata.gameTacticalCombatSnapshot)
        : undefined,
    genre: (setupConfig?.genre as string) || "fantasy",
    setting: (setupConfig?.setting as string) || "original",
    tone: (setupConfig?.tone as string) || "balanced",
    rating: (setupConfig?.rating as "sfw" | "nsfw") || "sfw",
    enableQuickTimeEvents: setupConfig?.enableQuickTimeEvents !== false,
    campaignPlan: gameBlueprint?.campaignPlan ?? null,
    canGenerateBackgrounds:
      !!args.chatMetadata.enableSpriteGeneration &&
      args.chatMetadata.gameImageAutoGenerationEnabled !== false &&
      args.chatMetadata.gameStoryboardViewerDisplayMode !== "background" &&
      !!args.chatMetadata.gameImageConnectionId,
    artStylePrompt: resolveGameSetupArtStylePrompt(setupConfig) || undefined,
    gameTime,
    weatherContext,
    playerNotes,
    enableCustomWidgets:
      args.chatMetadata.enableCustomWidgets !== false &&
      (args.chatMetadata.gameSetupConfig as { enableCustomWidgets?: boolean } | undefined)?.enableCustomWidgets !==
        false,
    enableExtendedWidgets: isGameExtendedWidgetsEnabled(args.chatMetadata),
    hudWidgets: Array.isArray(args.chatMetadata.gameWidgetState)
      ? (args.chatMetadata.gameWidgetState as any[])
      : Array.isArray(gameBlueprint?.hudWidgets)
        ? (gameBlueprint.hudWidgets as any[])
        : undefined,
    hasSceneModel,
    playerMoved,
    turnNumber: gameTurnNumber,
    perceptionHints: perceptionHintsBlock,
    moraleContext: (() => {
      const morale = (args.chatMetadata.gameMorale as number) ?? 50;
      const tier = getMoraleTier(morale);
      return formatMoraleContext({ value: morale, tier });
    })(),
    characterSprites: listPartySprites(partyIdNamePairs),
    language: (setupConfig?.language as string) || undefined,
    gameSystemPrompt: resolveGameGmPromptTemplate(args.chatMetadata, setupConfig),
    gameSpecialInstructions:
      typeof args.chatMetadata.gameSpecialInstructions === "string"
        ? args.chatMetadata.gameSpecialInstructions.trim()
        : null,
  };

  const builtGmPromptParts = buildGmSystemPromptParts(gmCtx, { cacheFriendly: args.cacheFriendlyLayout === true });
  const promptTextReplacements = parseGamePromptTextReplacements(args.chatMetadata.gamePromptTextReplacements) ?? [];
  // Edit GM-owned blocks before they are assembled with lore, memory or other
  // producer-owned context. Never run a broad replacement over the final prompt.
  const gmPromptParts = {
    ...builtGmPromptParts,
    stable: replaceGamePromptText(builtGmPromptParts.stable, promptTextReplacements),
    dynamic: replaceGamePromptText(builtGmPromptParts.dynamic, promptTextReplacements),
    reference: builtGmPromptParts.reference
      ? replaceGamePromptText(builtGmPromptParts.reference, promptTextReplacements)
      : undefined,
    referenceBlocks: builtGmPromptParts.referenceBlocks?.map((block) =>
      replaceGamePromptText(block, promptTextReplacements),
    ),
  };
  const customGmPrompt =
    typeof args.chatMetadata.customGmPrompt === "string" ? args.chatMetadata.customGmPrompt.trim() : "";
  if (!args.cacheFriendlyLayout) {
    const fullGmPrompt = args.resolvePromptMacros(
      customGmPrompt
        ? `${gmPromptParts.stable}\n${gmPromptParts.dynamic}\n\n${customGmPrompt}`
        : `${gmPromptParts.stable}\n${gmPromptParts.dynamic}`,
    );
    const sysIdx = args.messages.findIndex((message) => message.role === "system");
    if (sysIdx >= 0) {
      args.messages[sysIdx] = { role: "system", content: fullGmPrompt };
    } else {
      args.messages.unshift({ role: "system", content: fullGmPrompt });
    }
  } else {
    // Remove only GM-owned blocks from a repeated runtime pass. Other marked
    // runtime context (memory, spatial state, lore, etc.) must remain intact.
    const replacingGm = args.messages.some(
      (message) =>
        message.providerMetadata?.marinaraGmStable === true ||
        message.providerMetadata?.marinaraGmDynamic === true ||
        message.providerMetadata?.marinaraGmReference === true,
    );
    for (let index = args.messages.length - 1; index >= 0; index -= 1) {
      const metadata = args.messages[index]?.providerMetadata;
      if (
        metadata?.marinaraGmStable === true ||
        metadata?.marinaraGmDynamic === true ||
        metadata?.marinaraGmReference === true
      ) {
        args.messages.splice(index, 1);
      }
    }

    const stableGmPrompt = args.resolvePromptMacros(gmPromptParts.stable);
    const dynamicStableGmPrompt = hasPromptMacroSyntax(gmPromptParts.stable);
    const dynamicTail = customGmPrompt ? `${gmPromptParts.dynamic}\n\n${customGmPrompt}` : gmPromptParts.dynamic;
    const dynamicGmPrompt = args.resolvePromptMacros(dynamicTail);
    const referenceGmPrompts = (
      gmPromptParts.referenceBlocks ?? (gmPromptParts.reference ? [gmPromptParts.reference] : [])
    ).map((reference) => ({
      content: args.resolvePromptMacros(reference),
      volatile: hasUnstableReferenceMacroSyntax(reference),
    }));
    const replacementIdx = replacingGm
      ? -1
      : args.messages.findIndex(
          (message) =>
            message.role === "system" &&
            message.providerMetadata?.marinaraRuntimeContext !== true &&
            message.providerMetadata?.marinaraFullLoreContext !== true &&
            message.providerMetadata?.marinaraDynamicLoreContext !== true,
        );
    const stableMessage: PromptMessage = {
      role: "system",
      content: stableGmPrompt,
      // Macro-bearing GM rules still have system authority. Mark their cache
      // boundary without relocating the role/card instructions into user history.
      contextKind: "prompt",
      providerMetadata: dynamicStableGmPrompt
        ? { marinaraRuntimeContext: true, marinaraGmDynamic: true }
        : { marinaraGmStable: true },
    };
    if (replacementIdx >= 0) args.messages.splice(replacementIdx, 1);
    args.messages.unshift(stableMessage);
    if (dynamicGmPrompt) {
      const stableIdx = args.messages.indexOf(stableMessage);
      args.messages.splice(stableIdx + 1, 0, {
        role: "system",
        content: dynamicGmPrompt,
        contextKind: "injection",
        // This is an app-owned, per-turn snapshot. The replay helper requires
        // both this trust marker and the runtime boundary before archiving it.
        providerMetadata: {
          marinaraRuntimeContext: true,
          marinaraGmDynamic: true,
          marinaraPromptHistoryReplaySnapshot: true,
        },
      });
    }
    for (const referenceGmPrompt of referenceGmPrompts) {
      if (!referenceGmPrompt.content) continue;
      args.messages.push({
        role: "system",
        content: referenceGmPrompt.content,
        contextKind: "injection",
        providerMetadata: {
          marinaraGmReference: true,
          ...(referenceGmPrompt.volatile ? { marinaraRuntimeContext: true } : {}),
        },
      });
    }
  }

  // The runtime does not have a trustworthy current-message order key: mappedMessages
  // intentionally carries only roles. Therefore this live request uses current storage
  // contents without a historical cutoff. Historical replay callers must supply their own
  // verified projection instead of guessing an ISO/id ordering key here.
  if (args.db && args.campaignMemoryRequestMode === "live-current") {
    try {
      // Presence reuses the same authoritative snapshot as the isolated actor path:
      // stable character ids only, never names. An unreadable snapshot leaves
      // presence unknown so the boundary fails closed to GM-only.
      let presence: { characterIds: string[]; personaId: string | null } | undefined;
      try {
        const snapshot = await args.selectedGameStateSnapshotPromise;
        const presentCharacters = parseMaybeJson(snapshot?.presentCharacters);
        presence = {
          characterIds: Array.isArray(presentCharacters)
            ? presentCharacters
                .map((entry: { characterId?: unknown }) =>
                  typeof entry?.characterId === "string" ? entry.characterId.trim() : "",
                )
                .filter(Boolean)
            : [],
          personaId: typeof playerPersonaId === "string" && playerPersonaId ? playerPersonaId : null,
        };
      } catch {
        presence = undefined;
      }
      const campaignMemory = await buildCampaignMemoryContextFromStorage(args.db, {
        chatId: args.chatId,
        audience: { kind: "gm" },
        ...(presence ? { presence } : {}),
        dedupeContinuityReceipts: true,
        // The player's message and the latest turns decide which people and places the memory block leads with.
        focusTexts: args.mappedMessages
          .filter((message) => message.contextKind === undefined || message.contextKind === "history")
          .slice(-4)
          .map((message) => (typeof message.content === "string" ? message.content : "")),
        maxCharacters:
          typeof args.chatMetadata.gameCampaignMemoryMaxCharacters === "number" &&
          args.chatMetadata.gameCampaignMemoryMaxCharacters > 0
            ? args.chatMetadata.gameCampaignMemoryMaxCharacters
            : (args.campaignMemoryMaxCharacters ?? DEFAULT_CAMPAIGN_MEMORY_MAX_CHARACTERS),
      });
      appendGameGmCampaignMemory(args.messages, campaignMemory, promptTextReplacements);
    } catch (err) {
      logger.error(
        {
          event: "prompt.campaign_memory.unavailable",
          outcome: "failed",
          errorCode: "CAMPAIGN_MEMORY_PROJECTION_UNAVAILABLE",
          chatId: args.chatId,
          err,
        },
        "Campaign memory projection unavailable; preserving the existing GM prompt",
      );
      appendGameGmCampaignMemory(
        args.messages,
        {
          text: "[Campaign memory unavailable: canonical campaign memory was not validated for this request. Do not treat absent campaign memory as proof that no memory exists.]",
          includedIds: [],
          exclusions: [{ id: "campaign-memory", reason: "projection unavailable" }],
          degraded: true,
        },
        promptTextReplacements,
      );
    }
  }

  return {
    gmCtx,
    gameActiveState,
    sessionNumber,
    gameTurnNumber,
    gameTime,
    gameMap,
    hasSceneModel,
  };
}
