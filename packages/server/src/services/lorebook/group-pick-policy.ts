import { isFeatureEnabled } from "../features/feature-settings.js";

/**
 * The `random` option for processLorebooks callers. With "Stable lorebook picks" on (the default)
 * it is undefined, so the scan seeds inclusion-group winners by chat id and the same candidates
 * pick the same entry every turn. Off returns Math.random: a supplied random source disables the
 * seed, so every scan re-rolls the winner as upstream does. Probability gates already default to
 * Math.random, so they are unchanged either way.
 */
export function lorebookGroupPickRandom(): (() => number) | undefined {
  return isFeatureEnabled("stableLorebookGroupPicks") ? undefined : Math.random;
}
