export interface GameTurnClock {
  day: number;
  hour: number;
  minute: number;
}

export type GameTurnReviewField = "time" | "location" | "presence";

export interface GameTurnReviewLocation {
  id: string | null;
  name: string;
}

export interface GameTurnReviewState {
  time: GameTurnClock | null;
  location: GameTurnReviewLocation | null;
  present: string[] | null;
}

export interface GameTurnReviewEvidence {
  messageId: string;
  swipeIndex: number;
  quote: string;
}

export interface GameTurnReviewChange {
  id: string;
  field: GameTurnReviewField;
  subject?: string;
  before: string | null;
  after: string | null;
  evidence: GameTurnReviewEvidence | null;
  source: "recorded" | "state_only";
  corrected?: boolean;
}

export interface GameTurnReview {
  messageId: string;
  swipeIndex: number;
  revision: string;
  pending: boolean;
  canCorrect: boolean;
  readOnlyReason?: string;
  before: GameTurnReviewState;
  after: GameTurnReviewState;
  /** Current editable clock for the latest turn; never used as historical evidence. */
  editableTime?: GameTurnClock | null;
  changes: GameTurnReviewChange[];
  locations: GameTurnReviewLocation[];
}

export type GameTurnReviewCorrection =
  | { field: "time"; value: GameTurnClock }
  | { field: "location"; locationId: string }
  | { field: "presence"; name: string; present: boolean; sourceHash?: string };
