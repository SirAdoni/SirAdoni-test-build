// ──────────────────────────────────────────────
// Schema: Generation Usage Ledger
// ──────────────────────────────────────────────
// One small row per completed main generation, feeding the Usage dashboard.
// Deliberately not cascaded from chats or connections: tokens that were spent
// stay counted after the chat or connection that spent them is deleted.
import { fileTable, integer, text } from "../file-schema.js";

export const generationUsage = fileTable("generation_usage", {
  id: text("id").primaryKey(),
  /** UTC day (YYYY-MM-DD) of createdAt; the shard key, so each day is one small file. */
  day: text("day").notNull(),
  chatId: text("chat_id"),
  messageId: text("message_id"),
  connectionId: text("connection_id"),
  provider: text("provider").notNull().default(""),
  model: text("model").notNull().default(""),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  createdAt: text("created_at").notNull(),
});
