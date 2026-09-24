import { useSyncExternalStore } from "react";

/**
 * Short Game viewports below the floating layout, told apart by device.
 *
 * The viewport alone cannot tell a landscape phone from a landscape tablet with its on-screen
 * keyboard up: both are short and below the floating layout (a 1024x768 tablet shrinks to about
 * 1023x461). The device's screen does not shrink with the keyboard, so its short side decides:
 * a phone is under 600px on its short side, a tablet is at least that.
 * - "phone": landscape phones fold the Game chrome into one top row so narration keeps the height.
 * - "tablet": a tablet (or a short desktop window) keeps the tablet layout; only the chrome that
 *   would squeeze the narration and composer steps aside while the viewport is short.
 */
export type ShortGameViewport = "phone" | "tablet" | null;

export const SHORT_LANDSCAPE_VIEWPORT_QUERY = "(max-width: 1023px) and (max-height: 32rem)";
/** Screens whose short side is at least this wide are tablets or larger, whatever the viewport height. */
export const PHONE_SCREEN_SHORT_SIDE_MAX = 600;
/** Root attributes the `game-short-landscape:` and `game-short-tablet:` Tailwind variants key on (see globals.css). */
export const SHORT_LANDSCAPE_ATTRIBUTE = "data-game-short-landscape";
export const SHORT_TABLET_ATTRIBUTE = "data-game-short-tablet";

export interface ShortLandscapeEnvironment {
  /** The viewport matches SHORT_LANDSCAPE_VIEWPORT_QUERY. */
  shortViewport: boolean;
  screenWidth: number;
  screenHeight: number;
}

/** Which short layout applies. Unknown screen sizes (0 or missing) keep the phone answer, as before. */
export function classifyShortGameViewport({
  shortViewport,
  screenWidth,
  screenHeight,
}: ShortLandscapeEnvironment): ShortGameViewport {
  if (!shortViewport) return null;
  const sides = [screenWidth, screenHeight].filter((side) => Number.isFinite(side) && side > 0);
  if (sides.length === 0) return "phone";
  return Math.min(...sides) < PHONE_SCREEN_SHORT_SIDE_MAX ? "phone" : "tablet";
}

/** A short viewport on a phone-sized screen: the landscape phone layout. */
export function isShortLandscapeGameEnvironment(environment: ShortLandscapeEnvironment) {
  return classifyShortGameViewport(environment) === "phone";
}

function readEnvironment(): ShortGameViewport {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return classifyShortGameViewport({
    shortViewport: window.matchMedia(SHORT_LANDSCAPE_VIEWPORT_QUERY).matches,
    screenWidth: window.screen?.width ?? 0,
    screenHeight: window.screen?.height ?? 0,
  });
}

const listeners = new Set<() => void>();
let current: ShortGameViewport = null;
let installed = false;

function applyAttributes(value: ShortGameViewport) {
  if (typeof document === "undefined") return;
  document.documentElement.toggleAttribute(SHORT_LANDSCAPE_ATTRIBUTE, value === "phone");
  document.documentElement.toggleAttribute(SHORT_TABLET_ATTRIBUTE, value === "tablet");
}

function refresh() {
  const next = readEnvironment();
  applyAttributes(next);
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Tracks the state on the document root for the Tailwind variants; safe to call more than once. */
export function installShortLandscapeGame() {
  if (installed || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  installed = true;
  current = readEnvironment();
  applyAttributes(current);
  window.matchMedia(SHORT_LANDSCAPE_VIEWPORT_QUERY).addEventListener("change", refresh);
  window.addEventListener("resize", refresh);
  window.addEventListener("orientationchange", refresh);
}

/** Current state, for event handlers. */
export function getShortGameViewport(): ShortGameViewport {
  installShortLandscapeGame();
  return current;
}

/** Landscape phone layout right now, for event handlers. */
export function isShortLandscapeGame() {
  return getShortGameViewport() === "phone";
}

function subscribe(listener: () => void) {
  installShortLandscapeGame();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Short Game viewport state, unaffected by a tablet's keyboard telling it apart from a phone. */
export function useShortGameViewport() {
  return useSyncExternalStore(subscribe, getShortGameViewport, () => null);
}

/** Landscape phone Game layout: short viewport on a phone-sized screen. */
export function useShortLandscapeGame() {
  return useShortGameViewport() === "phone";
}

installShortLandscapeGame();
