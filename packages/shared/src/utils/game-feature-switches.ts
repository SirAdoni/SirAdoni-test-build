import type { HudWidget } from "../types/game.js";
import { isExtendedHudWidgetType } from "./hud-widget-extended.js";

/**
 * Per-game feature switches, stored as top-level chat metadata booleans on each session chat (and carried to
 * new sessions with the rest of the game's settings). A missing key means ON, which is the fork's behaviour;
 * `false` restores the upstream Marinara Engine behaviour for that feature.
 */
export const GAME_SCENE_TIMELINE_ENABLED_KEY = "gameSceneTimelineEnabled";
export const GAME_EXTENDED_WIDGETS_ENABLED_KEY = "gameExtendedWidgetsEnabled";
export const GAME_AUTO_SCENE_MEDIA_ENABLED_KEY = "gameAutoSceneMediaEnabled";

type MetadataLike = Record<string, unknown> | null | undefined;

/** Scene timeline: background scene review after each GM turn, the scene recap, and timeline-based presence. */
export function isGameSceneTimelineEnabled(metadata: MetadataLike): boolean {
  return metadata?.[GAME_SCENE_TIMELINE_ENABLED_KEY] !== false;
}

/** Extended HUD widgets: the extra widget types plus the GM's dynamic widget create/delete commands. */
export function isGameExtendedWidgetsEnabled(metadata: MetadataLike): boolean {
  return metadata?.[GAME_EXTENDED_WIDGETS_ENABLED_KEY] !== false;
}

/** Automatic scene media: the post-turn queue that generates scene images and media without being asked. */
export function isGameAutoSceneMediaEnabled(metadata: MetadataLike): boolean {
  return metadata?.[GAME_AUTO_SCENE_MEDIA_ENABLED_KEY] !== false;
}

/**
 * Widgets visible while extended widgets are OFF: upstream types only. Extended widgets are hidden, never
 * deleted, so turning the switch back ON shows them again with their saved values.
 */
export function upstreamHudWidgets<T extends Pick<HudWidget, "type">>(widgets: readonly T[]): T[] {
  return widgets.filter((widget) => !isExtendedHudWidgetType(widget.type));
}
