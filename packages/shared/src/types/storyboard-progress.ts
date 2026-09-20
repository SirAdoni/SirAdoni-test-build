export interface StoryboardProgress {
  active: boolean;
  startedAt: number;
  elapsedMs: number;
  targetMs: number;
  steps: Array<{
    stage: string;
    startedAt: number;
    offsetMs: number;
    elapsedMs: number;
    durationMs?: number;
    failed?: boolean;
  }>;
}
