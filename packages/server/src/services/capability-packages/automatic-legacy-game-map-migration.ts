import { randomUUID } from "node:crypto";
import {
  convertLegacyGameMapToSpatialDefinition,
  spatialContextDefinitionSchema,
  type GameMap,
} from "@marinara-engine/shared";
import { eq } from "../../db/file-query.js";
import { chats, spatialContextSnapshots } from "../../db/schema/index.js";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { withChatMetadataPatchQueue } from "../storage/chats.storage.js";
import { getCapabilityService } from "./capability-service-registry.service.js";

const HIERARCHICAL_MAPS_ID = "hierarchical-maps";

type SpatialStorageProvider = { create(): { getBootstrap(chatId: string): Promise<unknown> } };

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function legacyNodeMap(metadata: Record<string, unknown>): GameMap | null {
  // `gameMap` is the active map. If it exists but is a grid, do not silently
  // migrate an unrelated historical node map from `gameMaps`.
  const candidates = metadata.gameMap ? [metadata.gameMap] : Array.isArray(metadata.gameMaps) ? metadata.gameMaps : [];
  return (
    candidates.find(
      (candidate): candidate is GameMap =>
        !!candidate && typeof candidate === "object" && !Array.isArray(candidate) && candidate.type === "node",
    ) ?? null
  );
}

export type LegacyGameMapMigrationSummary = {
  migrated: number;
  skipped: number;
  failed: number;
};

export type LegacyGameMapMigrationOptions = {
  /** Test-only fault injection; omitted by the boot caller. */
  beforeSnapshotInsert?: (chatId: string) => void;
};

/**
 * Convert old node maps after the World Maps package has registered its services.
 * The source gameMap/gameMaps fields are intentionally left intact as a recovery
 * copy and for the local tactical map surface.
 */
export async function migrateLegacyGameMapsAtBoot(
  db: DB,
  options: LegacyGameMapMigrationOptions = {},
): Promise<LegacyGameMapMigrationSummary> {
  const provider = getCapabilityService<SpatialStorageProvider>("hierarchical-maps:storage");
  if (!provider) return { migrated: 0, skipped: 0, failed: 0 };

  const rows = await db.select().from(chats);
  const summary: LegacyGameMapMigrationSummary = { migrated: 0, skipped: 0, failed: 0 };
  for (const chat of rows) {
    if (chat.mode !== "game") {
      summary.skipped += 1;
      continue;
    }
    try {
      const result = await withChatMetadataPatchQueue(chat.id, async () => {
        return db.transaction(async (tx) => {
          const current = (await tx.select().from(chats).where(eq(chats.id, chat.id)).limit(1))[0];
          if (!current) return false;
          const metadata = record(current.metadata);
          // Treat any valid persisted definition as authoritative. A malformed
          // value is also preserved rather than overwritten by an automatic job.
          if (spatialContextDefinitionSchema.safeParse(metadata.spatialContext).success) return false;
          if (metadata.spatialContext !== undefined && metadata.spatialContext !== null) return false;
          const existingSnapshot = await tx
            .select({ id: spatialContextSnapshots.id })
            .from(spatialContextSnapshots)
            .where(eq(spatialContextSnapshots.chatId, chat.id))
            .limit(1);
          if (existingSnapshot.length > 0) return false;
          const map = legacyNodeMap(metadata);
          if (!map) return false;
          const converted = convertLegacyGameMapToSpatialDefinition(map);
          const parsed = spatialContextDefinitionSchema.safeParse(converted);
          if (!parsed.success) throw new Error(`Converted legacy map did not satisfy the spatial schema`);
          const activeAgentIds = Array.isArray(metadata.activeAgentIds)
            ? metadata.activeAgentIds.filter((id): id is string => typeof id === "string")
            : [];
          const setup = record(metadata.gameSetupConfig);
          const nextMetadata = {
            ...metadata,
            enableAgents: true,
            activeAgentIds: activeAgentIds.includes(HIERARCHICAL_MAPS_ID)
              ? activeAgentIds
              : [...activeAgentIds, HIERARCHICAL_MAPS_ID],
            gameSetupConfig: { ...setup, gameWorldMapMode: "hierarchical" },
            spatialContext: parsed.data,
          };
          const createdAt = new Date().toISOString();
          await tx
            .update(chats)
            .set({ metadata: JSON.stringify(nextMetadata), updatedAt: createdAt })
            .where(eq(chats.id, chat.id));
          options.beforeSnapshotInsert?.(chat.id);
          await tx.insert(spatialContextSnapshots).values({
            id: randomUUID(),
            chatId: chat.id,
            messageId: "",
            swipeIndex: 0,
            currentLocationId: parsed.data.startingLocationId,
            definitionRevision: parsed.data.revision,
            source: "bootstrap",
            transitionCommandId: null,
            transitionPayloadHash: null,
            createdAt,
          });
          return true;
        });
      });
      if (result) summary.migrated += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      logger.warn(
        {
          err: error,
          code: "ME_LEGACY_MAP_MIGRATION",
          diagnostic: { code: "ME_LEGACY_MAP_MIGRATION" },
          chatId: chat.id,
        },
        "Legacy game map conversion failed; continuing",
      );
    }
  }
  if (summary.migrated > 0 || summary.failed > 0) {
    logger.info(
      "[migration] Legacy game map conversion complete: migrated=%d skipped=%d failed=%d",
      summary.migrated,
      summary.skipped,
      summary.failed,
    );
  }
  return summary;
}
