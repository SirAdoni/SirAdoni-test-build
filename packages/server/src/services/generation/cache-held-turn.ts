import { createHash } from "node:crypto";

export interface CacheGuardHeldTurnDescriptor {
  messageId: string;
  activeSwipeIndex: number;
  contentHash: string;
  submissionId?: string;
}

interface HeldTurnMessage {
  id: string;
  chatId: string;
  role: string;
  content: string;
  activeSwipeIndex?: number | null;
  extra?: unknown;
}

function readExtra(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function heldTurnIdentity(message: HeldTurnMessage) {
  const extra = readExtra(message.extra);
  const activeSwipeIndex =
    typeof message.activeSwipeIndex === "number" && Number.isInteger(message.activeSwipeIndex)
      ? message.activeSwipeIndex
      : 0;
  return {
    chatId: message.chatId,
    id: message.id,
    role: message.role,
    content: message.content,
    activeSwipeIndex,
    submissionId: typeof extra.submissionId === "string" ? extra.submissionId : null,
    attachments: extra.attachments ?? [],
    replyTo: extra.replyTo ?? null,
  };
}

export function createCacheGuardHeldTurnDescriptor(message: HeldTurnMessage): CacheGuardHeldTurnDescriptor | null {
  if (message.role !== "user") return null;
  const identity = heldTurnIdentity(message);
  return {
    messageId: message.id,
    activeSwipeIndex: identity.activeSwipeIndex,
    contentHash: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    ...(identity.submissionId ? { submissionId: identity.submissionId } : {}),
  };
}

/** Returns the held row only while its ownership, selected content, and turn position remain unchanged. */
export function resolveCacheGuardHeldTurn<T extends HeldTurnMessage>(
  messagesInChronologicalOrder: T[],
  chatId: string,
  descriptor: CacheGuardHeldTurnDescriptor,
): T | null {
  const heldIndex = messagesInChronologicalOrder.findIndex((message) => message.id === descriptor.messageId);
  if (heldIndex < 0) return null;
  const held = messagesInChronologicalOrder[heldIndex];
  if (!held) return null;
  if (held.chatId !== chatId || held.role !== "user") return null;
  const current = createCacheGuardHeldTurnDescriptor(held);
  if (
    !current ||
    current.activeSwipeIndex !== descriptor.activeSwipeIndex ||
    current.contentHash !== descriptor.contentHash ||
    (descriptor.submissionId !== undefined && current.submissionId !== descriptor.submissionId)
  ) {
    return null;
  }
  if (
    messagesInChronologicalOrder
      .slice(heldIndex + 1)
      .some((message) => message.role === "user" || message.role === "assistant" || message.role === "narrator")
  ) {
    return null;
  }
  return held;
}
