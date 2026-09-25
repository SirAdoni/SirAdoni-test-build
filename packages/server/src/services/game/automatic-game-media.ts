import type { FastifyInstance } from "fastify";
import { STORYBOARD_AGENT_ID, type GameNpc } from "@marinara-engine/shared";
import { buildSceneAssetNpcCandidates } from "../../routes/game.routes.js";
import { gameNpcSanitizationOptionsFromMetadata } from "./npc-avatar-utils.js";
import { getAssetManifest } from "./asset-manifest.service.js";
import { resolveGameAddressMode } from "./gm-prompts.js";
import { buildStoryboardSourceSections } from "./segment-edits.js";
import { applyStoryboardAgentSettings } from "./storyboard-agent-settings.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createGameStateStorage } from "../storage/game-state.storage.js";
import { createAgentsStorage } from "../storage/agents.storage.js";
import { logger } from "../../lib/logger.js";

type HeaderValue = string | string[] | undefined;
export type AutomaticGameMediaHeaders = Record<string, HeaderValue>;

export interface QueueAutomaticGameMediaInput {
  chatId: string;
  messageId: string;
  swipeIndex?: number;
  headers?: AutomaticGameMediaHeaders;
}

const activeJobs = new Set<string>();

export function forwardedHeaders(headers: AutomaticGameMediaHeaders | undefined): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const name of [
    "authorization",
    "cookie",
    "x-marinara-csrf",
    "x-marinara-android-secret",
    "host",
    "origin",
    "referer",
    "x-forwarded-proto",
  ]) {
    const value = headers?.[name] ?? headers?.[name.toLowerCase()];
    if (typeof value === "string" || Array.isArray(value)) result[name] = value;
  }
  return result;
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const next = text(value);
    if (next) return next;
  }
  return null;
}

function activeAgentIds(meta: Record<string, unknown>): Set<string> {
  return new Set(
    Array.isArray(meta.activeAgentIds)
      ? meta.activeAgentIds
          .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
          .map((value) => value.trim())
      : [],
  );
}

function isStoryboardAutomaticEnabled(meta: Record<string, unknown>): boolean {
  if (meta.enableAgents !== true && meta.enableAgents !== "true") return false;
  const ids = activeAgentIds(meta);
  return (
    (ids.has(STORYBOARD_AGENT_ID) || meta.storyboardAgentActive === true) &&
    (meta.gameStoryboardAutoIllustrationsEnabled !== false || meta.gameStoryboardAutoGenerationEnabled === true)
  );
}

function sceneContext(meta: Record<string, unknown>, state: Record<string, unknown> | null) {
  const manifest = getAssetManifest();
  const assets = Object.keys(manifest.assets ?? {});
  const setup = metadataObject(meta.gameSetupConfig);
  let presentCharacters: unknown[] = [];
  try {
    const value =
      typeof state?.presentCharacters === "string" ? JSON.parse(state.presentCharacters) : state?.presentCharacters;
    if (Array.isArray(value)) presentCharacters = value;
  } catch {
    /* An absent snapshot roster is not inferred from party membership. */
  }
  const trackedNpcs = Array.isArray(meta.gameNpcs) ? meta.gameNpcs : [];
  const names = [...presentCharacters, ...trackedNpcs]
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>).name : null))
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim())
    .slice(0, 100);
  return {
    currentState: (["exploration", "dialogue", "combat", "travel_rest"].includes(text(meta.gameActiveState))
      ? meta.gameActiveState
      : "exploration") as "exploration" | "dialogue" | "combat" | "travel_rest",
    availableBackgrounds: assets.filter((value) => value.startsWith("backgrounds:")).slice(0, 2000),
    availableSfx: assets.filter((value) => value.startsWith("sfx:")).slice(0, 2000),
    activeWidgets: Array.isArray(meta.gameWidgetState)
      ? meta.gameWidgetState
      : ((metadataObject(meta.gameBlueprint).hudWidgets ?? []) as unknown[]),
    trackedNpcs: trackedNpcs.slice(0, 200),
    characterNames: names,
    currentBackground: firstString(meta.gameSceneBackground),
    currentMusic: firstString(meta.gameSceneMusic),
    recentMusic: Array.isArray(meta.gameRecentMusic)
      ? meta.gameRecentMusic.filter((value): value is string => typeof value === "string").slice(0, 20)
      : [],
    useSpotifyMusic: meta.gameUseSpotifyMusic === true,
    generateSoundEffects: meta.gameGenerateSoundEffects === true,
    generateMusic: meta.gameGenerateMusic === true,
    availableSpotifyTracks: [],
    currentAmbient: firstString(meta.gameSceneAmbient),
    currentLocation: firstString(state?.location),
    currentWeather: firstString(state?.weather),
    currentTimeOfDay: firstString(state?.time),
    genre: firstString(setup.genre),
    setting: firstString(setup.setting),
    worldOverview: firstString(meta.gameWorldOverview),
  };
}

async function inject(
  app: FastifyInstance,
  path: string,
  payload: unknown,
  headers: Record<string, string | string[]>,
) {
  const response = await app.inject({
    method: "POST",
    url: path,
    headers,
    payload: payload as Record<string, unknown>,
  });
  if (response.statusCode >= 400) throw new Error(`${path} failed with HTTP ${response.statusCode}`);
  try {
    return response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function assetPayload(
  meta: Record<string, unknown>,
  scene: Record<string, unknown>,
  narration: string,
  state: Record<string, unknown> | null,
) {
  const gameNpcs = (Array.isArray(meta.gameNpcs) ? meta.gameNpcs : []) as GameNpc[];
  const policy = gameNpcSanitizationOptionsFromMetadata(meta);
  const candidates = buildSceneAssetNpcCandidates(
    gameNpcs,
    state?.presentCharacters,
    [
      ...(policy.protectedCharacterNames ?? []),
      ...(policy.locationNames ?? []),
      ...(policy.narrationExcludedNames ?? []),
      text(state?.location),
    ],
    narration,
  );
  const npcsNeedingAvatars = candidates
    .filter((entry) => text(entry.name) && !text(entry.avatarUrl))
    .slice(0, 10)
    .map((entry) => ({
      npcId: text(entry.npcId) || null,
      name: text(entry.name),
      description: text(entry.description),
      gender: text(entry.gender) || null,
      pronouns: text(entry.pronouns) || null,
    }));
  const savedBackground = firstString(meta.gameSceneBackground);
  const proposedBackground = firstString(scene.background, savedBackground);
  const background =
    meta.gameStoryboardViewerDisplayMode !== "background" &&
    proposedBackground &&
    proposedBackground !== "black" &&
    proposedBackground !== "none" &&
    !getAssetManifest().assets[proposedBackground]
      ? proposedBackground
      : null;
  const rawIllustration = scene.illustration;
  const illustration =
    rawIllustration && typeof rawIllustration === "object"
      ? (() => {
          const value = rawIllustration as Record<string, unknown>;
          const prompt = text(value.prompt);
          return prompt.length >= 40
            ? {
                prompt,
                title: text(value.title) || undefined,
                characters: Array.isArray(value.characters)
                  ? value.characters.filter((entry): entry is string => typeof entry === "string").slice(0, 6)
                  : undefined,
                reason: text(value.reason) || undefined,
                slug: text(value.slug) || undefined,
              }
            : undefined;
        })()
      : undefined;
  return {
    automatic: true,
    backgroundTag: background || undefined,
    backgroundDescription: background ? text(scene.locationDescription).slice(0, 5000) || undefined : undefined,
    illustration,
    illustrationNarration: illustration ? narration : undefined,
    npcsNeedingAvatars: npcsNeedingAvatars.length ? npcsNeedingAvatars : undefined,
    queueImageGenerationRequests: true,
  };
}

/** Queue accepted Game media work independently of the browser response lifecycle. */
export function queueAutomaticGameMedia(app: FastifyInstance, input: QueueAutomaticGameMediaInput): Promise<void> {
  const swipeIndex = Number.isInteger(input.swipeIndex) && (input.swipeIndex ?? 0) >= 0 ? (input.swipeIndex ?? 0) : 0;
  const key = `${input.chatId}:${input.messageId}:${swipeIndex}`;
  if (activeJobs.has(key)) return Promise.resolve();
  activeJobs.add(key);
  const headers = forwardedHeaders(input.headers);
  let resolveStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  void (async () => {
    try {
      const chats = createChatsStorage(app.db);
      const chat = await chats.getById(input.chatId);
      if (!chat || chat.mode !== "game") return;
      const message = await chats.getMessage(input.messageId);
      if (
        !message ||
        message.chatId !== input.chatId ||
        (message.activeSwipeIndex ?? 0) !== swipeIndex ||
        (message.role !== "assistant" && message.role !== "narrator")
      )
        return;
      const meta = metadataObject(chat.metadata);
      if (meta.gameSessionStatus !== "ready" && meta.gameSessionStatus !== "active") return;
      const agents = createAgentsStorage(app.db);
      const resolvedMeta = await applyStoryboardAgentSettings(meta, agents, "game");
      const illustrator = await agents.getByType("illustrator");
      const imageConnectionId = firstString(
        resolvedMeta.gameImageConnectionId,
        metadataObject(illustrator?.settings).imageConnectionId,
      );
      const setup = metadataObject(resolvedMeta.gameSetupConfig);
      const sceneConfigured =
        (resolvedMeta.enableAgents === true || resolvedMeta.enableAgents === "true") &&
        Boolean(text(resolvedMeta.gameSceneConnectionId) || text(setup.sceneConnectionId));
      const assetsConfigured =
        resolvedMeta.enableSpriteGeneration === true &&
        resolvedMeta.gameImageAutoGenerationEnabled !== false &&
        Boolean(imageConnectionId);
      const storyboardAuto =
        isStoryboardAutomaticEnabled(resolvedMeta) &&
        Boolean(imageConnectionId || text(resolvedMeta.storyboardAgentImageConnectionId));
      if (!sceneConfigured && !assetsConfigured && !storyboardAuto) return;
      const allMessages = await chats.listMessages(input.chatId);
      const targetIndex = allMessages.findIndex((candidate) => candidate.id === message.id);
      const precedingUser =
        targetIndex >= 0
          ? allMessages
              .slice(0, targetIndex)
              .reverse()
              .find((candidate) => candidate.role === "user")
          : undefined;
      if (resolveGameAddressMode(precedingUser?.content) === "gm" || resolveGameAddressMode(message.content) === "gm")
        return;

      const state = (await createGameStateStorage(app.db)
        .getByMessage(message.id, swipeIndex)
        .catch(() => null)) as Record<string, unknown> | null;
      const sourceSections = buildStoryboardSourceSections(message.content ?? "", resolvedMeta, message.id);
      if (sourceSections.length === 0) return;
      await chats.updateMessageExtraForSwipe(message.id, swipeIndex, {
        gameAutomaticMedia: { status: "running", sceneStatus: sceneConfigured ? "running" : "skipped", swipeIndex },
      });
      resolveStarted();
      const narration = sourceSections
        .map((section) => section.content)
        .join("\n\n")
        .slice(0, 50_000);
      const context = sceneContext(resolvedMeta, state);
      const scenePromise: Promise<Record<string, unknown>> = sceneConfigured
        ? inject(
            app,
            "/api/game/scene-wrap",
            {
              chatId: input.chatId,
              narration,
              playerAction: precedingUser?.content?.slice(0, 5000),
              context,
              streaming: false,
            },
            headers,
          )
        : Promise.resolve({});

      const storyboardPromise = storyboardAuto
        ? inject(
            app,
            "/api/game/storyboard/generate",
            {
              chatId: input.chatId,
              messageId: message.id,
              swipeIndex,
              sections: sourceSections,
              automatic: true,
              generateVideos: resolvedMeta.gameStoryboardAutoGenerationEnabled === true,
              keyframeCount: resolvedMeta.gameStoryboardKeyframeCount,
              durationSeconds: resolvedMeta.gameStoryboardAnimationDurationSeconds,
            },
            headers,
          )
        : Promise.resolve({});

      const sceneBranch = (async () => {
        const sceneResponse = await scenePromise;
        const scene =
          sceneResponse.result && typeof sceneResponse.result === "object"
            ? (sceneResponse.result as Record<string, unknown>)
            : {};
        if (sceneConfigured && !sceneResponse.result) throw new Error("Scene analysis returned no usable result");
        if (sceneConfigured) {
          await chats.updateMessageExtraForSwipe(message.id, swipeIndex, {
            gameSceneAnalysis: { messageId: message.id, swipeIndex, result: scene },
            gameAutomaticMedia: { status: "running", sceneStatus: "completed", swipeIndex },
          });
        }
        const currentMessage = await chats.getMessage(message.id);
        const currentSwipeIndex = currentMessage?.activeSwipeIndex ?? 0;
        if (currentMessage?.chatId !== input.chatId || currentSwipeIndex !== swipeIndex) return { scene };
        if (assetsConfigured) {
          const latestChat = await chats.getById(input.chatId);
          const assetMeta = latestChat ? metadataObject(latestChat.metadata) : resolvedMeta;
          if (assetMeta.gameImageAutoGenerationEnabled === false || assetMeta.enableSpriteGeneration !== true)
            return { scene };
          const payload = assetPayload(assetMeta, scene, narration, state);
          if (!payload.backgroundTag && !payload.illustration && !payload.npcsNeedingAvatars?.length) return { scene };
          await inject(app, "/api/game/generate-assets", { ...payload, chatId: input.chatId }, headers);
        }
        return { scene };
      })().catch(async (error: unknown) => {
        await chats.updateMessageExtraForSwipe(message.id, swipeIndex, {
          gameAutomaticMedia: { status: "running", sceneStatus: "failed", swipeIndex },
        });
        throw error;
      });
      const [sceneOutcome, storyboardOutcome] = await Promise.allSettled([sceneBranch, storyboardPromise]);
      if (sceneOutcome.status === "rejected")
        logger.warn(sceneOutcome.reason, "[game/automatic-media] scene-wrap failed");
      if (storyboardOutcome.status === "rejected")
        logger.warn(storyboardOutcome.reason, "[game/automatic-media] storyboard failed");
      await chats.updateMessageExtraForSwipe(message.id, swipeIndex, {
        gameAutomaticMedia: {
          status:
            sceneOutcome.status === "rejected" || storyboardOutcome.status === "rejected" ? "failed" : "completed",
          sceneStatus: sceneConfigured ? (sceneOutcome.status === "rejected" ? "failed" : "completed") : "skipped",
          swipeIndex,
          error:
            sceneOutcome.status === "rejected"
              ? sceneOutcome.reason instanceof Error
                ? sceneOutcome.reason.message
                : String(sceneOutcome.reason)
              : storyboardOutcome.status === "rejected"
                ? storyboardOutcome.reason instanceof Error
                  ? storyboardOutcome.reason.message
                  : String(storyboardOutcome.reason)
                : null,
        },
      });
    } catch (error) {
      logger.warn(
        error,
        "[game/automatic-media] accepted media scheduling failed for chat %s message %s",
        input.chatId,
        input.messageId,
      );
      resolveStarted();
      await createChatsStorage(app.db)
        .updateMessageExtraForSwipe(input.messageId, swipeIndex, {
          gameAutomaticMedia: {
            status: "failed",
            sceneStatus: "failed",
            swipeIndex,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        .catch(() => undefined);
    } finally {
      resolveStarted();
      activeJobs.delete(key);
    }
  })();
  return started;
}
