import type { Message } from "@marinara-engine/shared";
import type { InfiniteData } from "@tanstack/react-query";
import { parseMessageExtraRecord } from "./chat-message-extra";

function sortMessagesByCreatedAt(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const createdAtOrder = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (createdAtOrder !== 0) return createdAtOrder;
    return 0;
  });
}

function mergeCachedGeneratedMessage(existing: Message, incoming: Message): Message {
  const merged = { ...existing, ...incoming };
  const activeSwipeChanged =
    typeof incoming.activeSwipeIndex === "number" && incoming.activeSwipeIndex !== existing.activeSwipeIndex;
  const existingSwipeCount = typeof existing.swipeCount === "number" ? existing.swipeCount : 0;
  const incomingSwipeCount = typeof incoming.swipeCount === "number" ? incoming.swipeCount : 0;
  const activeSwipeFloor =
    typeof incoming.activeSwipeIndex === "number" && Number.isInteger(incoming.activeSwipeIndex)
      ? incoming.activeSwipeIndex + 1
      : 0;
  if (existingSwipeCount || incomingSwipeCount || activeSwipeFloor) {
    merged.swipeCount = Math.max(existingSwipeCount, incomingSwipeCount, activeSwipeFloor);
  }
  const existingExtra = parseMessageExtraRecord(existing.extra);
  const incomingExtra = parseMessageExtraRecord(incoming.extra);
  // A same-swipe SSE snapshot can predate post-processing extras already in
  // cache. Never carry those extras into a newly selected swipe.
  if (!activeSwipeChanged && (Object.keys(existingExtra).length > 0 || Object.keys(incomingExtra).length > 0)) {
    merged.extra = { ...existingExtra, ...incomingExtra } as unknown as Message["extra"];
  }
  return merged;
}

export function reconcilePersistedMessages(
  old: InfiniteData<Message[]> | undefined,
  sortedIncoming: Message[],
): InfiniteData<Message[]> {
  // Map preserves the first position for each ID while the latest durable
  // snapshot replaces its value.
  const uniqueIncoming = [...new Map(sortedIncoming.map((msg) => [msg.id, msg])).values()];
  if (!old?.pages) {
    return {
      pageParams: [undefined],
      pages: [uniqueIncoming],
    };
  }

  const persistedById = new Map(uniqueIncoming.map((msg) => [msg.id, msg]));
  // A just-sent user row starts with a temporary ID. Match its submission ID
  // once the server returns the durable row so edits cannot target the temporary ID.
  const persistedUserBySubmissionId = new Map(
    uniqueIncoming.flatMap((msg) => {
      const submissionId = parseMessageExtraRecord(msg.extra).submissionId;
      return msg.role === "user" &&
        !msg.id.startsWith("__optimistic_") &&
        typeof submissionId === "string" &&
        submissionId
        ? [[submissionId, msg] as const]
        : [];
    }),
  );
  const existingIds = new Set<string>();

  const pages = old.pages.map((page) =>
    page.flatMap((msg) => {
      const submissionId = parseMessageExtraRecord(msg.extra).submissionId;
      const persisted =
        persistedById.get(msg.id) ??
        (msg.id.startsWith("__optimistic_") && typeof submissionId === "string"
          ? persistedUserBySubmissionId.get(submissionId)
          : undefined);
      const nextMessage = persisted ? mergeCachedGeneratedMessage(msg, persisted) : msg;
      if (existingIds.has(nextMessage.id)) return [];
      existingIds.add(nextMessage.id);
      return [nextMessage];
    }),
  );

  const missing = uniqueIncoming.filter((msg) => !existingIds.has(msg.id));
  if (missing.length > 0) {
    if (pages.length === 0) {
      pages.push(missing);
    } else {
      pages[0] = sortMessagesByCreatedAt([...pages[0], ...missing]);
    }
  }

  return { ...old, pages };
}
