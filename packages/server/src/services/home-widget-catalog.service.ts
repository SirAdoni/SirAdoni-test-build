import {
  HOME_CUSTOM_WIDGETS_SETTINGS_KEY,
  homeCustomWidgetCatalogSchema,
  type HomeCustomWidget,
  type HomeCustomWidgetCatalog,
} from "@marinara-engine/shared";
import type { DB } from "../db/connection.js";
import { eq } from "../db/file-query.js";
import { appSettings } from "../db/schema/index.js";
import { logger } from "../lib/logger.js";
import { now } from "../utils/id-generator.js";

export class HomeWidgetCatalogConflictError extends Error {
  constructor() {
    super("Home widget catalog changed; refresh it and try again.");
    this.name = "HomeWidgetCatalogConflictError";
  }
}

function parseStoredHomeWidgetCatalog(value: string | null): HomeCustomWidgetCatalog {
  if (!value) return homeCustomWidgetCatalogSchema.parse({ widgets: [] });
  try {
    return homeCustomWidgetCatalogSchema.parse(JSON.parse(value));
  } catch (error) {
    logger.warn(error, "Ignoring invalid stored Home custom widget catalog");
    return homeCustomWidgetCatalogSchema.parse({ widgets: [] });
  }
}

export async function readHomeWidgetCatalog(db: DB): Promise<HomeCustomWidgetCatalog> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, HOME_CUSTOM_WIDGETS_SETTINGS_KEY));
  return parseStoredHomeWidgetCatalog(rows[0]?.value ?? null);
}

export async function replaceHomeWidgetCatalog(
  db: DB,
  expectedRevision: number,
  widgets: HomeCustomWidget[],
): Promise<HomeCustomWidgetCatalog> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(appSettings).where(eq(appSettings.key, HOME_CUSTOM_WIDGETS_SETTINGS_KEY));
    const existing = rows[0] ?? null;
    const current = parseStoredHomeWidgetCatalog(existing?.value ?? null);
    if (current.revision !== expectedRevision) throw new HomeWidgetCatalogConflictError();
    const next = homeCustomWidgetCatalogSchema.parse({ revision: current.revision + 1, widgets });
    const row = {
      key: HOME_CUSTOM_WIDGETS_SETTINGS_KEY,
      value: JSON.stringify(next),
      updatedAt: now(),
    };
    if (existing) {
      await tx.update(appSettings).set(row).where(eq(appSettings.key, HOME_CUSTOM_WIDGETS_SETTINGS_KEY));
    } else {
      await tx.insert(appSettings).values(row);
    }
    return next;
  });
}
