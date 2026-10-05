import { resolveAssetTag } from "../../lib/asset-fuzzy-match";
import {
  hasAuthoritativeNpcAvatarState,
  isNpcAvatarRemoved,
  resolveNpcAvatarStateForIdentity,
} from "../../lib/game-npc-avatar";
import type { GameNpcAvatarState } from "@marinara-engine/shared";

type AssetManifestMap = Record<string, { path: string }> | null;

export type SceneAssetNpcAvatarCandidate = {
  id?: string;
  npcId?: string | null;
  characterId?: string | null;
  sourceChatId?: string | null;
  name: string;
  description: string;
  gender?: string | null;
  pronouns?: string | null;
  avatarUrl?: string | null;
  avatarState?: GameNpcAvatarState;
};

export type CampaignPortraitBatch = {
  candidates: Array<SceneAssetNpcAvatarCandidate & { npcId: string }>;
  stylePrompt: string;
};

export type CampaignPortraitCharacter = {
  id: string;
  name: string;
  description?: string | null;
  appearance?: string | null;
  avatarUrl?: string | null;
  avatarState?: GameNpcAvatarState;
};

type MissingSceneAssetGenerationPayload = {
  chatId: string;
  backgroundTag?: string;
  npcsNeedingAvatars?: SceneAssetNpcAvatarCandidate[];
  forceNpcAvatarNames?: string[];
};

type MissingSceneAssetGenerationInput = {
  gameImageGenerationEnabled: boolean;
  gameBackgroundGenerationEnabled?: boolean;
  activeChatId: string | null;
  currentBackground: string | null;
  savedSceneBackground: string | undefined;
  assetMap: AssetManifestMap;
  sceneAssetNpcs: SceneAssetNpcAvatarCandidate[];
  npcAvatarLookup: Map<string, string>;
  npcsNeedingAvatars: SceneAssetNpcAvatarCandidate[];
  failedNpcAvatarNames?: Iterable<string>;
};

export function normalizeSceneAssetNameForGeneration(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function sceneAssetNpcAvatarKey(candidate: { id?: string; npcId?: string | null; name: string }): string {
  const id = candidate.npcId?.trim() || candidate.id?.trim();
  return id ? `id:${id}` : `name:${normalizeSceneAssetNameForGeneration(candidate.name)}`;
}

function findNpcAvatar(lookup: Map<string, string>, candidate: SceneAssetNpcAvatarCandidate): string | undefined {
  if (isNpcAvatarRemoved(candidate.avatarState)) return undefined;
  const direct = lookup.get(sceneAssetNpcAvatarKey(candidate));
  if (direct) return direct;
  const characterId = candidate.characterId?.trim();
  if (characterId && lookup.has(`character:${characterId}`)) return lookup.get(`character:${characterId}`);
  return hasAuthoritativeNpcAvatarState(candidate.avatarState)
    ? undefined
    : lookup.get(normalizeSceneAssetNameForGeneration(candidate.name));
}

function sceneAssetNpcAvatarForceValue(candidate: SceneAssetNpcAvatarCandidate): string {
  return candidate.id?.trim() || candidate.npcId?.trim() ? sceneAssetNpcAvatarKey(candidate) : candidate.name;
}

function normalizeSceneAssetFailureKey(value: string): string {
  if (value.startsWith("id:")) return value;
  return `name:${normalizeSceneAssetNameForGeneration(value)}`;
}

function isChatOwnedNpcAvatar(avatarUrl: string | undefined, chatId: string): boolean {
  if (!avatarUrl) return false;
  try {
    const pathname = new URL(avatarUrl, "http://marinara.local").pathname;
    return pathname.startsWith(`/api/avatars/npc/${encodeURIComponent(chatId)}/`);
  } catch {
    return false;
  }
}

export const CAMPAIGN_PORTRAIT_BATCH_SIZE = 10;
export const DEFAULT_CAMPAIGN_PORTRAIT_STYLE_PROMPT =
  "Cohesive stylized 2.5D game portrait illustration, dimensional painterly shading, clean shapes, expressive features, and a drawn finish; not photorealistic.";

/** Join the saved NPC roster and active character cards by stable identity. */
export function buildCampaignPortraitRosterCandidates(
  trackedNpcs: SceneAssetNpcAvatarCandidate[],
  metadataNpcs: SceneAssetNpcAvatarCandidate[],
  activeCharacters: CampaignPortraitCharacter[],
  activeCharacterIds: ReadonlySet<string>,
): SceneAssetNpcAvatarCandidate[] {
  const ambiguousIds = new Set<string>();
  for (const rows of [trackedNpcs, metadataNpcs]) {
    const seen = new Set<string>();
    for (const candidate of rows) {
      const npcId = candidate.npcId?.trim() || candidate.id?.trim();
      if (!npcId) continue;
      if (seen.has(npcId)) ambiguousIds.add(npcId);
      seen.add(npcId);
    }
  }
  const byNpcId = new Map<string, SceneAssetNpcAvatarCandidate>();
  for (const candidate of [...trackedNpcs, ...metadataNpcs]) {
    const npcId = candidate.npcId?.trim() || candidate.id?.trim();
    const name = candidate.name.trim();
    if (!npcId || !name || ambiguousIds.has(npcId)) continue;
    const previous = byNpcId.get(npcId);
    const avatarState = resolveNpcAvatarStateForIdentity(
      previous?.avatarState,
      previous?.characterId,
      candidate.avatarState,
      candidate.characterId,
    );
    const incomingCharacterId = candidate.characterId?.trim();
    const previousCharacterId = previous?.characterId?.trim();
    const changedAuthoritySubject = !!incomingCharacterId && incomingCharacterId !== previousCharacterId;
    const stateOwner = avatarState === candidate.avatarState ? candidate : previous;
    byNpcId.set(npcId, {
      ...previous,
      ...candidate,
      id: npcId,
      npcId,
      characterId: candidate.characterId?.trim() || previous?.characterId || null,
      name: previous?.name || name,
      description: previous?.description || candidate.description || "",
      gender: candidate.gender ?? previous?.gender ?? null,
      pronouns: candidate.pronouns ?? previous?.pronouns ?? null,
      avatarUrl: isNpcAvatarRemoved(avatarState)
        ? undefined
        : hasAuthoritativeNpcAvatarState(avatarState)
          ? (stateOwner?.avatarUrl ?? undefined)
          : changedAuthoritySubject
            ? (candidate.avatarUrl ?? undefined)
            : candidate.avatarUrl || previous?.avatarUrl || undefined,
      avatarState,
    });
  }

  const linkedCharacterIds = new Set(
    [...byNpcId.values()].map((candidate) => candidate.characterId?.trim()).filter((id): id is string => !!id),
  );
  for (const character of activeCharacters) {
    if (!activeCharacterIds.has(character.id) || linkedCharacterIds.has(character.id)) continue;
    byNpcId.set(`party:${character.id}`, {
      id: `party:${character.id}`,
      npcId: `party:${character.id}`,
      characterId: character.id,
      name: character.name,
      description: [character.description, character.appearance].filter(Boolean).join("\n\n"),
      avatarUrl: character.avatarUrl ?? undefined,
      avatarState: character.avatarState,
    });
  }
  return [...byNpcId.values()];
}

/** Split only identity-safe, missing portraits into provider-size batches. */
export function buildCampaignPortraitBatches(
  candidates: SceneAssetNpcAvatarCandidate[],
  avatarLookup: ReadonlyMap<string, string>,
  stylePrompt: string,
  linkedAvatarCharacterIds: ReadonlySet<string> = new Set(),
): CampaignPortraitBatch[] {
  const idsByName = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const npcId = candidate.npcId?.trim() || candidate.id?.trim();
    const nameKey = normalizeSceneAssetNameForGeneration(candidate.name);
    if (!npcId || !nameKey) continue;
    const ids = idsByName.get(nameKey) ?? new Set<string>();
    ids.add(npcId);
    idsByName.set(nameKey, ids);
  }
  const groupedById = new Map<string, Array<SceneAssetNpcAvatarCandidate & { npcId: string }>>();
  for (const candidate of candidates) {
    const npcId = candidate.npcId?.trim() || candidate.id?.trim();
    const nameKey = normalizeSceneAssetNameForGeneration(candidate.name);
    if (!npcId || !nameKey) continue;
    const group = groupedById.get(npcId) ?? [];
    group.push({ ...candidate, npcId });
    groupedById.set(npcId, group);
  }

  const selected: Array<SceneAssetNpcAvatarCandidate & { npcId: string }> = [];
  for (const group of groupedById.values()) {
    const first = group[0];
    if (!first) continue;
    const nameKey = normalizeSceneAssetNameForGeneration(first.name);
    const explicitlyRemoved = group.some((candidate) => isNpcAvatarRemoved(candidate.avatarState));
    if (
      group.some((candidate) => normalizeSceneAssetNameForGeneration(candidate.name) !== nameKey) ||
      group.some((candidate) => !!candidate.avatarUrl?.trim()) ||
      group.some(
        (candidate) =>
          !explicitlyRemoved &&
          !!candidate.characterId?.trim() &&
          linkedAvatarCharacterIds.has(candidate.characterId.trim()),
      )
    )
      continue;
    if (
      !explicitlyRemoved &&
      !group.some((candidate) => candidate.characterId?.trim()) &&
      idsByName.get(nameKey)?.size === 1 &&
      avatarLookup.has(nameKey)
    )
      continue;
    selected.push(first);
  }

  const batches: CampaignPortraitBatch[] = [];
  for (let index = 0; index < selected.length; index += CAMPAIGN_PORTRAIT_BATCH_SIZE) {
    batches.push({
      candidates: selected.slice(index, index + CAMPAIGN_PORTRAIT_BATCH_SIZE),
      stylePrompt: stylePrompt.trim() || DEFAULT_CAMPAIGN_PORTRAIT_STYLE_PROMPT,
    });
  }
  return batches;
}

export function getMissingBackgroundTag(
  backgroundTag: string | undefined | null,
  manifest: AssetManifestMap,
): string | null {
  const cleaned = backgroundTag?.trim();
  if (!cleaned || cleaned === "black" || cleaned === "none") return null;
  const resolved = resolveAssetTag(cleaned, "backgrounds", manifest);
  return manifest?.[resolved] ? null : cleaned;
}

export function buildMissingSceneAssetGenerationPayload({
  gameImageGenerationEnabled,
  gameBackgroundGenerationEnabled = gameImageGenerationEnabled,
  activeChatId,
  currentBackground,
  savedSceneBackground,
  assetMap,
  sceneAssetNpcs,
  npcAvatarLookup,
  npcsNeedingAvatars,
  failedNpcAvatarNames,
}: MissingSceneAssetGenerationInput): MissingSceneAssetGenerationPayload | null {
  if (!gameImageGenerationEnabled) return null;
  if (!activeChatId) return null;

  const unresolvedBackground = gameBackgroundGenerationEnabled
    ? getMissingBackgroundTag(currentBackground || savedSceneBackground, assetMap)
    : null;
  const savedGeneratedBackgroundMissing =
    !!savedSceneBackground &&
    unresolvedBackground === savedSceneBackground &&
    savedSceneBackground.startsWith("backgrounds:");
  const npcAssetCandidates = sceneAssetNpcs
    .filter((npc) => npc.description && npc.name)
    .map((npc) => ({
      id: npc.id,
      npcId: npc.npcId ?? npc.id ?? null,
      characterId: npc.characterId ?? null,
      name: npc.name,
      description: npc.description,
      gender: npc.gender ?? null,
      pronouns: npc.pronouns ?? null,
      avatarUrl: npc.avatarUrl ?? null,
      avatarState: npc.avatarState,
    }))
    .slice(0, 10);
  const forceNpcAvatarValueSet = new Set<string>();
  if (savedGeneratedBackgroundMissing) {
    for (const npc of npcAssetCandidates) {
      const avatarUrl = findNpcAvatar(npcAvatarLookup, npc);
      if (isChatOwnedNpcAvatar(avatarUrl, activeChatId)) {
        forceNpcAvatarValueSet.add(sceneAssetNpcAvatarForceValue(npc));
      }
    }
  }
  const failedNpcAvatarNameSet = new Set(
    [...(failedNpcAvatarNames ?? [])].map(normalizeSceneAssetFailureKey).filter(Boolean),
  );
  for (const npc of npcAssetCandidates) {
    const identityKey = sceneAssetNpcAvatarKey(npc);
    const nameKey = `name:${normalizeSceneAssetNameForGeneration(npc.name)}`;
    const avatarUrl = findNpcAvatar(npcAvatarLookup, npc);
    if (
      (failedNpcAvatarNameSet.has(identityKey) || failedNpcAvatarNameSet.has(nameKey)) &&
      isChatOwnedNpcAvatar(avatarUrl, activeChatId)
    ) {
      forceNpcAvatarValueSet.add(sceneAssetNpcAvatarForceValue(npc));
    }
  }
  const forceNpcAvatarNames = [...forceNpcAvatarValueSet];
  const forcedNpcPayload = npcAssetCandidates.filter((npc) =>
    forceNpcAvatarValueSet.has(sceneAssetNpcAvatarForceValue(npc)),
  );
  const missingCampaignNpcPayload = npcsNeedingAvatars.filter((npc) => !isNpcAvatarRemoved(npc.avatarState));
  const npcPayload =
    savedGeneratedBackgroundMissing && forceNpcAvatarNames.length > 0
      ? npcAssetCandidates
      : [
          ...missingCampaignNpcPayload,
          ...forcedNpcPayload.filter(
            (forcedNpc) =>
              !missingCampaignNpcPayload.some(
                (npc) => sceneAssetNpcAvatarKey(npc) === sceneAssetNpcAvatarKey(forcedNpc),
              ),
          ),
        ].slice(0, 10);

  if (!unresolvedBackground && npcPayload.length === 0) return null;

  return {
    chatId: activeChatId,
    backgroundTag: unresolvedBackground ?? undefined,
    npcsNeedingAvatars: npcPayload.length > 0 ? npcPayload : undefined,
    forceNpcAvatarNames: forceNpcAvatarNames.length > 0 ? forceNpcAvatarNames : undefined,
  };
}
