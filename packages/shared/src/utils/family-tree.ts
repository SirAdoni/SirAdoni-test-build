import type { AvatarCrop } from "../types/avatar-crop.js";
import type { CampaignMemoryEntity, CampaignMemoryOwnerRef } from "../types/campaign-memory.js";

export const FAMILY_KINDS = [
  "parent",
  "child",
  "adoptive-parent",
  "guardian",
  "spouse",
  "partner",
  "sibling",
  "relative",
] as const;
export type FamilyKind = (typeof FAMILY_KINDS)[number];
export const FAMILY_FACT_PREDICATE = "family.link";

/** Links reference existing owners. Names are display data and never establish identity. */
export interface FamilyPerson {
  id: string;
  name: string;
  owner: CampaignMemoryOwnerRef;
  entityId: string;
  chatId: string;
  sessionNumber?: number;
  tags: string[];
  avatarUrl?: string | null;
  avatarCrop?: AvatarCrop | null;
  available: boolean;
}

export interface FamilyLink {
  id: string;
  chatId: string;
  sessionNumber?: number;
  revision: number;
  recordType: "fact" | "relationship";
  sourceId: string;
  targetId: string | null;
  kind: FamilyKind;
  note: string;
  /** False means review is required; these links never contribute to the tree. */
  confirmed: boolean;
}

export interface FamilyTreeData {
  people: FamilyPerson[];
  links: FamilyLink[];
}

export function familyPersonId(entity: Pick<CampaignMemoryEntity, "owner" | "entityId">): string {
  return entity.owner.type === "existing"
    ? JSON.stringify([entity.owner.store, entity.owner.recordId])
    : JSON.stringify(["entity", entity.entityId]);
}

export function familyKind(type: string): FamilyKind | null {
  const normalized = type.trim().toLowerCase().replace(/-of$/, "");
  return FAMILY_KINDS.includes(normalized as FamilyKind) ? (normalized as FamilyKind) : null;
}

export function familyParentPair(link: Pick<FamilyLink, "kind" | "sourceId" | "targetId">): [string, string] | null {
  if (!link.targetId) return null;
  if (link.kind === "parent" || link.kind === "adoptive-parent") return [link.sourceId, link.targetId];
  if (link.kind === "child") return [link.targetId, link.sourceId];
  return null;
}

/** Directed parentage only: partnership loops and pedigree collapse are legitimate. */
export function familyCreatesCycle(
  links: FamilyLink[],
  candidate: Pick<FamilyLink, "kind" | "sourceId" | "targetId">,
): boolean {
  const pair = familyParentPair(candidate);
  if (!pair) return candidate.sourceId === candidate.targetId;
  const [parent, child] = pair;
  const children = new Map<string, string[]>();
  for (const link of links) {
    if (!link.confirmed) continue;
    const edge = familyParentPair(link);
    if (edge) children.set(edge[0], [...(children.get(edge[0]) ?? []), edge[1]]);
  }
  const visited = new Set<string>();
  const pending = [child];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === parent) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return false;
}

export function familyLinkKey(link: Pick<FamilyLink, "kind" | "sourceId" | "targetId" | "note">): string {
  const pair = familyParentPair(link);
  if (pair) return JSON.stringify([link.kind === "adoptive-parent" ? "adoptive-parent" : "parent", ...pair]);
  const endpoints =
    link.targetId && ["spouse", "partner", "sibling", "relative"].includes(link.kind)
      ? [link.sourceId, link.targetId].sort()
      : [link.sourceId, link.targetId];
  return JSON.stringify([link.kind, ...endpoints, link.targetId ? "" : link.note]);
}

/** Bounded, iterative neighbourhood layout; imported cycles cannot recurse or duplicate a person. */
export function layoutFamilyTree(data: FamilyTreeData, focusId: string, depth = 2, limit = 80) {
  const people = new Map(data.people.map((person) => [person.id, person]));
  const edges = data.links.filter(
    (link) => link.confirmed && link.targetId && people.has(link.sourceId) && people.has(link.targetId),
  );
  const adjacency = new Map<string, Array<{ id: string; delta: number }>>();
  for (const edge of edges) {
    const delta =
      edge.kind === "parent" || edge.kind === "adoptive-parent" || edge.kind === "guardian"
        ? 1
        : edge.kind === "child"
          ? -1
          : 0;
    adjacency.set(edge.sourceId, [...(adjacency.get(edge.sourceId) ?? []), { id: edge.targetId!, delta }]);
    adjacency.set(edge.targetId!, [...(adjacency.get(edge.targetId!) ?? []), { id: edge.sourceId, delta: -delta }]);
  }
  const positions = new Map<string, number>();
  if (people.has(focusId)) positions.set(focusId, 0);
  const queue = positions.size ? [{ id: focusId, level: 0, distance: 0 }] : [];
  let truncated = false;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const node = queue[cursor]!;
    for (const next of adjacency.get(node.id) ?? []) {
      if (positions.has(next.id)) continue;
      if (node.distance >= depth || positions.size >= limit) {
        truncated = true;
        continue;
      }
      positions.set(next.id, node.level + next.delta);
      queue.push({ id: next.id, level: node.level + next.delta, distance: node.distance + 1 });
    }
  }
  const levels = [...new Set(positions.values())].sort((a, b) => a - b);
  const rows = levels.map((level) =>
    [...positions]
      .filter(([, value]) => value === level)
      .map(([id]) => people.get(id)!)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  );
  const width = Math.max(320, ...rows.map((row) => row.length * 200));
  const nodes = rows.flatMap((row, rowIndex) =>
    row.map((person, column) => ({
      person,
      x: (width - row.length * 200) / 2 + column * 200 + 10,
      y: rowIndex * 170 + 20,
    })),
  );
  return {
    nodes,
    edges: edges.filter((edge) => positions.has(edge.sourceId) && positions.has(edge.targetId!)),
    width,
    height: Math.max(160, rows.length * 170),
    truncated,
  };
}
