export interface GameStatusBar {
  id: string;
  label: string;
  value: number;
  max: number;
  color?: string;
}
export interface GameStatusAttribute {
  id: string;
  label: string;
  value: number | string;
}
export interface GameStatusProjection {
  bars: GameStatusBar[];
  attributes: GameStatusAttribute[];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}
function numeric(value: unknown): number | null {
  const next = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(next) ? next : null;
}
function labelOf(value: unknown): string {
  const label = record(value).name;
  return typeof label === "string" ? label.trim() : "";
}
function keyOf(value: string): string {
  return value.trim().toLocaleLowerCase();
}
function stableHash(value: string): string {
  let hash = 2166136261;
  for (const codePoint of value) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}
function id(kind: string, label: string): string {
  const raw = label.trim().normalize("NFKC").toLocaleLowerCase();
  const slug = raw.replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/gu, "") || "stat";
  return `${kind}:${slug}${raw === slug ? "" : `-${stableHash(raw)}`}`;
}
function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function liveValue(value: unknown): number | null {
  const row = record(value);
  return numeric(row.value ?? row.current);
}
function liveTextValue(value: unknown): number | string | null {
  const next = record(value).value;
  return typeof next === "number" || typeof next === "string" ? next : null;
}

export function projectGameStatusStats(input: {
  personaStats?: unknown;
  rpgStats?: unknown;
  config?: unknown;
}): GameStatusProjection {
  const persona = record(input.personaStats),
    rpg = record(input.rpgStats),
    config = record(input.config);
  const configured = input.config !== undefined && input.config !== null;
  const configuredBars = items(config.bars),
    configuredRpg = record(config.rpgStats);
  const configuredPools = Array.isArray(configuredRpg.pools)
      ? configuredRpg.pools
      : configuredRpg.hp && typeof configuredRpg.hp === "object"
        ? [{ name: "HP", ...record(configuredRpg.hp) }]
        : [],
    configuredAttributes = items(configuredRpg.attributes);
  const rpgEnabled = !configured || (config.enabled === true && configuredRpg.enabled === true);
  const personaEnabled = !configured || config.enabled === true;
  const personaBars = Array.isArray(input.personaStats) ? input.personaStats : items(persona.bars);
  const rpgStats = items(rpg.stats),
    rpgPools = items(rpg.pools),
    legacyHp = record(rpg.hp);
  const livePools = [...rpgStats, ...rpgPools, { name: "HP", ...legacyHp }];
  const findLive = (list: unknown[], label: string) => list.find((item) => keyOf(labelOf(item)) === keyOf(label));
  const bars: GameStatusBar[] = [];
  const addBar = (kind: "bar" | "pool", configuredItem: unknown, liveItems: unknown[]) => {
    const configRow = record(configuredItem),
      label = labelOf(configuredItem);
    if (!label) return;
    const live = findLive(liveItems, label),
      liveRow = record(live);
    const value = liveValue(live) ?? liveValue(configuredItem) ?? 0;
    const max = numeric(configRow.max) ?? numeric(liveRow.max) ?? 100;
    if (!max || max <= 0) return;
    const color =
      typeof configRow.color === "string"
        ? configRow.color
        : typeof liveRow.color === "string"
          ? liveRow.color
          : undefined;
    bars.push({
      id: id(kind, label),
      label,
      value: Math.max(0, Math.min(max, value)),
      max,
      ...(color ? { color } : {}),
    });
  };
  if (personaEnabled) {
    for (const item of configured ? configuredBars : personaBars) {
      addBar("bar", item, [...personaBars, ...livePools]);
    }
  }
  const existingLabels = new Set(bars.map((bar) => keyOf(bar.label)));
  const poolItems = configured ? configuredPools : [...rpgPools, ...rpgStats];
  if (rpgEnabled) {
    for (const item of poolItems) {
      const label = labelOf(item);
      if (!label || existingLabels.has(keyOf(label))) continue;
      addBar("pool", item, livePools);
      existingLabels.add(keyOf(label));
    }
    if (!configured && !existingLabels.has("hp") && liveValue(legacyHp) != null) {
      addBar("pool", { name: "HP" }, livePools);
    }
  }
  const liveAttributes = Array.isArray(rpg.attributes)
    ? rpg.attributes
    : rpg.attributes && typeof rpg.attributes === "object"
      ? Object.entries(rpg.attributes).map(([name, value]) => ({ name, value }))
      : [];
  const attributes: GameStatusAttribute[] = [];
  if (rpgEnabled)
    for (const item of configured ? configuredAttributes : liveAttributes) {
      const label = labelOf(item);
      if (!label) continue;
      const value = liveTextValue(findLive(liveAttributes, label)) ?? liveTextValue(item);
      if (value != null) attributes.push({ id: id("attribute", label), label, value });
    }
  return { bars, attributes };
}
