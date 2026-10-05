import { currentRoomGeneration, roomHostIdentity } from "../multiplayer/generation-policy.js";
import { isCampaignSurfaceEnabled } from "../features/campaign-surface-opt-in.js";
import {
  GAME_GM_BUILT_IN_PROMPT_TEMPLATES,
  composeGameTimeLine,
  isGameExtendedWidgetsEnabled,
  normalizeAgentPromptTemplateOptions,
  normalizeTextForMatch,
  resolveGameSetupArtStylePrompt,
  summarizeTacticalBattlefield,
  type GameActiveState,
  type GameCampaignPlan,
  type GameMap,
  type GameNpc,
  type SessionSummary,
} from "@marinara-engine/shared";
import { isFeatureEnabled } from "../features/feature-settings.js";
import { buildGmSystemPrompt, type GmPromptContext } from "../game/gm-prompts.js";
import { listPartySprites } from "../game/sprite.service.js";
import { generatePerceptionHints, formatPerceptionHints, type PerceptionContext } from "../game/perception.service.js";
import { getMoraleTier, formatMoraleContext } from "../game/morale.service.js";
import { sidecarModelService } from "../sidecar/sidecar-model.service.js";
import { isInferenceAvailable as isSidecarInferenceAvailable } from "../sidecar/sidecar-inference.service.js";
import { cardPromptText } from "../prompt/card-text.js";
import { buildPartyNpcId, isPartyNpcId } from "./game-party-utils.js";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { isCampaignMemoryRecallEnabled } from "../features/campaign-opt-in.js";
import {
  buildCampaignMemoryContextFromStorage,
  normalizeCampaignMemoryMaxCharacters,
  type CampaignMemoryContextResult,
} from "../game/campaign-memory-context.js";
export { DEFAULT_CAMPAIGN_MEMORY_MAX_CHARACTERS } from "../game/campaign-memory-context.js";

type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  contextKind?: string;
  providerMetadata?: Record<string, unknown>;
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

export function formatGameGmMemoryOmissions(context: CampaignMemoryContextResult): string {
  const omissions = context.omissions ?? { budgetOmitted: 0, duplicatesMerged: 0, mergedIds: [] };
  return `[memory_omissions] ${omissions.budgetOmitted} records omitted for budget; ${omissions.duplicatesMerged} duplicates merged into continuity receipts`;
}

const GAME_GM_CAMPAIGN_MEMORY_PRECEDENCE =
  "Precedence: current state and verified facts in this block override any conflicting character card, persona, or lore text; when they conflict, use this block.";

export function appendGameGmCampaignMemory(
  messages: PromptMessage[],
  context: CampaignMemoryContextResult,
  cutoffOrder?: string,
): boolean {
  if (!context.text.trim() && !context.degraded) return false;
  const availability = context.degraded
    ? "Some campaign memory was excluded by validation or budget. Absence is not evidence that a fact never happened. Use current verified records over stale descriptions; respect each listed knowledge holder."
    : "These are current verified campaign records. World truth is not automatic character knowledge; only listed holders have the attributed knowledge.";
  const body = [
    GAME_GM_CAMPAIGN_MEMORY_PRECEDENCE,
    availability,
    context.text,
    formatGameGmCharacterBoundary(context),
    formatGameGmMemoryOmissions(context),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
  messages.push({
    role: "system",
    content: `<campaign_memory audience="gm">\n${body}\n</campaign_memory>`,
    contextKind: "injection",
    providerMetadata: {
      marinaraPromptHistoryReplaySnapshot: true,
      marinaraRuntimeContext: true,
      marinaraCampaignMemory: {
        audience: "gm",
        includedIds: context.includedIds,
        exclusions: context.exclusions,
        degraded: context.degraded,
        cutoffOrder: cutoffOrder ?? null,
        characterBoundaries: context.characterBoundaries ?? null,
        omissions: context.omissions ?? null,
        precedence: "campaign-memory-over-cards",
        currentStateCount: context.currentStateCount ?? 0,
      },
    },
  });
  return true;
}

export function appendGameGmCampaignMemoryIfEnabled(
  messages: PromptMessage[],
  context: CampaignMemoryContextResult,
  cutoffOrder?: string,
): boolean {
  return isCampaignMemoryRecallEnabled() && appendGameGmCampaignMemory(messages, context, cutoffOrder);
}

/** Limit only what enters a future prompt; persisted session history is unchanged. */
export function limitGameGmSessionSummaries(summaries: SessionSummary[], limit: unknown): SessionSummary[] {
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) return summaries;
  if (summaries.length <= limit) return summaries;
  return [...summaries].sort((left, right) => left.sessionNumber - right.sessionNumber).slice(-limit);
}

export function projectGameGmSessionSummaries(
  summaries: SessionSummary[],
  limit: unknown,
): { summaries: SessionSummary[]; applied: boolean } {
  const projected = limitGameGmSessionSummaries(summaries, isFeatureEnabled("gameMemoryControls") ? limit : null);
  return { summaries: projected, applied: projected.length < summaries.length };
}

type CharactersStore = {
  getById(id: string): Promise<{ data: unknown } | null>;
  getPersona(id: string): Promise<any | null>;
};

type ChatsStore = {
  getById(id: string): Promise<{ metadata?: unknown } | null>;
  updateMetadata(chatId: string, metadata: Record<string, unknown>): Promise<unknown>;
};

type ChatLike = {
  personaId?: string | null;
};

export type GameGmPromptRuntime = {
  gmCtx: GmPromptContext;
  gameActiveState: string;
  sessionNumber: number;
  gameTurnNumber: number;
  gameTime: string | undefined;
  gameMap: GameMap | null;
  hasSceneModel: boolean;
  memoryControlsApplied: boolean;
  campaignMemoryApplied: boolean;
};

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

function appendGameCardDetails(parts: string[], card: Record<string, unknown> | undefined): void {
  if (!card) return;
  if (card.class) parts.push(`Class: ${card.class}`);
  if ((card.abilities as string[])?.length) parts.push(`Abilities: ${(card.abilities as string[]).join(", ")}`);
  if ((card.strengths as string[])?.length) parts.push(`Strengths: ${(card.strengths as string[]).join(", ")}`);
  if ((card.weaknesses as string[])?.length) parts.push(`Weaknesses: ${(card.weaknesses as string[]).join(", ")}`);
  const extra = card.extra as Record<string, string> | undefined;
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      parts.push(`${key}: ${value}`);
    }
  }
}

function buildLibraryCardParts(data: any, fallbackName = "Unknown"): { name: string; parts: string[] } {
  const name = data.name || fallbackName;
  const parts = [`Name: ${name}`];
  const personality = cardPromptText(data.personality);
  const description = cardPromptText(data.description);
  const backstory = cardPromptText(data.extensions?.backstory || data.backstory);
  const appearance = cardPromptText(data.extensions?.appearance || data.appearance);
  const systemPrompt = cardPromptText(data.system_prompt);
  if (description) parts.push(`Description: ${description}`);
  if (personality) parts.push(`Personality: ${personality}`);
  if (backstory) parts.push(`Backstory: ${backstory}`);
  if (appearance) parts.push(`Appearance: ${appearance}`);
  if (systemPrompt) parts.push(`Character System Instructions: ${systemPrompt}`);
  return { name, parts };
}

/** Cancel only a request that already incorporated the optional widget instructions. */
export async function assertExtendedWidgetDispatchAllowed(
  applied: boolean,
  loadChat: () => Promise<{ metadata: unknown } | null | undefined>,
): Promise<void> {
  if (!applied) return;
  const current = await loadChat();
  if (
    !current ||
    !isFeatureEnabled("extendedHudWidgets") ||
    !isGameExtendedWidgetsEnabled(parseExtra(current.metadata))
  ) {
    throw new Error("Extended HUD widgets were disabled before dispatch; retry the request.");
  }
}

export async function injectGameGmPromptRuntime(args: {
  db?: DB;
  campaignMemoryRequestMode?: "live-current";
  messages: PromptMessage[];
  chatId: string;
  chat: ChatLike;
  chatMetadata: Record<string, unknown>;
  characterIds: string[];
  chars: CharactersStore;
  chats: ChatsStore;
  selectedGameStateSnapshotPromise: Promise<any | null>;
  mappedMessages: Array<{ role: string; content?: unknown; contextKind?: string }>;
  personaName: string;
  resolvePromptMacros(value: string): string;
}): Promise<GameGmPromptRuntime> {
  const setupConfig =
    args.chatMetadata.gameSetupConfig &&
    typeof args.chatMetadata.gameSetupConfig === "object" &&
    !Array.isArray(args.chatMetadata.gameSetupConfig)
      ? (args.chatMetadata.gameSetupConfig as Record<string, unknown>)
      : null;
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
  const sessionSummaryProjection = projectGameGmSessionSummaries(
    storedSessionSummaries,
    args.chatMetadata.gamePromptRecentSessionLimit,
  );
  const sessionSummaries = sessionSummaryProjection.summaries;
  let campaignMemoryApplied = false;
  const playerNotes =
    typeof args.chatMetadata.gamePlayerNotes === "string" ? args.chatMetadata.gamePlayerNotes.trim() : undefined;

  let gmCharacterCard: string | null = null;
  const gmCharId = args.chatMetadata.gameGmCharacterId as string | null;
  if (gmCharId) {
    try {
      const gmChar = await args.chars.getById(gmCharId);
      if (gmChar) {
        const gmData = parseMaybeJson(gmChar.data) as any;
        const { parts } = buildLibraryCardParts(gmData);
        gmCharacterCard = parts.join("\n");
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
    try {
      const pc = await args.chars.getById(pcId);
      if (pc) {
        const pcData = parseMaybeJson(pc.data) as any;
        const { name, parts } = buildLibraryCardParts(pcData);
        partyNames.push(name);
        partyIdNamePairs.push({ id: pcId, name });
        appendGameCardDetails(parts, gameCardByName.get(normalizeTextForMatch(name)));
        partyCards.push({ name, card: parts.join("\n") });
      }
    } catch {
      /* ignore */
    }
  }

  for (const npcId of partyCharIds) {
    if (!isPartyNpcId(npcId)) continue;
    const npc = gameNpcs.find((candidate) => buildPartyNpcId(candidate.name) === npcId);
    if (!npc) continue;
    const name = npc.name || "Unknown";
    partyNames.push(name);
    partyIdNamePairs.push({ id: npcId, name });
    const parts = [`Name: ${name}`, "Source: Tracked NPC companion, not a character-library card"];
    if (npc.description) parts.push(`Description: ${npc.description}`);
    if (npc.location) parts.push(`Last Known Location: ${npc.location}`);
    if (npc.notes?.length) parts.push(`Notes: ${npc.notes.join("; ")}`);
    appendGameCardDetails(parts, gameCardByName.get(normalizeTextForMatch(name)));
    partyCards.push({ name, card: parts.join("\n") });
  }

  let playerCard: string | null = null;
  const playerPersonaId = (args.chat.personaId || setupConfig?.personaId) as string | null | undefined;
  const roomPersona = roomHostIdentity();
  if (playerPersonaId || roomPersona) {
    try {
      const persona = roomPersona ?? (await args.chars.getPersona(playerPersonaId!));
      if (persona) {
        const parts = [`Name: ${persona.name}`];
        const description = cardPromptText(persona.description);
        const personality = cardPromptText(persona.personality);
        const backstory = cardPromptText(persona.backstory);
        const appearance = cardPromptText(persona.appearance);
        if (description) parts.push(`Description: ${description}`);
        if (personality) parts.push(`Personality: ${personality}`);
        if (backstory) parts.push(`Backstory: ${backstory}`);
        if (appearance) parts.push(`Appearance: ${appearance}`);
        appendGameCardDetails(parts, gameCardByName.get(normalizeTextForMatch(persona.name)));
        playerCard = parts.join("\n");
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
    const calendarMetadata = isCampaignSurfaceEnabled("gameCalendar")
      ? args.chatMetadata
      : { ...args.chatMetadata, gameCalendar: undefined };
    gameTime = composeGameTimeLine(snap, calendarMetadata);
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
      (setupConfig as { enableCustomWidgets?: boolean } | null)?.enableCustomWidgets !== false,
    enableExtendedWidgets: isFeatureEnabled("extendedHudWidgets") && isGameExtendedWidgetsEnabled(args.chatMetadata),
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

  const builtGmPrompt = buildGmSystemPrompt(gmCtx);
  const customGmPrompt =
    typeof args.chatMetadata.customGmPrompt === "string" ? args.chatMetadata.customGmPrompt.trim() : "";
  let fullGmPrompt = customGmPrompt ? `${builtGmPrompt}\n\n${customGmPrompt}` : builtGmPrompt;
  fullGmPrompt = args.resolvePromptMacros(fullGmPrompt);

  // Only a current request may read the latest durable projection. Historical callers use their explicit cutoff.
  if (args.db && args.campaignMemoryRequestMode === "live-current" && isCampaignMemoryRecallEnabled()) {
    try {
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
          personaId: typeof args.chat.personaId === "string" ? args.chat.personaId : null,
        };
      } catch {
        presence = undefined;
      }
      const campaignMemory = await buildCampaignMemoryContextFromStorage(args.db, {
        chatId: args.chatId,
        audience: { kind: "gm" },
        ...(presence ? { presence } : {}),
        dedupeContinuityReceipts: true,
        focusTexts: args.mappedMessages
          .filter((message) => message.contextKind === undefined || message.contextKind === "history")
          .slice(-4)
          .map((message) => (typeof message.content === "string" ? message.content : "")),
        maxCharacters: normalizeCampaignMemoryMaxCharacters(args.chatMetadata.gameCampaignMemoryMaxCharacters),
      });
      campaignMemoryApplied = appendGameGmCampaignMemoryIfEnabled(args.messages, campaignMemory);
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
      campaignMemoryApplied = appendGameGmCampaignMemoryIfEnabled(args.messages, {
        text: "[Campaign memory unavailable: canonical campaign memory was not validated for this request. Do not treat absent campaign memory as proof that no memory exists.]",
        includedIds: [],
        exclusions: [{ id: "campaign-memory", reason: "projection unavailable" }],
        degraded: true,
      });
    }
  }

  const sysIdx = args.messages.findIndex((message) => message.role === "system");
  if (sysIdx >= 0) {
    args.messages[sysIdx] = { role: "system", content: fullGmPrompt };
  } else {
    args.messages.unshift({ role: "system", content: fullGmPrompt });
  }

  return {
    gmCtx,
    gameActiveState,
    sessionNumber,
    gameTurnNumber,
    gameTime,
    gameMap,
    hasSceneModel,
    memoryControlsApplied: sessionSummaryProjection.applied,
    campaignMemoryApplied,
  };
}
