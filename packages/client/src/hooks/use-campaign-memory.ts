import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CampaignMemoryAuditPage,
  CampaignMemoryAuthoringPreview,
  CampaignMemoryAuthoringRequest,
  CampaignMemoryEntity,
  CampaignMemoryEntityDetail,
  CampaignMemoryEntityKind,
  CampaignMemoryEpistemicState,
  CampaignMemoryFact,
  CampaignMemoryJson,
  CampaignMemoryKnowledge,
  CampaignMemoryCurrentState,
  CampaignMemoryRelationship,
  CampaignMemoryPage,
} from "@marinara-engine/shared";
import { api } from "../lib/api-client";

const campaignMemoryKeys = {
  all: ["campaign-memory"] as const,
  entities: (chatId: string, query: string, kind: CampaignMemoryEntityKind | "all", offset: number, limit: number) =>
    [...campaignMemoryKeys.all, "entities", chatId, query, kind, offset, limit] as const,
  entity: (chatId: string, entityId: string, offset: number, limit: number) =>
    [...campaignMemoryKeys.all, "entity", chatId, entityId, offset, limit] as const,
  source: (chatId: string, messageId: string, sourceHash: string) =>
    [...campaignMemoryKeys.all, "source", chatId, messageId, sourceHash] as const,
  timeline: (chatId: string, entityId: string, locationId: string, cursor: string, limit: number) =>
    [...campaignMemoryKeys.all, "timeline", chatId, entityId, locationId, cursor, limit] as const,
};

/** Search ranking tier reported per entity when a query is present (id > alias > prefix > text). */
export type CampaignMemoryMatchTier = "id" | "alias" | "prefix" | "text";
export type CampaignMemoryEntityListItem = CampaignMemoryEntity & { matchTier?: CampaignMemoryMatchTier };

/** Another knowledge holder of the same fact, excluding the page entity. */
export interface CampaignMemoryCoHolder {
  entityId: string;
  alias: string;
  epistemicState: CampaignMemoryEpistemicState;
}
export type CampaignMemoryFactWithCoHolders = CampaignMemoryFact & { coHolders?: CampaignMemoryCoHolder[] };

export interface CampaignMemoryTimelineRef {
  entityId: string;
  alias: string;
}

export interface CampaignMemoryTimelineItem {
  eventId: string;
  occurrenceOrder: string;
  campaignTime: string | null;
  location: CampaignMemoryTimelineRef | null;
  participants: CampaignMemoryTimelineRef[];
  summary: string;
  stateChanges: Array<{ entityId: string; key: string; value: CampaignMemoryJson }>;
  sourceMessageId: string | null;
}

export interface CampaignMemoryTimelinePage {
  items: CampaignMemoryTimelineItem[];
  nextCursor: string | null;
}

export interface CampaignMemorySource {
  messageId: string;
  sourceHash: string;
  swipeIndex: number;
  content: string;
}

type CampaignMemoryMutationRecord =
  | CampaignMemoryEntity
  | CampaignMemoryFact
  | CampaignMemoryKnowledge
  | CampaignMemoryCurrentState
  | CampaignMemoryRelationship;

export interface CampaignMemoryImportManifest {
  legacySourceHash: string;
  counts: Record<string, number>;
}

export interface CampaignMemoryImportPreview {
  manifest: CampaignMemoryImportManifest;
  heldEntityIds: string[];
  skippedExistingEntityIds: string[];
}

export interface CampaignMemoryImportResult {
  manifest: CampaignMemoryImportManifest;
  createdEntityIds: string[];
}

function withParams(path: string, params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export function useCampaignMemoryEntities(
  chatId: string | null,
  options: {
    query?: string;
    kind?: CampaignMemoryEntityKind | "all";
    offset?: number;
    limit?: number;
    enabled?: boolean;
  } = {},
) {
  const query = options.query?.trim() ?? "";
  const kind = options.kind ?? "all";
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  return useQuery({
    queryKey: campaignMemoryKeys.entities(chatId ?? "", query, kind, offset, limit),
    queryFn: () =>
      api.get<CampaignMemoryPage<CampaignMemoryEntityListItem>>(
        withParams(`/game/${chatId}/memory/entities`, {
          q: query,
          kind: kind === "all" ? undefined : kind,
          offset,
          limit,
        }),
      ),
    enabled: Boolean(chatId) && options.enabled !== false,
    staleTime: 30_000,
  });
}

export function useCampaignMemoryEntity(
  chatId: string | null,
  entityId: string | null,
  options: { offset?: number; limit?: number; enabled?: boolean } = {},
) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  return useQuery({
    queryKey: campaignMemoryKeys.entity(chatId ?? "", entityId ?? "", offset, limit),
    queryFn: () =>
      api.get<CampaignMemoryEntityDetail>(withParams(`/game/${chatId}/memory/entities/${entityId}`, { offset, limit })),
    enabled: Boolean(chatId && entityId) && options.enabled !== false,
    staleTime: 30_000,
  });
}

/** Campaign-wide (no filter) or entity/location-filtered timeline, cursor paged, ordered by occurrenceOrder. */
export function useCampaignMemoryTimeline(
  chatId: string | null,
  options: { entityId?: string; locationId?: string; cursor?: string; limit?: number; enabled?: boolean } = {},
) {
  const entityId = options.entityId ?? "";
  const locationId = options.locationId ?? "";
  const cursor = options.cursor ?? "";
  const limit = options.limit ?? 50;
  return useQuery({
    queryKey: campaignMemoryKeys.timeline(chatId ?? "", entityId, locationId, cursor, limit),
    queryFn: () =>
      api.get<CampaignMemoryTimelinePage>(
        withParams(`/game/${chatId}/memory/timeline`, { entityId, locationId, cursor, limit }),
      ),
    enabled: Boolean(chatId) && options.enabled !== false,
    staleTime: 30_000,
  });
}

export function useCampaignMemorySource(
  chatId: string,
  messageId: string,
  sourceHash: string | undefined,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: campaignMemoryKeys.source(chatId, messageId, sourceHash ?? ""),
    queryFn: () =>
      api.get<CampaignMemorySource>(withParams(`/game/${chatId}/memory/sources/${messageId}`, { sourceHash })),
    enabled: Boolean(chatId && messageId && sourceHash) && options.enabled === true,
    staleTime: 0,
  });
}

export function usePreviewCampaignMemoryMutation(chatId: string | null) {
  return useMutation<CampaignMemoryAuthoringPreview, unknown, CampaignMemoryAuthoringRequest>({
    mutationFn: (request) =>
      api.post<CampaignMemoryAuthoringPreview>(`/game/${chatId}/memory/mutations/preview`, request),
  });
}

export function useApplyCampaignMemoryMutation(chatId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<CampaignMemoryMutationRecord, unknown, CampaignMemoryAuthoringRequest>({
    mutationFn: (request) => api.post<CampaignMemoryMutationRecord>(`/game/${chatId}/memory/mutations`, request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignMemoryKeys.all });
    },
  });
}

export function useCompensateCampaignMemoryMutation(chatId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<
    CampaignMemoryMutationRecord,
    unknown,
    { operationId: string; originalOperationId: string; reason: string }
  >({
    mutationFn: (request) =>
      api.post<CampaignMemoryMutationRecord>(`/game/${chatId}/memory/mutations/compensate`, {
        ...request,
        evidence: [],
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignMemoryKeys.all });
    },
  });
}

export function useCampaignMemoryAudit(chatId: string | null) {
  return useQuery({
    queryKey: [...campaignMemoryKeys.all, "audit", chatId],
    queryFn: () => api.get<CampaignMemoryAuditPage>(`/game/${chatId}/memory/audit?offset=0&limit=20`),
    staleTime: 30_000,
  });
}

export function usePreviewCampaignMemoryImport(chatId: string | null) {
  return useMutation<CampaignMemoryImportPreview, unknown, { operationId: string }>({
    mutationFn: (request) => api.post<CampaignMemoryImportPreview>(`/game/${chatId}/memory/import/preview`, request),
  });
}

export function useApplyCampaignMemoryImport(chatId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<CampaignMemoryImportResult, unknown, { operationId: string; expectedSourceHash: string }>({
    mutationFn: (request) => api.post<CampaignMemoryImportResult>(`/game/${chatId}/memory/import`, request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignMemoryKeys.all });
    },
  });
}

/** Pulse 8 commitments (quests, promises, offers, invitations): projected from `commitment` facts and continuity-published records. */
export type CampaignMemoryCommitmentKind =
  | "invitation"
  | "promise"
  | "offer"
  | "quest"
  | "employment"
  | "candidacy"
  | "other";
export type CampaignMemoryCommitmentState =
  | "proposed"
  | "accepted"
  | "active"
  | "completed"
  | "declined"
  | "cancelled"
  | "unresolved";
export interface CampaignMemoryCommitmentTransition {
  factId: string;
  state: CampaignMemoryCommitmentState;
  sourceOrder: string | null;
  evidenceMessageIds: string[];
}
export interface CampaignMemoryCommitmentItem {
  /** Newest fact in the supersession chain; transitions name it and its `revision`. */
  commitmentId: string;
  subjectEntityId: string;
  kind: CampaignMemoryCommitmentKind;
  title: string;
  state: CampaignMemoryCommitmentState;
  conditions: string[];
  deadline: string | null;
  notes: string;
  participants: Array<{ entityId: string; alias: string; role: string }>;
  evidence: Array<{ messageId: string; quote: string; sourceHash?: string }>;
  transitions: CampaignMemoryCommitmentTransition[];
  historical: boolean;
  openSince: string | null;
  revision: number;
}
export interface CampaignMemoryCommitmentsPage {
  items: CampaignMemoryCommitmentItem[];
  nextCursor: string | null;
}
export interface CampaignMemoryCommitmentTransitionRequest {
  commitmentId: string;
  state: CampaignMemoryCommitmentState;
  expectedRevision: number;
  conditions?: string[];
  deadline?: string | null;
  notes?: string;
  evidence?: Array<{ messageId: string; quote: string }>;
  reason?: string;
  operationId?: string;
}

export function useCampaignMemoryCommitments(
  chatId: string | null,
  options: {
    entityId?: string;
    state?: CampaignMemoryCommitmentState;
    cursor?: string;
    limit?: number;
    enabled?: boolean;
  } = {},
) {
  const entityId = options.entityId ?? "";
  const state = options.state ?? "";
  const cursor = options.cursor ?? "";
  const limit = options.limit ?? 50;
  return useQuery({
    queryKey: [...campaignMemoryKeys.all, "commitments", chatId ?? "", entityId, state, cursor, limit] as const,
    queryFn: () =>
      api.get<CampaignMemoryCommitmentsPage>(
        withParams(`/game/${chatId}/memory/commitments`, { entityId, state, cursor, limit }),
      ),
    enabled: Boolean(chatId) && options.enabled !== false,
    staleTime: 30_000,
  });
}

/** Every state change creates a superseding fact; 409 means the commitment moved on (reload), 400 an illegal transition. */
export function useTransitionCampaignMemoryCommitment(chatId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<CampaignMemoryCommitmentItem, unknown, CampaignMemoryCommitmentTransitionRequest>({
    mutationFn: ({ commitmentId, ...body }) =>
      api.post<CampaignMemoryCommitmentItem>(`/game/${chatId}/memory/commitments/${commitmentId}/transition`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignMemoryKeys.all });
    },
  });
}
