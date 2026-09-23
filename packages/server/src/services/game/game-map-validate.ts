// ──────────────────────────────────────────────
// Game: validate a model-generated map before it is saved
// ──────────────────────────────────────────────
import type { GameMap, GridCell, MapEdge, MapNode } from "@marinara-engine/shared";

export type GameMapValidationResult = { ok: true; map: GameMap } | { ok: false; error: string };

const MAX_GRID_SIDE = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toInt(value: unknown): number | null {
  const n = toNumber(value);
  return n === null ? null : Math.trunc(n);
}

function toText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeCell(raw: unknown, width: number, height: number): GridCell | null {
  if (!isRecord(raw)) return null;
  const x = toInt(raw.x);
  const y = toInt(raw.y);
  if (x === null || y === null || x < 0 || y < 0 || x >= width || y >= height) return null;
  const cell: GridCell = {
    x,
    y,
    emoji: toText(raw.emoji),
    label: toText(raw.label),
    discovered: toBool(raw.discovered, false),
    terrain: toText(raw.terrain),
  };
  const description = optionalText(raw.description);
  if (description) cell.description = description;
  const spatialLocationId = optionalText(raw.spatialLocationId);
  if (spatialLocationId) cell.spatialLocationId = spatialLocationId;
  return cell;
}

function normalizeNode(raw: unknown): MapNode | null {
  if (!isRecord(raw)) return null;
  const id = toText(raw.id).trim();
  if (!id) return null;
  const x = toNumber(raw.x);
  const y = toNumber(raw.y);
  if (x === null || y === null) return null;
  const node: MapNode = {
    id,
    emoji: toText(raw.emoji),
    label: toText(raw.label, id),
    x,
    y,
    discovered: toBool(raw.discovered, false),
  };
  const description = optionalText(raw.description);
  if (description) node.description = description;
  const spatialLocationId = optionalText(raw.spatialLocationId);
  if (spatialLocationId) node.spatialLocationId = spatialLocationId;
  return node;
}

function normalizeEdge(raw: unknown, nodeIds: Set<string>): MapEdge | null {
  if (!isRecord(raw)) return null;
  const from = toText(raw.from).trim();
  const to = toText(raw.to).trim();
  if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) return null;
  const edge: MapEdge = { from, to };
  const label = optionalText(raw.label);
  if (label) edge.label = label;
  return edge;
}

/**
 * Check and normalise a map returned by the model. Unwraps a single top-level
 * "map" key, coerces numeric fields, and drops malformed cells, nodes and edges.
 */
export function validateGeneratedGameMap(input: unknown): GameMapValidationResult {
  let raw: unknown = input;
  if (isRecord(raw) && Object.keys(raw).length === 1 && isRecord(raw.map)) raw = raw.map;
  if (!isRecord(raw)) return { ok: false, error: "Map must be a JSON object" };

  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  if (type !== "grid" && type !== "node") {
    return { ok: false, error: 'Map type must be "grid" or "node"' };
  }

  const base = {
    name: toText(raw.name, "Unnamed Area").trim() || "Unnamed Area",
    description: toText(raw.description),
    ...(optionalText(raw.id) ? { id: optionalText(raw.id) } : {}),
    ...(optionalText(raw.spatialLocationId) ? { spatialLocationId: optionalText(raw.spatialLocationId) } : {}),
  };

  if (type === "grid") {
    const width = toInt(raw.width);
    const height = toInt(raw.height);
    if (width === null || height === null || width < 1 || height < 1 || width > MAX_GRID_SIDE || height > MAX_GRID_SIDE) {
      return { ok: false, error: `Grid map needs a width and height between 1 and ${MAX_GRID_SIDE}` };
    }
    if (!Array.isArray(raw.cells)) return { ok: false, error: "Grid map needs a cells array" };
    const seen = new Set<string>();
    const cells: GridCell[] = [];
    for (const entry of raw.cells) {
      const cell = normalizeCell(entry, width, height);
      if (!cell) continue;
      const key = `${cell.x},${cell.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cells.push(cell);
    }
    if (cells.length === 0) return { ok: false, error: "Grid map has no valid cells" };

    let partyPosition: { x: number; y: number } = { x: cells[0]!.x, y: cells[0]!.y };
    if (isRecord(raw.partyPosition)) {
      const px = toInt(raw.partyPosition.x);
      const py = toInt(raw.partyPosition.y);
      if (px !== null && py !== null && px >= 0 && py >= 0 && px < width && py < height) {
        partyPosition = { x: px, y: py };
      }
    }
    return { ok: true, map: { ...base, type: "grid", width, height, cells, partyPosition } };
  }

  if (!Array.isArray(raw.nodes)) return { ok: false, error: "Node map needs a nodes array" };
  if (!Array.isArray(raw.edges)) return { ok: false, error: "Node map needs an edges array" };
  const nodeIds = new Set<string>();
  const nodes: MapNode[] = [];
  for (const entry of raw.nodes) {
    const node = normalizeNode(entry);
    if (!node || nodeIds.has(node.id)) continue;
    nodeIds.add(node.id);
    nodes.push(node);
  }
  if (nodes.length === 0) return { ok: false, error: "Node map has no valid nodes" };
  const edges: MapEdge[] = [];
  for (const entry of raw.edges) {
    const edge = normalizeEdge(entry, nodeIds);
    if (edge) edges.push(edge);
  }
  const requested = typeof raw.partyPosition === "string" ? raw.partyPosition.trim() : "";
  const partyPosition = nodeIds.has(requested) ? requested : nodes[0]!.id;
  return { ok: true, map: { ...base, type: "node", nodes, edges, partyPosition } };
}
