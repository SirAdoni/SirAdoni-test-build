/**
 * Source capture ordering for campaign-memory records.
 *
 * This is message chronology only. It is deliberately not campaign or
 * in-world time. The token is versioned so future order schemes can be held
 * instead of being interpreted as if they were this one.
 */
export type CampaignMemoryMessageOrder = `m1|${string}|${string}`;

const VERSION_PREFIX = "m1|";
const TIMESTAMP_LENGTH = 24;

export interface CampaignMemoryOrderMessage {
  id: string;
  createdAt: string;
}

export interface CampaignMemoryOrderEvidence {
  messageId: string;
}

export interface CampaignMemoryTargetMessage {
  id: string;
  createdAt: string;
}

function isCanonicalUtcIso(value: string): boolean {
  const date = new Date(value);
  return (
    value.length === TIMESTAMP_LENGTH &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(date.getTime()) &&
    date.toISOString() === value
  );
}

/** Format a canonical source-message capture order. */
export function formatCampaignMemoryMessageOrder(messageId: string, createdAt: string): CampaignMemoryMessageOrder {
  if (!messageId) throw new Error("CAMPAIGN_MEMORY_ORDER_INVALID_MESSAGE_ID");
  if (!isCanonicalUtcIso(createdAt)) throw new Error("CAMPAIGN_MEMORY_ORDER_INVALID_TIMESTAMP");
  return `${VERSION_PREFIX}${createdAt}|${messageId}` as CampaignMemoryMessageOrder;
}

/** Parse only the current version; the suffix is the complete message ID and may contain `|`. */
export function parseCampaignMemoryMessageOrder(value: string): { createdAt: string; messageId: string } | null {
  if (!value.startsWith(VERSION_PREFIX) || value.length <= VERSION_PREFIX.length + TIMESTAMP_LENGTH + 1) return null;
  const timestampStart = VERSION_PREFIX.length;
  const separator = timestampStart + TIMESTAMP_LENGTH;
  if (value[separator] !== "|") return null;
  const createdAt = value.slice(timestampStart, separator);
  const messageId = value.slice(separator + 1);
  if (!messageId || !isCanonicalUtcIso(createdAt)) return null;
  return { createdAt, messageId };
}

/** Compare using JavaScript string/code-unit ordering, matching the DB message ordering contract. */
export function compareCampaignMemoryMessageOrder(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Build orders from the source messages actually present in a branch. */
export function buildCampaignMemoryMessageOrderMap(
  messages: readonly CampaignMemoryOrderMessage[],
): Map<string, CampaignMemoryMessageOrder> {
  const result = new Map<string, CampaignMemoryMessageOrder>();
  for (const message of messages) {
    if (result.has(message.id)) throw new Error(`CAMPAIGN_MEMORY_ORDER_DUPLICATE_MESSAGE: ${message.id}`);
    result.set(message.id, formatCampaignMemoryMessageOrder(message.id, message.createdAt));
  }
  return result;
}

/**
 * Derive the conservative capture order from every exact cited source message.
 * Missing evidence is unknown; it must not fall back to the earliest citation.
 */
export function deriveCampaignMemoryCaptureOrder(
  evidence: readonly CampaignMemoryOrderEvidence[],
  sourceOrders: ReadonlyMap<string, CampaignMemoryMessageOrder>,
): CampaignMemoryMessageOrder | null {
  if (evidence.length === 0) return null;
  let maximum: CampaignMemoryMessageOrder | null = null;
  for (const item of evidence) {
    const order = sourceOrders.get(item.messageId);
    if (!order) return null;
    if (maximum === null || compareCampaignMemoryMessageOrder(order, maximum) > 0) maximum = order;
  }
  return maximum;
}

/**
 * Remap a source token through source-message identity; unknown versions or
 * mappings are held. This regenerates the token from target chronology. A
 * caller projecting a branch must retain the original token in provenance (or
 * otherwise verify the full batch) because target IDs can reorder messages
 * that share a timestamp.
 */
export function remapCampaignMemoryMessageOrder(
  value: string | undefined,
  targetMessagesBySourceId: ReadonlyMap<string, CampaignMemoryTargetMessage>,
): CampaignMemoryMessageOrder | null {
  if (!value) return null;
  const parsed = parseCampaignMemoryMessageOrder(value);
  if (!parsed) return null;
  const target = targetMessagesBySourceId.get(parsed.messageId);
  if (!target) return null;
  try {
    return formatCampaignMemoryMessageOrder(target.id, target.createdAt);
  } catch {
    return null;
  }
}
