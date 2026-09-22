// ──────────────────────────────────────────────
// Game: campaign codex export
//
// A read-only, human-readable export of a game's campaign memory. Memory is
// stored per session chat, so the same character can appear once per session
// under a different record id; the codex folds those into one entry, keeps the
// newest summary and state, and tags every fact, relationship and event with
// the session it came from. Ids never reach the reader: every reference is
// resolved to a name.
//
// buildCampaignCodex and renderCampaignCodexMarkdown are pure; the loader at
// the bottom only reads.
// ──────────────────────────────────────────────

import type {
  CampaignMemoryCurrentState,
  CampaignMemoryEntity,
  CampaignMemoryEntityKind,
  CampaignMemoryEvent,
  CampaignMemoryFact,
  CampaignMemoryJson,
  CampaignMemoryKnowledge,
  CampaignMemoryRelationship,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import { chats } from "../../db/schema/index.js";
import { createCampaignMemoryStorage } from "../storage/campaign-memory.storage.js";

export const CAMPAIGN_CODEX_FORMAT = "marinara-campaign-codex";
export const CAMPAIGN_CODEX_VERSION = 1;

export interface CampaignCodexSessionInput {
  chatId: string;
  /** Session number as the game counts it; null falls back to the position in the list. */
  sessionNumber: number | null;
  name: string;
  entities: readonly CampaignMemoryEntity[];
  facts: readonly CampaignMemoryFact[];
  knowledge: readonly CampaignMemoryKnowledge[];
  events: readonly CampaignMemoryEvent[];
  currentState: readonly CampaignMemoryCurrentState[];
  relationships: readonly CampaignMemoryRelationship[];
}

export interface CampaignCodexInput {
  gameId: string;
  gameName: string;
  generatedAt: string;
  /** Oldest session first. */
  sessions: readonly CampaignCodexSessionInput[];
}

export interface CampaignCodexStatement {
  label: string;
  value: string;
  session: number;
}

export interface CampaignCodexRelationship {
  type: string;
  target: string;
  status: "active" | "ended";
  session: number;
}

export interface CampaignCodexEntity {
  kind: CampaignMemoryEntityKind;
  name: string;
  aliases: string[];
  tags: string[];
  summary: string | null;
  notes: string | null;
  archived: boolean;
  sessions: number[];
  currentState: CampaignCodexStatement[];
  facts: CampaignCodexStatement[];
  knowledge: CampaignCodexStatement[];
  relationships: CampaignCodexRelationship[];
}

export interface CampaignCodexEvent {
  session: number;
  campaignTime: string | null;
  summary: string;
  location: string | null;
  participants: string[];
  changes: CampaignCodexStatement[];
}

export interface CampaignCodex {
  format: typeof CAMPAIGN_CODEX_FORMAT;
  version: typeof CAMPAIGN_CODEX_VERSION;
  gameId: string;
  gameName: string;
  generatedAt: string;
  sessions: Array<{ number: number; name: string }>;
  entities: CampaignCodexEntity[];
  events: CampaignCodexEvent[];
}

export const CAMPAIGN_CODEX_KIND_ORDER: readonly CampaignMemoryEntityKind[] = [
  "character",
  "persona",
  "location",
  "organization",
  "item",
  "quest",
  "lore",
  "note",
];

const KIND_HEADINGS: Record<CampaignMemoryEntityKind, string> = {
  character: "Characters",
  persona: "Player characters",
  location: "Locations",
  organization: "Factions and organizations",
  item: "Items",
  quest: "Quests",
  lore: "Lore",
  note: "Notes",
};

const EPISTEMIC_LABELS: Record<string, string> = {
  knows: "Knows",
  believes: "Believes",
  rumor: "Has heard",
};

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function humanize(value: string): string {
  const spaced = value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase() : value;
}

/** A JSON memory value as one readable line. */
export function codexValueText(value: CampaignMemoryJson | undefined): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => codexValueText(item)).join(", ");
  return Object.entries(value)
    .map(([key, item]) => `${humanize(key)}: ${codexValueText(item)}`)
    .join("; ");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function originId(record: { provenance?: { origin?: { sourceRecordId?: string } } }): string | null {
  const id = record.provenance?.origin?.sourceRecordId;
  return typeof id === "string" && id ? id : null;
}

interface EntityAccumulator {
  /** The merge key carries record ids, so it stays internal to the build. */
  entity: CampaignCodexEntity & { key: string };
  lastSeen: number;
}

/** Build the codex from per-session memory. Pure: same input, same output. */
export function buildCampaignCodex(input: CampaignCodexInput): CampaignCodex {
  const sessions = input.sessions.map((session, index) => ({
    ...session,
    number: session.sessionNumber != null && Number.isFinite(session.sessionNumber) ? session.sessionNumber : index + 1,
  }));

  // ── Entities: one codex entry per real-world thing across sessions ──
  const keyByRecordId = new Map<string, string>();
  const byKey = new Map<string, EntityAccumulator>();
  const keyForEntity = (entity: CampaignMemoryEntity): string => {
    const origin = originId(entity);
    if (origin && keyByRecordId.has(origin)) return keyByRecordId.get(origin)!;
    if (entity.owner?.type === "existing") return `owner:${entity.owner.store}:${entity.owner.recordId}`;
    const name = entity.aliases[0] ? normalizeName(entity.aliases[0]) : "";
    return name ? `name:${entity.kind}:${name}` : `record:${origin ?? entity.entityId}`;
  };

  for (const session of sessions) {
    for (const entity of session.entities) {
      const key = keyForEntity(entity);
      keyByRecordId.set(entity.entityId, key);
      const aliases = entity.aliases.map((alias) => alias.trim()).filter(Boolean);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          lastSeen: session.number,
          entity: {
            key,
            kind: entity.kind,
            name: aliases[0] || entity.summary?.trim() || humanize(entity.kind),
            aliases: aliases.slice(1),
            tags: [...entity.tags],
            summary: entity.summary?.trim() || null,
            notes: entity.body?.trim() || null,
            archived: entity.status === "archived",
            sessions: [session.number],
            currentState: [],
            facts: [],
            knowledge: [],
            relationships: [],
          },
        });
        continue;
      }
      const target = existing.entity;
      if (!target.sessions.includes(session.number)) target.sessions.push(session.number);
      for (const alias of aliases) {
        if (normalizeName(alias) !== normalizeName(target.name) && !target.aliases.includes(alias))
          target.aliases.push(alias);
      }
      for (const tag of entity.tags) if (!target.tags.includes(tag)) target.tags.push(tag);
      if (session.number >= existing.lastSeen) {
        existing.lastSeen = session.number;
        if (entity.summary?.trim()) target.summary = entity.summary.trim();
        if (entity.body?.trim()) target.notes = entity.body.trim();
        target.archived = entity.status === "archived";
      }
    }
  }

  const entityFor = (recordId: string | undefined | null) =>
    recordId ? byKey.get(keyByRecordId.get(recordId) ?? "")?.entity : undefined;
  const nameFor = (recordId: string | undefined | null) => entityFor(recordId)?.name ?? null;

  // ── Facts, knowledge, state and relationships ──
  const seenFacts = new Set<string>();
  const factById = new Map<string, CampaignMemoryFact>();
  const stateByProperty = new Map<string, { statement: CampaignCodexStatement; order: string }>();
  const relationshipByKey = new Map<string, { owner: CampaignCodexEntity; relationship: CampaignCodexRelationship }>();
  const seenKnowledge = new Set<string>();

  for (const session of sessions) {
    for (const fact of session.facts) factById.set(fact.factId, fact);
  }

  for (const session of sessions) {
    for (const fact of session.facts) {
      if (fact.status !== "verified") continue;
      const subject = entityFor(fact.subjectEntityId);
      if (!subject) continue;
      const value = codexValueText(fact.value);
      const dedupe = `${subject.key}\u0000${normalizeName(fact.predicate)}\u0000${stableJson(fact.value)}`;
      if (seenFacts.has(dedupe)) continue;
      seenFacts.add(dedupe);
      subject.facts.push({ label: humanize(fact.predicate), value, session: session.number });
    }

    for (const item of session.knowledge) {
      if (item.epistemicState === "unknown") continue;
      const holder = entityFor(item.holderEntityId);
      if (!holder) continue;
      const fact = item.factId ? factById.get(item.factId) : undefined;
      const claim = fact
        ? { subjectEntityId: fact.subjectEntityId, predicate: fact.predicate, value: fact.value }
        : item.attributedClaim;
      if (!claim) continue;
      const subjectName = nameFor(claim.subjectEntityId);
      if (!subjectName) continue;
      const value = `${subjectName}: ${humanize(claim.predicate).toLowerCase()} ${codexValueText(claim.value)}`;
      const label = EPISTEMIC_LABELS[item.epistemicState] ?? humanize(item.epistemicState);
      const dedupe = `${holder.key}\u0000${label}\u0000${value}`;
      if (seenKnowledge.has(dedupe)) continue;
      seenKnowledge.add(dedupe);
      holder.knowledge.push({ label, value, session: session.number });
    }

    for (const state of session.currentState) {
      const owner = entityFor(state.entityId);
      if (!owner) continue;
      const stateKey = `${owner.key}\u0000${normalizeName(state.property)}`;
      const order = `${String(session.number).padStart(6, "0")}|${state.validAtOrder}`;
      const previous = stateByProperty.get(stateKey);
      if (previous && previous.order > order) continue;
      stateByProperty.set(stateKey, {
        order,
        statement: { label: humanize(state.property), value: codexValueText(state.value), session: session.number },
      });
    }

    for (const relationship of session.relationships) {
      if (relationship.status !== "active" && relationship.status !== "ended") continue;
      const source = entityFor(relationship.sourceEntityId);
      const target = entityFor(relationship.targetEntityId);
      if (!source || !target) continue;
      const relKey = `${source.key}\u0000${target.key}\u0000${normalizeName(relationship.type)}`;
      relationshipByKey.set(relKey, {
        owner: source,
        relationship: {
          type: humanize(relationship.type).toLowerCase(),
          target: target.name,
          status: relationship.status,
          session: session.number,
        },
      });
    }
  }

  for (const [stateKey, { statement }] of stateByProperty) {
    const ownerKey = stateKey.split("\u0000")[0]!;
    byKey.get(ownerKey)?.entity.currentState.push(statement);
  }
  for (const { owner, relationship } of relationshipByKey.values()) owner.relationships.push(relationship);

  // ── Events: one chronological timeline across sessions ──
  const seenEvents = new Set<string>();
  const events: Array<CampaignCodexEvent & { sortKey: string }> = [];
  const changesByEvent = new Map<string, CampaignCodexStatement[]>();
  for (const session of sessions) {
    for (const state of session.currentState) {
      const owner = nameFor(state.entityId);
      if (!owner) continue;
      const list = changesByEvent.get(state.sourceEventId) ?? [];
      list.push({
        label: `${owner}, ${humanize(state.property).toLowerCase()}`,
        value: codexValueText(state.value),
        session: session.number,
      });
      changesByEvent.set(state.sourceEventId, list);
    }
  }
  sessions.forEach((session, sessionIndex) => {
    for (const event of session.events) {
      const identity = originId(event) ?? event.eventId;
      if (seenEvents.has(identity)) continue;
      seenEvents.add(identity);
      const summary =
        event.transitions.join(" ").replace(/\s+/g, " ").trim() ||
        event.evidence[0]?.quote?.replace(/\s+/g, " ").trim() ||
        "";
      const participants = event.participantEntityIds
        .map((id) => nameFor(id))
        .filter((name): name is string => Boolean(name));
      const changes = changesByEvent.get(event.eventId) ?? [];
      if (!summary && participants.length === 0 && changes.length === 0) continue;
      events.push({
        sortKey: `${String(sessionIndex).padStart(6, "0")}|${event.occurrenceOrder}|${event.eventId}`,
        session: session.number,
        campaignTime: event.campaignTime?.trim() || null,
        summary: summary || "Event recorded.",
        location: nameFor(event.locationEntityId),
        participants: [...new Set(participants)],
        changes,
      });
    }
  });
  events.sort((left, right) => (left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0));

  const kindRank = (kind: CampaignMemoryEntityKind) => {
    const index = CAMPAIGN_CODEX_KIND_ORDER.indexOf(kind);
    return index < 0 ? CAMPAIGN_CODEX_KIND_ORDER.length : index;
  };
  const bySession = (left: { session: number }, right: { session: number }) => left.session - right.session;
  const entities = [...byKey.values()]
    .map(({ entity: { key: _key, ...entity } }) => ({
      ...entity,
      sessions: [...entity.sessions].sort((left, right) => left - right),
      currentState: [...entity.currentState].sort((left, right) => left.label.localeCompare(right.label)),
      facts: [...entity.facts].sort(bySession),
      knowledge: [...entity.knowledge].sort(bySession),
      relationships: [...entity.relationships].sort(
        (left, right) => left.target.localeCompare(right.target) || left.type.localeCompare(right.type),
      ),
    }))
    .sort(
      (left, right) =>
        kindRank(left.kind) - kindRank(right.kind) ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );

  return {
    format: CAMPAIGN_CODEX_FORMAT,
    version: CAMPAIGN_CODEX_VERSION,
    gameId: input.gameId,
    gameName: input.gameName,
    generatedAt: input.generatedAt,
    sessions: sessions.map((session) => ({ number: session.number, name: session.name })),
    entities,
    events: events.map(({ sortKey: _sortKey, ...event }) => event),
  };
}

/** One line of prose-safe Markdown: no line breaks, no accidental headings, lists, markup or HTML. */
export function codexInline(value: string): string {
  return (
    value
      .replace(/\s+/g, " ")
      .trim()
      .replace(/([\\`*_~#[\]<>|])/g, "\\$1")
      // A value that starts a line must not open a list or a setext underline.
      .replace(/^([-+=])/, "\\$1")
      .replace(/^(\d+)([.)])/, "$1\\$2")
  );
}

/**
 * Free-form notes keep their own Markdown, but nothing in them may restructure the codex
 * around them: no headings (ATX or setext), no code fence that would swallow the rest of
 * the file, and no raw HTML.
 */
export function codexBlock(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/[<>]/g, "\\$&")
        .replace(/^(\s*)(#{1,6}(?:\s|$)|`{3,}|~{3,})/, "$1\\$2")
        .replace(/^(\s*)(=+|-+)(\s*)$/, "$1\\$2$3"),
    )
    .join("\n")
    .trim();
}

const inline = codexInline;
const block = codexBlock;

function sessionTag(session: number): string {
  return `*(S${session})*`;
}

/** Render the codex as a Markdown document meant to be read, printed or pasted into notes. */
export function renderCampaignCodexMarkdown(codex: CampaignCodex): string {
  const lines: string[] = [];
  lines.push(`# ${inline(codex.gameName || "Campaign")}: Campaign Codex`, "");
  const sessionCount = codex.sessions.length;
  lines.push(
    `Exported ${codex.generatedAt.slice(0, 10)} from ${sessionCount} session${sessionCount === 1 ? "" : "s"}. ` +
      "Tags like *(S2)* name the session a record came from.",
    "",
  );

  if (codex.entities.length === 0 && codex.events.length === 0) {
    lines.push("No campaign memory has been recorded for this game yet.", "");
    return lines.join("\n");
  }

  const groups = CAMPAIGN_CODEX_KIND_ORDER.map((kind) => ({
    kind,
    entities: codex.entities.filter((entity) => entity.kind === kind),
  })).filter((group) => group.entities.length > 0);

  if (groups.length > 0) {
    lines.push("## Contents", "");
    for (const group of groups) lines.push(`- ${KIND_HEADINGS[group.kind]} (${group.entities.length})`);
    if (codex.events.length > 0) lines.push(`- Timeline (${codex.events.length})`);
    lines.push("");
  }

  for (const group of groups) {
    lines.push(`## ${KIND_HEADINGS[group.kind]}`, "");
    for (const entity of group.entities) {
      lines.push(`### ${inline(entity.name)}${entity.archived ? " (archived)" : ""}`, "");
      const meta: string[] = [];
      if (entity.aliases.length) meta.push(`**Also known as:** ${entity.aliases.map(inline).join(", ")}`);
      if (entity.tags.length) meta.push(`**Tags:** ${entity.tags.map(inline).join(", ")}`);
      meta.push(`**Seen in:** ${entity.sessions.map((session) => `Session ${session}`).join(", ")}`);
      lines.push(meta.join("  \n"), "");
      if (entity.summary) lines.push(inline(entity.summary), "");
      if (entity.notes && entity.notes !== entity.summary) lines.push(block(entity.notes), "");
      if (entity.currentState.length) {
        lines.push("**Current state**", "");
        for (const item of entity.currentState)
          lines.push(`- ${inline(item.label)}: ${inline(item.value)} ${sessionTag(item.session)}`);
        lines.push("");
      }
      if (entity.facts.length) {
        lines.push("**Verified facts**", "");
        for (const item of entity.facts)
          lines.push(`- ${inline(item.label)}: ${inline(item.value)} ${sessionTag(item.session)}`);
        lines.push("");
      }
      if (entity.knowledge.length) {
        lines.push("**What they know**", "");
        for (const item of entity.knowledge)
          lines.push(`- ${inline(item.label)}: ${inline(item.value)} ${sessionTag(item.session)}`);
        lines.push("");
      }
      if (entity.relationships.length) {
        lines.push("**Relationships**", "");
        for (const item of entity.relationships)
          lines.push(
            `- ${inline(item.type.charAt(0).toUpperCase() + item.type.slice(1))}: ${inline(item.target)}${item.status === "ended" ? " (ended)" : ""} ${sessionTag(item.session)}`,
          );
        lines.push("");
      }
    }
  }

  if (codex.events.length > 0) {
    lines.push("## Timeline", "");
    let currentSession: number | null = null;
    for (const event of codex.events) {
      if (event.session !== currentSession) {
        currentSession = event.session;
        lines.push(`### Session ${event.session}`, "");
      }
      const when = event.campaignTime ? `**${inline(event.campaignTime)}.** ` : "";
      const where = event.location ? ` *At ${inline(event.location)}.*` : "";
      const who = event.participants.length ? ` *With ${event.participants.map(inline).join(", ")}.*` : "";
      lines.push(`- ${when}${inline(event.summary)}${where}${who}`);
      for (const change of event.changes) lines.push(`  - ${inline(change.label)}: ${inline(change.value)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Filesystem-safe base name for the download. */
export function campaignCodexFileBase(gameName: string): string {
  const slug = gameName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "campaign"}-codex`;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read every session of the chat's game and build its codex. Read-only: it lists memory
 * through the storage readers and never writes. Returns null for an unknown chat.
 */
export async function loadCampaignCodex(db: DB, chatId: string): Promise<CampaignCodex | null> {
  const chat = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  if (!chat) return null;
  const meta = parseMetadata(chat.metadata);
  const gameId = readString(meta.gameId) || chat.groupId || chat.id;
  const grouped = chat.groupId ? await db.select().from(chats).where(eq(chats.groupId, chat.groupId)) : [];
  const candidates = grouped.filter((session) => session.mode === "game");
  // Branches are what-ifs over a session; the codex follows the canonical line unless
  // the export was asked for from inside a branch, which then joins it.
  const isBranch = (row: typeof chat) => readString(parseMetadata(row.metadata).branchName) !== "";
  const canonical = candidates.filter((session) => !isBranch(session));
  let chosen = canonical.length > 0 ? canonical : candidates;
  if (!chosen.some((session) => session.id === chat.id)) chosen.push(chat);
  // A branch stands in for the session it forked from: that session's line past the fork is
  // not what happened in the branch, so the chain the branch came from is left out.
  const replaced = new Set<string>();
  for (let row: typeof chat | undefined = chat; row && isBranch(row); ) {
    const parentId = readString(parseMetadata(row.metadata).branchParentChatId);
    if (!parentId || parentId === chat.id || replaced.has(parentId)) break;
    replaced.add(parentId);
    row = grouped.find((session) => session.id === parentId);
  }
  if (replaced.size > 0) chosen = chosen.filter((session) => !replaced.has(session.id));

  const sessionNumber = (row: typeof chat): number | null => {
    const value = parseMetadata(row.metadata).gameSessionNumber;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  chosen.sort((left, right) => {
    const diff = (sessionNumber(left) ?? 0) - (sessionNumber(right) ?? 0);
    if (diff !== 0) return diff;
    return String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
  });

  const storage = createCampaignMemoryStorage(db);
  const sessions: CampaignCodexSessionInput[] = [];
  for (const session of chosen) {
    const scope = { chatId: session.id };
    const [entities, facts, knowledge, events, currentState, relationships] = await Promise.all([
      storage.listEntities(scope),
      storage.listFacts(scope),
      storage.listKnowledge(scope),
      storage.listEvents(scope),
      storage.listCurrentState(scope),
      storage.listRelationships(scope),
    ]);
    sessions.push({
      chatId: session.id,
      sessionNumber: sessionNumber(session),
      name: readString(session.name),
      entities,
      facts,
      knowledge,
      events,
      currentState,
      relationships,
    });
  }

  return buildCampaignCodex({
    gameId,
    // Later sessions are named "<game> — Session N"; the game's own name is the part before it.
    gameName: (readString(chosen[0]?.name) || readString(chat.name)).replace(/ — Session \d+$/, "") || "Campaign",
    generatedAt: new Date().toISOString(),
    sessions,
  });
}
