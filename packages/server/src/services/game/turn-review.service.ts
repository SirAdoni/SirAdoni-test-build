import { createHash } from "node:crypto";
import type {
  GameTurnClock,
  GameTurnReview,
  GameTurnReviewChange,
  GameTurnReviewCorrection,
  GameTurnReviewEvidence,
  GameTurnReviewLocation,
  GameTurnReviewState,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { createChatsStorage, withGameTurnReviewWrite } from "../storage/chats.storage.js";
import { isGameTurnReviewMutationPending as isReviewWritePending } from "../storage/chats.storage.js";
import { and, eq } from "../../db/file-query.js";
import {
  chats as chatsTable,
  messages as messagesTable,
  messageSwipes,
  gameStateSnapshots,
  spatialContextSnapshots,
} from "../../db/schema/index.js";
import { createGameStateStorage } from "../storage/game-state.storage.js";
import { createSpatialContextStorage } from "../storage/spatial-context.storage.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { isSceneTimelinePending, readSource } from "./scene-timeline.service.js";
import { addMinutes } from "./time.service.js";
import { syncGameMapMetaPartyPosition } from "./map-position.service.js";
import { applyAllSegmentEdits } from "./segment-edits.js";
import { sceneTurnSchema } from "./scene-timeline-model.js";
import { validateSceneClockEvidence } from "../sidecar/scene-postprocess.js";

const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, any>;
};
const correctionQueues = new Map<string, Promise<unknown>>();

function parseExtra(value: unknown): Record<string, any> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return record(value);
}
function visibleTurn(message: any): boolean {
  const extra = parseExtra(message.extra);
  return (
    extra.hiddenFromUser !== true &&
    extra.hiddenFromAI !== true &&
    extra.roleplayPrivateOnly !== true &&
    extra.commandOnly !== true
  );
}

function clock(value: unknown): GameTurnClock | null {
  const raw = record(value);
  if (!Number.isInteger(raw.day) || !Number.isInteger(raw.hour) || !Number.isInteger(raw.minute)) return null;
  if (raw.day < 1 || raw.hour < 0 || raw.hour > 23 || raw.minute < 0 || raw.minute > 59) return null;
  return { day: raw.day, hour: raw.hour, minute: raw.minute };
}

function stateText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function locationList(metadata: unknown): GameTurnReviewLocation[] {
  const raw = parseExtra(metadata).spatialContext?.locations;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({ id: typeof item?.id === "string" ? item.id : null, name: stateText(item?.name) }))
    .filter((item): item is GameTurnReviewLocation => !!item.name)
    .map((item) => ({ id: item.id, name: item.name }));
}

function revision(
  message: { id: string; activeSwipeIndex?: number | null; content: string; extra: unknown },
  sourceHash?: string,
  canonicalState?: unknown,
): string {
  const extra = parseExtra(message.extra);
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: message.id,
        swipeIndex: message.activeSwipeIndex ?? 0,
        content: message.content,
        clock: extra.gameTurnClock,
        corrections: extra.gameTurnReviewCorrections,
        scene: extra.gameSceneTimeline,
        sourceHash: sourceHash ?? null,
        canonicalState,
      }),
    )
    .digest("hex");
}

function quoteEvidence(messageId: string, swipeIndex: number, quote: unknown): GameTurnReviewEvidence | null {
  return typeof quote === "string" && quote.trim() ? { messageId, swipeIndex, quote: quote.trim() } : null;
}

function formatTime(value: GameTurnClock | null): string | null {
  return value
    ? `Day ${value.day}, ${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`
    : null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  try {
    return parseStringArray(JSON.parse(value));
  } catch {
    return [];
  }
}

function parseStoredArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type PresenceIdentity = { id: string | null; name: string };
function canonicalPresenceName(
  input: string,
  chat: any,
  state: any,
  linkedNames: PresenceIdentity[] = [],
): PresenceIdentity | null {
  const metadata = parseExtra(chat.metadata);
  const candidates: PresenceIdentity[] = [];
  const add = (value: unknown, id: string | null = null) => {
    if (typeof value === "string" && value.trim()) candidates.push({ id, name: value.trim() });
  };
  for (const npc of Array.isArray(metadata.gameNpcs) ? metadata.gameNpcs : []) {
    add(npc?.name, npc?.characterId?.trim() || npc?.id || null);
  }
  for (const card of Array.isArray(metadata.gameCharacterCards) ? metadata.gameCharacterCards : [])
    add(card?.name, card?.characterId ?? card?.id ?? null);
  for (const identity of linkedNames) candidates.push(identity);
  for (const item of parseStoredArray(state?.presentCharacters)) add(item?.name, item?.characterId ?? null);
  const normalized = input.trim().toLocaleLowerCase();
  const matches = candidates.filter((entry) => entry.name.toLocaleLowerCase() === normalized);
  const identified = new Map(matches.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  // The same person commonly exists in the linked cards, NPC registry and
  // current roster. Deduplicate by stable identity, never merely by name.
  if (identified.size === 1) return [...identified.values()][0]!;
  if (identified.size > 1) return null;
  return matches.length === 1 ? matches[0]! : null;
}

async function readReview(
  db: DB,
  chatId: string,
  messageId: string,
): Promise<
  {
    review: GameTurnReview;
    message: any;
    chat: any;
  } & { sourceHash: string | null }
> {
  const chats = createChatsStorage(db);
  const chat = await chats.getById(chatId);
  if (!chat) throw new Error("Chat not found");
  if (chat.mode !== "game") throw new Error("Turn review is available only for Game Mode chats.");
  const messages = await chats.listMessages(chatId);
  const message = messages.find((entry) => entry.id === messageId);
  if (!message) throw new Error("Message not found");
  const swipeIndex = message.activeSwipeIndex ?? 0;
  const extra = parseExtra(message.extra);
  const currentClock = record(extra.gameTurnClock);
  const afterClock = clock(currentClock.after);
  const beforeClock = clock(currentClock.before);
  const previous = messages
    .slice(
      0,
      messages.findIndex((entry) => entry.id === messageId),
    )
    .reverse()
    .find((entry) => (entry.role === "assistant" || entry.role === "narrator") && visibleTurn(entry));
  const previousExtra = parseExtra(previous?.extra);
  const snapshots = createSpatialContextStorage();
  const currentSpatial = await snapshots.getByAnchor(chatId, messageId, swipeIndex);
  const previousSpatial = previous
    ? await snapshots.getByAnchor(chatId, previous.id, previous.activeSwipeIndex ?? 0)
    : null;
  const locations = locationList(chat.metadata);
  const nameFor = (id: string | null) => locations.find((item) => item.id === id) ?? (id ? { id, name: id } : null);
  const currentState = await createGameStateStorage(db).getByChatAndMessage(chatId, messageId, swipeIndex);
  const previousState = previous
    ? await createGameStateStorage(db).getByChatAndMessage(chatId, previous.id, previous.activeSwipeIndex ?? 0)
    : null;
  const timeline = parseExtra(message.extra).gameSceneTimeline;
  const source = await readSource(db, chatId);
  const sourceTurn = source.turns.find((turn) => turn.message.id === message.id);
  const parsedTimeline = sceneTurnSchema.safeParse(timeline);
  const sourceBoundTimeline =
    sourceTurn && parsedTimeline.success && timeline?.hash === sourceTurn.hash ? parsedTimeline.data : null;
  const editedMessages = messages.map((entry) => ({ ...entry }));
  applyAllSegmentEdits(editedMessages, parseExtra(chat.metadata), messages);
  const editedCurrent = editedMessages.find((entry) => entry.id === message.id);
  const sourceText = editedCurrent?.content ?? message.content;
  const visits = sourceBoundTimeline
    ? sourceBoundTimeline.visits.map((visit: any) => ({
        ...visit,
        presenceEvidence: Array.isArray(visit.presenceEvidence)
          ? visit.presenceEvidence.filter(
              (item: any) => typeof item?.quote === "string" && sourceText.includes(item.quote),
            )
          : [],
        departures: Array.isArray(visit.departures)
          ? visit.departures.filter((item: any) => typeof item?.quote === "string" && sourceText.includes(item.quote))
          : [],
      }))
    : [];
  const lastVisit = visits.at(-1);
  const previousSourceTurn = previous ? source.turns.find((turn) => turn.message.id === previous.id) : undefined;
  const previousTimeline = sceneTurnSchema.safeParse(previousExtra.gameSceneTimeline);
  const previousVisits =
    previousSourceTurn && previousTimeline.success && previousExtra.gameSceneTimeline?.hash === previousSourceTurn.hash
      ? previousTimeline.data.visits
      : [];
  const previousVisit = previousVisits.at(-1);
  const previousPresent = parseStoredArray(previousState?.presentCharacters)
    .map((item: any) => item?.name)
    .filter((name: unknown): name is string => typeof name === "string");
  const currentPresent = parseStoredArray(currentState?.presentCharacters)
    .map((item: any) => item?.name)
    .filter((name: unknown): name is string => typeof name === "string");
  const beforePresent =
    previousState !== null ? previousPresent : Array.isArray(previousVisit?.present) ? previousVisit.present : null;
  const afterPresent =
    currentState !== null ? currentPresent : Array.isArray(lastVisit?.present) ? lastVisit.present : null;
  const beforeLocation = nameFor(previousSpatial?.currentLocationId ?? null);
  const afterLocation = nameFor(currentSpatial?.currentLocationId ?? null);
  const before: GameTurnReviewState = {
    time: beforeClock,
    location: beforeLocation,
    present: beforePresent,
  };
  const after: GameTurnReviewState = { time: afterClock, location: afterLocation, present: afterPresent };
  const changes: GameTurnReviewChange[] = [];
  const clockEvidenceMessage = editedMessages.find((entry) => entry.id === currentClock.timeEvidence?.messageId);
  const capturedTimeEvidence =
    typeof currentClock.timeEvidence?.quote === "string" &&
    clockEvidenceMessage &&
    (clockEvidenceMessage.activeSwipeIndex ?? 0) === currentClock.timeEvidence.swipeIndex &&
    clockEvidenceMessage.content.includes(currentClock.timeEvidence.quote)
      ? quoteEvidence(
          typeof currentClock.timeEvidence.messageId === "string" ? currentClock.timeEvidence.messageId : messageId,
          Number.isInteger(currentClock.timeEvidence.swipeIndex) ? currentClock.timeEvidence.swipeIndex : swipeIndex,
          currentClock.timeEvidence.quote,
        )
      : null;
  if (JSON.stringify(before.time) !== JSON.stringify(after.time))
    changes.push({
      id: "time",
      field: "time",
      before: formatTime(before.time),
      after: formatTime(after.time),
      evidence: capturedTimeEvidence,
      source: capturedTimeEvidence ? "recorded" : "state_only",
    });
  if (JSON.stringify(before.location) !== JSON.stringify(after.location)) {
    const locationVisit = visits.at(-1);
    const locationQuote = typeof locationVisit?.locationEvidence === "string" ? locationVisit.locationEvidence : null;
    const locationEvidence =
      locationQuote &&
      locationVisit?.location.toLocaleLowerCase() === after.location?.name.toLocaleLowerCase() &&
      sourceText.includes(locationQuote)
        ? quoteEvidence(messageId, swipeIndex, locationQuote)
        : null;
    changes.push({
      id: "location",
      field: "location",
      before: before.location?.name ?? null,
      after: after.location?.name ?? null,
      evidence: locationEvidence,
      source: locationEvidence ? "recorded" : "state_only",
    });
  }
  const arrivals = new Map<string, GameTurnReviewEvidence>();
  const departures = new Map<string, GameTurnReviewEvidence>();
  for (const visit of visits) {
    for (const [items, target] of [
      [visit.presenceEvidence ?? [], arrivals],
      [visit.departures ?? [], departures],
    ] as const) {
      for (const item of items) {
        const evidence = quoteEvidence(messageId, swipeIndex, item.quote);
        if (typeof item.name === "string" && evidence) target.set(item.name.toLocaleLowerCase(), evidence);
      }
    }
  }
  const correctionMap = new Set(
    (Array.isArray(extra.gameTurnReviewCorrections) ? extra.gameTurnReviewCorrections : []).map((item: any) =>
      item?.field === "presence" ? `presence:${item.name}` : item?.field,
    ),
  );
  const names = new Set([...(before.present ?? []), ...(after.present ?? [])]);
  for (const name of names) {
    const was = before.present?.includes(name) ?? false;
    const is = after.present?.includes(name) ?? false;
    if (was === is) continue;
    const corrected = correctionMap.has(`presence:${name}`);
    const evidence = (is ? arrivals : departures).get(name.toLocaleLowerCase()) ?? null;
    changes.push({
      id: `presence:${name}`,
      field: "presence",
      subject: name,
      before: was ? name : null,
      after: is ? name : null,
      evidence: corrected ? null : evidence,
      source: !corrected && evidence ? "recorded" : "state_only",
      corrected,
    });
  }
  const latestAssistant = [...messages].reverse().find((entry) => entry.role === "assistant" && visibleTurn(entry));
  const isLatest = latestAssistant?.id === message.id;
  const canEditState = isLatest && currentState !== null;
  const readOnlyReason = !isLatest
    ? "Only the latest completed assistant turn can be corrected."
    : !currentState
      ? "This turn has no canonical game-state snapshot to correct."
      : undefined;
  for (const change of changes)
    if (correctionMap.has(change.id)) {
      change.corrected = true;
      change.evidence = null;
      change.source = "state_only";
    }
  return {
    review: {
      messageId,
      swipeIndex,
      revision: revision(message, sourceTurn?.hash, {
        metadata: chat.metadata,
        state: currentState,
        spatial: currentSpatial,
      }),
      pending: isSceneTimelinePending(chatId),
      canCorrect: canEditState && !isSceneTimelinePending(chatId),
      ...(readOnlyReason ? { readOnlyReason } : {}),
      before,
      after,
      editableTime: isLatest ? clock(parseExtra(chat.metadata).gameTime) : null,
      changes,
      locations,
    },
    message,
    chat,
    sourceHash: sourceTurn?.hash ?? null,
  };
}

export async function getGameTurnReview(
  db: DB,
  chatId: string,
  messageId: string,
  isGenerating: () => boolean = () => false,
) {
  const result = (await readReview(db, chatId, messageId)).review;
  if (isGenerating()) return { ...result, pending: true, canCorrect: false, readOnlyReason: "Generation is active." };
  return result;
}

export function isGameTurnReviewMutationPending(chatId: string): boolean {
  return correctionQueues.has(chatId) || isReviewWritePending(chatId);
}

// Install the lease synchronously, before validation awaits. Generation checks
// this same lease, and automatic clock updates share it with manual corrections.
async function withTurnMutation<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
  const previous = correctionQueues.get(chatId) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(operation);
  const marker = queued.then(
    () => undefined,
    () => undefined,
  );
  correctionQueues.set(chatId, marker);
  try {
    return await queued;
  } finally {
    if (correctionQueues.get(chatId) === marker) correctionQueues.delete(chatId);
  }
}

async function correctGameTurnReviewNow(
  db: DB,
  chatId: string,
  messageId: string,
  input: { revision: string; swipeIndex: number; correction: GameTurnReviewCorrection },
  isGenerating: () => boolean,
) {
  const current = await readReview(db, chatId, messageId);
  if (current.chat.mode !== "game") throw new Error("Turn review is available only for Game Mode chats.");
  if (current.review.pending || isGenerating())
    throw new Error("Turn review is busy while generation or scene sync is active.");
  if (!current.review.canCorrect) throw new Error(current.review.readOnlyReason ?? "Turn review is read-only.");
  if (current.review.revision !== input.revision || current.review.swipeIndex !== input.swipeIndex)
    throw new Error("Turn review is stale; refresh before correcting.");
  const correction = input.correction;
  const extra = parseExtra(current.message.extra);
  if (extra.gameSceneTimeline?.hash && current.sourceHash !== extra.gameSceneTimeline.hash)
    throw new Error("Turn scene timeline is stale; refresh before correcting.");
  const corrections = Array.isArray(extra.gameTurnReviewCorrections) ? extra.gameTurnReviewCorrections : [];
  if (
    correction.field === "location" &&
    !current.review.locations.some((item: GameTurnReviewLocation) => item.id === correction.locationId)
  )
    throw new Error("Unknown canonical location.");
  if (correction.field === "time" && !clock(correction.value)) throw new Error("Invalid game time.");
  if (correction.field === "presence" && !correction.name.trim()) throw new Error("Presence name is required.");
  const fresh = await readReview(db, chatId, messageId);
  if (fresh.review.revision !== input.revision || fresh.review.swipeIndex !== input.swipeIndex)
    throw new Error("Turn review changed while preparing the correction; refresh before correcting.");
  const states = createGameStateStorage(db);
  const state = await states.getByChatAndMessage(chatId, messageId, input.swipeIndex);
  if (!state) throw new Error("This turn has no canonical game-state snapshot to correct.");
  let linkedNames: PresenceIdentity[] = [];
  const linkedIds = parseStringArray(current.chat.characterIds);
  if (linkedIds.length) {
    linkedNames = (await createCharactersStorage(db).getByIds(linkedIds))
      .map((row: any) => ({ id: row.id ?? null, name: parseExtra(row.data).name }))
      .filter((entry: PresenceIdentity) => typeof entry.name === "string" && !!entry.name.trim());
  }
  let normalizedCorrection: GameTurnReviewCorrection = correction;
  let presenceIdentity: PresenceIdentity | null = null;
  if (correction.field === "presence") {
    const canonical = canonicalPresenceName(correction.name, current.chat, state, linkedNames);
    if (!canonical) throw new Error("Presence correction must target one known canonical character or NPC.");
    presenceIdentity = canonical;
    normalizedCorrection = { ...correction, name: canonical.name, sourceHash: current.sourceHash ?? undefined };
  }
  const storedCorrections = [
    ...corrections.filter(
      (item: any) =>
        item?.field !== normalizedCorrection.field ||
        (normalizedCorrection.field === "presence" &&
          String(item?.name).toLocaleLowerCase() !== normalizedCorrection.name.toLocaleLowerCase()),
    ),
    normalizedCorrection,
  ];
  const oldSpatial =
    normalizedCorrection.field === "location"
      ? await createSpatialContextStorage().getByAnchor(chatId, messageId, input.swipeIndex)
      : null;
  if (normalizedCorrection.field === "location" && !oldSpatial)
    throw new Error("This turn has no authoritative spatial snapshot to correct.");
  const sceneTimeline = parseExtra(current.message.extra).gameSceneTimeline;
  const nextSceneTimeline =
    (normalizedCorrection.field === "presence" || normalizedCorrection.field === "location") &&
    sceneTimeline &&
    Array.isArray(sceneTimeline.visits)
      ? (() => {
          const visits = structuredClone(sceneTimeline.visits) as Array<Record<string, any>>;
          const last = visits.at(-1);
          if (!last) return sceneTimeline;
          if (normalizedCorrection.field === "location") {
            last.location = current.review.locations.find((item) => item.id === normalizedCorrection.locationId)!.name;
            delete last.locationEvidence;
            return { ...sceneTimeline, visits };
          }
          const names = Array.isArray(last.present) ? [...last.present] : [];
          const index = names.findIndex(
            (name) =>
              typeof name === "string" && name.toLocaleLowerCase() === normalizedCorrection.name.toLocaleLowerCase(),
          );
          if (normalizedCorrection.present && index < 0) names.push(normalizedCorrection.name);
          if (!normalizedCorrection.present && index >= 0) names.splice(index, 1);
          last.present = names;
          return { ...sceneTimeline, visits };
        })()
      : undefined;
  const nextClock =
    normalizedCorrection.field === "time"
      ? { ...record(extra.gameTurnClock), after: normalizedCorrection.value, manualCorrection: true }
      : undefined;
  await withGameTurnReviewWrite(db, chatId, messageId, async (tx) => {
    const [chatRow] = await tx.select().from(chatsTable).where(eq(chatsTable.id, chatId));
    const [messageRow] = await tx
      .select()
      .from(messagesTable)
      .where(and(eq(messagesTable.id, messageId), eq(messagesTable.chatId, chatId)));
    if (!chatRow || !messageRow || (messageRow.activeSwipeIndex ?? 0) !== input.swipeIndex)
      throw new Error("Turn review changed while saving; refresh before correcting.");
    if (messageRow.content !== current.message.content)
      throw new Error("Turn content changed while saving; refresh before correcting.");
    const swipeRows = await tx.select().from(messageSwipes).where(eq(messageSwipes.messageId, messageId));
    const targetSwipe = swipeRows.find((row) => row.index === input.swipeIndex);
    if (!targetSwipe && (messageRow.activeSwipeIndex ?? 0) !== input.swipeIndex)
      throw new Error("Turn review swipe no longer exists.");
    const latestRows = await tx
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.chatId, chatId))
      .orderBy(messagesTable.createdAt, messagesTable.id);
    const latest = [...latestRows].reverse().find((entry) => entry.role === "assistant" && visibleTurn(entry));
    if (chatRow.mode !== "game" || latest?.id !== messageId || isGenerating())
      throw new Error("Only the latest idle Game turn can be corrected.");
    if (JSON.stringify(parseExtra(chatRow.metadata)) !== JSON.stringify(parseExtra(current.chat.metadata)))
      throw new Error("Game state changed while saving; refresh before correcting.");
    const liveSource = await readSource(tx, chatId);
    if (liveSource.turns.find((turn) => turn.message.id === messageId)?.hash !== current.sourceHash)
      throw new Error("Turn source changed while saving; refresh before correcting.");
    const currentMessageExtra = parseExtra(messageRow.extra);
    if (
      revision(messageRow, current.sourceHash ?? undefined) !==
      revision(current.message, current.sourceHash ?? undefined)
    )
      throw new Error("Turn review is stale; refresh before correcting.");
    if (currentMessageExtra.gameSceneTimeline?.hash !== extra.gameSceneTimeline?.hash)
      throw new Error("Scene timeline changed while saving; refresh before correcting.");
    if (JSON.stringify(currentMessageExtra.gameTurnClock) !== JSON.stringify(extra.gameTurnClock))
      throw new Error("Turn clock changed while saving; refresh before correcting.");
    const mergedExtra = {
      ...currentMessageExtra,
      gameTurnReviewCorrections: storedCorrections,
      ...(nextClock ? { gameTurnClock: nextClock } : {}),
      ...(nextSceneTimeline ? { gameSceneTimeline: nextSceneTimeline } : {}),
    };
    if (targetSwipe) {
      const swipeExtra = parseExtra(targetSwipe.extra);
      await tx
        .update(messageSwipes)
        .set({ extra: JSON.stringify({ ...swipeExtra, ...mergedExtra }) })
        .where(eq(messageSwipes.id, targetSwipe.id));
    }
    if ((messageRow.activeSwipeIndex ?? 0) === input.swipeIndex)
      await tx
        .update(messagesTable)
        .set({ extra: JSON.stringify(mergedExtra) })
        .where(eq(messagesTable.id, messageId));
    if (normalizedCorrection.field === "time" || normalizedCorrection.field === "location") {
      const metadata = parseExtra(chatRow.metadata);
      const nextMetadata =
        normalizedCorrection.field === "time"
          ? { ...metadata, gameTime: normalizedCorrection.value }
          : syncGameMapMetaPartyPosition(
              metadata,
              current.review.locations.find((item) => item.id === normalizedCorrection.locationId)!.name,
            );
      await createChatsStorage(tx).patchMetadata(chatId, nextMetadata, { metadataQueueHeld: true });
    }
    const [stateRow] = await tx
      .select()
      .from(gameStateSnapshots)
      .where(
        and(
          eq(gameStateSnapshots.chatId, chatId),
          eq(gameStateSnapshots.messageId, messageId),
          eq(gameStateSnapshots.swipeIndex, input.swipeIndex),
        ),
      );
    if (!stateRow) throw new Error("This turn has no canonical game-state snapshot to correct.");
    if (
      stateRow.location !== state.location ||
      stateRow.time !== state.time ||
      JSON.stringify(parseStoredArray(stateRow.presentCharacters)) !==
        JSON.stringify(parseStoredArray(state.presentCharacters))
    )
      throw new Error("Game state changed while saving; refresh before correcting.");
    if (normalizedCorrection.field === "location" && oldSpatial) {
      // The optional map capability persists through this Engine-owned table.
      // Update its existing anchor inside the SAME transaction as the tracker
      // and review; no cross-store compensation or crash window is needed.
      const [spatialRow] = await tx
        .select()
        .from(spatialContextSnapshots)
        .where(
          and(
            eq(spatialContextSnapshots.chatId, chatId),
            eq(spatialContextSnapshots.messageId, messageId),
            eq(spatialContextSnapshots.swipeIndex, input.swipeIndex),
          ),
        );
      if (
        !spatialRow ||
        spatialRow.id !== oldSpatial.id ||
        spatialRow.currentLocationId !== oldSpatial.currentLocationId ||
        spatialRow.definitionRevision !== oldSpatial.definitionRevision
      )
        throw new Error("Location changed while saving; refresh before correcting.");
      await tx
        .update(spatialContextSnapshots)
        .set({ currentLocationId: normalizedCorrection.locationId })
        .where(eq(spatialContextSnapshots.id, spatialRow.id));
    }
    const statePatch: Record<string, unknown> = {};
    if (normalizedCorrection.field === "time") statePatch.time = formatTime(normalizedCorrection.value);
    if (normalizedCorrection.field === "location")
      statePatch.location = current.review.locations.find((item) => item.id === normalizedCorrection.locationId)?.name;
    if (normalizedCorrection.field === "presence") {
      const present = [...parseStoredArray(stateRow.presentCharacters)];
      const index = present.findIndex(
        (item: any) => item?.name?.toLocaleLowerCase() === normalizedCorrection.name.toLocaleLowerCase(),
      );
      if (normalizedCorrection.present && index < 0)
        present.push({
          name: normalizedCorrection.name,
          ...(presenceIdentity?.id ? { characterId: presenceIdentity.id } : {}),
        });
      if (normalizedCorrection.present && index >= 0 && presenceIdentity?.id)
        present[index] = { ...present[index], characterId: presenceIdentity.id };
      statePatch.presentCharacters = JSON.stringify(
        normalizedCorrection.present
          ? present
          : present.filter(
              (item: any) => item?.name?.toLocaleLowerCase() !== normalizedCorrection.name.toLocaleLowerCase(),
            ),
      );
    }
    const manual = parseExtra(stateRow.manualOverrides);
    if (normalizedCorrection.field === "time") manual.time = formatTime(normalizedCorrection.value);
    if (normalizedCorrection.field === "location")
      manual.location = current.review.locations.find((item) => item.id === normalizedCorrection.locationId)?.name;
    if (Object.keys(statePatch).length)
      await tx
        .update(gameStateSnapshots)
        .set({ ...statePatch, manualOverrides: JSON.stringify(manual) })
        .where(eq(gameStateSnapshots.id, stateRow.id));
  });
  return getGameTurnReview(db, chatId, messageId);
}

export async function correctGameTurnReview(
  db: DB,
  chatId: string,
  messageId: string,
  input: { revision: string; swipeIndex: number; correction: GameTurnReviewCorrection },
  isGenerating: () => boolean,
) {
  return withTurnMutation(chatId, () => correctGameTurnReviewNow(db, chatId, messageId, input, isGenerating));
}

async function applyGameTurnClockNow(
  db: DB,
  chatId: string,
  messageId: string,
  input: { swipeIndex: number; elapsedMinutes: number; timeEvidence: string },
  isGenerating: () => boolean,
) {
  if (isGenerating()) throw new Error("Cannot advance turn time while generation is active.");
  if (!Number.isInteger(input.elapsedMinutes) || input.elapsedMinutes < 1 || input.elapsedMinutes > 1440)
    throw new Error("elapsedMinutes must be an integer from 1 through 1440.");
  if (!input.timeEvidence.trim()) throw new Error("timeEvidence is required.");
  const chats = createChatsStorage(db);
  const chat = await chats.getById(chatId);
  const messages = await chats.listMessages(chatId);
  const message = messages.find((entry) => entry.id === messageId);
  if (!chat || !message) throw new Error("Message not found");
  if (chat.mode !== "game") throw new Error("Turn review is available only for Game Mode chats.");
  if (message.role !== "assistant" || (message.activeSwipeIndex ?? 0) !== input.swipeIndex)
    throw new Error("Clock advancement requires the active completed assistant swipe.");
  const latest = [...messages].reverse().find((entry) => entry.role === "assistant" && visibleTurn(entry));
  if (latest?.id !== messageId) throw new Error("Only the latest completed assistant turn can advance time.");
  const editedMessages = messages.map((entry) => ({ ...entry }));
  applyAllSegmentEdits(editedMessages, parseExtra(chat.metadata), messages);
  const targetIndex = messages.findIndex((entry) => entry.id === messageId);
  let previousAssistantIndex = targetIndex - 1;
  while (previousAssistantIndex >= 0 && messages[previousAssistantIndex]!.role !== "assistant")
    previousAssistantIndex--;
  const precedingUser = messages
    .slice(previousAssistantIndex + 1, targetIndex)
    .reverse()
    .find((entry) => entry.role === "user" && visibleTurn(entry));
  const evidenceSources = [precedingUser, message]
    .filter((entry): entry is any => !!entry)
    .map((entry) => editedMessages.find((candidate) => candidate.id === entry.id)?.content ?? entry.content);
  const validatedEvidence = validateSceneClockEvidence(
    { elapsedMinutes: input.elapsedMinutes, timeEvidence: input.timeEvidence },
    evidenceSources,
  );
  if (!validatedEvidence.timeEvidence || validatedEvidence.elapsedMinutes !== input.elapsedMinutes)
    throw new Error("timeEvidence must be an exact source quote for the stated duration.");
  const evidenceMessage = [message, precedingUser].find(
    (entry) =>
      entry &&
      (editedMessages.find((candidate) => candidate.id === entry.id)?.content ?? entry.content).includes(
        input.timeEvidence,
      ),
  );
  if (!evidenceMessage) throw new Error("timeEvidence must be an exact source quote.");
  const extra = parseExtra(message.extra);
  const captured = record(extra.gameTurnClock);
  const before = clock(captured.before);
  const after = clock(captured.after);
  if (!before || !after) throw new Error("This turn has no immutable captured clock; time advancement is unavailable.");
  if (captured.manualCorrection === true)
    throw new Error("The turn clock was manually corrected; automatic advancement is disabled.");
  if (
    typeof captured.sourceHash === "string" &&
    captured.sourceHash !==
      createHash("sha256")
        .update(editedMessages.find((entry) => entry.id === message.id)?.content ?? message.content)
        .digest("hex")
  )
    throw new Error("Turn content changed since its clock was captured.");
  const key = `${messageId}:${input.swipeIndex}:${input.elapsedMinutes}:${input.timeEvidence}`;
  if (captured.appliedKey === key) return getGameTurnReview(db, chatId, messageId);
  const currentMeta = parseExtra((await chats.getById(chatId))?.metadata);
  const liveClock = clock(currentMeta.gameTime);
  if (!liveClock || JSON.stringify(liveClock) !== JSON.stringify(after))
    throw new Error("Game clock changed since this turn was captured.");
  const expected = addMinutes(before, input.elapsedMinutes);
  const nextExtra = {
    ...extra,
    gameTurnClock: {
      ...captured,
      after: expected,
      elapsedMinutes: input.elapsedMinutes,
      timeEvidence: {
        messageId: evidenceMessage.id,
        swipeIndex: evidenceMessage.activeSwipeIndex ?? 0,
        quote: input.timeEvidence,
      },
      appliedKey: key,
    },
  };
  const state = await createGameStateStorage(db).getByChatAndMessage(chatId, messageId, input.swipeIndex);
  await withGameTurnReviewWrite(db, chatId, messageId, async (tx) => {
    const [chatRow] = await tx.select().from(chatsTable).where(eq(chatsTable.id, chatId));
    const [messageRow] = await tx
      .select()
      .from(messagesTable)
      .where(and(eq(messagesTable.id, messageId), eq(messagesTable.chatId, chatId)));
    const [swipeRow] = (await tx.select().from(messageSwipes).where(eq(messageSwipes.messageId, messageId))).filter(
      (row) => row.index === input.swipeIndex,
    );
    if (!chatRow || !messageRow || ((messageRow.activeSwipeIndex ?? 0) !== input.swipeIndex && !swipeRow))
      throw new Error("Turn changed while advancing time; refresh before retrying.");
    const latestRows = await tx
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.chatId, chatId))
      .orderBy(messagesTable.createdAt, messagesTable.id);
    if (
      chatRow.mode !== "game" ||
      [...latestRows].reverse().find((entry) => entry.role === "assistant" && visibleTurn(entry))?.id !== messageId ||
      isGenerating()
    )
      throw new Error("Only the latest idle Game turn can advance time.");
    if (
      JSON.stringify(parseExtra(chatRow.metadata)) !== JSON.stringify(parseExtra(chat.metadata)) ||
      JSON.stringify(parseExtra(messageRow.extra).gameTurnClock) !== JSON.stringify(captured)
    )
      throw new Error("Turn clock or source changed while advancing time.");
    const live = clock(parseExtra(chatRow.metadata).gameTime);
    if (!live || JSON.stringify(live) !== JSON.stringify(after))
      throw new Error("Game clock changed since this turn was captured.");
    if (messageRow.content !== message.content || (messageRow.activeSwipeIndex ?? 0) !== input.swipeIndex)
      throw new Error("Turn content or active swipe changed while advancing time; refresh before retrying.");
    const liveExtra = parseExtra(messageRow.extra).gameTurnClock;
    if (liveExtra?.sourceHash !== captured.sourceHash || liveExtra?.manualCorrection === true)
      throw new Error("Turn clock changed while advancing time; refresh before retrying.");
    const mergedExtra = { ...parseExtra(messageRow.extra), gameTurnClock: nextExtra.gameTurnClock };
    await createChatsStorage(tx).patchMetadata(chatId, { gameTime: expected }, { metadataQueueHeld: true });
    if (swipeRow)
      await tx
        .update(messageSwipes)
        .set({ extra: JSON.stringify({ ...parseExtra(swipeRow.extra), gameTurnClock: nextExtra.gameTurnClock }) })
        .where(eq(messageSwipes.id, swipeRow.id));
    if ((messageRow.activeSwipeIndex ?? 0) === input.swipeIndex)
      await tx
        .update(messagesTable)
        .set({ extra: JSON.stringify(mergedExtra) })
        .where(eq(messagesTable.id, messageId));
    if (state) {
      const [stateRow] = await tx.select().from(gameStateSnapshots).where(eq(gameStateSnapshots.id, state.id));
      if (stateRow)
        await tx
          .update(gameStateSnapshots)
          .set({ time: formatTime(expected) })
          .where(eq(gameStateSnapshots.id, state.id));
    }
  });
  return getGameTurnReview(db, chatId, messageId);
}

export async function applyGameTurnClock(
  db: DB,
  chatId: string,
  messageId: string,
  input: { swipeIndex: number; elapsedMinutes: number; timeEvidence: string },
  isGenerating: () => boolean,
) {
  return withTurnMutation(chatId, () => applyGameTurnClockNow(db, chatId, messageId, input, isGenerating));
}
