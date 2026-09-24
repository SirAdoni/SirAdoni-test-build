import { randomUUID } from "crypto";
import type { GameCampaignPlan, GameNpc, GameNpcStatus } from "@marinara-engine/shared";
import { normalizeCharacterLookupName } from "./name-normalization.js";

function normalizeText(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export function normalizeNextSessionCampaignPlan(raw: unknown, current: GameCampaignPlan): GameCampaignPlan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return current;
  const source = raw as Record<string, unknown>;
  const stringList = (value: unknown, fallback: string[] | undefined, limit: number, maxLength: number) => {
    if (!Array.isArray(value)) return fallback ?? [];
    const normalized = value
      .map((item) => normalizeText(item).slice(0, maxLength))
      .filter(Boolean)
      .slice(0, limit);
    return normalized.length > 0 ? normalized : (fallback ?? []);
  };
  const normalizedPressureClocks = Array.isArray(source.pressureClocks)
    ? source.pressureClocks
        .flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const clock = item as Record<string, unknown>;
          const name = normalizeText(clock.name).slice(0, 80);
          if (!name) return [];
          const steps =
            typeof clock.steps === "number" && Number.isFinite(clock.steps)
              ? Math.max(1, Math.min(12, Math.trunc(clock.steps)))
              : 4;
          const currentStep =
            typeof clock.current === "number" && Number.isFinite(clock.current)
              ? Math.max(0, Math.min(steps, Math.trunc(clock.current)))
              : 0;
          return [
            {
              name,
              steps,
              current: currentStep,
              failure: normalizeText(clock.failure).slice(0, 180),
            },
          ];
        })
        .slice(0, 2)
    : (current.pressureClocks ?? []);
  const pressureClocks =
    normalizedPressureClocks.length > 0 ? normalizedPressureClocks : (current.pressureClocks ?? []);
  const normalizedFactions = Array.isArray(source.factions)
    ? source.factions
        .flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const faction = item as Record<string, unknown>;
          const name = normalizeText(faction.name).slice(0, 80);
          const goal = normalizeText(faction.goal).slice(0, 160);
          if (!name || !goal) return [];
          const method = normalizeText(faction.method).slice(0, 160);
          const secret = normalizeText(faction.secret).slice(0, 180);
          return [{ name, goal, ...(method ? { method } : {}), ...(secret ? { secret } : {}) }];
        })
        .slice(0, 2)
    : (current.factions ?? []);
  const factions = normalizedFactions.length > 0 ? normalizedFactions : (current.factions ?? []);
  const openingSituation = normalizeText(source.openingSituation).slice(0, 240);

  return {
    openingSituation: openingSituation || current.openingSituation,
    pressureClocks,
    factions,
    questSeeds: stringList(source.questSeeds, current.questSeeds, 3, 180),
    encounterPrinciples: stringList(source.encounterPrinciples, current.encounterPrinciples, 2, 160),
  };
}

export function normalizeNextSessionNpcs(raw: unknown, current: GameNpc[]): GameNpc[] {
  if (!Array.isArray(raw)) return current;
  const next = [...current];
  const knownNames = new Set(current.map((npc) => normalizeCharacterLookupName(npc.name)));
  for (const item of raw.slice(0, 3)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const name = normalizeText(source.name).slice(0, 120);
    const normalizedName = normalizeCharacterLookupName(name);
    if (!name || !normalizedName || knownNames.has(normalizedName)) continue;
    knownNames.add(normalizedName);
    const description = normalizeText(source.description).slice(0, 500);
    const roleOrAgenda = normalizeText(source.roleOrAgenda).slice(0, 300);
    next.push({
      id: randomUUID(),
      name,
      emoji: normalizeText(source.emoji).slice(0, 16) || "👤",
      description,
      ...(description ? { descriptionSource: "model" as const } : {}),
      gender: normalizeText(source.gender).slice(0, 80) || null,
      pronouns: normalizeText(source.pronouns).slice(0, 80) || null,
      location: normalizeText(source.location).slice(0, 160) || "Unknown",
      reputation: 0,
      notes: roleOrAgenda ? [`Next-session role: ${roleOrAgenda}`] : [],
      avatarUrl: null,
    });
  }
  return next;
}

const DEAD_STATUS_WORDS = /^(?:dead|deceased|died|killed|slain|murdered|executed|perished)$/iu;
const UNKNOWN_STATUS_WORDS = /^(?:unknown|missing|lost|vanished|disappeared|gone|whereabouts unknown)$/iu;
const ALIVE_STATUS_WORDS = /^(?:alive|living|survived|surviving)$/iu;

/** Map a status word (from a status field or a location mistakenly holding one) to a status. */
export function parseGameNpcStatusWord(value: unknown): GameNpcStatus | null {
  const word = normalizeText(value)
    .replace(/[.!]+$/u, "")
    .trim();
  if (!word) return null;
  if (DEAD_STATUS_WORDS.test(word)) return "dead";
  if (UNKNOWN_STATUS_WORDS.test(word)) return "unknown";
  if (ALIVE_STATUS_WORDS.test(word)) return "alive";
  return null;
}

/** True when a location string is really a life-status word and must never be stored or shown as a place. */
export function isGameNpcStatusWordLocation(location: unknown): boolean {
  return parseGameNpcStatusWord(location) !== null;
}

/**
 * Apply session-conclusion updates to NPCs that already exist: life status and last known location.
 * Unknown names are ignored (new NPCs arrive through namedNpcs). A status word sent as a location
 * never becomes the stored location; a death word there sets status "dead".
 */
export function applyKnownNpcUpdates(raw: unknown, current: GameNpc[]): GameNpc[] {
  if (!Array.isArray(raw) || raw.length === 0) return current;
  const indexByName = new Map<string, number>();
  current.forEach((npc, index) => {
    const key = normalizeCharacterLookupName(npc.name);
    if (key && !indexByName.has(key)) indexByName.set(key, index);
  });
  let next: GameNpc[] | null = null;
  for (const item of raw.slice(0, 12)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const index = indexByName.get(normalizeCharacterLookupName(normalizeText(source.name).slice(0, 120)));
    if (index === undefined) continue;
    const npc = (next ?? current)[index]!;
    const rawLocation = normalizeText(source.location).slice(0, 160);
    const locationStatus = parseGameNpcStatusWord(rawLocation);
    // A missing place ("Unknown") says nothing about the NPC's fate; only a death word in location sets status.
    const status = parseGameNpcStatusWord(source.status) ?? (locationStatus === "dead" ? "dead" : null);
    const location = rawLocation && !locationStatus && rawLocation.toLowerCase() !== "unknown" ? rawLocation : null;
    const updated: GameNpc = {
      ...npc,
      ...(location ? { location } : {}),
      ...(status ? { status } : {}),
    };
    if (updated.location === npc.location && updated.status === npc.status) continue;
    next ??= [...current];
    next[index] = updated;
  }
  return next ?? current;
}
