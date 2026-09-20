export interface GameSceneVisit {
  location: string;
  present: string[];
  participants: string[];
  /** Exact NEW TURN excerpts proving newly introduced physical occupants. */
  presenceEvidence?: Array<{ name: string; quote: string }>;
  departures: Array<{ name: string; quote: string }>;
  facts: Array<{ text: string; quote: string }>;
}

export interface GameSceneTimelineEntry {
  id: string;
  location: string;
  participants: string[];
  present: string[];
  summary: string;
  closed: boolean;
  reviewed: boolean;
  messageIds: string[];
}

export interface GameSceneTimeline {
  scenes: GameSceneTimelineEntry[];
  pending: boolean;
  error: string | null;
  remaining: number;
  /** Closed scenes whose complete source turns are available for factual review. */
  reviewableSceneCount: number;
  needsReview: boolean;
}
