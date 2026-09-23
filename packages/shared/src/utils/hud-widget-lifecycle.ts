import type { HudWidget, HudWidgetType, WidgetUpdate } from "../types/game.js";
import {
  EXTENDED_HUD_WIDGET_TYPES,
  createExtendedWidgetConfig,
  isExtendedHudWidgetType,
  leadingWidgetNumber,
} from "./hud-widget-extended.js";

const types = new Set<HudWidgetType>([
  "progress_bar",
  "gauge",
  "relationship_meter",
  "counter",
  "stat_block",
  "list",
  "inventory_grid",
  "timer",
  ...EXTENDED_HUD_WIDGET_TYPES,
]);

/** Shared by live playback and branch restoration. Create never overwrites an existing widget. */
export function applyHudWidgetLifecycle(widgets: HudWidget[], update: WidgetUpdate): HudWidget[] {
  const { widgetId, changes } = update;
  if (!widgetId || widgetId.length > 80) return widgets;
  if (changes.action === "delete") return widgets.filter((widget) => widget.id !== widgetId);
  if (changes.action !== "create" || widgets.some((widget) => widget.id === widgetId)) return widgets;
  if (!changes.type || !types.has(changes.type) || !changes.label?.trim() || changes.label.length > 120) return widgets;
  if (changes.position && !["hud_left", "hud_right"].includes(changes.position)) return widgets;
  if (changes.icon && changes.icon.length > 16) return widgets;
  const finite = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const max = Math.max(1, finite(changes.max, 100));
  const value = Math.min(max, Math.max(0, leadingWidgetNumber(changes.value) ?? 0));
  const config: HudWidget["config"] = isExtendedHudWidgetType(changes.type)
    ? createExtendedWidgetConfig(changes.type, changes)
    : ["progress_bar", "gauge", "relationship_meter"].includes(changes.type)
      ? { value, startingValue: value, max }
      : changes.type === "counter"
        ? { count: finite(changes.count, 0) }
        : changes.type === "timer"
          ? { seconds: Math.max(0, finite(changes.seconds, 0)), running: changes.running === true }
          : changes.type === "stat_block"
            ? { stats: [] }
            : changes.type === "inventory_grid"
              ? { slots: 12, contents: [] }
              : { items: [] };
  return [
    ...widgets,
    {
      id: widgetId,
      type: changes.type,
      label: changes.label.trim(),
      ...(changes.icon ? { icon: changes.icon } : {}),
      position: changes.position ?? "hud_left",
      config,
    },
  ];
}
