import { findUnambiguousGameNpcNameMatch, gameNpcIdentityTokens } from "@marinara-engine/shared";

export type RetroactiveMessage = {
  id: string;
  chatId?: string;
  role: string;
  content: string;
  createdAt?: string;
  activeSwipeIndex?: number | null;
};

export type NpcSourceSnapshot = {
  chatId: string;
  messageId: string;
  swipeIndex: number;
  content: string;
};

/** The storage cursor is a timestamp followed by an URI-encoded message id. */
export function encodeMessageCursor(message: Pick<RetroactiveMessage, "createdAt" | "id">): string {
  if (!message.createdAt || !message.id) throw new Error("Cannot encode a message without createdAt and id");
  return `${message.createdAt}|${encodeURIComponent(message.id)}`;
}

function escapedBoundary(name: string): RegExp {
  const escaped = name
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
}

export function isRelevantNpcName(name: string, texts: readonly string[], knownNames: readonly string[] = []): boolean {
  const normalized = name.trim();
  if (!normalized) return false;
  const uniqueKnownNames = [
    ...new Map(
      [...knownNames, normalized].map((candidate) => [candidate.trim().toLocaleLowerCase(), candidate.trim()]),
    ).values(),
  ].filter(Boolean);
  const target = findUnambiguousGameNpcNameMatch(normalized, uniqueKnownNames);
  if (target < 0) return false;
  const tokens = gameNpcIdentityTokens(normalized);
  const aliases = new Set([normalized, tokens.join(" "), tokens[0] ?? ""]);
  return [...aliases].some(
    (alias) =>
      alias &&
      findUnambiguousGameNpcNameMatch(alias, uniqueKnownNames) === target &&
      texts.some((text) => escapedBoundary(alias).test(text)),
  );
}

/** Excerpts remain literal source text, including evidence in the middle of long turns. */
function focusedExcerpt(content: string, names: readonly string[], budget: number): string {
  if (budget <= 0) return "";
  if (content.length <= budget) return content;
  const hits = names.flatMap((name) => {
    const index = name.trim() ? content.search(escapedBoundary(name)) : -1;
    return index >= 0 ? [index] : [];
  });
  const centers = [...new Set([0, ...hits, Math.max(0, content.length - 1)])].sort((a, b) => a - b);
  const width = Math.max(1, Math.floor((budget - centers.length * 2) / centers.length));
  const ranges = centers.map((center) => {
    const start = Math.max(0, Math.min(content.length - width, center - Math.floor(width / 3)));
    return { start, end: start + width };
  });
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && last.end >= range.start) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged
    .map(({ start, end }) => content.slice(start, end))
    .join("\n\n")
    .slice(0, budget);
}

/** Keep old evidence and the newest corrections in chronological order. */
export function buildFocusedNpcProfileMessages(
  messages: readonly RetroactiveMessage[],
  pinnedMessageIds: readonly string[],
  maxChars = 60_000,
  focusNames: readonly string[] = [],
): RetroactiveMessage[] {
  const unique = messages.filter(
    (message, index, all) => all.findIndex((candidate) => candidate.id === message.id) === index,
  );
  const pinned = new Set(pinnedMessageIds);
  const selected = new Map<string, RetroactiveMessage>();
  const budget = Math.max(0, Math.floor(maxChars));
  let used = 0;
  const select = (message: RetroactiveMessage, allowance: number) => {
    if (selected.has(message.id)) return;
    const content = focusedExcerpt(message.content, focusNames, Math.min(12_000, allowance, budget - used));
    if (!content) return;
    selected.set(message.id, { ...message, content });
    used += content.length;
  };
  // Historical evidence may never consume the allowance for the latest user correction.
  const latestUser = [...unique].reverse().find((message) => message.role === "user");
  if (latestUser) select(latestUser, Math.floor(budget / 4));
  const pinnedMessages = unique.filter((message) => pinned.has(message.id) && !selected.has(message.id));
  const pinnedAllowance = Math.floor(((budget - used) * 0.75) / Math.max(1, pinnedMessages.length));
  for (const message of pinnedMessages) select(message, pinnedAllowance);
  // Keep explicit corrections before filling spare space with ordinary recent turns.
  for (let index = unique.length - 1; index >= 0 && used < budget; index -= 1) {
    const message = unique[index]!;
    if (message.role === "user") select(message, budget - used);
  }
  for (let index = unique.length - 1; index >= 0 && used < budget; index -= 1) {
    select(unique[index]!, budget - used);
  }
  return unique.filter((message) => selected.has(message.id)).map((message) => selected.get(message.id)!);
}

export function sourceSnapshotMatches(source: NpcSourceSnapshot, message: RetroactiveMessage | undefined): boolean {
  return Boolean(
    message &&
    message.id === source.messageId &&
    message.chatId === source.chatId &&
    (message.activeSwipeIndex ?? 0) === source.swipeIndex &&
    message.content === source.content,
  );
}
