import type { HudWidget } from "../types/game.js";
import { isExtendedHudWidgetType } from "./hud-widget-extended.js";

export const GAME_EXTENDED_WIDGETS_ENABLED_KEY = "gameExtendedWidgetsEnabled";

/** Per-chat preference; the separate app-wide permission defaults OFF. */
export function isGameExtendedWidgetsEnabled(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.[GAME_EXTENDED_WIDGETS_ENABLED_KEY] !== false;
}

/** A view only: hidden extended widgets remain stored for re-enable. */
export function upstreamHudWidgets<T extends Pick<HudWidget, "type">>(widgets: readonly T[]): T[] {
  return widgets.filter((widget) => !isExtendedHudWidgetType(widget.type));
}

type MetadataLike = Record<string, unknown> | null | undefined;
export const GAME_SCENE_TIMELINE_ENABLED_KEY = "gameSceneTimelineEnabled";

/** Scene timeline: background scene review after each GM turn, the scene recap, and timeline-based presence. */
export function isGameSceneTimelineEnabled(metadata: MetadataLike): boolean {
  return metadata?.[GAME_SCENE_TIMELINE_ENABLED_KEY] !== false;
}
