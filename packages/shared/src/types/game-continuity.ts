export type GameContinuityMode = "off" | "shadow" | "active";

export interface GameContinuityMetadata {
  mode: GameContinuityMode;
  extractorConnectionId?: string;
  verifierConnectionId?: string;
  extractionInstructions?: string;
  verificationInstructions?: string;
  activationMessageId?: string;
  activationAt?: string;
  /**
   * Per-chat provider stage timeout override in milliseconds: one number for every stage or a
   * per-stage map. Read at call time; never part of the frozen receipt config hash.
   */
  stageTimeoutMs?: number | { extract?: number; review?: number; repair?: number };
}

export interface GameContinuitySource {
  messageId: string;
  swipeIndex: number;
  hash: string;
  role: string;
  content: string;
  start?: number;
  end?: number;
}

export interface GameContinuityContextSource {
  messageId: string;
  swipeIndex: number;
  hash: string;
  role: string;
  content: string;
  start?: number;
  end?: number;
}

export interface GameContinuityHolderSnapshot {
  entityId: string;
  kind: "character" | "persona";
  store: "characters" | "personas" | "game-npcs";
  recordId: string;
  name: string;
}

export interface GameContinuityProviderSnapshot {
  connectionId?: string;
  provider?: string;
  model?: string;
  maxContext?: number;
  parametersHash?: string;
}

export type GameContinuityRecordKind =
  | "decision"
  | "promise"
  | "condition"
  | "event"
  | "learning"
  | "reaction"
  | "correction"
  | "other";
export type GameContinuityRecordStatus =
  | "proposed"
  | "accepted"
  | "completed"
  | "declined"
  | "cancelled"
  | "unresolved"
  | "asserted";

export interface GameContinuityEvidence {
  messageId: string;
  quote: string;
}

export type GameContinuityKnowledgeScope = "world" | "private" | "belief" | "rumor" | "unknown";

export interface GameContinuityKnowledge {
  scope: GameContinuityKnowledgeScope;
  holders: string[];
  holderRefs?: string[];
}

export interface GameContinuityRecord {
  id: string;
  kind: GameContinuityRecordKind;
  text: string;
  subjects: string[];
  conditions: string[];
  status: GameContinuityRecordStatus;
  evidence: GameContinuityEvidence[];
  keys: string[];
  /** Optional on the wire for legacy receipts; absent means unknown to consumers. */
  knowledge?: GameContinuityKnowledge;
}

export type GameContinuityMessageDispositionStatus = "covered" | "no_durable_facts" | "unresolved";
export interface GameContinuityMessageDisposition {
  messageId: string;
  status: GameContinuityMessageDispositionStatus;
  reason: string;
}

export interface GameContinuityExtraction {
  records: GameContinuityRecord[];
  dispositions: GameContinuityMessageDisposition[];
}

export type GameContinuityFindingKind =
  | "omission"
  | "attribution"
  | "condition"
  | "unsupported"
  | "contradiction"
  | "knowledge"
  | "other";
export interface GameContinuityReviewFinding {
  kind: GameContinuityFindingKind;
  messageId: string;
  quote: string;
  recordIds: string[];
  detail: string;
}
export interface GameContinuityReview {
  findings: GameContinuityReviewFinding[];
  dispositions: GameContinuityMessageDisposition[];
  /**
   * Records the reviewer still flagged after every repair attempt, withheld so the rest of the batch could publish,
   * with the findings that flagged them and any omissions it reported. Absent on a batch that reviewed clean.
   */
  withheld?: { records: GameContinuityRecord[]; findings: GameContinuityReviewFinding[] };
}

export type GameContinuityReceiptStatus =
  | "queued"
  | "extracting"
  | "reviewing"
  | "repairing"
  | "verified"
  | "published"
  | "unresolved"
  | "failed"
  | "stale";
export interface GameContinuityReceipt {
  id: string;
  chatId: string;
  sessionNumber: number;
  sourceHash: string;
  sources: GameContinuitySource[];
  context: GameContinuityContextSource[];
  configHash: string;
  config: {
    extractorConnectionId?: string;
    verifierConnectionId?: string;
    /** Frozen identity hint for source-grounded player attribution. */
    playerCharacter?: { id: string; name: string };
    extractionInstructions?: string;
    verificationInstructions?: string;
    extractor?: GameContinuityProviderSnapshot;
    verifier?: GameContinuityProviderSnapshot;
    historicalBackfill?: {
      id: string;
      fromMessageId: string;
      toMessageId: string;
      sessionNumber: number;
    };
  };
  status: GameContinuityReceiptStatus;
  attempts: number;
  repairAttempts: number;
  records: GameContinuityRecord[];
  dispositions: GameContinuityMessageDisposition[];
  review: GameContinuityReview | null;
  /** Immutable canonical holder identities captured when this receipt was enqueued. */
  knowledgeHolders?: GameContinuityHolderSnapshot[];
  knowledgeHoldersHash?: string;
  entryIds: string[];
  errorCode?: string;
  error?: string;
  /** Append-only per-stage timing and token usage; entries are never rewritten or removed. */
  telemetry?: GameContinuityTelemetryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface GameContinuityTelemetryEntry {
  stage: string;
  startedAt: string;
  elapsedMs: number;
  /** Time spent inside the provider call, excluding config reads and prompt fitting. */
  providerMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null;
  attempt: number;
}
