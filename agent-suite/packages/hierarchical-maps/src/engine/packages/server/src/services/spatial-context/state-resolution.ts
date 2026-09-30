import {
  resolveSpatialBreadcrumb,
  resolveSpatialDestinations,
  SPATIAL_CONTEXT_LIMITS,
  type CapabilityPersistenceSession,
  spatialContextDefinitionSchema,
  spatialLocationKindSchema,
  type SpatialLocationKind,
  validateSpatialTransition,
  type SpatialContextDefinition,
  type SpatialContextSnapshot,
  type ResolvedSpatialTravel,
  type SpatialLocation,
} from "@marinara-engine/shared";
import { getPackagePersistence, logger, newId, newTimeSortableId, now } from "./package-runtime.js";
import { parseSpatialMetadata, readSpatialAutoTravelNowEnabled } from "./metadata.js";
import {
  readSpatialSharedWorldLink,
  resolveSpatialWorldSource,
  withSpatialSharedWorldDraft,
} from "./shared-world.service.js";
import { selectBoundGameMapForLocation } from "./game-map-binding.js";

export const supportsDiscoveryPaths = true;
export const supportsNarratedTeleport = true;

export type AssistantSpatialDirective =
  | { type: "move"; destinationId: string }
  | { type: "teleport"; destinationId: string; evidence: string; authorizationEvidence: string }
  | {
      type: "discover_path";
      parentId: string | null;
      locations: Array<{ name: string; kind: SpatialLocationKind; description: string }>;
    }
  | {
      type: "discover";
      name: string;
      relation: "enter" | "link" | "place";
      parentId?: string | null;
      direction?: "outgoing" | "incoming" | "both";
      description?: string;
    };

export interface SpatialMessageAnchor {
  messageId: string;
  swipeIndex: number;
}

export interface EffectiveSpatialState {
  definition: SpatialContextDefinition | null;
  snapshot: SpatialContextSnapshot | null;
  currentLocationId: string | null;
  definitionRevision: number;
  autoTravelNowEnabled: boolean;
  visibleAnchor: SpatialMessageAnchor | null;
  virtual: boolean;
}

export interface ResolveSpatialStateOptions {
  exactAnchor?: SpatialMessageAnchor;
  throughMessageId?: string;
  beforeMessageId?: string;
  acceptedTravel?: ResolvedSpatialTravel | null;
}

function normalizedLocationName(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[_-]+/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/^\s*(?:the|a|an)\s+/u, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function numberedLayerIdentity(value: string): string | null {
  const match = value.trim().match(/^(level|floor|storey|story|deck)\s+([a-z]?\d+[a-z]?)\b/iu);
  return match ? `${match[1]!.toLowerCase()} ${match[2]!.toLowerCase()}` : null;
}

function knownLocationMatches(definition: SpatialContextDefinition, guidance: string): SpatialLocation[] {
  const expected = normalizedLocationName(guidance);
  if (!expected) return [];
  const exact = definition.locations.filter((location) => {
    if (location.status !== "active") return false;
    const breadcrumb = resolveSpatialBreadcrumb(definition, location.id)
      .map((entry) => entry.name)
      .join(" > ");
    return normalizedLocationName(location.name) === expected || normalizedLocationName(breadcrumb) === expected;
  });
  if (exact.length > 0) return exact;
  const layerIdentity = numberedLayerIdentity(guidance);
  return layerIdentity
    ? definition.locations.filter(
        (location) => location.status === "active" && numberedLayerIdentity(location.name) === layerIdentity,
      )
    : [];
}

function exactGuidanceDestination(definition: SpatialContextDefinition, guidance: string): string | null {
  const matches = knownLocationMatches(definition, guidance);
  return matches.length === 1 ? matches[0]!.id : null;
}

function resolveAssistantMoveDestination(
  definition: SpatialContextDefinition,
  currentLocationId: string,
  requestedDestinationId: string,
  autoTravelNowEnabled: boolean,
  commandId: string,
): string | null {
  if (requestedDestinationId === currentLocationId) return null;
  if (autoTravelNowEnabled) {
    const validated = validateSpatialTransition(definition, currentLocationId, {
      destinationId: requestedDestinationId,
      travelMode: "travel_now",
      expectedDefinitionRevision: definition.revision,
      expectedCurrentLocationId: currentLocationId,
      commandId,
    });
    return validated.ok ? validated.destination.id : null;
  }
  const reachable = new Set(resolveSpatialDestinations(definition, currentLocationId).map(({ id }) => id));
  return reachable.has(requestedDestinationId) ? requestedDestinationId : null;
}

function hasExactEvidence(content: string, evidence: unknown): boolean {
  if (typeof evidence !== "string") return false;
  const quote = evidence.trim();
  return quote.length > 0 && quote === evidence && content.includes(quote);
}

function validateNarratedTeleportEvidence(
  input: {
    messageId: string;
    swipeIndex: number;
    regenerate: boolean;
    continuation: boolean;
    directive: Extract<AssistantSpatialDirective, { type: "teleport" }>;
  },
  messages: Array<{
    id: string;
    chatId: string;
    role: string;
    content: string;
    activeSwipeIndex: number;
  }>,
  chatId: string,
): void {
  const sourceIndex = messages.findIndex((message) => message.id === input.messageId);
  const source = sourceIndex >= 0 ? messages[sourceIndex] : null;
  if (
    !source ||
    source.chatId !== chatId ||
    source.role !== "assistant" ||
    source.activeSwipeIndex !== input.swipeIndex ||
    !hasExactEvidence(source.content, input.directive.evidence)
  ) {
    throw new Error("Narrated teleport evidence does not match the saved assistant turn.");
  }
  if (
    !input.regenerate &&
    !input.continuation &&
    messages.slice(sourceIndex + 1).some(({ role }) => role !== "system")
  ) {
    throw new Error("A newer visible turn appeared after the narrated teleport source.");
  }
  const priorUserMessages = messages
    .slice(Math.max(0, sourceIndex - 31), sourceIndex)
    .filter((message) => message.role === "user");
  if (!priorUserMessages.some((message) => hasExactEvidence(message.content, input.directive.authorizationEvidence))) {
    throw new Error("Narrated teleport evidence does not match a preceding user turn.");
  }
}

function addAvailableLink(
  definition: SpatialContextDefinition,
  currentLocationId: string,
  destinationId: string,
  direction: "outgoing" | "incoming" | "both" = "both",
): SpatialContextDefinition | null {
  if (currentLocationId === destinationId) return null;
  const current = definition.locations.find((location) => location.id === currentLocationId);
  const destination = definition.locations.find((location) => location.id === destinationId);
  if (!current || !destination || current.status !== "active" || destination.status !== "active") return null;
  const sourceId = direction === "incoming" ? destinationId : currentLocationId;
  const targetId = direction === "incoming" ? currentLocationId : destinationId;
  const source = definition.locations.find((location) => location.id === sourceId);
  if (!source) return null;
  const pairLinks = definition.locations.flatMap((location) =>
    location.links
      .filter(
        (link) =>
          (location.id === currentLocationId && link.targetId === destinationId) ||
          (location.id === destinationId && link.targetId === currentLocationId),
      )
      .map((link) => ({ locationId: location.id, link })),
  );
  const existingLabel = pairLinks.find(({ link }) => link.label?.trim())?.link.label?.trim();
  const canonicalLink = {
    targetId,
    ...(existingLabel ? { label: existingLabel } : {}),
    bidirectional: direction === "both",
    state: "available" as const,
  };
  const alreadyCanonical =
    pairLinks.length === 1 &&
    pairLinks[0]?.locationId === sourceId &&
    pairLinks[0].link.targetId === targetId &&
    pairLinks[0].link.bidirectional === canonicalLink.bidirectional &&
    pairLinks[0].link.state === "available";
  if (alreadyCanonical) return definition;
  const sourceLinksWithoutPair = source.links.filter(
    (link) => !(sourceId === currentLocationId ? link.targetId === destinationId : link.targetId === currentLocationId),
  );
  if (sourceLinksWithoutPair.length >= SPATIAL_CONTEXT_LIMITS.maxLinksPerLocation) return null;
  return {
    ...definition,
    revision: definition.revision + 1,
    locations: definition.locations.map((location) => {
      if (location.id === sourceId)
        return {
          ...location,
          links: [...sourceLinksWithoutPair, canonicalLink],
        };
      if (location.id === currentLocationId || location.id === destinationId) {
        return {
          ...location,
          links: location.links.filter(
            (link) =>
              !(location.id === currentLocationId && link.targetId === destinationId) &&
              !(location.id === destinationId && link.targetId === currentLocationId),
          ),
        };
      }
      return location;
    }),
  };
}

function discoverLocation(
  definition: SpatialContextDefinition,
  currentLocationId: string,
  directive: Extract<AssistantSpatialDirective, { type: "discover" }>,
): { definition: SpatialContextDefinition; destinationId: string } | null {
  const nameKey = normalizedLocationName(directive.name);
  if (!nameKey) return null;
  const matching = knownLocationMatches(definition, directive.name);
  const reachableIds = new Set(resolveSpatialDestinations(definition, currentLocationId).map((entry) => entry.id));
  const reachableMatching = matching.filter((location) => reachableIds.has(location.id));
  if (reachableMatching.length === 1) {
    return { definition, destinationId: reachableMatching[0]!.id };
  }
  if (matching.length === 1) return null;
  if (matching.length > 1 || definition.locations.length >= SPATIAL_CONTEXT_LIMITS.maxLocations) return null;

  const current = definition.locations.find((location) => location.id === currentLocationId);
  if (!current) return null;
  const requestedParentId = Object.prototype.hasOwnProperty.call(directive, "parentId")
    ? directive.parentId
    : directive.relation === "enter"
      ? currentLocationId
      : null;
  if (requestedParentId !== null && typeof requestedParentId !== "string") return null;
  if (
    (directive.relation === "enter" && requestedParentId !== currentLocationId) ||
    (directive.relation === "link" && requestedParentId === currentLocationId)
  ) {
    logger.warn("[spatial/assistant] Ignored discovery with contradictory containment: %o", {
      currentLocationId,
      requestedParentId,
      directive,
    });
    return null;
  }
  const parent =
    requestedParentId === null
      ? null
      : definition.locations.find((location) => location.id === requestedParentId && location.status === "active");
  if (requestedParentId !== null && !parent) {
    logger.warn("[spatial/assistant] Ignored discovery with an unknown or archived parent: %o", {
      currentLocationId,
      requestedParentId,
      directive,
    });
    return null;
  }
  const parentId = requestedParentId;
  const siblings = definition.locations.filter((location) => location.parentId === parentId);
  const sortOrder = Math.max(-1, ...siblings.map((location) => location.sortOrder)) + 1;
  const layerOrder =
    parent?.childPresentation === "layers"
      ? Math.max(-1, ...siblings.map((location) => location.layerOrder ?? -1)) + 1
      : undefined;
  const destinationId = `loc_${newId()}`;
  const discovered: SpatialLocation = {
    id: destinationId,
    parentId,
    name: directive.name,
    kind: "place",
    description: directive.description ?? "A location discovered during the story.",
    lorebookEntryIds: [],
    childPresentation: "list",
    links: [],
    status: "active",
    sortOrder,
    ...(layerOrder === undefined ? {} : { layerOrder }),
  };
  let nextDefinition: SpatialContextDefinition = {
    ...definition,
    revision: definition.revision + 1,
    locations: [...definition.locations, discovered],
  };
  if (directive.relation === "link") {
    if (!directive.direction) {
      logger.warn("[spatial/assistant] Ignored link discovery without an explicit direction: %o", {
        currentLocationId,
        destinationId,
        directive,
      });
      return null;
    }
    const linked = addAvailableLink(
      { ...nextDefinition, revision: definition.revision },
      currentLocationId,
      destinationId,
      directive.direction,
    );
    if (!linked) return null;
    nextDefinition = linked;
  }
  const parsed = spatialContextDefinitionSchema.safeParse(nextDefinition);
  return parsed.success ? { definition: parsed.data as SpatialContextDefinition, destinationId } : null;
}

/** Build the entire containment chain before the transaction persists anything. */
function discoverLocationPath(
  definition: SpatialContextDefinition,
  directive: Extract<AssistantSpatialDirective, { type: "discover_path" }>,
): { definition: SpatialContextDefinition; destinationId: string } {
  if (!Array.isArray(directive.locations) || directive.locations.length < 1 || directive.locations.length > 6) {
    throw new Error("Location discovery needs one to six places");
  }
  let parentId = directive.parentId;
  if (
    parentId !== null &&
    !definition.locations.some((location) => location.id === parentId && location.status === "active")
  ) {
    throw new Error("Location discovery selected an unknown or archived parent");
  }
  const locations = [...definition.locations];
  for (const proposed of directive.locations) {
    if (
      typeof proposed?.name !== "string" ||
      !normalizedLocationName(proposed.name) ||
      proposed.name.length > 200 ||
      typeof proposed.description !== "string" ||
      !proposed.description.trim() ||
      proposed.description.length > 4000
    ) {
      throw new Error("Invalid discovered location name or description");
    }
    const kind = spatialLocationKindSchema.parse(proposed.kind);
    const siblings = locations.filter((location) => location.parentId === parentId);
    const matches = siblings.filter(
      (location) => normalizedLocationName(location.name) === normalizedLocationName(proposed.name),
    );
    if (matches.length > 1 || (matches.length === 1 && matches[0]!.status !== "active")) {
      throw new Error("Discovered location is ambiguous or archived");
    }
    if (matches.length === 1) {
      parentId = matches[0]!.id;
      continue;
    }
    if (locations.length >= SPATIAL_CONTEXT_LIMITS.maxLocations) throw new Error("World map location limit reached");
    const parent = locations.find((location) => location.id === parentId);
    const id = `loc_${newId()}`;
    locations.push({
      id,
      parentId,
      name: proposed.name.trim(),
      kind,
      description: proposed.description.trim(),
      lorebookEntryIds: [],
      childPresentation: "list",
      links: [],
      status: "active",
      sortOrder: Math.max(-1, ...siblings.map((location) => location.sortOrder)) + 1,
      ...(parent?.childPresentation === "layers"
        ? { layerOrder: Math.max(-1, ...siblings.map((location) => location.layerOrder ?? -1)) + 1 }
        : {}),
    });
    parentId = id;
  }
  const next =
    locations.length === definition.locations.length
      ? definition
      : (spatialContextDefinitionSchema.parse({
          ...definition,
          revision: definition.revision + 1,
          locations,
        }) as SpatialContextDefinition);
  return { definition: next, destinationId: parentId! };
}

export function parseStoredSpatialDefinition(rawMetadata: unknown): SpatialContextDefinition | null {
  const candidate = parseSpatialMetadata(rawMetadata).spatialContext;
  const parsed = spatialContextDefinitionSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as SpatialContextDefinition) : null;
}

function anchorForMessage(message: { id: string; role: string; activeSwipeIndex: number }): SpatialMessageAnchor {
  return {
    messageId: message.id,
    swipeIndex: message.role === "assistant" ? message.activeSwipeIndex : 0,
  };
}

export async function resolveEffectiveSpatialState(
  chatId: string,
  options: ResolveSpatialStateOptions = {},
  persistence: CapabilityPersistenceSession = getPackagePersistence(),
): Promise<EffectiveSpatialState> {
  const chat = await persistence.getChat(chatId);
  const definition = chat ? (await resolveSpatialWorldSource(chat, persistence)).definition : null;
  const autoTravelNowEnabled = readSpatialAutoTravelNowEnabled(chat?.metadata);
  const storage = persistence.spatialSnapshots;

  if (options.exactAnchor) {
    const snapshot = await storage.getByAnchor(chatId, options.exactAnchor.messageId, options.exactAnchor.swipeIndex);
    return {
      definition,
      snapshot,
      currentLocationId: snapshot?.currentLocationId ?? null,
      definitionRevision: snapshot?.definitionRevision ?? definition?.revision ?? 0,
      autoTravelNowEnabled,
      visibleAnchor: options.exactAnchor,
      virtual: false,
    };
  }

  const ordered = await persistence.listMessages(chatId);

  let end = ordered.length - 1;
  if (options.beforeMessageId) {
    const index = ordered.findIndex((message) => message.id === options.beforeMessageId);
    end = index < 0 ? -1 : index - 1;
  } else if (options.throughMessageId) {
    const index = ordered.findIndex((message) => message.id === options.throughMessageId);
    end = index < 0 ? -1 : index;
  }

  const visibleMessage = end >= 0 ? ordered[end] : undefined;
  const visibleAnchor = visibleMessage ? anchorForMessage(visibleMessage) : null;
  const eligibleAnchors = ordered.slice(0, end + 1).map(anchorForMessage);
  const snapshots = await storage.listByAnchors(chatId, eligibleAnchors);
  const snapshotsByAnchor = new Map(
    snapshots.map((snapshot) => [`${snapshot.messageId}\u0000${snapshot.swipeIndex}`, snapshot]),
  );
  for (let index = end; index >= 0; index -= 1) {
    const message = ordered[index];
    if (!message) continue;
    const anchor = anchorForMessage(message);
    const snapshot = snapshotsByAnchor.get(`${anchor.messageId}\u0000${anchor.swipeIndex}`);
    if (!snapshot) continue;
    return {
      definition,
      snapshot,
      currentLocationId: snapshot.currentLocationId,
      definitionRevision: snapshot.definitionRevision,
      autoTravelNowEnabled,
      visibleAnchor,
      virtual: false,
    };
  }

  const bootstrap = await storage.getBootstrap(chatId);
  if (bootstrap) {
    return {
      definition,
      snapshot: bootstrap,
      currentLocationId: bootstrap.currentLocationId,
      definitionRevision: bootstrap.definitionRevision,
      autoTravelNowEnabled,
      visibleAnchor,
      virtual: false,
    };
  }

  const startingLocationId = definition?.enabled ? definition.startingLocationId : null;
  return {
    definition,
    snapshot: null,
    currentLocationId: startingLocationId,
    definitionRevision: definition?.revision ?? 0,
    autoTravelNowEnabled,
    visibleAnchor,
    virtual: startingLocationId !== null,
  };
}

export async function materializeAssistantSpatialState(input: {
  chatId: string;
  messageId: string;
  swipeIndex: number;
  regenerate: boolean;
  continuation: boolean;
  expectedCurrentLocationId?: string;
  expectedDefinitionRevision?: number;
  directive?: AssistantSpatialDirective | null;
  locationGuidance?: string | null;
}): Promise<SpatialContextSnapshot | null> {
  const persistence = getPackagePersistence();
  return persistence.withChatLock(input.chatId, async () =>
    persistence.transaction(async (transaction) => {
      const existingAtAnchor = await transaction.spatialSnapshots.getByAnchor(
        input.chatId,
        input.messageId,
        input.swipeIndex,
      );
      if (input.locationGuidance && existingAtAnchor?.transitionCommandId?.startsWith("assistant:")) {
        return existingAtAnchor;
      }
      const state = input.regenerate
        ? await resolveEffectiveSpatialState(input.chatId, { beforeMessageId: input.messageId }, transaction)
        : input.continuation
          ? await resolveEffectiveSpatialState(input.chatId, { throughMessageId: input.messageId }, transaction)
          : await resolveEffectiveSpatialState(input.chatId, {}, transaction);

      if (!state.definition?.enabled || state.currentLocationId === null) return null;
      if (
        (input.expectedCurrentLocationId !== undefined &&
          input.expectedCurrentLocationId !== state.currentLocationId) ||
        (input.expectedDefinitionRevision !== undefined &&
          input.expectedDefinitionRevision !== state.definition.revision)
      ) {
        throw new Error("The world map changed during location reconciliation; retry with the updated location.");
      }
      let definition = state.definition;
      let destinationId = state.currentLocationId;
      let transitionApplied = false;

      if (input.directive?.type === "teleport") {
        const directive = input.directive;
        if (!state.autoTravelNowEnabled) {
          throw new Error("Narrated teleport requires Automatic Travel now.");
        }
        if (input.expectedCurrentLocationId === undefined || input.expectedDefinitionRevision === undefined) {
          throw new Error("Narrated teleport requires expected current location and map revision.");
        }
        validateNarratedTeleportEvidence(
          { ...input, directive },
          await transaction.listMessages(input.chatId),
          input.chatId,
        );
        const current = definition.locations.find((location) => location.id === state.currentLocationId);
        if (!current || current.status !== "active") {
          throw new Error("Narrated teleport current location is unknown or archived.");
        }
        const destination = definition.locations.find((location) => location.id === directive.destinationId);
        if (!destination || destination.status !== "active") {
          throw new Error("Narrated teleport destination is unknown or archived.");
        }
        if (destination.id === state.currentLocationId) {
          throw new Error("Narrated teleport destination must differ from the current location.");
        }
        destinationId = destination.id;
        transitionApplied = true;
      } else if (input.directive?.type === "move") {
        const resolvedDestinationId = resolveAssistantMoveDestination(
          definition,
          state.currentLocationId,
          input.directive.destinationId,
          state.autoTravelNowEnabled,
          `assistant:${input.messageId}:${input.swipeIndex}`.slice(0, 200),
        );
        if (resolvedDestinationId) {
          destinationId = resolvedDestinationId;
          transitionApplied = true;
        }
      } else if (input.directive?.type === "discover") {
        const discovered =
          input.directive.relation === "place" && !state.autoTravelNowEnabled
            ? null
            : discoverLocation(definition, state.currentLocationId, input.directive);
        if (discovered) {
          definition = discovered.definition;
          destinationId = discovered.destinationId;
          transitionApplied =
            destinationId !== state.currentLocationId || definition.revision !== state.definition.revision;
        }
      } else if (input.directive?.type === "discover_path" && state.autoTravelNowEnabled) {
        const discovered = discoverLocationPath(definition, input.directive);
        definition = discovered.definition;
        destinationId = discovered.destinationId;
        transitionApplied =
          destinationId !== state.currentLocationId || definition.revision !== state.definition.revision;
      } else if (input.locationGuidance) {
        const guidedDestinationId = exactGuidanceDestination(definition, input.locationGuidance);
        const resolvedDestinationId = guidedDestinationId
          ? resolveAssistantMoveDestination(
              definition,
              state.currentLocationId,
              guidedDestinationId,
              state.autoTravelNowEnabled,
              `assistant:${input.messageId}:${input.swipeIndex}`.slice(0, 200),
            )
          : null;
        if (resolvedDestinationId) {
          destinationId = resolvedDestinationId;
          transitionApplied = true;
        }
      }

      const chat = await transaction.getChat(input.chatId);
      if (!chat) return null;
      const metadata = parseSpatialMetadata(chat.metadata);
      let nextMetadata = metadata;
      if (definition.revision !== state.definition.revision) {
        const link = readSpatialSharedWorldLink(metadata);
        if (link) {
          const source = await resolveSpatialWorldSource(chat, transaction);
          nextMetadata = withSpatialSharedWorldDraft(
            nextMetadata,
            link,
            link.draft?.baseWorldRevision ?? source.world?.revision ?? state.definition.revision,
            definition,
            source.hierarchyProfile,
            now(),
          );
        } else {
          nextMetadata = { ...nextMetadata, spatialContext: definition };
        }
      }
      if (chat.mode === "game" && transitionApplied) {
        nextMetadata = selectBoundGameMapForLocation(nextMetadata, definition, destinationId);
      }
      if (nextMetadata !== metadata) {
        await transaction.updateChatMetadata({
          chatId: input.chatId,
          metadata: nextMetadata,
          updatedAt: now(),
        });
      }

      const transitionCommandId = transitionApplied
        ? `assistant:${input.messageId}:${input.swipeIndex}`.slice(0, 200)
        : input.regenerate
          ? null
          : (existingAtAnchor?.transitionCommandId ?? null);
      const snapshot = await transaction.spatialSnapshots.replaceAtAnchor({
        id: newTimeSortableId(),
        chatId: input.chatId,
        messageId: input.messageId,
        swipeIndex: input.swipeIndex,
        currentLocationId: destinationId,
        definitionRevision: definition.revision,
        source: "assistant_swipe",
        transitionCommandId,
        transitionPayloadHash: null,
        createdAt: now(),
      });
      if (transitionApplied) {
        logger.info(
          "[spatial/assistant] Applied narrated location transition for chat %s to %s",
          input.chatId,
          destinationId,
        );
      }
      return snapshot;
    }),
  );
}
