import type { GameMap } from "@marinara-engine/shared";
import { useSaveMapLayout } from "../../hooks/use-map-layout";
import { CapabilityElement } from "../capabilities/CapabilityElement";

export interface LocalMapCapabilityProps {
  chatId: string;
  map: GameMap;
  disabled?: boolean;
  compact?: boolean;
  viewSwitch?: {
    value: "world" | "local";
    onChange: (value: "world" | "local") => void;
    world: string;
    local: string;
    label: string;
  };
  onMove: (position: { x: number; y: number } | string) => void;
}
export function LocalMapCapability({ chatId, map, disabled, compact, onMove, viewSwitch }: LocalMapCapabilityProps) {
  const save = useSaveMapLayout();
  return (
    <CapabilityElement
      packageId="hierarchical-maps"
      view="world-map"
      className="block min-h-0 flex-1 overflow-hidden"
      capabilityProps={{
        chatId,
        chatMode: "game",
        localMap: map,
        compact,
        viewSwitch,
        disabled: disabled || save.isPending,
        onLocalMove: onMove,
        onLocalMapSave: async (next: GameMap) => {
          await save.mutateAsync({ chatId, previous: map, next });
        },
      }}
    />
  );
}
