import { applyHudWidgetLifecycle, type HudWidget, type WidgetUpdate } from "@marinara-engine/shared";
import type { Journal, JournalEntry } from "./journal.service.js";

function normalizeListItem(value: string): string {
  return value
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?;,:]+$/g, "")
    .toLowerCase();
}

function readWidgetParam(body: string, name: string): string | null {
  const match = body.match(new RegExp(`(?:^|,)\\s*${name}:\\s*(?:"([^"]*)"|'([^']*)'|([^,]*))`, "i"));
  const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  return value || null;
}

export function restoreBranchHudLists(
  metadata: Record<string, unknown>,
  copiedMessages: Array<{ content?: string | null }>,
): HudWidget[] {
  const blueprint = metadata.gameBlueprint as { hudWidgets?: unknown } | null;
  const setup = metadata.gameSetupConfig as { customHudWidgets?: unknown } | null;
  const hasBlueprintWidgets = Array.isArray(blueprint?.hudWidgets);
  const hasSetupWidgets = Array.isArray(setup?.customHudWidgets);
  const initial = hasBlueprintWidgets
    ? (blueprint.hudWidgets as HudWidget[])
    : hasSetupWidgets
      ? (setup.customHudWidgets as HudWidget[])
      : Array.isArray(metadata.gameWidgetState)
        ? (metadata.gameWidgetState as HudWidget[])
        : [];
  let widgets = initial.map((widget) => ({
    ...widget,
    config: {
      ...widget.config,
      ...(!hasBlueprintWidgets && widget.type === "list" ? { items: [] } : {}),
    },
  }));

  for (const message of copiedMessages) {
    for (const match of (message.content ?? "").matchAll(/\[widget:\s*([^,\]]+),([^\]]*)\]/gi)) {
      const widgetId = match[1]!.trim();
      const body = match[2] ?? "";
      const action = readWidgetParam(body, "action");
      if (action === "create" || action === "delete") {
        const changes: WidgetUpdate["changes"] = {
          action,
          type: readWidgetParam(body, "type") as WidgetUpdate["changes"]["type"],
          label: readWidgetParam(body, "label") ?? undefined,
          icon: readWidgetParam(body, "icon") ?? undefined,
          position: readWidgetParam(body, "position") as WidgetUpdate["changes"]["position"],
        };
        for (const key of ["value", "max", "count", "seconds"] as const) {
          const value = readWidgetParam(body, key);
          if (value !== null) changes[key] = Number(value);
        }
        changes.running = readWidgetParam(body, "running") === "true";
        widgets = applyHudWidgetLifecycle(widgets, { widgetId, changes });
        continue;
      }
      const add = readWidgetParam(match[2] ?? "", "add");
      const remove = readWidgetParam(match[2] ?? "", "remove");
      widgets = widgets.map((widget) => {
        if (widget.id !== widgetId) return widget;
        if (widget.type !== "list") {
          const config = { ...widget.config };
          const stat = readWidgetParam(body, "stat");
          const rawValue = readWidgetParam(body, "value");
          if (stat && widget.type === "stat_block" && rawValue !== null) {
            const value = Number.isFinite(Number(rawValue)) ? Number(rawValue) : rawValue;
            const stats = [...(config.stats ?? [])];
            const index = stats.findIndex((s) => s.name.toLowerCase() === stat.toLowerCase());
            if (index < 0) stats.push({ name: stat, value });
            else stats[index] = { ...stats[index]!, value };
            config.stats = stats;
          } else {
            for (const key of ["value", "count", "seconds"] as const) {
              const value = readWidgetParam(body, key);
              if (value !== null && Number.isFinite(Number(value))) config[key] = Number(value);
            }
            const running = readWidgetParam(body, "running");
            if (running !== null) config.running = running === "true";
          }
          if (widget.type === "inventory_grid") {
            if (remove) config.contents = (config.contents ?? []).filter((c) => c.name !== remove);
            if (add) config.contents = [...(config.contents ?? []), { name: add, quantity: 1 }];
          }
          return { ...widget, config };
        }
        let items = [...(widget.config.items ?? [])];
        if (remove) {
          const target = normalizeListItem(remove);
          items = items.filter((item) => normalizeListItem(item) !== target);
        }
        if (add) {
          const target = normalizeListItem(add);
          items = [...items.filter((item) => normalizeListItem(item) !== target), add].slice(-5);
        }
        return { ...widget, config: { ...widget.config, items } };
      });
    }
  }
  return widgets;
}

function normalizedEntryTitle(entry: JournalEntry): string {
  return entry.title
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim()
    .toLowerCase();
}

export function trimJournalForBranch(
  journal: Journal,
  copiedMessageIds: Set<string>,
  cutoffCreatedAt: string,
): Journal {
  const cutoff = Date.parse(cutoffCreatedAt);
  if (!Number.isFinite(cutoff)) return journal;
  const beforeCutoff = (timestamp: string | undefined) => {
    const parsed = Date.parse(timestamp ?? "");
    return Number.isFinite(parsed) && parsed < cutoff;
  };
  const entries = journal.entries.filter((entry) =>
    entry.sourceMessageId ? copiedMessageIds.has(entry.sourceMessageId) : beforeCutoff(entry.timestamp),
  );
  const locationNames = new Set(
    entries
      .filter((entry) => entry.type === "location")
      .map((entry) =>
        entry.title
          .replace(/^Discovered:\s*/i, "")
          .trim()
          .toLowerCase(),
      ),
  );
  const npcEntries = entries.filter((entry) => entry.type === "npc");

  return {
    ...journal,
    entries,
    locations: journal.locations.filter((location) => locationNames.has(location.trim().toLowerCase())),
    npcLog: journal.npcLog
      .map((npc) => ({
        ...npc,
        interactions: npc.interactions.filter((interaction) =>
          npcEntries.some(
            (entry) =>
              normalizedEntryTitle(entry) === npc.npcName.trim().toLowerCase() &&
              entry.content.trim() === interaction.trim(),
          ),
        ),
      }))
      .filter((npc) => npc.interactions.length > 0),
    inventoryLog: journal.inventoryLog.filter((entry) => beforeCutoff(entry.timestamp)),
    quests: journal.quests
      .filter((quest) => beforeCutoff(quest.discoveredAt))
      .map((quest) =>
        quest.completedAt && !beforeCutoff(quest.completedAt)
          ? { ...quest, status: "active" as const, completedAt: undefined }
          : quest,
      ),
  };
}
