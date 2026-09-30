import { useRef, useState } from "react";
import type { GameMap, SpatialContextDefinition, SpatialLocation } from "@marinara-engine/shared";
import type { MapsSpatialContextResponse } from "../../../../maps-shared/src/maps-model";
import { GameWorldMap, type MapViewSwitch } from "./GameWorldMap";
import { useSpatialMapTranslation } from "../../features/spatial-context/localization";

export function GameLocalMap({
  map,
  spatial,
  chatId,
  onSave,
  onMove,
  disabled,
  compact,
  viewSwitch,
}: {
  map: GameMap;
  spatial: MapsSpatialContextResponse;
  chatId: string;
  onSave: (map: GameMap) => Promise<void>;
  onMove: (id: string) => void;
  disabled?: boolean;
  compact?: boolean;
  viewSwitch?: MapViewSwitch;
}) {
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const { t } = useSpatialMapTranslation();
  const rootId = "local-map-root";
  const base = {
    kind: "room" as const,
    status: "active" as const,
    sortOrder: 0,
    lorebookEntryIds: [],
    childPresentation: "map" as const,
    links: [],
  };
  const locations: SpatialLocation[] = [
    { ...base, id: rootId, parentId: null, name: map.name, description: map.description },
    ...(map.nodes ?? []).map((node, index): SpatialLocation => ({
      ...base,
      id: node.id,
      parentId: rootId,
      name: node.discovered ? node.label : t("ui.worldMaps.local.unknown"),
      description: node.discovered ? (node.description ?? "") : "",
      icon: node.discovered ? node.emoji : "emoji:❓",
      sortOrder: index,
      placement: { x: node.x, y: node.y },
      links: (map.edges ?? [])
        .filter((edge) => edge.from === node.id)
        .map((edge) => ({ targetId: edge.to, label: edge.label, bidirectional: true, state: "available" })),
    })),
  ];
  const definition: SpatialContextDefinition = {
    schemaVersion: 1,
    revision: 0,
    enabled: true,
    ownerMode: "game",
    startingLocationId: typeof map.partyPosition === "string" ? map.partyPosition : null,
    locations,
  };
  const currentLocationId = definition.startingLocationId;
  const localSpatial = {
    ...spatial,
    definition,
    currentLocationId,
    destinations: [],
    breadcrumb: locations
      .filter((location) => location.id === rootId || location.id === currentLocationId)
      .map((location) => ({ id: location.id, name: location.name, kind: location.kind })),
  };
  const save = async (next: SpatialContextDefinition) => {
    if (busy.current) throw new Error("Map save in progress");
    busy.current = true;
    setSaving(true);
    try {
      const ids = new Set((map.nodes ?? []).map((node) => node.id));
      const nextById = new Map(next.locations.map((location) => [location.id, location]));
      await onSave({
        ...map,
        nodes: (map.nodes ?? []).map((node) => ({
          ...node,
          ...(nextById.get(node.id)?.placement ?? { x: node.x, y: node.y }),
        })),
        edges: next.locations
          .filter((location) => ids.has(location.id))
          .flatMap((location) =>
            location.links
              .filter((link) => ids.has(link.targetId))
              .map((link) => ({ from: location.id, to: link.targetId, ...(link.label ? { label: link.label } : {}) })),
          ),
      });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  return (
    <GameWorldMap
      chatId={chatId}
      spatial={localSpatial}
      focusLocationId={rootId}
      onSaveDefinition={save}
      onLocalMove={(id) => {
        if ((map.nodes ?? []).some((node) => node.id === id && node.discovered)) onMove(id);
      }}
      disabled={disabled || saving}
      layoutDisabled={saving}
      compact={compact}
      viewSwitch={viewSwitch}
    />
  );
}
