import type {
  CapabilityMessageRecord,
  MessageAttachment,
  PendingSpatialTransition,
  ResolvedSpatialTravel,
  SpatialContextSnapshot,
  SpatialTransitionErrorCode,
} from "@marinara-engine/shared";
import { getDB, type DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { getCapabilityService } from "../capability-packages/capability-service-registry.service.js";
import { recordLegacyMovement } from "../game/campaign-memory-legacy-writers.js";

export type SpatialOwnerTurnErrorCode =
  | SpatialTransitionErrorCode
  | "chat_not_found"
  | "spatial_mode_unsupported"
  | "spatial_transition_requires_new_turn"
  | "spatial_transition_command_mismatch"
  | "spatial_transition_already_applied"
  | "spatial_feature_unavailable";

interface SpatialErrorShape {
  name: "SpatialOwnerTurnError";
  code: SpatialOwnerTurnErrorCode;
  statusCode: 400 | 404 | 409;
  details?: {
    snapshot?: SpatialContextSnapshot;
    messageId?: string;
    travel?: ResolvedSpatialTravel;
    currentRevision?: number;
    currentLocationId?: string | null;
    currentBreadcrumb?: Array<{ id: string; name: string }>;
  };
}

export class SpatialOwnerTurnError extends Error implements SpatialErrorShape {
  readonly name = "SpatialOwnerTurnError";

  constructor(
    readonly code: SpatialOwnerTurnErrorCode,
    message: string,
    readonly statusCode: 400 | 404 | 409,
    readonly details?: SpatialErrorShape["details"],
  ) {
    super(message);
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "SpatialOwnerTurnError";
  }
}

export interface CommitSpatialOwnerTurnInput {
  chatId: string;
  content: string;
  transition: PendingSpatialTransition;
  gameStateSnapshotId?: string | null;
  attachments?: MessageAttachment[];
}

export type CommitSpatialOwnerTurnResult = {
  message: CapabilityMessageRecord;
  snapshot: SpatialContextSnapshot;
  travel?: ResolvedSpatialTravel;
};
export type AppliedSpatialOwnerTurn = {
  messageId: string;
  snapshot: SpatialContextSnapshot;
  travel?: ResolvedSpatialTravel;
};
interface OwnerTurnService {
  commitSpatialOwnerTurn(input: CommitSpatialOwnerTurnInput): Promise<CommitSpatialOwnerTurnResult>;
  findAppliedSpatialOwnerTurn?(
    input: Pick<CommitSpatialOwnerTurnInput, "chatId" | "transition">,
  ): Promise<AppliedSpatialOwnerTurn | null>;
}

export async function findAppliedSpatialOwnerTurn(
  input: Pick<CommitSpatialOwnerTurnInput, "chatId" | "transition">,
): Promise<AppliedSpatialOwnerTurn | null> {
  const provider = getCapabilityService<OwnerTurnService>("hierarchical-maps:owner-turn");
  if (!provider) throw new SpatialOwnerTurnError("spatial_feature_unavailable", "World Maps is not active.", 409);
  return provider.findAppliedSpatialOwnerTurn?.(input) ?? null;
}

export async function commitSpatialOwnerTurn(
  input: CommitSpatialOwnerTurnInput,
  options: { db?: DB } = {},
): Promise<CommitSpatialOwnerTurnResult> {
  const provider = getCapabilityService<OwnerTurnService>("hierarchical-maps:owner-turn");
  if (!provider) throw new SpatialOwnerTurnError("spatial_feature_unavailable", "World Maps is not active.", 409);
  const committed = await provider.commitSpatialOwnerTurn(input);
  // Pulse 4: the spatial snapshot stays the location owner; the accepted move is
  // projected into campaign memory as a movement transition after the durable
  // commit, best-effort, keyed by the committed message so a retry replays.
  const toLocationId = committed.snapshot.currentLocationId;
  if (toLocationId && committed.message?.id) {
    try {
      await recordLegacyMovement(options.db ?? (await getDB()), {
        chatId: input.chatId,
        messageId: committed.message.id,
        toLocationId,
        fromLocationId: committed.travel?.fromLocationId ?? input.transition.expectedCurrentLocationId,
      });
    } catch (error) {
      logger.warn({ err: error, chatId: input.chatId }, "[spatial] Movement transition was not recorded");
    }
  }
  return committed;
}
