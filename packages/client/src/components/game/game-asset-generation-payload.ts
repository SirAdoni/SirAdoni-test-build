import { resolveAssetTag } from "../../lib/asset-fuzzy-match";

type AssetManifestMap = Record<string, { path: string }> | null;

export type SceneAssetNpcAvatarCandidate = {
  /** Local roster id accepted for GameNpc-shaped inputs; requests emit it as npcId. */
  id?: string;
  npcId?: string | null;
  characterId?: string | null;
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

export const CAMPAIGN_PORTRAIT_BATCH_SIZE = 10;
export const DEFAULT_CAMPAIGN_PORTRAIT_STYLE_PROMPT =
  "Cohesive stylized 2.5D game portrait illustration, dimensional painterly shading, clean shapes, expressive features, and a drawn finish; not photorealistic.";

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
};

/** Joins the saved NPC roster and active character cards by stable identity. */
export function buildCampaignPortraitRosterCandidates(
  trackedNpcs: SceneAssetNpcAvatarCandidate[],
  metadataNpcs: SceneAssetNpcAvatarCandidate[],
  activeCharacters: CampaignPortraitCharacter[],
  activeCharacterIds: ReadonlySet<string>,
): SceneAssetNpcAvatarCandidate[] {
  const byNpcId = new Map<string, SceneAssetNpcAvatarCandidate>();
  for (const candidate of [...trackedNpcs, ...metadataNpcs]) {
    const npcId = candidate.npcId?.trim() || candidate.id?.trim();
    const name = candidate.name.trim();
    if (!npcId || !name) continue;
    const previous = byNpcId.get(npcId);
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
      avatarUrl: candidate.avatarUrl || previous?.avatarUrl || undefined,
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
    });
  }
  return [...byNpcId.values()];
}

/** Selects only identified campaign characters without an assigned or linked portrait. */
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
    // Conflicting duplicate ids or an assigned avatar on any duplicate suppress the whole identity.
    if (
      group.some((candidate) => normalizeSceneAssetNameForGeneration(candidate.name) !== nameKey) ||
      group.some((candidate) => !!candidate.avatarUrl?.trim()) ||
      group.some(
        (candidate) => !!candidate.characterId?.trim() && linkedAvatarCharacterIds.has(candidate.characterId.trim()),
      )
    )
      continue;
    // Name lookup is safe only when that name uniquely identifies a campaign character.
    if (
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
