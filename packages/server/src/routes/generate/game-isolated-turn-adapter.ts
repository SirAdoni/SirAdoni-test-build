import {
  fitMessagesToContext,
  type BaseLLMProvider,
  type ChatMessage,
  type ChatOptions,
  type LLMUsage,
} from "../../services/llm/base-provider.js";
import { parseGameJsonish } from "../../services/game/jsonish.js";
import {
  ISOLATED_MAX_LINES_PER_ACTOR,
  runIsolatedGameTurn,
  type IsolatedGameActor,
  type IsolatedGamePlan,
  type IsolatedGameTurnResult,
} from "../../services/game/game-isolated-turn.js";

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
  provider: BaseLLMProvider;
  providerOptions: Omit<ChatOptions, "model" | "signal" | "stream" | "responseFormat"> & {
    model: string;
  };
  signal: AbortSignal;
  maxConcurrency?: number;
  onPrompt?: IsolatedTurnPromptLogger;
  beforeRequest?: IsolatedTurnBeforeRequest;
  afterRequest?: IsolatedTurnAfterRequest;
};

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
  "Return only one JSON object with exactly these keys: publicScene and actorRequests.",
  "publicScene is an ordered array of externally observable scene beats with {beat:number,text:string,perceivedBy:string[]}.",
  "actorRequests is an array of {beat:number,actorId:string}.",
  "Each perceivedBy must contain only exact trusted NPC IDs who could observe or hear that beat; use [] for player-only narration. Do not assume every present actor heard private communication.",
  "A publicScene beat may contain only what the player could observe at that point. Preserve the player's supplied spoken questions, requests, and observable actions in beats for their actual hearers or witnesses, so those actors can respond. Keep private player intent out of those beats.",
  "When the player explicitly asks a present actor to introduce unnamed people by name and role, fulfill that request in this turn. For this introduction only, the explicit request authorizes naming visible people: preserve any established names, roles, and counts; if the current scene or history establishes visible people or their roles but not their names, assign suitable names now and establish only the minimum missing names and roles needed for those visible people in a publicScene beat, mark it perceivedBy the hearing actor, and request that actor after the beat. This narrow allowance does not override established canon, player-agency rules, or private-knowledge boundaries. Do not stop at promising to introduce them, saying you will read a roster, or deferring the list to a later turn.",
  "New names or roles established to answer that explicit introduction request are public scene facts, not hidden GM knowledge. The actor may state them because they appear in its publicScene beats; do not expose unrelated campaign-memory or private planner facts.",
  "Never invent additional player actions, decisions, thoughts, or answers. Do not script NPC dialogue in the plan; actor requests generate their responses. Never include hidden plans, future events, private GM bookkeeping, or formatted character dialogue lines.",
  "Request only actors from the supplied trusted roster. Never request the player actor.",
].join("\n");

function actorPromptMessages(prompt: {
  expectedActorId: string;
  actorName: string;
  ownCard: string;
  authorizedMemory: string;
  publicScene: readonly IsolatedGamePlan["publicScene"][number][];
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are one isolated game actor. Speak only for the expected actor.",
        'Return only JSON: {"actorId":string,"lines":[{"type":"main"|"side"|"action"|"thought"|"whisper","text":string,"expression"?:string,"targetActorId"?:string}]}.',
        "Use only the supplied actor card, authorized memory, and the supplied public scene beats. Do not invent private GM knowledge or future events.",
        `A direct player request to introduce visible unnamed people by name and role is an instruction to complete the introductions now. Use the exact names and roles established in the public scene; do not create additional names, roles, or identities in the actor turn. The output may contain at most ${ISOLATED_MAX_LINES_PER_ACTOR} lines; combine related introductions into fewer lines when needed so every requested visible name and role is still stated. Never silently omit a requested introduction. Do not answer with a promise, preparation, or an instruction for someone else to name them later.`,
        "Respect memory's epistemic labels: knowing a claim was made does not make it true or your own belief. For the same fact and time, current source-verified authorized memory takes precedence over contradictory older card text; retain the card's characterization. Missing memory is not proof that something never happened or that nobody knows it.",
        `Expected actor ID: ${prompt.expectedActorId}`,
        `Expected actor name: ${prompt.actorName}`,
        `Own actor card:\n${prompt.ownCard}`,
        `Authorized memory:\n${prompt.authorizedMemory || "(none)"}`,
        `Public scene through this beat:\n${prompt.publicScene.map((beat) => `[beat ${beat.beat}] ${beat.text}`).join("\n")}`,
      ].join("\n\n"),
    },
  ];
}

function planMessages(messages: readonly ChatMessage[], actors: readonly IsolatedGameActor[]): ChatMessage[] {
  const roster = actors.map(({ actorId, name }) => ({ actorId, name }));
  return [
    ...messages.map((message) => ({ ...message })),
    {
      role: "user" as const,
      content: `${PLAN_INSTRUCTION}\nTrusted actor roster (exact IDs): ${JSON.stringify(roster ?? [])}`,
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
    const fit = fitMessagesToContext([...messages], {
      maxContext: input.providerOptions.maxContext,
      maxTokens: extra.maxTokens ?? input.providerOptions.maxTokens,
      tools: input.providerOptions.tools,
      suppressModelParameters: input.providerOptions.suppressModelParameters,
    });
    const samePrompt =
      fit.messages.length === messages.length &&
      fit.messages.every((message, index) => {
        const original = messages[index];
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
    plan: async () => parseGameJsonish(await request("planner", planMessages(input.plannerMessages, input.actors))),
    actor: async (prompt) =>
      parseGameJsonish(
        await request(
          "actor",
          actorPromptMessages(prompt),
          {
            maxTokens: Math.min(input.providerOptions.maxTokens ?? 4096, 4096),
          },
          { actorId: prompt.expectedActorId, actorName: prompt.actorName },
        ),
      ),
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
