import { resolveAssetTag } from "../../lib/asset-fuzzy-match";

type AssetManifestMap = Record<string, { path: string }> | null;

export type SceneAssetNpcAvatarCandidate = {
  /** Local roster id accepted for GameNpc-shaped inputs; requests emit it as npcId. */
  id?: string;
  npcId?: string | null;
  name: string;
  description: string;
  gender?: string | null;
  pronouns?: string | null;
  avatarUrl?: string | null;
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
  const npcId = candidate.npcId?.trim() || candidate.id?.trim();
  return npcId ? `id:${npcId}` : `name:${normalizeSceneAssetNameForGeneration(candidate.name)}`;
}

function normalizeSceneAssetFailureKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("id:") || trimmed.startsWith("name:")) return trimmed;
  return `name:${normalizeSceneAssetNameForGeneration(trimmed)}`;
}

function sceneAssetNpcAvatarForceValue(candidate: SceneAssetNpcAvatarCandidate): string {
  return candidate.npcId?.trim() || candidate.id?.trim() ? sceneAssetNpcAvatarKey(candidate) : candidate.name;
}

function findNpcAvatar(lookup: Map<string, string>, candidate: SceneAssetNpcAvatarCandidate): string | undefined {
  const keyed = lookup.get(sceneAssetNpcAvatarKey(candidate));
  if (keyed) return keyed;
  // GameSurface builds name-keyed lookups, so fall back to the normalized name when the id key misses.
  return lookup.get(normalizeSceneAssetNameForGeneration(candidate.name));
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
      npcId: npc.npcId ?? npc.id ?? null,
      name: npc.name,
      description: npc.description,
      gender: npc.gender ?? null,
      pronouns: npc.pronouns ?? null,
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
  const npcPayload =
    savedGeneratedBackgroundMissing && forceNpcAvatarNames.length > 0
      ? npcAssetCandidates
      : [
          ...npcsNeedingAvatars,
          ...forcedNpcPayload.filter(
            (forcedNpc) =>
              !npcsNeedingAvatars.some((npc) => sceneAssetNpcAvatarKey(npc) === sceneAssetNpcAvatarKey(forcedNpc)),
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
