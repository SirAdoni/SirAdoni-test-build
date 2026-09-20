import { createHash } from "node:crypto";
import type { DB } from "../../db/connection.js";
import { and, eq, inArray } from "../../db/file-query.js";
import { chats, messageSwipes, messages } from "../../db/schema/index.js";
import { prepareContinuitySources, type ContinuityRawMessage } from "./continuity-sources.js";
import { compareCampaignMemoryMessageOrder, formatCampaignMemoryMessageOrder } from "./campaign-memory-order.js";

export type CampaignMemorySource = {
  chatId: string;
  content: string;
  sourceHash: string;
  swipeIndex: number;
  captureOrder?: string;
};
type Scope = { chatId: string; messageIds?: ReadonlySet<string> | readonly string[] };
const objectValue = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export async function readCampaignMemorySources(db: DB, scope: Scope): Promise<Map<string, CampaignMemorySource>> {
  const requested = scope.messageIds ? new Set(scope.messageIds) : undefined;
  if (requested && requested.size === 0) return new Map();
  const rows = await db
    .select()
    .from(messages)
    .where(
      requested?.size
        ? and(eq(messages.chatId, scope.chatId), inArray(messages.id, [...requested]))
        : eq(messages.chatId, scope.chatId),
    );
  if (!rows.length) return new Map();
  const swipeRows = await db
    .select()
    .from(messageSwipes)
    .where(
      inArray(
        messageSwipes.messageId,
        rows.map((row) => row.id),
      ),
    );
  const swipes = new Map(swipeRows.map((row) => [`${row.messageId}:${row.index}`, row]));
  const chatRow = (await db.select().from(chats).where(eq(chats.id, scope.chatId)).limit(1))[0];
  if (!chatRow || chatRow.mode !== "game") return new Map();
  rows.sort((left, right) =>
    compareCampaignMemoryMessageOrder(`${left.createdAt}|${left.id}`, `${right.createdAt}|${right.id}`),
  );
  const orderMap = new Map<string, string>();
  for (const row of rows) {
    try {
      orderMap.set(row.id, formatCampaignMemoryMessageOrder(row.id, row.createdAt));
    } catch {
      /* unknown capture order remains absent */
    }
  }
  const effective: ContinuityRawMessage[] = rows.map((row) => {
    const swipe = swipes.get(`${row.id}:${row.activeSwipeIndex}`);
    return {
      id: row.id,
      role: row.role,
      content: swipe?.content ?? row.content,
      activeSwipeIndex: row.activeSwipeIndex,
      extra: swipe?.extra ?? row.extra,
    };
  });
  const prepared = prepareContinuitySources(effective, objectValue(chatRow?.metadata));
  return new Map(
    prepared.map((source) => [
      source.messageId,
      {
        chatId: scope.chatId,
        content: source.content,
        sourceHash: createHash("sha256").update(source.content, "utf8").digest("hex"),
        swipeIndex: source.swipeIndex,
        captureOrder: orderMap.get(source.messageId),
      },
    ]),
  );
}
