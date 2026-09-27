import { z } from "zod";
import type { CampaignMemoryEntity } from "../types/campaign-memory.js";
import type { GameCalendarConfig } from "./game-calendar.js";
import { daysInMonth, GAME_CALENDAR_LIMITS } from "./game-calendar.js";

/** A manually authored wiki note, not an inferred scene event or an automatic canon update. */
export const WORLD_HISTORY_ATTRIBUTE = "worldHistory";
export const worldHistorySchema = z
  .object({
    version: z.literal(1),
    era: z.string().trim().max(100),
    /** Explicit user order for eras with independent year numbering. No historical ordering is inferred. */
    eraOrder: z.number().int().min(-1_000_000).max(1_000_000),
    certainty: z.enum(["exact", "approximate", "uncertain", "unknown"]),
    dateLabel: z.string().trim().max(300),
    date: z
      .object({
        year: z.number().int().min(-GAME_CALENDAR_LIMITS.year).max(GAME_CALENDAR_LIMITS.year),
        month: z
          .number()
          .int()
          .min(0)
          .max(GAME_CALENDAR_LIMITS.months - 1)
          .nullable(),
        day: z
          .number()
          .int()
          .min(1)
          .max(GAME_CALENDAR_LIMITS.monthDays + 1000)
          .nullable(),
      })
      .strict()
      .nullable(),
    participantEntityIds: z.array(z.string().trim().min(1).max(300)).max(100),
    locationEntityId: z.string().trim().min(1).max(300).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.certainty === "unknown" && value.date !== null)
      ctx.addIssue({ code: "custom", path: ["date"], message: "Unknown dates cannot have a numeric date" });
    if (value.certainty !== "unknown" && value.date === null && !value.dateLabel)
      ctx.addIssue({ code: "custom", path: ["dateLabel"], message: "Provide a date or a date description" });
    if (value.date?.day != null && value.date.month === null)
      ctx.addIssue({ code: "custom", path: ["date", "month"], message: "A day requires a month" });
  });
export type WorldHistoryData = z.infer<typeof worldHistorySchema>;
export type WorldHistoryEntry = {
  entity: CampaignMemoryEntity & { originChatId?: string };
  history: WorldHistoryData;
};
export interface WorldHistoryPage {
  items: WorldHistoryEntry[];
  total: number;
  offset: number;
  limit: number;
  eras: string[];
  relatedEntities: CampaignMemoryEntity[];
}

export function readWorldHistory(entity: Pick<CampaignMemoryEntity, "kind" | "attributes">): WorldHistoryData | null {
  if (entity.kind !== "note") return null;
  const result = worldHistorySchema.safeParse(entity.attributes[WORLD_HISTORY_ATTRIBUTE]);
  return result.success ? result.data : null;
}

/** Partial dates retain their precision; never sanitize/clamp a user's history into a different date. */
export function isWorldHistoryDateValid(date: WorldHistoryData["date"], config: GameCalendarConfig): boolean {
  if (!date || date.month === null) return true;
  if (!config.months[date.month]) return false;
  return date.day === null || date.day <= daysInMonth(config, date.year, date.month);
}

export function compareWorldHistory(a: WorldHistoryEntry, b: WorldHistoryEntry): number {
  const x = a.history;
  const y = b.history;
  return (
    x.eraOrder - y.eraOrder ||
    x.era.localeCompare(y.era) ||
    (x.date === null ? 1 : 0) - (y.date === null ? 1 : 0) ||
    (x.date?.year ?? 0) - (y.date?.year ?? 0) ||
    (x.date?.month ?? -1) - (y.date?.month ?? -1) ||
    (x.date?.day ?? 0) - (y.date?.day ?? 0) ||
    a.entity.entityId.localeCompare(b.entity.entityId)
  );
}

/** Pure read projection: filtering and pagination never modify stored notes or promote them to verified facts. */
export function worldHistoryPage(
  entities: CampaignMemoryEntity[],
  options: { q?: string; era?: string; offset: number; limit: number; archived?: boolean },
  resolveId: (id: string) => string = (id) => id,
): WorldHistoryPage {
  const all = entities.flatMap((entity) => {
    const history = readWorldHistory(entity);
    return history && (options.archived || entity.status === "active") ? [{ entity, history }] : [];
  });
  const query = options.q?.trim().toLocaleLowerCase();
  const byId = new Map(entities.map((entity) => [entity.entityId, entity]));
  const filtered = all
    .filter(({ entity, history }) => {
      if (options.era !== undefined && history.era !== options.era) return false;
      const names = [...history.participantEntityIds, history.locationEntityId]
        .filter((id): id is string => !!id)
        .flatMap((id) => byId.get(resolveId(id))?.aliases ?? []);
      return (
        !query ||
        [
          ...entity.aliases,
          entity.body ?? "",
          entity.summary ?? "",
          history.era,
          history.dateLabel,
          history.date?.year?.toString() ?? "",
          ...names,
        ]
          .join("\n")
          .toLocaleLowerCase()
          .includes(query)
      );
    })
    .sort(compareWorldHistory);
  const items = filtered.slice(options.offset, options.offset + options.limit);
  const ids = new Set(
    items
      .flatMap(({ history }) => [...history.participantEntityIds, history.locationEntityId])
      .filter((id): id is string => !!id),
  );
  // Preserve stored IDs for editing; give the UI an alias for references folded by campaign scope.
  const relatedEntities = [...ids].flatMap((id) => {
    const entity = byId.get(resolveId(id));
    return entity ? [{ ...entity, entityId: id }] : [];
  });
  return {
    items,
    total: filtered.length,
    offset: options.offset,
    limit: options.limit,
    eras: [...new Set(all.sort(compareWorldHistory).map(({ history }) => history.era))],
    relatedEntities,
  };
}
