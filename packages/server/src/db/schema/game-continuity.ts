// ──────────────────────────────────────────────
// Schema: Incremental Game Keeper receipts
// ──────────────────────────────────────────────
import { fileTable, integer, text } from "../file-schema.js";

/**
 * One row is the durable checkpoint for an incremental Game Keeper batch.
 * The JSON columns retain the frozen source/config and current model-stage
 * result; history preserves replaced model results across checkpoints.
 */
export const gameContinuityBatches = fileTable("game_continuity_batches", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  sessionNumber: integer("session_number").notNull(),
  sourceHash: text("source_hash").notNull(),
  sources: text("sources").notNull().default("[]"),
  context: text("context").notNull().default("[]"),
  configHash: text("config_hash").notNull(),
  config: text("config").notNull().default("{}"),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  repairAttempts: integer("repair_attempts").notNull().default(0),
  records: text("records").notNull().default("[]"),
  dispositions: text("dispositions").notNull().default("[]"),
  review: text("review"),
  knowledgeHolders: text("knowledge_holders"),
  knowledgeHoldersHash: text("knowledge_holders_hash"),
  history: text("history").notNull().default("[]"),
  entryIds: text("entry_ids").notNull().default("[]"),
  errorCode: text("error_code"),
  error: text("error"),
  telemetry: text("telemetry").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
