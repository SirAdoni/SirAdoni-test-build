import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Crosshair, Move } from "lucide-react";
import type { SpatialLocation, SpatialLocationPlacement } from "@marinara-engine/shared";
import { useSpatialMapTranslation } from "../localization";
import { MapViewport } from "./MapViewport";
import { MAP_GRID_STEP, snapMapCoordinate } from "./map-grid";
import { MapConnectionHandle } from "./MapConnectionHandle";
import { SpatialLocationIcon } from "./SpatialLocationIcon";
import { cn } from "../package-utils";
import {
  resolveSpatialLinkPresentation,
  spatialLinkPresentationKey,
  spatialLinkStrokeDasharray,
  type SpatialHierarchyProfile,
} from "../../../../../maps-shared/src/maps-model";

interface LocalMapCanvasProps {
  locations: SpatialLocation[];
  selectedId: string | null;
  onSelect: (locationId: string) => void;
  onEnter: (locationId: string) => void;
  backgroundImageUrl?: string;
  backgroundPosition?: SpatialLocationPlacement;
  backgroundEditing?: boolean;
  onBackgroundMove?: (position: SpatialLocationPlacement) => void;
  hierarchyProfile: SpatialHierarchyProfile;
  editing?: boolean;
  connectionEditing?: boolean;
  onConnect?: (from: string, to: string) => void;
  onMove?: (locationId: string, placement: { x: number; y: number }) => void;
}

function clampCoordinate(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

export function LocalMapCanvas({
  locations,
  selectedId,
  onSelect,
  onEnter,
  backgroundImageUrl,
  backgroundPosition = { x: 50, y: 50 },
  backgroundEditing = false,
  onBackgroundMove,
  hierarchyProfile,
  editing = false,
  connectionEditing = false,
  onMove,
  onConnect,
}: LocalMapCanvasProps) {
  const { t } = useSpatialMapTranslation();
  const [connectionSource, setConnectionSource] = useState<string | null>(null);
  useEffect(() => {
    if (!connectionEditing) setConnectionSource(null);
  }, [connectionEditing]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number; placement: { x: number; y: number } } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingBackground, setDraggingBackground] = useState(false);
  const visibleLocationIds = useMemo(() => new Set(locations.map((location) => location.id)), [locations]);
  const visibleLinks = useMemo(() => {
    const seen = new Set<string>();
    return locations.flatMap((location) =>
      location.links.flatMap((link) => {
        if (link.state !== "available" || !visibleLocationIds.has(link.targetId)) return [];
        const key = spatialLinkPresentationKey(location.id, link.targetId);
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ key, from: location.id, to: link.targetId }];
      }),
    );
  }, [locations, visibleLocationIds]);
  const placementById = useMemo(
    () => new Map(locations.map((location) => [location.id, location.placement ?? { x: 50, y: 50 }])),
    [locations],
  );

  const backgroundFromPointer = (event: PointerEvent<HTMLElement>) => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    onBackgroundMove?.({
      x: clampCoordinate(((event.clientX - bounds.left) / bounds.width) * 100),
      y: clampCoordinate(((event.clientY - bounds.top) / bounds.height) * 100),
    });
  };

  const moveFromPointer = (locationId: string, event: PointerEvent<HTMLElement>) => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    const start = dragStart.current;
    if (!start || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
    onMove?.(locationId, {
      x: snapMapCoordinate(start.placement.x + ((event.clientX - start.x) / bounds.width) * 100),
      y: snapMapCoordinate(start.placement.y + ((event.clientY - start.y) / bounds.height) * 100),
    });
  };

  const nudge = (location: SpatialLocation, event: KeyboardEvent<HTMLButtonElement>) => {
    if (!editing || !onMove || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? MAP_GRID_STEP * 5 : MAP_GRID_STEP;
    const placement = location.placement ?? { x: 50, y: 50 };
    onMove(location.id, {
      x: snapMapCoordinate(placement.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0)),
      y: snapMapCoordinate(placement.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)),
    });
  };

  const nudgeBackground = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !backgroundEditing ||
      !onBackgroundMove ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : 1;
    onBackgroundMove({
      x: clampCoordinate(
        backgroundPosition.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
      ),
      y: clampCoordinate(
        backgroundPosition.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
      ),
    });
  };

  return (
    <MapViewport contentRef={canvasRef} compact={false} className="aspect-square w-full">
      <div
        tabIndex={backgroundEditing ? 0 : undefined}
        aria-label={backgroundEditing ? "Reposition map background" : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape") setConnectionSource(null);
          nudgeBackground(event);
        }}
        onPointerDown={(event) => {
          if (!backgroundEditing || !onBackgroundMove || event.button !== 0) return;
          event.stopPropagation();
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDraggingBackground(true);
          backgroundFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (!backgroundEditing || !draggingBackground) return;
          backgroundFromPointer(event);
        }}
        onPointerUp={(event) => {
          if (!draggingBackground) return;
          backgroundFromPointer(event);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          setDraggingBackground(false);
        }}
        onPointerCancel={() => setDraggingBackground(false)}
        className={cn(
          "absolute inset-0 w-full rounded-xl border border-[var(--marinara-chat-chrome-panel-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]",
          backgroundEditing && "cursor-crosshair touch-none",
        )}
        data-layout-editing={editing ? "true" : "false"}
        data-background-editing={backgroundEditing ? "true" : "false"}
        data-marinara-maps-editor-canvas
        style={{ touchAction: backgroundEditing ? "none" : undefined }}
      >
        {backgroundImageUrl && (
          <img
            src={backgroundImageUrl}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            style={{ objectPosition: `${backgroundPosition.x}% ${backgroundPosition.y}%` }}
          />
        )}
        {editing && (
          <div className="pointer-events-none absolute left-3 top-3 z-20 inline-flex items-center gap-1.5 rounded-full border border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--background)]/95 px-2.5 py-1.5 text-[0.625rem] font-semibold text-[var(--marinara-chat-chrome-button-text-active)] shadow-sm">
            <Move size="0.6875rem" /> {t("ui.worldMaps.layout.dragHint")}
          </div>
        )}
        {backgroundEditing && (
          <>
            <div className="pointer-events-none absolute left-3 top-3 z-20 inline-flex items-center gap-1.5 rounded-full border border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--background)]/95 px-2.5 py-1.5 text-[0.625rem] font-semibold text-[var(--marinara-chat-chrome-button-text-active)] shadow-sm">
              <Crosshair size="0.6875rem" /> Drag to set focus · Arrow keys nudge · Shift moves 5
            </div>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute z-30 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--background)]/85 text-[var(--marinara-chat-chrome-button-text-active)] shadow-lg"
              style={{
                transform: "translate(-50%, -50%) scale(var(--map-marker-scale, 1))",
                left: `${backgroundPosition.x}%`,
                top: `${backgroundPosition.y}%`,
              }}
            >
              <Crosshair size="0.875rem" />
            </span>
          </>
        )}
        {locations.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-[var(--marinara-chat-chrome-panel-muted)]">
            Add a child location to place it on this map.
          </div>
        )}
        {hierarchyProfile.showConnections && (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full"
            style={{ overflow: "visible" }}
          >
            {visibleLinks.map((link) => {
              const from = placementById.get(link.from);
              const to = placementById.get(link.to);
              if (!from || !to) return null;
              const selected = selectedId === link.from || selectedId === link.to;
              const presentation = resolveSpatialLinkPresentation(hierarchyProfile, link.from, link.to);
              return (
                <line
                  key={link.key}
                  data-marinara-map-connection={link.key}
                  data-line-style={presentation.lineStyle}
                  x1={`${from.x}%`}
                  y1={`${from.y}%`}
                  x2={`${to.x}%`}
                  y2={`${to.y}%`}
                  stroke={presentation.color ?? "var(--marinara-chat-chrome-accent)"}
                  strokeWidth={selected ? "3.5" : "2.5"}
                  strokeDasharray={spatialLinkStrokeDasharray(presentation.lineStyle)}
                  strokeLinecap="round"
                  opacity={selected ? "1" : "0.9"}
                  vectorEffect="non-scaling-stroke"
                  style={{ filter: "drop-shadow(0 0 1.5px var(--marinara-chat-chrome-panel-bg))" }}
                />
              );
            })}
          </svg>
        )}
        {locations.map((location) => {
          const placement = location.placement ?? { x: 50, y: 50 };
          const selected = selectedId === location.id;
          return (
            <div
              key={location.id}
              className={cn("absolute z-10", backgroundEditing && "pointer-events-none opacity-75")}
              style={{
                transform: "translate(-50%, -50%) scale(var(--map-marker-scale, 1))",
                width: 160,
                height: 44,
                left: `${placement.x}%`,
                top: `${placement.y}%`,
              }}
            >
              <button
                type="button"
                data-map-node-id={location.id}
                onDoubleClick={() => onEnter(location.id)}
                onClick={() => {
                  if (connectionSource && connectionSource !== location.id) {
                    onConnect?.(connectionSource, location.id);
                    setConnectionSource(null);
                  } else onSelect(location.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onEnter(location.id);
                  } else nudge(location, event);
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (!editing || !onMove || connectionSource || event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragStart.current = { x: event.clientX, y: event.clientY, placement };
                  setDraggingId(location.id);
                  onSelect(location.id);
                }}
                onPointerMove={(event) => {
                  if (!editing || draggingId !== location.id) return;
                  moveFromPointer(location.id, event);
                }}
                onPointerUp={(event) => {
                  if (draggingId !== location.id) return;
                  moveFromPointer(location.id, event);
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  setDraggingId(null);
                  dragStart.current = null;
                }}
                onPointerCancel={() => {
                  setDraggingId(null);
                  dragStart.current = null;
                }}
                aria-pressed={selected}
                data-marinara-map-selected-location={selected ? "true" : undefined}
                aria-description={editing ? t("ui.worldMaps.layout.dragHint") : undefined}
                className={cn(
                  "flex min-h-11 w-full flex-col items-center gap-2 rounded-xl border bg-[var(--marinara-chat-chrome-panel-bg)] px-3 py-2 text-left shadow-md transition-[border-color,background-color,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]",
                  selected
                    ? "border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--background)] text-[var(--marinara-chat-chrome-panel-title)]"
                    : "border-[var(--marinara-chat-chrome-panel-border)] hover:border-[var(--marinara-chat-chrome-button-border-hover)]",
                  location.status === "archived" && "opacity-60",
                  editing && "cursor-move touch-none",
                  draggingId === location.id && "scale-[1.02] shadow-lg",
                )}
                style={{ touchAction: editing ? "none" : undefined }}
              >
                <SpatialLocationIcon
                  name={location.name}
                  kind={location.kind}
                  icon={location.icon}
                  className="shrink-0 text-2xl"
                />
                <span
                  className="min-w-0 flex-1 text-xs font-medium"
                  style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
                >
                  {location.name || "Untitled"}
                </span>
              </button>
            </div>
          );
        })}
      </div>
      {!backgroundEditing &&
        connectionEditing &&
        onConnect &&
        locations.map((location) => (
          <MapConnectionHandle
            key={location.id}
            id={location.id}
            name={location.name}
            position={location.placement ?? { x: 50, y: 50 }}
            canvasRef={canvasRef}
            disabled={false}
            onStart={setConnectionSource}
            onConnect={(from, to) => {
              onConnect(from, to);
              setConnectionSource(null);
            }}
          />
        ))}
    </MapViewport>
  );
}
