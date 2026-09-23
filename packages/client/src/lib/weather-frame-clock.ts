export const WEATHER_TARGET_FRAME_MS = 1000 / 30;

export type WeatherFrameStep = {
  accumulatedMs: number;
  frameElapsedMs: number;
  shouldDraw: boolean;
};

export function advanceWeatherFrameClock(accumulatedMs: number, elapsedMs: number): WeatherFrameStep {
  const nextAccumulated = accumulatedMs + Math.min(100, Math.max(0, elapsedMs));
  if (nextAccumulated < WEATHER_TARGET_FRAME_MS) {
    return { accumulatedMs: nextAccumulated, frameElapsedMs: 0, shouldDraw: false };
  }

  return {
    accumulatedMs: nextAccumulated % WEATHER_TARGET_FRAME_MS,
    frameElapsedMs: nextAccumulated,
    shouldDraw: true,
  };
}
