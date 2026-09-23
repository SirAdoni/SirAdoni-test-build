import type { DB } from "../../db/connection.js";
import { flushDB } from "../../db/connection.js";
import {
  correctLegacyHierarchicalMapsSelections,
  migrateLegacyChatCapabilitySelections,
} from "./legacy-capability-chat-migration.js";
import { capabilityPackageManager } from "./package-manager.service.js";

type AvailabilityMigrationResult = Awaited<ReturnType<typeof capabilityPackageManager.migrateLegacyAvailability>>;

export type LegacyCapabilityMigrationDependencies = {
  migrateAvailability: (legacyInstall: boolean) => Promise<AvailabilityMigrationResult>;
  migrateChatSelections: (db: DB) => Promise<void>;
  correctHierarchicalMapsSelections: (db: DB) => Promise<number>;
  isHierarchicalMapsCorrectionComplete: () => Promise<boolean>;
  flush: () => Promise<void>;
  completeHierarchicalMapsCorrection: () => Promise<void>;
  complete: () => Promise<void>;
};

const defaultDependencies: LegacyCapabilityMigrationDependencies = {
  migrateAvailability: (legacyInstall) => capabilityPackageManager.migrateLegacyAvailability(legacyInstall),
  migrateChatSelections: migrateLegacyChatCapabilitySelections,
  correctHierarchicalMapsSelections: correctLegacyHierarchicalMapsSelections,
  isHierarchicalMapsCorrectionComplete: async () =>
    capabilityPackageManager.isHierarchicalMapsSelectionCorrectionComplete(),
  flush: flushDB,
  completeHierarchicalMapsCorrection: () => capabilityPackageManager.completeHierarchicalMapsSelectionCorrection(),
  complete: () => capabilityPackageManager.completeLegacyAvailabilityMigration(),
};

/** Install legacy packages, persist per-chat selections, then commit completion. */
export async function migrateLegacyCapabilities(
  db: DB,
  legacyInstall: boolean,
  dependencies: LegacyCapabilityMigrationDependencies = defaultDependencies,
): Promise<AvailabilityMigrationResult> {
  const migration = await dependencies.migrateAvailability(legacyInstall);
  const correctionComplete = await dependencies.isHierarchicalMapsCorrectionComplete();
  if (migration.migrated) {
    await dependencies.migrateChatSelections(db);
    await dependencies.flush();
    if (!correctionComplete) await dependencies.completeHierarchicalMapsCorrection();
    await dependencies.complete();
    return { ...migration, complete: true };
  }

  if (!correctionComplete) {
    if (migration.legacy) {
      await dependencies.correctHierarchicalMapsSelections(db);
      await dependencies.flush();
    }
    await dependencies.completeHierarchicalMapsCorrection();
  }
  return migration;
}
