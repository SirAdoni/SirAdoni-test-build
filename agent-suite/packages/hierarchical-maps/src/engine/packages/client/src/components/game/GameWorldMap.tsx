import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { MapToolsPopover } from "../../features/spatial-context/components/MapToolsPopover";
import { MapConnectionHandle } from "../../features/spatial-context/components/MapConnectionHandle";
import { MapViewport } from "../../features/spatial-context/components/MapViewport";
import { LiveMapConnection } from "../../features/spatial-context/components/LiveMapConnection";
import { useUpdateSpatialContext } from "../../hooks/use-spatial-context";
import { useSpatialMapTranslation } from "../../features/spatial-context/localization";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  List,
  LocateFixed,
  Map as MapIcon,
  PencilLine,
  Route,
  Footprints,
  Zap,
  X,
} from "lucide-react";
import {
  compareSpatialLocations,
  resolveSpatialBreadcrumb,
  spatialRadialPlacement,
  type SpatialLocation,
  type SpatialContextDefinition,
} from "@marinara-engine/shared";
import { cn, generateClientId } from "../../features/spatial-context/package-utils";
import { MAP_GRID_STEP, snapMapCoordinate } from "../../features/spatial-context/components/map-grid";
import { SpatialLocationIcon } from "../../features/spatial-context/components/SpatialLocationIcon";
import {
  resolveSpatialArtworkImage,
  useSpatialGalleryImages,
  useSpatialGlobalGalleryImages,
} from "../../features/spatial-context/use-spatial-resources";
import { findSpatialRoute } from "../../features/spatial-context/spatial-route-plans";
import {
  clearPendingSpatialTransition,
  setPendingSpatialTransition,
  usePendingSpatialTransition,
} from "../../features/spatial-context/pending-spatial-transitions";
import { useMapConfirmation } from "../../features/spatial-context/components/use-map-confirmation";
import { focusedMapPlacement, getCompactMapLocations } from "./compact-map-layout";
import {
  hierarchyTypeForLocation,
  resolveSpatialLinkPresentation,
  spatialLinkPresentationKey,
  spatialLinkStrokeDasharray,
  type MapsSpatialContextResponse,
} from "../../../../maps-shared/src/maps-model";

export interface MapViewSwitch {
  value: "world" | "local";
  onChange: (value: "world" | "local") => void;
  world: string;
  local: string;
  label: string;
}
interface GameWorldMapProps {
  viewSwitch?: MapViewSwitch;
  layoutDisabled?: boolean;
  onSaveDefinition?: (definition: SpatialContextDefinition) => Promise<void>;
  onLocalMove?: (id: string) => void;
  focusLocationId?: string;
  chatId: string;
  spatial: MapsSpatialContextResponse;
  disabled?: boolean;
  compact?: boolean;
  useParentScroll?: boolean;
  onDestinationQueued?: () => void;
  onOpenEditor?: () => void;
}

function sortLocations(locations: SpatialLocation[]): SpatialLocation[] {
  return [...locations].sort(compareSpatialLocations);
}

function defaultViewLocationId(spatial: MapsSpatialContextResponse): string | null {
  const definition = spatial.definition;
  if (!definition) return null;
  const current = definition.locations.find(
    (location) => location.id === spatial.currentLocationId && location.status === "active",
  );
  if (!current) {
    return (
      sortLocations(
        definition.locations.filter((location) => location.status === "active" && location.parentId === null),
      )[0]?.id ?? null
    );
  }
  const hasActiveChildren = definition.locations.some(
    (location) => location.status === "active" && location.parentId === current.id,
  );
  return hasActiveChildren ? current.id : (current.parentId ?? current.id);
}

export function GameWorldMap({
  viewSwitch,
  layoutDisabled = false,
  onSaveDefinition,
  onLocalMove,
  focusLocationId,
  chatId,
  spatial,
  disabled = false,
  compact = false,
  useParentScroll = false,
  onDestinationQueued,
  onOpenEditor,
}: GameWorldMapProps) {
  const definition = spatial.definition;
  const centeredViewLocationId = definition?.locations.some(
    (location) => location.id === focusLocationId && location.status === "active",
  )
    ? focusLocationId!
    : defaultViewLocationId(spatial);
  const [viewLocationId, setViewLocationId] = useState<string | null>(() => centeredViewLocationId);
  const [selectedId, setSelectedId] = useState<string | null>(spatial.currentLocationId);
  const [showListView, setShowListView] = useState(false);
  const [showAllCompact, setShowAllCompact] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionFrom, setConnectionFrom] = useState<string | null>(null);
  const [connectionTo, setConnectionTo] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; x: number; y: number; origin: { x: number; y: number }; moved: boolean } | null>(
    null,
  );
  const [preview, setPreview] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragPreview = useRef<{ id: string; x: number; y: number } | null>(null);
  const [layoutError, setLayoutError] = useState(false);
  const updateSpatial = useUpdateSpatialContext();
  const { t } = useSpatialMapTranslation();
  const savePlacement = async (id: string, placement: { x: number; y: number }) => {
    if (!definition || updateSpatial.isPending) return;
    setLayoutError(false);
    try {
      if (onSaveDefinition) {
        await onSaveDefinition({
          ...definition,
          locations: definition.locations.map((location) =>
            location.id === id ? { ...location, placement } : location,
          ),
        });
        return;
      }
      await updateSpatial.mutateAsync({
        chatId,
        expectedRevision: definition.revision,
        expectedCurrentLocationId: spatial.currentLocationId,
        definition: {
          ...definition,
          locations: definition.locations.map((location) =>
            location.id === id ? { ...location, placement } : location,
          ),
        },
      });
    } catch {
      setLayoutError(true);
    } finally {
      setPreview(null);
    }
  };
  const pending = usePendingSpatialTransition(chatId);
  const { confirmAction, confirmationDialog } = useMapConfirmation();
  useEffect(() => {
    setViewLocationId(centeredViewLocationId);
    setSelectedId(spatial.currentLocationId);
    setShowAllCompact(false);
  }, [centeredViewLocationId, spatial.currentLocationId]);

  const activeLocations = useMemo(
    () => definition?.locations.filter((location) => location.status === "active") ?? [],
    [definition?.locations],
  );
  const galleryImages = useSpatialGalleryImages(
    chatId,
    definition?.enabled === true && activeLocations.some((location) => Boolean(location.mapBackgroundImageId)),
  );
  const globalGalleryImages = useSpatialGlobalGalleryImages(
    definition?.enabled === true && activeLocations.some((location) => Boolean(location.mapBackgroundImageId)),
  );
  const locationById = useMemo(
    () => new Map(activeLocations.map((location) => [location.id, location])),
    [activeLocations],
  );
  const viewLocation = viewLocationId ? (locationById.get(viewLocationId) ?? null) : null;
  const mapBackgroundImageUrl = viewLocation?.mapBackgroundImageId
    ? resolveSpatialArtworkImage(viewLocation.mapBackgroundImageId, galleryImages.data, globalGalleryImages.data)?.url
    : undefined;
  const mapBackgroundPosition = viewLocation?.mapBackgroundPosition ?? {
    x: 50,
    y: 50,
  };
  const visibleLocations = useMemo(
    () =>
      sortLocations(
        activeLocations.filter((location) =>
          viewLocation ? location.parentId === viewLocation.id : location.parentId === null,
        ),
      ),
    [activeLocations, viewLocation],
  );
  const focusLocationIdForCompact =
    viewLocation && viewLocation.id !== centeredViewLocationId ? viewLocation.id : spatial.currentLocationId;
  const compactFocusLocations = useMemo(() => {
    if (!compact) return visibleLocations;
    return getCompactMapLocations(
      activeLocations,
      visibleLocations,
      focusLocationIdForCompact,
      viewLocation?.id ?? null,
      showAllCompact,
    );
  }, [activeLocations, compact, focusLocationIdForCompact, showAllCompact, viewLocation, visibleLocations]);
  const mapLocations = compactFocusLocations;
  const focusedCompact = compact && !showAllCompact;
  const mapLocationIds = useMemo(() => new Set(mapLocations.map((location) => location.id)), [mapLocations]);
  const placementById = useMemo(
    () =>
      new Map(
        mapLocations.map((location, index) => [
          location.id,
          !compact || showAllCompact
            ? preview?.id === location.id
              ? preview
              : (location.placement ?? spatialRadialPlacement(index, mapLocations.length, 34))
            : location.id === focusLocationIdForCompact
              ? { x: 50, y: 50 }
              : focusedMapPlacement(mapLocations, focusLocationIdForCompact, location.id),
        ]),
      ),
    [compact, focusLocationIdForCompact, mapLocations, preview, showAllCompact],
  );
  const visibleLinks = useMemo(() => {
    const seen = new Set<string>();
    return mapLocations.flatMap((location) =>
      location.links.flatMap((link) => {
        if (link.state !== "available" || !mapLocationIds.has(link.targetId)) return [];
        const key = spatialLinkPresentationKey(location.id, link.targetId);
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ key, from: location.id, to: link.targetId }];
      }),
    );
  }, [mapLocationIds, mapLocations]);
  const selected = selectedId ? (locationById.get(selectedId) ?? null) : null;
  const selectedLinkedPlaces = useMemo(() => {
    if (!selected) return [];
    const linked = new Map<string, { location: SpatialLocation; label: string | null }>();
    for (const link of selected.links) {
      if (link.state !== "available") continue;
      const location = locationById.get(link.targetId);
      if (location)
        linked.set(location.id, {
          location,
          label: link.label?.trim() || null,
        });
    }
    for (const location of activeLocations) {
      if (location.id === selected.id) continue;
      const reverse = location.links.find(
        (link) => link.targetId === selected.id && link.bidirectional && link.state === "available",
      );
      if (reverse && !linked.has(location.id)) {
        linked.set(location.id, {
          location,
          label: reverse.label?.trim() || null,
        });
      }
    }
    return [...linked.values()].sort((left, right) => compareSpatialLocations(left.location, right.location));
  }, [activeLocations, locationById, selected]);
  const selectedDestination = spatial.destinations.find((destination) => destination.id === selected?.id);
  const selectedRoute = useMemo(
    () => (definition && selected ? findSpatialRoute(definition, spatial.currentLocationId, selected.id) : null),
    [definition, selected, spatial.currentLocationId],
  );
  const selectedTravelTarget =
    selectedDestination ??
    (selected && selectedRoute
      ? {
          id: selected.id,
          name: selected.name,
          kind: selected.kind,
          relation: "link" as const,
          sortOrder: selected.sortOrder,
          ...(selectedRoute.steps.at(-1)?.label ? { label: selectedRoute.steps.at(-1)!.label } : {}),
        }
      : null);
  const selectedHasChildren = selected ? activeLocations.some((location) => location.parentId === selected.id) : false;
  const viewBreadcrumb = definition ? resolveSpatialBreadcrumb(definition, viewLocation?.id ?? null) : [];
  const currentBreadcrumb = spatial.breadcrumb.map((crumb) => crumb.name).join(" › ");
  const presentation = viewLocation?.childPresentation ?? "map";
  const canBrowseUp = viewLocation !== null;

  const browseTo = (locationId: string | null) => {
    setViewLocationId(locationId);
    setSelectedId(locationId);
    setShowAllCompact(false);
  };

  const revealLocation = (location: SpatialLocation) => {
    setViewLocationId(location.parentId);
    setSelectedId(location.id);
  };

  const centerCurrent = () => {
    setViewLocationId(centeredViewLocationId);
    setSelectedId(spatial.currentLocationId);
  };

  const queueDestination = async (travelMode: "step_by_step" | "travel_now"): Promise<void> => {
    if (!definition || !spatial.currentLocationId || !selectedTravelTarget || disabled) return;
    if (onLocalMove) {
      onLocalMove(selectedTravelTarget.id);
      return;
    }
    if (pending && pending.transition.destinationId !== selectedTravelTarget.id) {
      const confirmed = await confirmAction({
        title: "Replace pending move?",
        message: `Replace the pending move to ${pending.destinationName}?`,
        confirmLabel: "Replace move",
      });
      if (!confirmed) return;
    }
    setPendingSpatialTransition(chatId, {
      transition: {
        destinationId: selectedTravelTarget.id,
        travelMode,
        expectedDefinitionRevision: definition.revision,
        expectedCurrentLocationId: spatial.currentLocationId,
        commandId: generateClientId(),
      },
      destinationName: selectedTravelTarget.name,
      relation: selectedTravelTarget.relation,
      ...(selectedTravelTarget.label ? { label: selectedTravelTarget.label } : {}),
      status: "ready",
    });
    onDestinationQueued?.();
  };

  const renderLocationRow = (location: SpatialLocation, layer = false) => {
    const isCurrent = location.id === spatial.currentLocationId;
    const isPending = location.id === pending?.transition.destinationId;
    const isSelected = location.id === selectedId;
    const hasChildren = activeLocations.some((candidate) => candidate.parentId === location.id);
    return (
      <button
        key={location.id}
        type="button"
        onDoubleClick={() => browseTo(location.id)}
        onClick={() => setSelectedId(location.id)}
        className={cn(
          "flex min-h-11 w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]",
          isSelected
            ? "border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--marinara-chat-chrome-highlight-bg)]"
            : "border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-panel-bg)] hover:bg-[var(--marinara-chat-chrome-highlight-bg-hover)]",
        )}
        aria-label={`Inspect ${location.name}${isCurrent ? ", current story location" : ""}${isPending ? ", pending destination" : ""}`}
      >
        <SpatialLocationIcon
          kind={location.kind}
          icon={location.icon}
          name={location.name}
          className="flex h-8 w-8 max-w-8 items-center justify-center rounded-lg bg-[var(--marinara-chat-chrome-highlight-bg)] text-lg"
        />
        <span className="min-w-0 flex-1">
          <span className="block whitespace-normal break-words text-xs font-semibold text-[var(--marinara-chat-chrome-panel-title)]">
            {location.name}
          </span>
          <span className="block whitespace-normal break-words text-[0.625rem] capitalize text-[var(--marinara-chat-chrome-panel-muted)]">
            {layer
              ? `Layer ${location.layerOrder ?? 0}`
              : hierarchyTypeForLocation(spatial.hierarchyProfile, location).label}
            {isCurrent ? " · You are here" : isPending ? " · Pending" : ""}
          </span>
        </span>
        {hasChildren && (
          <ChevronRight size="0.875rem" className="shrink-0 text-[var(--marinara-chat-chrome-panel-muted)]" />
        )}
      </button>
    );
  };

  if (!definition || !definition.enabled || activeLocations.length === 0) return null;

  return (
    <section aria-label="Hierarchical world map" className="min-w-0">
      {confirmationDialog}
      {connecting && (
        <p className="text-xs" role="status">
          {t(connectionFrom ? "ui.worldMaps.live.second" : "ui.worldMaps.live.first")}
        </p>
      )}
      {connecting &&
        connectionFrom &&
        connectionTo &&
        locationById.has(connectionFrom) &&
        locationById.has(connectionTo) && (
          <LiveMapConnection
            onSaveDefinition={onSaveDefinition}
            key={`${connectionFrom}:${connectionTo}`}
            chatId={chatId}
            spatial={spatial}
            fromId={connectionFrom}
            toId={connectionTo}
            onClose={() => {
              setConnectionFrom(null);
              setConnectionTo(null);
            }}
          />
        )}
      {(layoutError || updateSpatial.isPending) && (
        <div
          className="px-1 text-[11px] text-[var(--marinara-chat-chrome-muted)]"
          role={layoutError ? "alert" : "status"}
        >
          {layoutError
            ? t("ui.worldMaps.layout.failed")
            : updateSpatial.isPending
              ? t("ui.worldMaps.layout.saving")
              : null}
        </div>
      )}
      <div
        data-map-toolbar
        className="flex min-w-0 items-center border-b border-[var(--marinara-chat-chrome-panel-divider)] px-1"
      >
        {viewSwitch && (
          <div role="group" aria-label={viewSwitch.label} className="flex shrink-0 items-center gap-0.5">
            {(["world", "local"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={viewSwitch.value === value}
                onClick={() => viewSwitch.onChange(value)}
                className={cn(
                  "min-h-8 rounded px-1.5 text-[0.6875rem] pointer-coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]",
                  viewSwitch.value === value
                    ? "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-title)]"
                    : "text-[var(--marinara-chat-chrome-panel-muted)]",
                )}
              >
                {viewSwitch[value]}
              </button>
            ))}
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <button
            type="button"
            onClick={() => browseTo(viewLocation?.parentId ?? null)}
            disabled={!canBrowseUp}
            className="flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-lg text-[var(--marinara-chat-chrome-button-text)] hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)] disabled:opacity-30"
            aria-label={t("ui.worldMaps.header.up")}
          >
            <ChevronLeft size="1rem" />
          </button>
          <div className="min-w-0 flex-1">
            <p
              title={viewLocation?.name || t("ui.worldMaps.header.world")}
              className="truncate text-xs font-bold text-[var(--marinara-chat-chrome-panel-title)]"
            >
              <SpatialLocationIcon
                icon={viewLocation?.icon}
                name={viewLocation?.name}
                fallback="🌍"
                className="mr-1 max-w-[2.5em]"
              />
              {viewLocation?.name || t("ui.worldMaps.header.world")}
            </p>
          </div>
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={centerCurrent}
              className="flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-lg text-[var(--marinara-chat-chrome-button-text)] hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]"
              aria-label={t("ui.worldMaps.header.center")}
              title={t("ui.worldMaps.header.center")}
            >
              <LocateFixed size="1rem" />
            </button>
            {presentation === "map" && visibleLocations.length > 0 && (
              <button
                type="button"
                onClick={() => setShowListView((value) => !value)}
                aria-pressed={showListView}
                className="flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-lg text-[var(--marinara-chat-chrome-button-text)] hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]"
                aria-label={t(showListView ? "ui.worldMaps.header.map" : "ui.worldMaps.header.list")}
                title={t(showListView ? "ui.worldMaps.header.map" : "ui.worldMaps.header.list")}
              >
                {showListView ? <MapIcon size="1rem" /> : <List size="1rem" />}
              </button>
            )}
            {compact &&
              presentation === "map" &&
              (showAllCompact || visibleLocations.some((location) => !mapLocationIds.has(location.id))) && (
                <button
                  type="button"
                  onClick={() => setShowAllCompact((value) => !value)}
                  aria-pressed={showAllCompact}
                  className="min-h-8 rounded px-2 text-[0.625rem] font-semibold text-[var(--marinara-chat-chrome-button-text)] hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]"
                  aria-label={t(showAllCompact ? "ui.worldMaps.header.nearby" : "ui.worldMaps.header.all")}
                  title={t(showAllCompact ? "ui.worldMaps.header.nearby" : "ui.worldMaps.header.all")}
                >
                  {t(showAllCompact ? "ui.worldMaps.header.nearby" : "ui.worldMaps.header.all")}
                </button>
              )}
          </div>
        </div>
        <MapToolsPopover label={t("ui.worldMaps.header.details")}>
          <div className="flex flex-wrap gap-2 py-1">
            <button
              type="button"
              className="min-h-11 rounded border border-[var(--marinara-chat-chrome-panel-border)] px-2"
              disabled={compact || layoutDisabled || updateSpatial.isPending}
              aria-pressed={connecting}
              onClick={() => {
                setConnecting(!connecting);
                setConnectionFrom(null);
                setConnectionTo(null);
              }}
            >
              {t(connecting ? "ui.worldMaps.live.done" : "ui.worldMaps.live.edit")}
            </button>
            {onOpenEditor && (
              <button
                type="button"
                onClick={onOpenEditor}
                className="flex min-h-11 items-center gap-1 rounded px-2 text-[var(--marinara-chat-chrome-button-text)]"
              >
                <PencilLine size="1rem" />
                {t("ui.worldMaps.header.editor")}
              </button>
            )}
          </div>
          <p className="px-2 py-1 text-[var(--marinara-chat-chrome-panel-muted)]">
            {t("ui.worldMaps.layout.dragHint")}
          </p>
          <p className="whitespace-normal break-words px-2 py-1 text-[var(--marinara-chat-chrome-panel-muted)]">
            {onLocalMove ? t("ui.worldMaps.local.position") : t("ui.worldMaps.header.story")}{" "}
            {currentBreadcrumb || t("ui.worldMaps.header.unavailable")}
          </p>
          {viewBreadcrumb.length > 0 && (
            <div
              className="flex min-w-0 items-center justify-center gap-0.5 overflow-hidden"
              aria-label={t("ui.worldMaps.header.breadcrumb")}
            >
              {viewBreadcrumb.map((crumb, index) => (
                <span key={crumb.id} className="flex min-w-0 items-center">
                  {index > 0 && <ChevronRight size="0.625rem" className="shrink-0 opacity-50" />}
                  <button
                    type="button"
                    onClick={() => browseTo(crumb.id)}
                    className="max-w-24 whitespace-normal break-words rounded px-1 py-0.5 text-[0.625rem] text-[var(--marinara-chat-chrome-panel-muted)] hover:text-[var(--marinara-chat-chrome-panel-title)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]"
                    title={crumb.name}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
          )}
        </MapToolsPopover>
      </div>

      {pending && (
        <div
          className={cn(
            "mx-1 mt-2 flex min-h-11 items-center gap-2 rounded-lg border px-2 text-[0.6875rem]",
            pending.status === "needs_review"
              ? "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-200"
              : "border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--marinara-chat-chrome-highlight-bg)]",
          )}
          role="status"
        >
          {pending.status === "needs_review" ? <AlertTriangle size="0.8125rem" /> : <Route size="0.8125rem" />}
          <span className="min-w-0 flex-1">
            <span className="block whitespace-normal break-words font-semibold">
              Travel to {pending.destinationName}
            </span>
            <span className="block whitespace-normal break-words text-[0.625rem] opacity-75">
              {pending.status === "needs_review"
                ? "Needs review"
                : pending.transition.travelMode === "step_by_step"
                  ? "Step by step · one hop per turn"
                  : pending.transition.travelMode === "travel_now"
                    ? "Travel now · full route this turn"
                    : "Moves with your next turn"}
            </span>
          </span>
          <button
            type="button"
            onClick={() => clearPendingSpatialTransition(chatId, pending.transition.commandId)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]"
            aria-label={`Cancel move to ${pending.destinationName}`}
          >
            <X size="0.75rem" />
          </button>
        </div>
      )}

      <div
        data-marinara-maps-world-scroll={useParentScroll ? "parent" : "self"}
        className={cn(
          "min-h-0 py-1",
          useParentScroll
            ? "max-h-none overflow-visible"
            : cn("overflow-auto overscroll-contain", compact ? "max-h-[40dvh]" : "max-h-80"),
        )}
      >
        {visibleLocations.length === 0 ? (
          <div className="flex min-h-36 flex-col items-center justify-center px-5 text-center">
            <SpatialLocationIcon
              icon={viewLocation?.icon}
              name={viewLocation?.name}
              fallback="📍"
              className="text-2xl"
            />
            <p className="mt-2 text-xs font-semibold text-[var(--marinara-chat-chrome-panel-title)]">
              No places inside this location
            </p>
            <p className="mt-1 text-[0.6875rem] text-[var(--marinara-chat-chrome-panel-muted)]">
              Browse up to see nearby places.
            </p>
          </div>
        ) : presentation === "map" && !showListView ? (
          <MapViewport
            key={`${chatId}:${viewLocationId}`}
            contentRef={canvasRef}
            compact={compact}
            className="aspect-square w-full"
          >
            {mapBackgroundImageUrl && (
              <img
                src={mapBackgroundImageUrl}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 h-full w-full object-cover overflow-visible"
                style={{
                  objectPosition: `${mapBackgroundPosition.x}% ${mapBackgroundPosition.y}%`,
                }}
              />
            )}
            {spatial.hierarchyProfile.showConnections && (
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 h-full w-full"
                style={{ overflow: "visible" }}
              >
                {visibleLinks.map((link) => {
                  const from = placementById.get(link.from);
                  const to = placementById.get(link.to);
                  if (!from || !to) return null;
                  const linkIsSelected = selectedId === link.from || selectedId === link.to;
                  const linkPresentation = resolveSpatialLinkPresentation(spatial.hierarchyProfile, link.from, link.to);
                  return (
                    <line
                      key={link.key}
                      data-marinara-map-connection={link.key}
                      data-line-style={linkPresentation.lineStyle}
                      x1={`${from.x}%`}
                      y1={`${from.y}%`}
                      x2={`${to.x}%`}
                      y2={`${to.y}%`}
                      stroke={linkPresentation.color ?? "var(--marinara-chat-chrome-accent)"}
                      strokeWidth={linkIsSelected ? "3" : "2.25"}
                      strokeDasharray={spatialLinkStrokeDasharray(linkPresentation.lineStyle)}
                      strokeLinecap="round"
                      opacity={linkIsSelected ? "1" : "0.85"}
                      vectorEffect="non-scaling-stroke"
                      style={{
                        filter: "drop-shadow(0 0 1.5px var(--marinara-chat-chrome-panel-bg))",
                      }}
                    />
                  );
                })}
              </svg>
            )}
            {mapLocations.map((location) => {
              const placement = placementById.get(location.id) ?? {
                x: 50,
                y: 50,
              };
              const isCurrent = location.id === spatial.currentLocationId;
              const isPending = location.id === pending?.transition.destinationId;
              const isSelected = location.id === selectedId;
              return (
                <Fragment key={location.id}>
                  <button
                    key={location.id}
                    data-map-node-id={location.id}
                    onDoubleClick={() => {
                      if (!connecting) browseTo(location.id);
                    }}
                    type="button"
                    onClick={() => {
                      setSelectedId(location.id);
                      if (!connecting) return;
                      if (!connectionFrom || connectionTo) {
                        setConnectionFrom(location.id);
                        setConnectionTo(null);
                      } else if (connectionFrom !== location.id) setConnectionTo(location.id);
                    }}
                    title={`${location.name}. ${t("ui.worldMaps.layout.dragHint")}`}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      if (
                        connecting ||
                        focusedCompact ||
                        layoutDisabled ||
                        updateSpatial.isPending ||
                        event.button !== 0
                      )
                        return;
                      event.preventDefault();
                      dragPreview.current = null;
                      event.currentTarget.setPointerCapture(event.pointerId);
                      drag.current = {
                        id: location.id,
                        x: event.clientX,
                        y: event.clientY,
                        origin: placement,
                        moved: false,
                      };
                    }}
                    onPointerMove={(event) => {
                      const active = drag.current;
                      const bounds = canvasRef.current?.getBoundingClientRect();
                      if (!active || active.id !== location.id || !bounds) return;
                      const dx = event.clientX - active.x;
                      const dy = event.clientY - active.y;
                      if (!active.moved && Math.hypot(dx, dy) < 4) return;
                      active.moved = true;
                      const next = {
                        id: location.id,
                        x: snapMapCoordinate(active.origin.x + (dx / bounds.width) * 100),
                        y: snapMapCoordinate(active.origin.y + (dy / bounds.height) * 100),
                      };
                      dragPreview.current = next;
                      setPreview(next);
                    }}
                    onPointerUp={(event) => {
                      event.stopPropagation();
                      const active = drag.current;
                      drag.current = null;
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      const finalPosition = dragPreview.current;
                      dragPreview.current = null;
                      if (active?.moved && finalPosition?.id === location.id)
                        void savePlacement(location.id, { x: finalPosition.x, y: finalPosition.y });
                    }}
                    onPointerCancel={() => {
                      drag.current = null;
                      dragPreview.current = null;
                      setPreview(null);
                    }}
                    onLostPointerCapture={() => {
                      if (drag.current?.id !== location.id) return;
                      drag.current = null;
                      dragPreview.current = null;
                      setPreview(null);
                    }}
                    draggable={false}
                    onDragStart={(event) => event.preventDefault()}
                    onKeyDown={(event) => {
                      if (
                        focusedCompact ||
                        layoutDisabled ||
                        updateSpatial.isPending ||
                        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
                      )
                        return;
                      event.preventDefault();
                      event.stopPropagation();
                      const bounds = canvasRef.current?.getBoundingClientRect();
                      if (!bounds) return;
                      const step = event.shiftKey ? MAP_GRID_STEP * 5 : MAP_GRID_STEP;
                      const next = {
                        x: snapMapCoordinate(
                          placement.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
                        ),
                        y: snapMapCoordinate(
                          placement.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
                        ),
                      };
                      setPreview({ id: location.id, ...next });
                      void savePlacement(location.id, next);
                    }}
                    className="absolute z-10 flex min-h-[44px] w-[104px] touch-none select-none cursor-grab active:cursor-grabbing flex-col items-center rounded-lg p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]"
                    style={{
                      left: `${placement.x}%`,
                      top: `${placement.y}%`,
                      transform: "translate(-50%, -50%) scale(var(--map-marker-scale, 1))",
                    }}
                    aria-label={`Inspect ${location.name}${isCurrent ? ", current story location" : ""}${isPending ? ", pending destination" : ""}`}
                    aria-pressed={isSelected}
                  >
                    <span
                      className={cn(
                        "relative flex items-center justify-center rounded-full border bg-[var(--marinara-chat-chrome-panel-bg)] shadow-md transition-[border-color,background-color] duration-200",
                        isSelected
                          ? "scale-105 border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--background)]"
                          : "border-[var(--marinara-chat-chrome-panel-border)] hover:border-[var(--marinara-chat-chrome-button-border-hover)]",
                        isCurrent &&
                          "ring-2 ring-[var(--marinara-chat-chrome-focus-ring)] ring-offset-1 ring-offset-[var(--background)]",
                      )}
                      data-marinara-map-selected-location={isSelected ? "true" : undefined}
                      style={{
                        width: "clamp(28px, 7cqw, 36px)",
                        height: "clamp(28px, 7cqw, 36px)",
                        fontSize: "clamp(18px, 4.5cqw, 23px)",
                      }}
                      aria-hidden="true"
                    >
                      <SpatialLocationIcon kind={location.kind} icon={location.icon} name={location.name} />
                      {isPending && (
                        <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)]">
                          <Route size="0.5625rem" />
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block w-full whitespace-normal break-words rounded bg-[var(--marinara-chat-chrome-panel-bg)]/90 px-1 text-center text-[11px] font-semibold text-[var(--marinara-chat-chrome-panel-title)]">
                      {location.name}
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] font-semibold text-[var(--marinara-chat-chrome-accent)]">
                        You are here
                      </span>
                    )}
                  </button>
                  {connecting && (
                    <MapConnectionHandle
                      id={location.id}
                      name={location.name}
                      position={placement}
                      canvasRef={canvasRef}
                      disabled={layoutDisabled || updateSpatial.isPending}
                      onStart={(from) => {
                        setConnecting(true);
                        setConnectionFrom(from);
                        setConnectionTo(null);
                      }}
                      onConnect={(from, to) => {
                        setConnecting(true);
                        setConnectionFrom(from);
                        setConnectionTo(to);
                      }}
                    />
                  )}
                </Fragment>
              );
            })}
          </MapViewport>
        ) : (
          <div
            className="grid gap-1.5"
            role="list"
            aria-label={presentation === "layers" ? "Location layers" : "Locations"}
          >
            {(presentation === "layers"
              ? [...visibleLocations].sort((left, right) => (right.layerOrder ?? 0) - (left.layerOrder ?? 0))
              : visibleLocations
            ).map((location) => (
              <div key={location.id} role="listitem">
                {renderLocationRow(location, presentation === "layers")}
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div
          data-map-location-details
          className="border-t border-[var(--marinara-chat-chrome-panel-divider)] px-1 pt-1"
        >
          <div className="rounded-lg bg-[var(--marinara-chat-chrome-highlight-bg)] p-1.5">
            <div className="flex items-start gap-2">
              <SpatialLocationIcon icon={selected.icon} name={selected.name} fallback="📍" className="text-lg" />
              <div className="min-w-0 flex-1">
                <p className="whitespace-normal break-words text-xs font-bold text-[var(--marinara-chat-chrome-panel-title)]">
                  {selected.name}
                  {selected.id === spatial.currentLocationId && (
                    <span className="ml-2 text-[0.625rem] font-normal text-[var(--marinara-chat-chrome-accent)]">
                      {t("ui.worldMaps.location.here")}
                    </span>
                  )}
                </p>
                <p className="line-clamp-2 text-[0.6875rem] leading-4 text-[var(--marinara-chat-chrome-panel-muted)]">
                  {selected.description ||
                    `A ${hierarchyTypeForLocation(spatial.hierarchyProfile, selected).label} in this world.`}
                </p>
              </div>
            </div>
            {selectedLinkedPlaces.length > 0 && (
              <div className="mt-2">
                <p className="px-1 text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-[var(--marinara-chat-chrome-panel-muted)]">
                  Linked places
                </p>
                <div
                  className="mt-1 flex gap-1.5 overflow-x-auto overscroll-x-contain pb-1"
                  aria-label={`Linked places from ${selected.name}`}
                >
                  {selectedLinkedPlaces.map(({ location, label }) => (
                    <button
                      key={location.id}
                      type="button"
                      onClick={() => revealLocation(location)}
                      className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-button-bg)] px-2.5 text-left text-[0.6875rem] text-[var(--marinara-chat-chrome-button-text)] hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]"
                      aria-label={`Show linked place ${location.name}`}
                    >
                      <SpatialLocationIcon
                        kind={location.kind}
                        icon={location.icon}
                        name={location.name}
                        fallback="⌖"
                        className="text-sm"
                      />
                      <span>
                        <span className="block max-w-32 whitespace-normal break-words font-semibold">
                          {location.name}
                        </span>
                        {label && (
                          <span className="block max-w-32 whitespace-normal break-words text-[0.5625rem] opacity-70">
                            {label}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {selectedRoute && selectedRoute.steps.length > 1 && (
              <div className="mt-2 rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--background)]/40 p-2">
                <p className="text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-[var(--marinara-chat-chrome-panel-muted)]">
                  Shortest route · {selectedRoute.steps.length} hops
                </p>
                <ol className="mt-1 space-y-1 text-[0.625rem] text-[var(--marinara-chat-chrome-panel-muted)]">
                  {selectedRoute.steps.map((step, index) => (
                    <li key={`${step.locationId}-${index}`} className="flex items-center gap-1.5">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--marinara-chat-chrome-highlight-bg)] text-[0.5625rem] font-semibold">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-normal break-words">{step.locationName}</span>
                      {step.label && (
                        <span className="max-w-28 whitespace-normal break-words opacity-70">{step.label}</span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {(selected.id !== spatial.currentLocationId ||
              (selectedHasChildren && selected.id !== viewLocation?.id)) && (
              <div className="mt-1 flex flex-wrap justify-end gap-1.5">
                {selectedHasChildren && selected.id !== viewLocation?.id && (
                  <button
                    type="button"
                    onClick={() => browseTo(selected.id)}
                    className="flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-button-bg)] px-3 text-[0.6875rem] font-semibold text-[var(--marinara-chat-chrome-button-text-hover)] hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]"
                  >
                    <CornerDownRight size="0.75rem" /> Explore inside
                  </button>
                )}
                {selected.id === spatial.currentLocationId ? null : selected.id ===
                  pending?.transition.destinationId ? (
                  <span className="flex min-h-11 items-center gap-1.5 px-2 text-[0.6875rem] font-semibold text-[var(--marinara-chat-chrome-accent)]">
                    <Route size="0.75rem" />{" "}
                    {pending.transition.travelMode === "step_by_step" ? "Step-by-step queued" : "Travel queued"}
                  </span>
                ) : selectedTravelTarget ? (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => void queueDestination("step_by_step")}
                      disabled={disabled}
                      className="flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-button-bg)] px-3 text-[0.6875rem] font-semibold text-[var(--marinara-chat-chrome-button-text-hover)] hover:bg-[var(--marinara-chat-chrome-button-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={`Step by step to ${selected.name}`}
                    >
                      <Footprints size="0.75rem" /> Step by step
                    </button>
                    <button
                      type="button"
                      onClick={() => void queueDestination("travel_now")}
                      disabled={disabled}
                      className="flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 text-[0.6875rem] font-bold text-[var(--primary-foreground)] shadow-sm hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={`Travel now to ${selected.name}`}
                    >
                      <Zap size="0.75rem" /> Travel now
                    </button>
                  </div>
                ) : (
                  <span className="flex min-h-11 items-center px-2 text-[0.625rem] text-[var(--marinara-chat-chrome-panel-muted)]">
                    No available route from here
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
