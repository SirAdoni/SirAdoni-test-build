import { fileTable, integer, text } from "../file-schema.js";
import { chats } from "./chats.js";

const json = (name: string) => text(name).notNull().default("{}");
const jsonArray = (name: string) => text(name).notNull().default("[]");

export const campaignMemoryEntities = fileTable("campaign_memory_entities", {
  entityId: text("entity_id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  owner: json("owner"),
  aliases: jsonArray("aliases"),
  tags: jsonArray("tags"),
  summary: text("summary"),
  body: text("body"),
  attributes: json("attributes"),
  status: text("status").notNull().default("active"),
  manualLock: integer("manual_lock").notNull().default(0),
  provenance: json("provenance"),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const campaignMemoryFacts = fileTable("campaign_memory_facts", {
  factId: text("fact_id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  subjectEntityId: text("subject_entity_id").notNull(),
  predicate: text("predicate").notNull(),
  value: json("value"),
  conditions: jsonArray("conditions"),
  status: text("status").notNull(),
  validFromOrder: text("valid_from_order"),
  validToOrder: text("valid_to_order"),
  sourceRevision: text("source_revision").notNull(),
  evidence: jsonArray("evidence"),
  author: text("author").notNull(),
  provenance: json("provenance"),
  manualLock: integer("manual_lock").notNull().default(0),
  supersedesFactId: text("supersedes_fact_id"),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const campaignMemoryKnowledge = fileTable("campaign_memory_knowledge", {
  knowledgeId: text("knowledge_id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  holderEntityId: text("holder_entity_id").notNull(),
  factId: text("fact_id"),
  attributedClaim: text("attributed_claim"),
  epistemicState: text("epistemic_state").notNull(),
  learnedFrom: jsonArray("learned_from"),
  learnedAtOrder: text("learned_at_order"),
  confidence: text("confidence"),
  provenance: json("provenance"),
  manualLock: integer("manual_lock").notNull().default(0),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const campaignMemoryEvents = fileTable("campaign_memory_events", {
  eventId: text("event_id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  occurrenceOrder: text("occurrence_order").notNull(),
  campaignTime: text("campaign_time"),
  participantEntityIds: jsonArray("participant_entity_ids"),
  locationEntityId: text("location_entity_id"),
  sourceRevision: text("source_revision").notNull(),
  transitions: jsonArray("transitions"),
  evidence: jsonArray("evidence"),
  provenance: json("provenance"),
  immutable: integer("immutable").notNull().default(1),
  createdAt: text("created_at").notNull(),
});

export const campaignMemoryCurrentState = fileTable(
  "campaign_memory_current_state",
  {
    stateId: text("state_id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    entityId: text("entity_id").notNull(),
    property: text("property").notNull(),
    value: json("value"),
    sourceEventId: text("source_event_id").notNull(),
    validAtOrder: text("valid_at_order").notNull(),
    protected: integer("protected").notNull().default(0),
    provenance: json("provenance"),
    manualLock: integer("manual_lock").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  { uniqueBy: [["chatId", "entityId", "property"]] },
);

export const campaignMemoryRelationships = fileTable("campaign_memory_relationships", {
  relationshipId: text("relationship_id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  sourceEntityId: text("source_entity_id").notNull(),
  targetEntityId: text("target_entity_id").notNull(),
  type: text("type").notNull(),
  inverseLabel: text("inverse_label").notNull(),
  status: text("status").notNull(),
  effectiveFrom: text("effective_from"),
  effectiveTo: text("effective_to"),
  evidence: jsonArray("evidence"),
  provenance: json("provenance"),
  manualLock: integer("manual_lock").notNull().default(0),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const campaignMemoryMutationJournal = fileTable(
  "campaign_memory_mutation_journal",
  {
    journalId: text("journal_id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    actor: text("actor").notNull(),
    expectedRevision: integer("expected_revision"),
    before: text("before"),
    after: text("after"),
    reason: text("reason").notNull(),
    evidence: jsonArray("evidence"),
    compensationOperationId: text("compensation_operation_id"),
    payloadHash: text("payload_hash").notNull(),
    createdAt: text("created_at").notNull(),
  },
  { uniqueBy: [["chatId", "operationId"]] },
);
