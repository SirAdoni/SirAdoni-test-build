import type { GameMap, MapNode } from "../types/game.js";
import type { SpatialContextDefinition, SpatialLocation, SpatialLocationKind } from "../types/spatial-context.js";

const LEGACY_ROOT_PREFIX = "legacy-map:";

function stableMapId(map: GameMap): string {
  const raw = (map.id || map.name).trim().replace(/[^A-Za-z0-9._:-]+/gu, "-");
  return `${LEGACY_ROOT_PREFIX}${raw || "map"}`.slice(0, 128);
}

function locationKind(node: MapNode): SpatialLocationKind {
  return node.label.toLowerCase().includes("room") ? "room" : "place";
}

/** Convert a legacy node map without mutating or replacing its source metadata. */
export function convertLegacyGameMapToSpatialDefinition(
  map: GameMap | null | undefined,
  existing?: SpatialContextDefinition | null,
): SpatialContextDefinition | null {
  if (existing) return existing;
  if (!map || map.type !== "node" || !Array.isArray(map.nodes) || map.nodes.length === 0) return null;

  const nodeIds = new Set<string>();
  for (const node of map.nodes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(node.id) || nodeIds.has(node.id)) {
      throw new Error(`Legacy map contains an invalid or duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
  }
  const rootId = stableMapId(map);
  if (nodeIds.has(rootId)) throw new Error(`Legacy map node collides with generated root id: ${rootId}`);
  const root: SpatialLocation = {
    id: rootId,
    parentId: null,
    name: map.name.trim() || "Legacy map",
    kind: "place",
    description: map.description || "",
    lorebookEntryIds: [],
    childPresentation: "map",
    links: [],
    status: "active",
    sortOrder: 0,
  };
  const locations: SpatialLocation[] = [root];
  for (const [index, node] of map.nodes.entries()) {
    locations.push({
      id: node.id,
      parentId: rootId,
      name: node.label,
      kind: locationKind(node),
      description: node.description || "",
      icon: node.emoji,
      lorebookEntryIds: [],
      childPresentation: "list",
      placement: { x: node.x, y: node.y },
      links: [],
      status: node.discovered ? "active" : "archived",
      sortOrder: index + 1,
    });
  }
  const byId = new Map(locations.map((location) => [location.id, location]));
  for (const edge of map.edges ?? []) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) {
      throw new Error(`Legacy map contains a dangling or self-referencing edge: ${edge.from} -> ${edge.to}`);
    }
    const source = byId.get(edge.from);
    if (!source || source.links.some((link) => link.targetId === edge.to)) {
      throw new Error(`Legacy map contains a duplicate edge: ${edge.from} -> ${edge.to}`);
    }
    source.links.push({
      targetId: edge.to,
      ...(edge.label?.trim() ? { label: edge.label.trim() } : {}),
      bidirectional: true,
      state: "available",
    });
  }
  const partyPosition =
    typeof map.partyPosition === "string" && nodeIds.has(map.partyPosition) ? map.partyPosition : null;
  return {
    schemaVersion: 1,
    ownerMode: "game",
    enabled: true,
    locations,
    startingLocationId: partyPosition,
    revision: 0,
  };
}
