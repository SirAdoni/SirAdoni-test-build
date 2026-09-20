import type { GameTurnStoryboardKeyframe } from "@marinara-engine/shared";

/** While rendering, never leave the viewer empty when another frame is ready. */
export function findVisibleStoryboardKeyframe(
  frames: readonly GameTurnStoryboardKeyframe[],
  preferred: GameTurnStoryboardKeyframe | null,
  rendering: boolean,
  explicitSelection = false,
): GameTurnStoryboardKeyframe | null {
  if (!rendering || explicitSelection || preferred?.image || preferred?.video) return preferred;
  return frames.find((frame) => frame.image || frame.video) ?? preferred;
}

export function findReplayStoryboardKeyframe(
  frames: readonly GameTurnStoryboardKeyframe[],
  segmentIndex: number | null,
): GameTurnStoryboardKeyframe | null {
  if (frames.length === 0) return null;
  const sorted = [...frames].sort((a, b) => a.index - b.index);
  if (segmentIndex == null || !Number.isFinite(segmentIndex)) return sorted[0] ?? null;

  const exact = sorted.find((frame) => {
    const start = frame.sectionStartIndex ?? frame.sectionEndIndex;
    const end = frame.sectionEndIndex ?? frame.sectionStartIndex;
    if (start == null || end == null) return false;
    return segmentIndex >= Math.min(start, end) && segmentIndex <= Math.max(start, end);
  });
  if (exact) return exact;

  const anchored = sorted.filter((frame) => frame.sectionStartIndex != null || frame.sectionEndIndex != null);
  if (anchored.length === 0) return sorted[0] ?? null;
  return anchored.reduce((best, frame) => {
    const bestStart = best.sectionStartIndex ?? best.sectionEndIndex ?? 0;
    const bestEnd = best.sectionEndIndex ?? best.sectionStartIndex ?? bestStart;
    const frameStart = frame.sectionStartIndex ?? frame.sectionEndIndex ?? 0;
    const frameEnd = frame.sectionEndIndex ?? frame.sectionStartIndex ?? frameStart;
    const bestCenter = (bestStart + bestEnd) / 2;
    const frameCenter = (frameStart + frameEnd) / 2;
    return Math.abs(frameCenter - segmentIndex) < Math.abs(bestCenter - segmentIndex) ? frame : best;
  });
}
