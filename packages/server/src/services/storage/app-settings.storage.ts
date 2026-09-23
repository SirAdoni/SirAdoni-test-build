// ──────────────────────────────────────────────
// Storage: Synced App Settings (key/value)
// ──────────────────────────────────────────────
import { eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { appSettings } from "../../db/schema/index.js";
import { now } from "../../utils/id-generator.js";

export function createAppSettingsStorage(db: DB) {
  return {
    async get(key: string): Promise<string | null> {
      const rows = await db.select().from(appSettings).where(eq(appSettings.key, key));
      return rows[0]?.value ?? null;
    },

    async set(key: string, value: string): Promise<void> {
      const timestamp = now();
      // Single atomic upsert: a select-then-insert lets two concurrent first
      // writes of the same key both take the insert branch while a write turn
      // is pending, and the second one then fails the primary-key check.
      await db
        .insert(appSettings)
        .values({ key, value, updatedAt: timestamp })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: timestamp } });
    },

    async remove(key: string): Promise<void> {
      await db.delete(appSettings).where(eq(appSettings.key, key));
    },
  };
}
