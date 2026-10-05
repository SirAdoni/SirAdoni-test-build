// ──────────────────────────────────────────────
// Starter packs for the random tables tool
// Original, generic fantasy tables shipped as static JSON. Each pack is a
// marinara-random-tables style list, self-contained: every [[reference]] in a
// pack names a table in the same pack, so a pack rolls fully on its own.
// Adding one goes through the normal import route with skipExisting, so a
// table the player already has (or renamed and kept) is never duplicated.
// ──────────────────────────────────────────────
import type { RandomTableRow } from "@marinara-engine/shared";
import roadsAndWeather from "./table-packs/roads-and-weather.json";
import storyComplications from "./table-packs/story-complications.json";
import tavernsAndInns from "./table-packs/taverns-and-inns.json";
import townLife from "./table-packs/town-life.json";
import treasure from "./table-packs/treasure.json";

export interface RandomTablePack {
  id: string;
  name: string;
  description: string;
  tables: Array<{ name: string; dice: string | null; description?: string; rows: Array<string | RandomTableRow> }>;
}

export const RANDOM_TABLE_PACKS: readonly RandomTablePack[] = [
  tavernsAndInns,
  roadsAndWeather,
  townLife,
  treasure,
  storyComplications,
] as RandomTablePack[];

/** Translation keys for each pack's name and description; the JSON keeps English as the fallback. */
export const RANDOM_TABLE_PACK_KEYS: Record<string, { name: string; description: string }> = {
  "taverns-and-inns": {
    name: "ui.randomTables.packTavernsName",
    description: "ui.randomTables.packTavernsDescription",
  },
  "roads-and-weather": {
    name: "ui.randomTables.packRoadsName",
    description: "ui.randomTables.packRoadsDescription",
  },
  "town-life": {
    name: "ui.randomTables.packTownName",
    description: "ui.randomTables.packTownDescription",
  },
  treasure: {
    name: "ui.randomTables.packTreasureName",
    description: "ui.randomTables.packTreasureDescription",
  },
  "story-complications": {
    name: "ui.randomTables.packComplicationsName",
    description: "ui.randomTables.packComplicationsDescription",
  },
};

/** The import body for a pack, in the export format the import route reads. */
export function randomTablePackImport(pack: RandomTablePack) {
  return { format: "marinara-random-tables", version: 1, tables: pack.tables };
}
