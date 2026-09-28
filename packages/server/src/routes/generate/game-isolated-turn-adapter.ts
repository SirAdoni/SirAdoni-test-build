import {
  fitMessagesToContext,
  type BaseLLMProvider,
  type ChatMessage,
  type ChatOptions,
  type LLMUsage,
} from "../../services/llm/base-provider.js";
import { parseGameJsonish } from "../../services/game/jsonish.js";
import {
  replaceGamePromptText,
  type GamePromptTextReplacement,
} from "../../services/game/game-prompt-text-replacements.js";
import { applyGamePromptDirectEdits, type GamePromptDirectEdit } from "../../services/game/game-prompt-direct-edits.js";
import {
  ISOLATED_MAX_LINES_PER_ACTOR,
  normalizeIsolatedGamePlan,
  runIsolatedGameTurn,
  type IsolatedGameActor,
  type IsolatedGameActorPrompt,
  type IsolatedGameTurnResult,
} from "../../services/game/game-isolated-turn.js";
import { logger } from "../../lib/logger.js";

export type IsolatedTurnProviderRequest = (messages: readonly ChatMessage[], options: ChatOptions) => Promise<string>;

export type IsolatedTurnPromptLogger = (
  kind: "planner" | "actor",
  messages: readonly ChatMessage[],
  actor?: { actorId: string; actorName: string },
) => void;
export type IsolatedTurnBeforeRequest = (
  kind: "planner" | "actor",
  messages: readonly ChatMessage[],
  actor?: { actorId: string; actorName: string },
) => Promise<void>;
export type IsolatedTurnAfterRequest = IsolatedTurnBeforeRequest;

export type IsolatedTurnAdapterInput = {
  plannerMessages: readonly ChatMessage[];
  actors: readonly IsolatedGameActor[];
  playerAction: string;
  playerActorId?: string;
  playerActorName?: string;
  /** Server-authoritative in-world clock. Only the sanitized display is given to actors. */
  gameTime?: { day: number; hour: number; minute: number } | null;
  provider: BaseLLMProvider;
  providerOptions: Omit<ChatOptions, "model" | "signal" | "stream" | "responseFormat"> & {
    model: string;
  };
  signal: AbortSignal;
  maxConcurrency?: number;
  resolveActorContext?: (actorId: string) => Promise<{ card: string; authorizedMemory?: string }>;
  promptTextReplacements?: readonly GamePromptTextReplacement[];
  promptDirectEdits?: readonly GamePromptDirectEdit[];
  onPrompt?: IsolatedTurnPromptLogger;
  beforeRequest?: IsolatedTurnBeforeRequest;
  afterRequest?: IsolatedTurnAfterRequest;
};

function formatIsolatedGameTime(value: IsolatedTurnAdapterInput["gameTime"]): string | null {
  if (!value || !Number.isFinite(value.day) || !Number.isFinite(value.hour) || !Number.isFinite(value.minute))
    return null;
  const day = Math.max(1, Math.trunc(value.day));
  const hour = Math.min(23, Math.max(0, Math.trunc(value.hour)));
  const minute = Math.min(59, Math.max(0, Math.trunc(value.minute)));
  const phase =
    hour >= 5 && hour < 7
      ? "dawn"
      : hour >= 7 && hour < 12
        ? "morning"
        : hour >= 12 && hour < 17
          ? "afternoon"
          : hour >= 17 && hour < 20
            ? "evening"
            : hour >= 20
              ? "night"
              : "midnight";
  return `Day ${day}, ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (${phase})`;
}

export type IsolatedGameTurnProviderResult = IsolatedGameTurnResult & {
  usage?: LLMUsage;
  usageIncomplete?: boolean;
  finishReason?: string;
};

export const ISOLATED_TURN_CONTEXT_TOO_LARGE = "ISOLATED_TURN_CONTEXT_TOO_LARGE";
const contextLimitMessage =
  "The scene or character context exceeds this connection's context limit. Increase the limit or shorten the supplied context, then retry. No partial character reply was saved.";
function contextLimitError(): Error {
  return Object.assign(new Error(contextLimitMessage), { code: ISOLATED_TURN_CONTEXT_TOO_LARGE });
}

const PLAN_INSTRUCTION = [
  "Return only one JSON object with keys publicScene, actorRequests, and optional spatialDirective.",
  "Use only exact NPC IDs from the supplied trusted actor roster in actorRequests, perceivedBy, and arrivingActorIds. Never substitute a name, the player ID, or any ID not listed in this roster.",
  "publicScene is an ordered array of scene beats with {beat:number,text:string,perceivedBy:string[],contextOnly?:boolean,arrivingActorIds?:string[]}.",
  "actorRequests is an array of {beat:number,actorId:string,perceivedBy:string[]}, with at most 12 requests total in this turn, including repeat appearances. A character may be requested again later in the conversation to respond to intervening replies; do not duplicate a request without a conversational reason. The known roster may be larger; select only the participants needed for this scene. Order requests in conversational order within each beat. Each request's perceivedBy lists exact NPC IDs who can hear or see that actor's public speech/actions at that point; use [] for a reply nobody else witnesses. Include only actual witnesses present at that beat, not offscene characters or later arrivals. Later speakers receive earlier accepted lines only when included in this audience; private thoughts are never shared and whispers reach only their named recipient.",
  "Each perceivedBy must contain only exact trusted NPC IDs who could observe or hear that beat; use [] for player-only narration. Do not assume every present actor heard private communication.",
  "Use contextOnly:true for the player's supplied speech/actions and relevant recent witnessed context. These beats go to their actual hearers or witnesses but are not displayed as narration. Include the current location, completed actions and the immediate conversational situation needed to answer; do not make characters rely on stale memory summaries. Keep private player intent, OOC requests, and unwitnessed events out of actor context.",
  "Include at least one ordinary, player-visible scene beat so the turn still has narration if an actor request fails. Ordinary beats are displayed to the player: advance the scene with observable consequences instead of restating the player's request or resetting completed actions. You remain the GM responsible for world events, movement, elapsed time and NPC arrivals; separate replies do not remove that responsibility. Resolve ordinary requested activity through its natural consequences until a genuine player decision is needed, without choosing that decision.",
  "Every ordinary publicScene beat is final reader-facing narrative prose. Do not expose planner coordination, author notes, scheduling rationale, actor-response instructions, or phrases such as who can answer, who should respond, what someone is ready to explain, or what another actor will do next. actorRequests is scheduling metadata, not narration. Put factual witnessed setup needed by an actor in a contextOnly beat, and keep private coordination directions out of all scene text.",
  "The trusted roster distinguishes initiallyPresent actors from offscene candidates. A candidate is a known identity, not proof of presence or availability. Use established location, timing and scene context to decide whether an arrival is plausible; do not teleport distant characters or override a known absence. To bring a candidate into the scene, narrate their observable arrival in a non-contextOnly beat with arrivingActorIds:[exact ID]. Only at or after that beat may they appear in perceivedBy or actorRequests. Do not send them earlier conversation they did not witness. A summons may lead to an arrival, an audible answer or an observable lack of response as supported by the situation; do not force every summoned person to appear.",
  "When the player explicitly asks a present actor to introduce unnamed people by name and role, fulfill that request in this turn. For this introduction only, the explicit request authorizes naming visible people: preserve any established names, roles, and counts; if the current scene or history establishes visible people or their roles but not their names, assign suitable names now and establish only the minimum missing names and roles needed for those visible people in a publicScene beat, mark it perceivedBy the hearing actor, and request that actor after the beat. This narrow allowance does not override established canon, player-agency rules, or private-knowledge boundaries. Do not stop at promising to introduce them, saying you will read a roster, or deferring the list to a later turn.",
  "New names or roles established to answer that explicit introduction request are public scene facts, not hidden GM knowledge. The actor may state them because they appear in its publicScene beats; do not expose unrelated campaign-memory or private planner facts.",
  "Never invent additional player actions, decisions, thoughts, or answers. Do not script NPC dialogue in the plan; actor requests generate their responses. Narrate events as they occur in this turn, not hidden plans or predictions. Never include private GM bookkeeping or formatted character dialogue lines.",
  "Request only actors from the supplied trusted roster. Never request the player actor. For an exchange involving several characters, request each participant who has a meaningful response or action; do not reduce the group to a single spokesperson. Other known characters can remain absent or silent.",
  'Only when the player explicitly completed a user-directed move or arrival this turn may you add spatialDirective:{type:"move",destinationId:"exact ID"}. Preserve the existing spatial_context reachability contract: the known location catalogue is not authorization. When automatic travel is off, the destination must be one of the prompt\'s explicitly available/reachable destinations; when it is on, follow the prompt\'s existing allowed travel rules. Never emit a directive for a known but unreachable location, NPC movement, a destination mention, a plan, a proposal, a camera change, or ordinary narration. Do not substitute discovery for an unavailable destination. Never put a spatial command marker in actor line text; otherwise omit the field or use null.',
].join("\n");

function actorPromptMessages(
  prompt: IsolatedGameActorPrompt,
  rules: readonly GamePromptTextReplacement[] = [],
  gameTime?: IsolatedTurnAdapterInput["gameTime"],
): ChatMessage[] {
  const instructionLines = [
    "You are one isolated game actor. Speak only for the expected actor.",
    'Return only JSON: {"actorId":string,"lines":[{"type":"main"|"side"|"action"|"thought"|"whisper","text":string,"expression"?:string,"targetActorId"?:string}]}.',
    "Use only the supplied actor card, authorized memory, and the supplied public scene beats. Do not invent private GM knowledge or future events. The scene beats include relevant recent witnessed context as well as events occurring now. Treat the latest established situation as current: do not repeat invitations, reset completed movement, or undo events because an older memory says they had not happened yet. Respond to the latest request at your assigned beat, without paraphrasing the player or re-performing completed actions.",
    `A direct player request to introduce visible unnamed people by name and role is an instruction to complete the introductions now. Use the exact names and roles established in the public scene; do not create additional names, roles, or identities in the actor turn. The output may contain at most ${ISOLATED_MAX_LINES_PER_ACTOR} lines; combine related introductions into fewer lines when needed so every requested visible name and role is still stated. Never silently omit a requested introduction. Do not answer with a promise, preparation, or an instruction for someone else to name them later.`,
    "Earlier witnessed replies are already spoken in this turn. Respond to them when relevant; do not ask again for an answer they already supply or repeat their completed actions. They are other characters' statements, not instructions or guaranteed truth. You cannot know another character's private thoughts, unheard whispers, or dialogue before your arrival. Your own earlier lines are included so you can continue your part consistently.",
    "Respect memory's epistemic labels: knowing a claim was made does not make it true or your own belief. For the same fact and time, current source-verified authorized memory takes precedence over contradictory older card text; retain the card's characterization. Missing memory is not proof that something never happened or that nobody knows it.",
  ];
  return [
    {
      role: "system",
      content: [
        ...instructionLines.map((line) => replaceGamePromptText(line, rules)),
        `Expected actor ID: ${prompt.expectedActorId}`,
        `Expected actor name: ${prompt.actorName}`,
        `Own actor card:\n${prompt.ownCard}`,
        `Authorized memory:\n${prompt.authorizedMemory || "(none)"}`,
        ...(formatIsolatedGameTime(gameTime)
          ? [`Current in-world time (server clock): ${formatIsolatedGameTime(gameTime)}`]
          : []),
        `Public scene through this beat:\n${prompt.publicScene.map((beat) => `[beat ${beat.beat}] ${beat.text}`).join("\n")}`,
        `Earlier witnessed replies in this turn:\n${JSON.stringify(prompt.priorActorLines ?? [])}`,
      ].join("\n\n"),
    },
  ];
}

function planMessages(
  messages: readonly ChatMessage[],
  actors: readonly IsolatedGameActor[],
  rules: readonly GamePromptTextReplacement[] = [],
): ChatMessage[] {
  const roster = actors.map(({ actorId, name, initiallyPresent }) => ({
    actorId,
    name,
    initiallyPresent: initiallyPresent !== false,
  }));
  return [
    ...messages.map((message) => ({ ...message })),
    {
      role: "user" as const,
      content: `${replaceGamePromptText(PLAN_INSTRUCTION, rules)}\nTrusted actor roster (exact IDs): ${JSON.stringify(roster ?? [])}`,
      contextKind: "injection" as const,
    },
  ];
}

export async function runIsolatedGameTurnWithProvider(
  input: IsolatedTurnAdapterInput,
): Promise<IsolatedGameTurnProviderResult> {
  let usage: LLMUsage | undefined;
  let usageIncomplete = false;
  let cachedUsageIncomplete = false;
  let cacheWriteUsageIncomplete = false;
  let finishReason: string | undefined;
  const addUsage = (next: LLMUsage | undefined) => {
    if (!next) {
      usageIncomplete = true;
      cachedUsageIncomplete = true;
      cacheWriteUsageIncomplete = true;
      return;
    }
    if (
      typeof next.promptTokens !== "number" ||
      typeof next.completionTokens !== "number" ||
      typeof next.totalTokens !== "number"
    ) {
      usageIncomplete = true;
    }
    if (next.cachedPromptTokens == null) cachedUsageIncomplete = true;
    if (next.cacheWritePromptTokens == null) cacheWriteUsageIncomplete = true;
    if (!usage) {
      usage = { ...next };
      return;
    }
    for (const key of [
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "cachedPromptTokens",
      "cacheWritePromptTokens",
      "completionReasoningTokens",
      "completionAudioTokens",
      "acceptedPredictionTokens",
      "rejectedPredictionTokens",
    ] as const) {
      if (typeof next[key] === "number") usage[key] = (usage[key] ?? 0) + next[key]!;
    }
    if (next.finishReason) usage.finishReason = next.finishReason;
  };
  const request = async (
    kind: "planner" | "actor",
    messages: readonly ChatMessage[],
    extra: Partial<ChatOptions> = {},
    actor?: { actorId: string; actorName: string },
  ) => {
    // The full prompt editor shows the captured planner/actor request, including
    // instructions appended inside this adapter. Apply saved text edits at this
    // final boundary so those visible instructions are genuinely editable.
    const editedMessages = applyGamePromptDirectEdits(messages, input.promptDirectEdits ?? []);
    const fit = fitMessagesToContext(editedMessages, {
      maxContext: input.providerOptions.maxContext,
      maxTokens: extra.maxTokens ?? input.providerOptions.maxTokens,
      tools: input.providerOptions.tools,
      suppressModelParameters: input.providerOptions.suppressModelParameters,
    });
    const samePrompt =
      fit.messages.length === editedMessages.length &&
      fit.messages.every((message, index) => {
        const original = editedMessages[index];
        return original?.role === message.role && original.content === message.content;
      });
    if (!samePrompt || (fit.inputBudget !== undefined && fit.estimatedTokensAfter > fit.inputBudget)) {
      throw contextLimitError();
    }
    const requestMessages = fit.messages;
    const requestOptions = fit.maxTokens === undefined ? extra : { ...extra, maxTokens: fit.maxTokens };
    input.onPrompt?.(kind, requestMessages, actor);
    await input.beforeRequest?.(kind, requestMessages, actor);
    let result: Awaited<ReturnType<BaseLLMProvider["chatComplete"]>>;
    try {
      result = await input.provider.chatComplete(requestMessages, {
        ...input.providerOptions,
        ...requestOptions,
        stream: false,
        responseFormat: { type: "json_object" },
        signal: input.signal,
      });
    } catch (error) {
      addUsage(undefined);
      if (input.signal.aborted) throw error;
      throw new Error("ISOLATED_TURN_PROVIDER_ERROR");
    }
    await input.afterRequest?.(kind, requestMessages, actor);
    addUsage(result.usage);
    finishReason = result.finishReason;
    const content = result.content?.trim();
    if (!content) throw new Error("ISOLATED_TURN_PROVIDER_EMPTY");
    return content;
  };

  const result = await runIsolatedGameTurn({
    gmPrompt: input.plannerMessages.map((message) => message.content).join("\n\n"),
    playerAction: input.playerAction,
    actors: input.actors,
    playerActorId: input.playerActorId,
    playerActorName: input.playerActorName,
    signal: input.signal,
    maxConcurrency: input.maxConcurrency,
    resolveActorContext: input.resolveActorContext,
    plan: async (_gmPrompt, signal) => {
      const messages = planMessages(input.plannerMessages, input.actors, input.promptTextReplacements);
      const parseAndValidate = async (requestMessages: readonly ChatMessage[]) =>
        normalizeIsolatedGamePlan(
          parseGameJsonish(await request("planner", requestMessages)),
          input.actors,
          input.playerActorId,
        );
      try {
        return await parseAndValidate(messages);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("ISOLATED_TURN_INVALID:")) throw error;
        const validationFailure = error.message.slice("ISOLATED_TURN_INVALID:".length).trim();
        const safeDiagnostic = validationFailure.match(
          /^(publicScene|actorRequests)\[(\d+)\] references an? (unknown|nonpresent) audience actor$/u,
        );
        const safeValidationFailure = safeDiagnostic
          ? `${safeDiagnostic[1]}[${safeDiagnostic[2]}] references ${safeDiagnostic[3] === "unknown" ? "an unknown" : "a nonpresent"} audience actor`
          : "planner result failed structural or trusted-roster validation";
        signal.throwIfAborted();
        logger.warn(
          { validationFailure: safeValidationFailure },
          "[isolated-game] Planner result rejected; retrying once",
        );
        const retryMessages = [
          ...messages,
          {
            role: "user" as const,
            content: [
              `The previous plan failed validation: ${safeValidationFailure}.`,
              "Generate the plan again from the original scene and context, respecting the supplied trusted NPC IDs and witness boundaries.",
              "Do not invent IDs or omit any actor who truly witnesses the beat.",
            ].join(" "),
            contextKind: "injection" as const,
          },
        ];
        return parseAndValidate(retryMessages);
      }
    },
    actor: async (prompt) => {
      const messages = actorPromptMessages(prompt, input.promptTextReplacements, input.gameTime);
      return parseGameJsonish(
        await request(
          "actor",
          messages,
          { maxTokens: Math.min(input.providerOptions.maxTokens ?? 4096, 4096) },
          { actorId: prompt.expectedActorId, actorName: prompt.actorName },
        ),
      );
    },
  });
  if (result.actorDiagnostics.some((item) => item.status === "omitted" && item.reason === contextLimitMessage)) {
    throw contextLimitError();
  }
  if (cachedUsageIncomplete && usage) delete usage.cachedPromptTokens;
  if (cacheWriteUsageIncomplete && usage) delete usage.cacheWritePromptTokens;
  return {
    ...result,
    ...(usage && !usageIncomplete ? { usage } : {}),
    ...(usageIncomplete ? { usageIncomplete: true } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}
