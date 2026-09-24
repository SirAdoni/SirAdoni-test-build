import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { ApiError, api } from "../lib/api-client";

const campaignMemoryKeys = {
  all: ["campaign-memory"] as const,
  entities: (
    chatId: string,
    query: string,
    kind: CampaignMemoryEntityKind | "all",
    offset: number,
    limit: number,
    sort: CampaignMemoryEntitySort | "" = "",
  ) => [...campaignMemoryKeys.all, "entities", chatId, query, kind, offset, limit, sort] as const,
  entity: (chatId: string, entityId: string, offset: number, limit: number, filters: CampaignMemoryFactFilters = {}) =>
    [
      ...campaignMemoryKeys.all,
      "entity",
      chatId,
      entityId,
      offset,
      limit,
      filters.factQuery ?? "",
      filters.factKind ?? "",
      filters.session ?? "",
    ] as const,
  entityFacts: (chatId: string, entityId: string, limit: number, filters: CampaignMemoryFactFilters = {}) =>
    [
      ...campaignMemoryKeys.all,
      "entity-facts",
      chatId,
      entityId,
      limit,
      filters.factQuery ?? "",
      filters.factKind ?? "",
      filters.session ?? "",
    ] as const,
  source: (chatId: string, messageId: string, sourceHash: string) =>
    [...campaignMemoryKeys.all, "source", chatId, messageId, sourceHash] as const,
  timeline: (chatId: string, entityId: string, locationId: string, cursor: string, limit: number) =>
    [...campaignMemoryKeys.all, "timeline", chatId, entityId, locationId, cursor, limit] as const,
};

/** Search ranking tier reported per entity when a query is present (id > alias > prefix > text). */
export type CampaignMemoryMatchTier = "id" | "alias" | "prefix" | "text";
export type CampaignMemoryEntityListItem = CampaignMemoryEntity & { matchTier?: CampaignMemoryMatchTier };
/** List order: `name` (server default) or `kind` (people, places, ... lore, notes; archived last; name order within). */
export type CampaignMemoryEntitySort = "name" | "kind";
/**
 * Entity list page. Newer servers add `kindTotals`: pages per kind over the whole (unfiltered by kind) list, so one
 * request can label every kind chip. Absent on older builds.
 */
export type CampaignMemoryEntityListPage = CampaignMemoryPage<CampaignMemoryEntityListItem> & {
  kindTotals?: Partial<Record<CampaignMemoryEntityKind, number>>;
};

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
  /** Campaign scope: the chat and session number the event was recorded in (absent on older servers). */
  originChatId?: string;
  originSessionNumber?: number;
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
    /** Sent only when set; older servers ignore it and answer in name order. */
    sort?: CampaignMemoryEntitySort;
    enabled?: boolean;
  } = {},
) {
  const query = options.query?.trim() ?? "";
  const kind = options.kind ?? "all";
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  const sort = options.sort ?? "";
  return useQuery({
    queryKey: campaignMemoryKeys.entities(chatId ?? "", query, kind, offset, limit, sort),
    queryFn: () =>
      api.get<CampaignMemoryEntityListPage>(
        withParams(`/game/${chatId}/memory/entities`, {
          q: query,
          kind: kind === "all" ? undefined : kind,
          offset,
          limit,
          sort: sort || undefined,
        }),
      ),
    enabled: Boolean(chatId) && options.enabled !== false,
    staleTime: 30_000,
  });
}

/**
 * Optional fact filters on GET /memory/entities/:id, each sent only when set: `factQuery` is a case-insensitive
 * substring over the predicate and the JSON value, `factKind` the continuity kind (or the predicate without its
 * "continuity." prefix), `session` the fact's originSessionNumber. Older servers ignore them.
 */
export interface CampaignMemoryFactFilters {
  factQuery?: string;
  factKind?: string;
  session?: number;
}

/**
 * Entity detail as newer servers send it: `factSessions` / `factKinds` cover ALL facts of the entity regardless of
 * filters and paging (factSessions newest first, factKinds largest first). Absent on older builds.
 */
export type CampaignMemoryEntityDetailWithSessions = CampaignMemoryEntityDetail & {
  factSessions?: Array<{ sessionNumber: number | null; total: number }>;
  factKinds?: Array<{ kind: string; total: number }>;
};

function factFilterParams(filters: CampaignMemoryFactFilters) {
  return {
    factQuery: filters.factQuery?.trim() || undefined,
    factKind: filters.factKind || undefined,
    session: filters.session === undefined ? undefined : String(filters.session),
  };
}

export function useCampaignMemoryEntity(
  chatId: string | null,
  entityId: string | null,
  options: { offset?: number; limit?: number; enabled?: boolean } & CampaignMemoryFactFilters = {},
) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  const filters = factFilterParams(options);
  return useQuery({
    queryKey: campaignMemoryKeys.entity(chatId ?? "", entityId ?? "", offset, limit, options),
    queryFn: () =>
      api.get<CampaignMemoryEntityDetailWithSessions>(
        withParams(`/game/${chatId}/memory/entities/${entityId}`, { offset, limit, ...filters }),
      ),
    enabled: Boolean(chatId && entityId) && options.enabled !== false,
    staleTime: 30_000,
  });
}

/**
 * Successive fact pages of one page entity (the detail route pages every section with one offset; only `facts` is
 * read from the later pages). `initialPage` seeds the first page from an already loaded detail.
 */
export function useCampaignMemoryEntityFacts(
  chatId: string | null,
  entityId: string | null,
  options: {
    limit?: number;
    enabled?: boolean;
    initialPage?: CampaignMemoryEntityDetail;
  } & CampaignMemoryFactFilters = {},
) {
  const limit = options.limit ?? 50;
  const filters = factFilterParams(options);
  const initialPage = options.initialPage;
  return useInfiniteQuery({
    queryKey: campaignMemoryKeys.entityFacts(chatId ?? "", entityId ?? "", limit, options),
    queryFn: ({ pageParam }) =>
      api.get<CampaignMemoryEntityDetailWithSessions>(
        withParams(`/game/${chatId}/memory/entities/${entityId}`, { offset: pageParam, limit, ...filters }),
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.facts.offset + last.facts.items.length;
      return last.facts.items.length > 0 && next < last.facts.total ? next : undefined;
    },
    initialData: initialPage && initialPage.facts.offset === 0 ? { pages: [initialPage], pageParams: [0] } : undefined,
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

/**
 * Update patches are partial on the server: only the keys sent change, and a missing key keeps its stored value. So the
 * patch carries just the changed fields (Pin sends value + manualLock, Wrong sends status + manualLock). Re-sending the
 * whole record would also re-send `supersedesFactId`, which the server re-maps and can refuse across sessions.
 */
function factUpdatePatch(changes: CampaignMemoryFactChanges) {
  return {
    ...(changes.value !== undefined ? { value: changes.value } : {}),
    ...(changes.status !== undefined ? { status: changes.status } : {}),
    ...(changes.manualLock !== undefined ? { manualLock: changes.manualLock } : {}),
  };
}

export type CampaignMemoryFactChanges = Partial<Pick<CampaignMemoryFact, "status" | "manualLock" | "value">>;

export interface CampaignMemoryFactUpdateRequest {
  fact: CampaignMemoryFact;
  changes: CampaignMemoryFactChanges;
  reason: string;
  operationId: string;
}

/**
 * Status / lock / pin change on one fact (pin as canon, unpin, mark wrong), sent as a partial patch of only those
 * fields. `chatId` must be the fact's own session (recordWriteChatId). A 409 is either a revision conflict (the fact
 * changed since it was loaded) or CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE, which a reload does not fix.
 */
export function useUpdateCampaignMemoryFact(chatId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<CampaignMemoryMutationRecord, unknown, CampaignMemoryFactUpdateRequest>({
    mutationFn: ({ fact, changes, reason, operationId }) =>
      api.post<CampaignMemoryMutationRecord>(`/game/${chatId}/memory/mutations`, {
        operationId,
        action: "update",
        recordType: "fact",
        recordId: fact.factId,
        expectedRevision: fact.revision,
        reason,
        patch: factUpdatePatch(changes),
      } satisfies CampaignMemoryAuthoringRequest),
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
  /**
   * Head fact ids of every per-person copy merged into this promise (the server groups copies sharing a receipt and
   * record). `commitmentId`/`revision` are the representative's, so transitions stay on the item as listed.
   */
  memberCommitmentIds?: string[];
}
export interface CampaignMemoryCommitmentsPage {
  items: CampaignMemoryCommitmentItem[];
  nextCursor: string | null;
  /** Merged commitments matching the filters, the unit the pages count. */
  total?: number;
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

/** One fact of a duplicate group as GET /memory/review/duplicates sends it (the chat's own, unprojected fact). */
export interface CampaignMemoryDuplicateFact {
  factId: string;
  receiptId: string | null;
  status: CampaignMemoryFact["status"];
  /** The continuity text, or the JSON of a plain value. */
  text: string;
  evidenceMessageIds: string[];
  sourceOrder: string | null;
  historical: boolean;
}
export interface CampaignMemoryDuplicateGroup {
  groupId: string;
  subjectEntityId: string;
  predicate: string;
  /** Oldest source first. */
  facts: CampaignMemoryDuplicateFact[];
  reason: "overlapping-evidence" | "similar-text";
  similarity: number | null;
}
export interface CampaignMemoryDuplicatesPage {
  groups: CampaignMemoryDuplicateGroup[];
  nextCursor: string | null;
}
/** A session chat of the campaign; duplicate review reads and resolves per session chat. */
export interface CampaignMemorySessionChat {
  chatId: string;
  sessionNumber: number | null;
}
/** A duplicate group labelled with the session chat it was found in (resolve goes to that chat). */
export type CampaignMemorySessionDuplicateGroup = CampaignMemoryDuplicateGroup & CampaignMemorySessionChat;

/** Groups per request (server maximum) and a cap on pages per session chat. */
const DUPLICATES_PAGE = 100;
const DUPLICATES_MAX_PAGES = 10;

/** A 404 from a route an older server does not have; a memory 404 (missing chat or record) names its code. */
function isMissingRoute(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 404) return false;
  const body = (error.payload ?? {}) as { error?: { code?: unknown } | string };
  const code = error.code ?? (typeof body.error === "object" && body.error ? body.error.code : undefined);
  return typeof code !== "string" || !code.startsWith("CAMPAIGN_MEMORY_");
}

/**
 * Near-duplicate fact groups of every session chat of the campaign, each labelled with its session. `unsupported` is
 * true when no session chat knows the route (an older server).
 */
export function useCampaignMemoryDuplicates(
  sessions: CampaignMemorySessionChat[],
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: [
      ...campaignMemoryKeys.all,
      "duplicates",
      sessions.map((session) => `${session.chatId}:${session.sessionNumber ?? ""}`).join(","),
    ] as const,
    queryFn: async () => {
      const groups: CampaignMemorySessionDuplicateGroup[] = [];
      let supported = 0;
      let truncated = false;
      for (const session of sessions) {
        let cursor: string | null = null;
        try {
          for (let pageIndex = 0; pageIndex < DUPLICATES_MAX_PAGES; pageIndex += 1) {
            const page: CampaignMemoryDuplicatesPage = await api.get<CampaignMemoryDuplicatesPage>(
              withParams(`/game/${session.chatId}/memory/review/duplicates`, {
                limit: DUPLICATES_PAGE,
                cursor: cursor ?? undefined,
              }),
            );
            for (const group of page.groups) groups.push({ ...group, ...session });
            cursor = page.nextCursor;
            if (!cursor) break;
          }
          supported += 1;
          if (cursor) truncated = true;
        } catch (error) {
          if (!isMissingRoute(error)) throw error;
        }
      }
      return { groups, unsupported: sessions.length > 0 && supported === 0, truncated };
    },
    enabled: sessions.length > 0 && options.enabled !== false,
    staleTime: 5 * 60_000,
  });
}

/**
 * The stored records (with revisions) of one duplicate group, read unprojected (`scope=session`) from the group's own
 * session chat, so the ids match the group and the revisions are the ones resolve checks.
 */
export function useCampaignMemoryDuplicateRecords(group: CampaignMemorySessionDuplicateGroup | null) {
  return useQuery({
    queryKey: [...campaignMemoryKeys.all, "duplicate-records", group?.chatId ?? "", group?.groupId ?? ""] as const,
    queryFn: async () => {
      const wanted = new Set(group!.facts.map((fact) => fact.factId));
      const found = new Map<string, CampaignMemoryFact>();
      for (let offset = 0; found.size < wanted.size; offset += 100) {
        const page = await api.get<CampaignMemoryPage<CampaignMemoryFact>>(
          withParams(`/game/${group!.chatId}/memory/entities/${group!.subjectEntityId}/facts`, {
            scope: "session",
            offset,
            limit: 100,
          }),
        );
        for (const fact of page.items) if (wanted.has(fact.factId)) found.set(fact.factId, fact);
        if (page.items.length === 0 || offset + page.items.length >= page.total) break;
      }
      return found;
    },
    enabled: Boolean(group),
    staleTime: 30_000,
  });
}

export interface CampaignMemoryDuplicateResolveRequest {
  chatId: string;
  groupId: string;
  keepFactId: string;
  retireFactIds: string[];
  expectedRevisions: Record<string, number>;
}
export interface CampaignMemoryDuplicateResolveResult {
  groupId: string;
  keepFactId: string;
  retiredFactIds: string[];
  linkedFactId: string | null;
}

/** Keep one fact of a group and supersede the others, in the group's own session chat. A 409 means reload the group. */
export function useResolveCampaignMemoryDuplicates() {
  const queryClient = useQueryClient();
  return useMutation<CampaignMemoryDuplicateResolveResult, unknown, CampaignMemoryDuplicateResolveRequest>({
    mutationFn: ({ chatId, groupId, ...body }) =>
      api.post<CampaignMemoryDuplicateResolveResult>(
        `/game/${chatId}/memory/review/duplicates/${encodeURIComponent(groupId)}/resolve`,
        body,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignMemoryKeys.all });
    },
  });
}

/** GET /memory/entities/:id/references: campaign-wide counts of the records naming a page, with a few sample ids. */
export interface CampaignMemoryReferences {
  facts: number;
  knowledge: number;
  events: number;
  relationships: number;
  states: number;
  samples: Partial<Record<"facts" | "knowledge" | "events" | "relationships" | "states", string[]>>;
}

export function useCampaignMemoryReferences(chatId: string | null, entityId: string | null) {
  return useQuery({
    queryKey: [...campaignMemoryKeys.all, "references", chatId ?? "", entityId ?? ""] as const,
    queryFn: () => api.get<CampaignMemoryReferences>(`/game/${chatId}/memory/entities/${entityId}/references`),
    enabled: Boolean(chatId && entityId),
    staleTime: 60_000,
    retry: false,
  });
}

/** A fact from the campaign-wide GET /memory/facts, with its subject's name and origin session. */
export type CampaignMemoryListedFact = CampaignMemoryFact & {
  subject: { entityId: string; alias: string };
  originChatId?: string;
  originSessionNumber?: number;
};

const PINNED_PAGE = 100;

/**
 * Every pinned fact of the campaign (manualLock and value.pinned), newest session first, paged by offset.
 * `unsupported` is true when the server has no GET /memory/facts yet (it answers 404); nothing else is fetched then.
 */
export function useCampaignMemoryPinnedFacts(chatId: string | null, options: { query?: string } = {}) {
  const query = options.query?.trim() ?? "";
  const result = useInfiniteQuery({
    queryKey: [...campaignMemoryKeys.all, "pinned-facts", chatId ?? "", query] as const,
    queryFn: async ({ pageParam }) => {
      try {
        return await api.get<CampaignMemoryPage<CampaignMemoryListedFact>>(
          withParams(`/game/${chatId}/memory/facts`, {
            pinned: "true",
            q: query,
            offset: pageParam,
            limit: PINNED_PAGE,
          }),
        );
      } catch (error) {
        if (isMissingRoute(error)) return null;
        throw error;
      }
    },
    initialPageParam: 0,
    getNextPageParam: (last: CampaignMemoryPage<CampaignMemoryListedFact> | null) => {
      if (!last) return undefined;
      const next = last.offset + last.items.length;
      return last.items.length > 0 && next < last.total ? next : undefined;
    },
    enabled: Boolean(chatId),
    staleTime: 30_000,
  });
  const pages = result.data?.pages ?? [];
  return {
    ...result,
    unsupported: pages.length > 0 && pages[0] === null,
    facts: pages.flatMap((page) => page?.items ?? []),
    total: pages[0]?.total ?? 0,
  };
}
