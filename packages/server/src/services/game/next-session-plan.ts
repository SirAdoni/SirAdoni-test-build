import { randomUUID } from "crypto";
import type { GameCampaignPlan, GameNpc } from "@marinara-engine/shared";
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
