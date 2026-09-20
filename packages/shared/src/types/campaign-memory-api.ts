import type {
  CampaignMemoryBacklink,
  CampaignMemoryCurrentState,
  CampaignMemoryEntity,
  CampaignMemoryEvidence,
  CampaignMemoryEvent,
  CampaignMemoryFact,
  CampaignMemoryKnowledge,
  CampaignMemoryMutationJournal,
} from "./campaign-memory.js";

/** Every collection reports truncation; a reader must never imply partial data is complete. */
export interface CampaignMemoryPage<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

/** Read-only wiki projection. Existing character/map/lore owners retain authority. */
export interface CampaignMemoryEntityDetail {
  entity: CampaignMemoryEntity;
  facts: CampaignMemoryPage<CampaignMemoryFact>;
  knowledge: CampaignMemoryPage<CampaignMemoryKnowledge>;
  events: CampaignMemoryPage<CampaignMemoryEvent>;
  /** Immutable events referenced by the bounded current-state page, even when outside the event page. */
  referencedEvents?: CampaignMemoryEvent[];
  currentState: CampaignMemoryPage<CampaignMemoryCurrentState>;
  relationships: CampaignMemoryPage<CampaignMemoryBacklink>;
  relatedEntities: CampaignMemoryEntity[];
  referencedFacts: CampaignMemoryFact[];
  sourceChecks?: Record<string, CampaignMemorySourceCheck>;
}

export type CampaignMemorySourceCheckState = "current" | "stale" | "legacy" | "manual";
export interface CampaignMemorySourceCheck {
  state: CampaignMemorySourceCheckState;
  reason?: string;
}

/** HTTP authoring boundary.  Actor and provenance are deliberately absent: the server derives both. */
export type CampaignMemoryAuthoringRecordType = "entity" | "fact" | "knowledge" | "relationship";
export type CampaignMemoryAuthoringAction = "create" | "update";

export interface CampaignMemoryAuthoringRequest {
  operationId: string;
  action: CampaignMemoryAuthoringAction;
  recordType: CampaignMemoryAuthoringRecordType;
  recordId?: string;
  expectedRevision?: number;
  reason: string;
  evidence?: CampaignMemoryEvidence[];
  input?: Record<string, unknown>;
  patch?: Record<string, unknown>;
}

export interface CampaignMemoryAuthoringPreview {
  validated: true;
  persisted: false;
  recordType: CampaignMemoryAuthoringRecordType;
  action: CampaignMemoryAuthoringAction;
  before?: unknown;
  after?: unknown;
  diff: Record<string, unknown>;
}

export interface CampaignMemoryAuditPage {
  items: CampaignMemoryMutationJournal[];
  total: number;
  offset: number;
  limit: number;
}
