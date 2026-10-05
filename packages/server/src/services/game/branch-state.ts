import {
  applyExtendedWidgetUpdate,
  applyHudWidgetLifecycle,
  coerceWidgetValue,
  isExtendedHudWidgetType,
  isGameExtendedWidgetsEnabled,
  leadingWidgetNumber,
  listWidgetCapacity,
  type HudWidget,
  type WidgetUpdate,
} from "@marinara-engine/shared";
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

/** count / seconds read like the live tag parser: parseInt, 0 when not a number. */
function liveInteger(raw: string): number {
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resetReplayedContent(widget: HudWidget): HudWidget {
  if (widget.type === "list") return { ...widget, config: { ...widget.config, items: [] } };
  if (!isExtendedHudWidgetType(widget.type)) return widget;
  const config = widget.config ?? {};
  switch (widget.type) {
    case "checklist":
    case "obligations":
      return { ...widget, config: { ...config, tasks: [] } };
    case "schedule":
    case "calendar":
      return { ...widget, config: { ...config, entries: [] } };
    case "log":
      return { ...widget, config: { ...config, items: [] } };
    case "rumor_board":
      return { ...widget, config: { ...config, rumors: [] } };
    case "tags":
      return { ...widget, config: { ...config, tags: [] } };
    case "ledger": {
      const transactions = Array.isArray(config.transactions) ? config.transactions : [];
      const spent = transactions.reduce((sum, entry) => sum + (Number(entry?.amount) || 0), 0);
      const balance = (Number(config.value) || 0) - spent;
      return { ...widget, config: { ...config, value: Math.round(balance * 100) / 100, transactions: [] } };
    }
    default:
      return widget;
  }
}

function readInitialHudState(metadata: Record<string, unknown>): HudWidget[] | null {
  const baseline = metadata.gameWidgetInitialState;
  if (!Array.isArray(baseline)) return null;
  const valid = baseline.every(
    (widget) =>
      typeof widget === "object" &&
      widget !== null &&
      typeof (widget as HudWidget).id === "string" &&
      typeof (widget as HudWidget).type === "string" &&
      typeof (widget as HudWidget).label === "string" &&
      typeof (widget as HudWidget).config === "object" &&
      (widget as HudWidget).config !== null,
  );
  return valid ? (baseline as HudWidget[]) : null;
}

export function restoreBranchHudLists(
  metadata: Record<string, unknown>,
  copiedMessages: Array<{ content?: string | null }>,
): HudWidget[] {
  const blueprint = metadata.gameBlueprint as { hudWidgets?: unknown } | null;
  const setup = metadata.gameSetupConfig as { customHudWidgets?: unknown } | null;
  const hasBlueprintWidgets = Array.isArray(blueprint?.hudWidgets);
  const hasSetupWidgets = Array.isArray(setup?.customHudWidgets);
  const initialHudState = readInitialHudState(metadata);
  const initial =
    initialHudState ??
    (hasBlueprintWidgets
      ? (blueprint.hudWidgets as HudWidget[])
      : hasSetupWidgets
        ? (setup.customHudWidgets as HudWidget[])
        : Array.isArray(metadata.gameWidgetState)
          ? (metadata.gameWidgetState as HudWidget[])
          : []);
  let widgets = initial.map((widget) => {
    const copy = { ...widget, config: structuredClone(widget.config) };
    return hasBlueprintWidgets || initialHudState ? copy : resetReplayedContent(copy);
  });

  for (const message of copiedMessages) {
    for (const match of (message.content ?? "").matchAll(/\[widget:\s*([^,\]]+),([^\]]*)\]/gi)) {
      const widgetId = match[1]!.trim();
      const body = match[2] ?? "";
      const action = readWidgetParam(body, "action");
      if (action === "create" || action === "delete") {
        // Rebuild only actions accepted by this chat's historical switch; the app-wide switch is not consulted.
        if (!isGameExtendedWidgetsEnabled(metadata)) continue;
        const changes: WidgetUpdate["changes"] = {
          action,
          type: readWidgetParam(body, "type") as WidgetUpdate["changes"]["type"],
          label: readWidgetParam(body, "label") ?? undefined,
          icon: readWidgetParam(body, "icon") ?? undefined,
          position: readWidgetParam(body, "position") as WidgetUpdate["changes"]["position"],
          text: readWidgetParam(body, "text") ?? undefined,
        };
        const createValue = readWidgetParam(body, "value");
        if (createValue !== null) changes.value = coerceWidgetValue(createValue);
        const createMax = readWidgetParam(body, "max");
        if (createMax !== null) changes.max = Number(createMax);
        for (const key of ["count", "seconds"] as const) {
          const value = readWidgetParam(body, key);
          if (value !== null) changes[key] = liveInteger(value);
        }
        changes.running = readWidgetParam(body, "running") === "true";
        widgets = applyHudWidgetLifecycle(widgets, { widgetId, changes });
        continue;
      }

      const add = readWidgetParam(body, "add");
      const remove = readWidgetParam(body, "remove");
      widgets = widgets.map((widget) => {
        if (widget.id !== widgetId) return widget;
        if (isExtendedHudWidgetType(widget.type)) {
          // Do not replay extended-widget mutations for chats whose historical switch was off.
          if (!isGameExtendedWidgetsEnabled(metadata)) return widget;
          const rawValue = readWidgetParam(body, "value");
          const rawMax = readWidgetParam(body, "max");
          return applyExtendedWidgetUpdate(widget, {
            add: add ?? undefined,
            remove: remove ?? undefined,
            check: readWidgetParam(body, "check") ?? undefined,
            uncheck: readWidgetParam(body, "uncheck") ?? undefined,
            text: readWidgetParam(body, "text") ?? undefined,
            statName: readWidgetParam(body, "stat") ?? undefined,
            value: rawValue === null ? undefined : coerceWidgetValue(rawValue),
            max: rawMax !== null && Number.isFinite(Number(rawMax)) ? Number(rawMax) : undefined,
          });
        }
        if (widget.type !== "list") {
          const config = { ...widget.config };
          const stat = readWidgetParam(body, "stat");
          const rawValue = readWidgetParam(body, "value");
          if (stat && widget.type === "stat_block" && rawValue !== null) {
            const value = coerceWidgetValue(rawValue);
            const stats = [...(config.stats ?? [])];
            const index = stats.findIndex((entry) => entry.name.toLowerCase() === stat.toLowerCase());
            if (index < 0) stats.push({ name: stat, value });
            else stats[index] = { ...stats[index]!, value };
            config.stats = stats;
          } else {
            const value = readWidgetParam(body, "value");
            const number = value === null ? null : leadingWidgetNumber(value);
            if (number !== null) config.value = number;
            for (const key of ["count", "seconds"] as const) {
              const raw = readWidgetParam(body, key);
              if (raw !== null) config[key] = liveInteger(raw);
            }
            const running = readWidgetParam(body, "running");
            if (running !== null) config.running = running === "true";
          }
          if (widget.type === "inventory_grid") {
            if (remove) config.contents = (config.contents ?? []).filter((entry) => entry.name !== remove);
            if (add) config.contents = [...(config.contents ?? []), { name: add, quantity: 1 }];
          }
          return { ...widget, config };
        }
        const rawListMax = readWidgetParam(body, "max");
        const listConfig =
          rawListMax !== null && Number.isFinite(Number(rawListMax))
            ? { ...widget.config, max: listWidgetCapacity({ max: Number(rawListMax) }) }
            : widget.config;
        let items = [...(listConfig.items ?? [])];
        if (remove) {
          const target = normalizeListItem(remove);
          items = items.filter((item) => normalizeListItem(item) !== target);
        }
        if (add) {
          const target = normalizeListItem(add);
          items = [...items.filter((item) => normalizeListItem(item) !== target), add].slice(
            -listWidgetCapacity(listConfig),
          );
        }
        return { ...widget, config: { ...listConfig, items } };
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
