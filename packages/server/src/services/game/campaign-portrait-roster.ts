type GameNpcRow = {
  id: string;
  name: string;
  characterId?: string | null;
  description: string;
  descriptionSource?: "user" | "model" | "library" | "narration";
  observedDescription?: string;
  observedAppearance?: string;
  gender?: string | null;
  pronouns?: string | null;
  avatarUrl?: string | null;
  emoji: string;
  location: string;
  reputation: number;
  notes: string[];
};

type PortraitCardRow = { id: string; data: unknown; avatarPath?: string | null };
type PortraitRequest = {
  npcId?: string | null;
  characterId?: string | null;
  name: string;
  description: string;
  gender?: string | null;
  pronouns?: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && !!id.trim()) : [];
}

function portraitForCard(card: PortraitCardRow, characterId: string): GameNpcRow | null {
  const data = record(card.data);
  const name = text(data?.name);
  const extensions = record(data?.extensions);
  const appearance = text(extensions?.appearance) ?? text(data?.description);
  if (!name || !appearance) return null;
  return {
    id: `party:${characterId}`,
    characterId,
    name,
    description: appearance,
    gender: text(data?.gender) ?? null,
    pronouns: text(data?.pronouns) ?? null,
    emoji: "👤",
    location: "",
    reputation: 0,
    notes: [],
  };
}

/** Resolve requests against the current campaign's stable NPC and active party-card identities. */
export function resolveCampaignPortraitRoster<TNpc extends GameNpcRow, TCard extends PortraitCardRow>(
  meta: Record<string, unknown>,
  chatCharacterIds: string[],
  cards: TCard[],
  requests: PortraitRequest[] | undefined,
): { npcs: TNpc[]; candidates: PortraitRequest[] } {
  const sourceNpcs = Array.isArray(meta.gameNpcs) ? (meta.gameNpcs as TNpc[]) : [];
  const npcById = new Map<string, TNpc>();
  for (const npc of sourceNpcs) {
    const id = npc.id?.trim();
    if (id && !npcById.has(id)) npcById.set(id, npc);
  }
  const setup = record(meta.gameSetupConfig);
  const gmCharacterId = text(setup?.gmCharacterId);
  const activeIds = new Set([
    ...chatCharacterIds,
    ...stringIds(meta.gamePartyCharacterIds),
    ...stringIds(setup?.partyCharacterIds),
  ].filter((id) => id !== gmCharacterId));
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const linkedNpcByCardId = new Map<string, TNpc>();
  for (const npc of npcById.values()) {
    if (npc.characterId && activeIds.has(npc.characterId) && !linkedNpcByCardId.has(npc.characterId)) {
      linkedNpcByCardId.set(npc.characterId, npc);
    }
  }

  const npcs = [...npcById.values()];
  const candidates: PortraitRequest[] = [];
  const candidateKeys = new Set<string>();
  for (const request of requests ?? []) {
    const characterId = request.characterId?.trim();
    const requestId = request.npcId?.trim();
    const requestedNpc = requestId ? npcById.get(requestId) : undefined;
    if (requestedNpc) {
      if (characterId && requestedNpc.characterId !== characterId) {
        throw new Error("Portrait identity does not match the current campaign");
      }
      const key = `npc:${requestedNpc.id}`;
      if (candidateKeys.has(key)) continue;
      candidateKeys.add(key);
      if (requestedNpc.avatarUrl?.trim()) continue;
      candidates.push({
        npcId: requestedNpc.id,
        characterId: requestedNpc.characterId ?? null,
        name: requestedNpc.name,
        description: requestedNpc.description ?? requestedNpc.observedAppearance ?? requestedNpc.observedDescription ?? "",
        gender: requestedNpc.gender ?? null,
        pronouns: requestedNpc.pronouns ?? null,
      });
      continue;
    }
    if (characterId) {
      if (!activeIds.has(characterId) || (requestId && requestId !== `party:${characterId}` && linkedNpcByCardId.get(characterId)?.id !== requestId)) {
        throw new Error("Portrait character is not part of the current campaign");
      }
      const card = cardById.get(characterId);
      if (!card) throw new Error("Portrait character is not part of the current campaign");
      const linkedNpc = linkedNpcByCardId.get(characterId);
      const npc = linkedNpc ?? portraitForCard(card, characterId);
      if (!npc) throw new Error("Portrait character has no canonical appearance");
      if (card.avatarPath?.trim() || npc.avatarUrl?.trim()) continue;
      const key = `character:${characterId}`;
      if (candidateKeys.has(key)) continue;
      candidateKeys.add(key);
      if (!linkedNpc && !npcs.some((entry) => entry.id === npc.id)) npcs.push(npc as TNpc);
      candidates.push({
        npcId: npc.id,
        characterId,
        name: npc.name,
        description: npc.description ?? npc.observedAppearance ?? npc.observedDescription ?? "",
        gender: npc.gender ?? null,
        pronouns: npc.pronouns ?? null,
      });
      continue;
    }

    throw new Error("Portrait character is not part of the current campaign");
  }
  return { npcs, candidates };
}
