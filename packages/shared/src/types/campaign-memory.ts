import type { CampaignMemoryPage } from "./campaign-memory-api.js";

/**
 * Pulse 3 campaign memory contracts.
 *
 * `chatId` is the branch scope.  It is deliberately present on every
 * durable record so an adapter cannot accidentally perform an unscoped
 * lookup.  These records reference existing owners; they are not copies of
 * cards, spatial state, or lorebook entries.
 */
export type CampaignMemoryEntityKind =
  | "character"
  | "persona"
  | "location"
  | "organization"
  | "item"
  | "quest"
  | "lore"
  | "note";

export type CampaignMemoryRecordStatus = "active" | "archived";
/** `verified` is review acceptance; proposition truth remains in the structured value. `retracted` removes canonical force. */
export type CampaignMemoryFactStatus = "proposed" | "verified" | "superseded" | "held" | "retracted";
export type CampaignMemoryRelationshipStatus = "proposed" | "active" | "ended" | "held";
export type CampaignMemoryEpistemicState = "knows" | "believes" | "rumor" | "unknown";
export type CampaignMemoryActor = "system" | "user" | "import";
export type CampaignMemoryConfidence = "low" | "medium" | "high";

export type CampaignMemoryJson =
  | null
  | boolean
  | number
  | string
  | CampaignMemoryJson[]
  | { [key: string]: CampaignMemoryJson };

export interface CampaignMemoryEvidence {
  messageId: string;
  quote: string;
  /** SHA-256 of the complete active source message/swipe content at capture time. */
  sourceHash?: string;
}

export interface CampaignMemoryCondition {
  kind: string;
  value: CampaignMemoryJson;
}

export interface CampaignMemorySourceProvenance {
  source: string;
  sourceRevision: string;
  actor: CampaignMemoryActor;
  authoredAt?: string;
  /** Identity of the source record when an isolated branch projects historical memory. */
  origin?: {
    sourceChatId: string;
    sourceRecordId: string;
    /** Original capture orders retained when projecting records into a branch. */
    sourceOrders?: Partial<
      Record<
        | "validFromOrder"
        | "validToOrder"
        | "learnedAtOrder"
        | "occurrenceOrder"
        | "validAtOrder"
        | "effectiveFrom"
        | "effectiveTo",
        string
      >
    >;
  };
}

export interface CampaignMemoryExistingOwnerRef {
  type: "existing";
  store: string;
  recordId: string;
}

export interface CampaignMemoryRegistryOwnerRef {
  type: "registry";
  store: "campaign-memory";
  recordId: string;
}

export type CampaignMemoryOwnerRef = CampaignMemoryExistingOwnerRef | CampaignMemoryRegistryOwnerRef;

export interface CampaignMemoryEntity {
  entityId: string;
  chatId: string;
  kind: CampaignMemoryEntityKind;
  owner: CampaignMemoryOwnerRef;
  aliases: string[];
  tags: string[];
  summary?: string;
  /** Free-form prose notes (Markdown, up to 20,000 characters). Optional so existing records stay valid. */
  body?: string;
  attributes: Record<string, CampaignMemoryJson>;
  status: CampaignMemoryRecordStatus;
  manualLock: boolean;
  provenance: CampaignMemorySourceProvenance;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignMemoryFact {
  factId: string;
  chatId: string;
  subjectEntityId: string;
  predicate: string;
  value: CampaignMemoryJson;
  conditions: CampaignMemoryCondition[];
  status: CampaignMemoryFactStatus;
  validFromOrder?: string;
  validToOrder?: string;
  sourceRevision: string;
  evidence: CampaignMemoryEvidence[];
  author: CampaignMemoryActor;
  provenance: CampaignMemorySourceProvenance;
  manualLock: boolean;
  supersedesFactId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignMemoryKnowledge {
  knowledgeId: string;
  chatId: string;
  holderEntityId: string;
  factId?: string;
  attributedClaim?: { subjectEntityId: string; predicate: string; value: CampaignMemoryJson };
  epistemicState: CampaignMemoryEpistemicState;
  learnedFrom: CampaignMemoryEvidence[];
  learnedAtOrder?: string;
  confidence?: CampaignMemoryConfidence;
  provenance: CampaignMemorySourceProvenance;
  manualLock: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignMemoryEvent {
  eventId: string;
  chatId: string;
  occurrenceOrder: string;
  campaignTime?: string;
  participantEntityIds: string[];
  locationEntityId?: string;
  sourceRevision: string;
  transitions: string[];
  evidence: CampaignMemoryEvidence[];
  provenance: CampaignMemorySourceProvenance;
  immutable: true;
  createdAt: string;
}

export interface CampaignMemoryCurrentState {
  stateId: string;
  chatId: string;
  entityId: string;
  property: string;
  value: CampaignMemoryJson;
  sourceEventId: string;
  validAtOrder: string;
  protected: boolean;
  provenance: CampaignMemorySourceProvenance;
  manualLock: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignMemoryRelationship {
  relationshipId: string;
  chatId: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: string;
  inverseLabel: string;
  /** User-editable context, separate from source evidence. Missing on older records. */
  notes?: string;
  status: CampaignMemoryRelationshipStatus;
  effectiveFrom?: string;
  effectiveTo?: string;
  evidence: CampaignMemoryEvidence[];
  provenance: CampaignMemorySourceProvenance;
  manualLock: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignMemoryBacklink extends CampaignMemoryRelationship {
  direction: "outgoing" | "incoming";
  label: string;
}

/** A bounded neighborhood of existing organization records. Edges retain their write scope. */
export interface CampaignFactionWeb {
  entities: CampaignMemoryEntity[];
  relationships: CampaignMemoryPage<CampaignMemoryRelationship>;
}

export interface CampaignMemoryMutationJournal {
  journalId: string;
  chatId: string;
  operationId: string;
  recordType:
    | CampaignMemoryEntityKind
    | "entity"
    | "fact"
    | "knowledge"
    | "event"
    | "current-state"
    | "relationship"
    | "branch-projection"
    /** Pulse 4 typed transition (parent row of one or more child mutations). */
    | "transition";
  recordId: string;
  actor: CampaignMemoryActor;
  expectedRevision?: number;
  before?: CampaignMemoryJson;
  after?: CampaignMemoryJson;
  reason: string;
  evidence: CampaignMemoryEvidence[];
  compensationOperationId?: string;
  payloadHash: string;
  createdAt: string;
}

export interface CampaignMemoryScope {
  chatId: string;
}

export interface CampaignMemoryUpdateOptions {
  expectedRevision: number;
  actor: CampaignMemoryActor;
  reason: string;
  evidence?: CampaignMemoryEvidence[];
  operationId?: string;
}

export interface CampaignMemoryStorageError {
  code:
    | "CAMPAIGN_MEMORY_SCOPE_REQUIRED"
    | "CAMPAIGN_MEMORY_CHAT_NOT_FOUND"
    | "CAMPAIGN_MEMORY_NOT_FOUND"
    | "CAMPAIGN_MEMORY_CAS_MISMATCH"
    | "CAMPAIGN_MEMORY_IMMUTABLE"
    | "CAMPAIGN_MEMORY_LOCKED"
    | "CAMPAIGN_MEMORY_INVALID_REFERENCE"
    | "CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT"
    | "CAMPAIGN_MEMORY_CONFLICT"
    | "CAMPAIGN_MEMORY_INVALID_VALUE";
}
