import { readCharacterAvatarState, readGameNpcAvatarState } from "./npc-avatar-state.js";
import type { DB } from "../../db/connection.js";
import { chats } from "../../db/schema/index.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { PROFESSOR_MARI_ID } from "@marinara-engine/shared";
import { selectContactBookChats, selectContactBookNpcOwners, type ContactBookChatRow } from "./game-contact-book.js";

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
  avatarState?: unknown;
  emoji: string;
  location: string;
  reputation: number;
  notes: string[];
};

type PortraitCardRow = { id: string; data: unknown; avatarPath?: string | null };
export type PortraitRequest = {
  npcId?: string;
  characterId?: string;
  sourceChatId?: string;
  avatarState?: { revision: number; removed: boolean } | null;
  name: string;
  description: string;
  gender?: string | null;
  pronouns?: string | null;
};

export interface ResolvedCampaignPortraitOwner {
  sourceChatId: string;
  chat: ContactBookChatRow;
  meta: Record<string, unknown>;
  npcs: GameNpcRow[];
  candidates: PortraitRequest[];
}

function parseIds(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim())
    : [];
}

/** Resolve explicit portrait requests only within the exact Contact roster campaign/branch scope. */
export async function resolveCampaignPortraitOwners(
  db: DB,
  currentChat: ContactBookChatRow,
  requests: PortraitRequest[],
): Promise<ResolvedCampaignPortraitOwner[]> {
  const allRows = (await db.select().from(chats)) as ContactBookChatRow[];
  const selectedChats = selectContactBookChats(currentChat, allRows);
  const owners = selectContactBookNpcOwners(currentChat, selectedChats);
  const ownerByNpcId = new Map(owners.map((owner) => [owner.id, owner]));
  const ownerForRequest = new Map<string, PortraitRequest[]>();
  for (const request of requests) {
    const npcId = request.npcId?.trim();
    const sourceChatId = request.sourceChatId?.trim();
    if (!npcId || !sourceChatId) throw new Error("Campaign portrait owner is required");
    const partyCharacterId = npcId.startsWith("party:") ? npcId.slice("party:".length) : "";
    if (partyCharacterId) {
      if (sourceChatId !== currentChat.id || request.characterId?.trim() !== partyCharacterId) {
        throw new Error("Portrait character is not part of the current campaign");
      }
    } else {
      const owner = ownerByNpcId.get(npcId);
      if (!owner || owner.row.id !== sourceChatId)
        throw new Error("Campaign portrait owner is outside the roster scope");
    }
    const group = ownerForRequest.get(sourceChatId) ?? [];
    group.push({ ...request, npcId, sourceChatId });
    ownerForRequest.set(sourceChatId, group);
  }

  const characterStorage = createCharactersStorage(db);
  const resolved: ResolvedCampaignPortraitOwner[] = [];
  for (const [sourceChatId, scopedRequests] of ownerForRequest) {
    const row = selectedChats.find((candidate) => candidate.id === sourceChatId);
    if (!row) throw new Error("Campaign portrait owner is outside the roster scope");
    const meta = record(row.metadata) ?? {};
    const sourceNpcs = Array.isArray(meta.gameNpcs) ? (meta.gameNpcs as GameNpcRow[]) : [];
    const setup = record(meta.gameSetupConfig);
    const cardIds = new Set([
      ...parseIds(row.characterIds),
      ...parseIds(meta.gamePartyCharacterIds),
      ...parseIds(setup?.partyCharacterIds),
      ...sourceNpcs.map((npc) => text(npc.characterId)).filter((id): id is string => !!id),
      ...scopedRequests.map((request) => text(request.characterId)).filter((id): id is string => !!id),
    ]);
    const cards = (await Promise.all([...cardIds].map((id) => characterStorage.getById(id)))).filter(
      (card): card is NonNullable<typeof card> => card !== null,
    );
    const roster = resolveCampaignPortraitRoster(meta, parseIds(row.characterIds), cards, scopedRequests);
    resolved.push({ sourceChatId, chat: row, meta, npcs: roster.npcs, candidates: roster.candidates });
  }
  return resolved;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function canonicalPortraitDescription(npc: GameNpcRow): string {
  const descriptionSource = npc.descriptionSource;
  const persistedDescription =
    descriptionSource === undefined ||
    descriptionSource === "user" ||
    descriptionSource === "model" ||
    descriptionSource === "library"
      ? text(npc.description)
      : undefined;
  return persistedDescription ?? text(npc.observedAppearance) ?? text(npc.observedDescription) ?? "";
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
  const duplicateNpcIds = new Set<string>();
  for (const npc of sourceNpcs) {
    const id = npc.id?.trim();
    if (!id || duplicateNpcIds.has(id)) continue;
    if (npcById.has(id)) {
      npcById.delete(id);
      duplicateNpcIds.add(id);
      continue;
    }
    npcById.set(id, npc);
  }
  const setup = record(meta.gameSetupConfig);
  const gmCharacterId = text(setup?.gmCharacterId);
  const activeIds = new Set(
    [...chatCharacterIds, ...stringIds(meta.gamePartyCharacterIds), ...stringIds(setup?.partyCharacterIds)].filter(
      (id) => id !== gmCharacterId && id !== PROFESSOR_MARI_ID,
    ),
  );
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
      const appearance = canonicalPortraitDescription(requestedNpc);
      if ((request.name && request.name.trim() !== requestedNpc.name.trim()) || request.description !== appearance) {
        throw new Error("Portrait identity changed; refresh the campaign roster");
      }
      const key = `npc:${requestedNpc.id}`;
      if (candidateKeys.has(key)) continue;
      candidateKeys.add(key);
      const linkedCard = requestedNpc.characterId ? cardById.get(requestedNpc.characterId) : undefined;
      const canonicalState =
        readCharacterAvatarState(linkedCard?.data) ?? readGameNpcAvatarState(requestedNpc.avatarState);
      const requestedState = readGameNpcAvatarState(request.avatarState);
      if (request.avatarState !== undefined && JSON.stringify(requestedState) !== JSON.stringify(canonicalState)) {
        throw new Error("Portrait avatar state changed; refresh the campaign roster");
      }
      const removed = canonicalState?.removed === true;
      if (!removed && (requestedNpc.avatarUrl?.trim() || linkedCard?.avatarPath?.trim())) continue;
      candidates.push({
        npcId: requestedNpc.id,
        ...(request.sourceChatId ? { sourceChatId: request.sourceChatId } : {}),
        ...(canonicalState ? { avatarState: canonicalState } : {}),
        ...(requestedNpc.characterId ? { characterId: requestedNpc.characterId } : {}),
        name: requestedNpc.name,
        description: appearance,
        gender: requestedNpc.gender ?? null,
        pronouns: requestedNpc.pronouns ?? null,
      });
      continue;
    }
    if (characterId) {
      if (
        !activeIds.has(characterId) ||
        (requestId && requestId !== `party:${characterId}` && linkedNpcByCardId.get(characterId)?.id !== requestId)
      ) {
        throw new Error("Portrait character is not part of the current campaign");
      }
      const card = cardById.get(characterId);
      if (!card) throw new Error("Portrait character is not part of the current campaign");
      const linkedNpc = linkedNpcByCardId.get(characterId);
      const npc = linkedNpc ?? portraitForCard(card, characterId);
      if (!npc) throw new Error("Portrait character has no canonical appearance");
      const appearance = canonicalPortraitDescription(npc);
      if ((request.name && request.name.trim() !== npc.name.trim()) || request.description !== appearance) {
        throw new Error("Portrait identity changed; refresh the campaign roster");
      }
      const removed = readCharacterAvatarState(card.data)?.removed === true;
      const canonicalState = readCharacterAvatarState(card.data);
      const requestedState = readGameNpcAvatarState(request.avatarState);
      if (request.avatarState !== undefined && JSON.stringify(requestedState) !== JSON.stringify(canonicalState)) {
        throw new Error("Portrait avatar state changed; refresh the campaign roster");
      }
      if (!removed && (card.avatarPath?.trim() || npc.avatarUrl?.trim())) continue;
      const key = `character:${characterId}`;
      if (candidateKeys.has(key)) continue;
      candidateKeys.add(key);
      if (!linkedNpc && !npcs.some((entry) => entry.id === npc.id)) npcs.push(npc as TNpc);
      candidates.push({
        npcId: npc.id,
        ...(request.sourceChatId ? { sourceChatId: request.sourceChatId } : {}),
        ...(canonicalState ? { avatarState: canonicalState } : {}),
        characterId,
        name: npc.name,
        description: appearance,
        gender: npc.gender ?? null,
        pronouns: npc.pronouns ?? null,
      });
      continue;
    }

    throw new Error("Portrait character is not part of the current campaign");
  }
  return { npcs, candidates };
}
