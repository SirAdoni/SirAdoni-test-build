// ──────────────────────────────────────────────
// Schema: Mari Instructions (#4851)
//
// Persistent, user-scoped "standing instructions / memories" for Professor
// Mari, how the user likes their lorebooks/characters formatted, workflow
// conventions, and behavior directives. Retrieved index-and-fetch (only the
// title + description index is always injected; full `content` is pulled on
// relevance) so the store stays token-cheap regardless of size. A `persistent`
// row injects its body every turn (for the rare directive that must not risk
// a fetch-miss). New rows default disabled (enabled 0) so a memory is inert
// until the user turns it on. One row per memory.
//
// Deliberately NOT named `memory_*`: that namespace already means several
// other things (conversation-RAG `memory_chunks`, `agent_memory`, scene
// memories, the "Important Memories" prompt block).
// ──────────────────────────────────────────────
import { fileTable, text, integer } from "../file-schema.js";

export const mariInstructions = fileTable("mari_instructions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  content: text("content").notNull(),
  persistent: integer("persistent").notNull().default(0),
  enabled: integer("enabled").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
