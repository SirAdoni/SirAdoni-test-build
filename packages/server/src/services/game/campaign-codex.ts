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
// A long campaign holds tens of thousands of records, many of them the same
// statement known by many characters. Each statement is written once, with the
// characters who know, believe or have heard it listed under it, and long values
// are cut: to CODEX_MARKDOWN_VALUE_MAX in the Markdown, CODEX_JSON_VALUE_MAX in
// the JSON.
//
// On the canonical line the loader reads the campaign memory projection (the
// same merge the game itself plays from: identity folding, presence only from
// the newest session, re-read facts deduped). A branch export, or a game whose
// sessions the projection does not cover exactly, falls back to reading each
// session chat.
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
import { readCampaignMemoryProjection, type CampaignMemoryProjection } from "./campaign-memory-campaign-scope.js";

export const CAMPAIGN_CODEX_FORMAT = "marinara-campaign-codex";
export const CAMPAIGN_CODEX_VERSION = 2;

/** Longest value the Markdown prints; a long campaign's records run to thousands of characters each. */
export const CODEX_MARKDOWN_VALUE_MAX = 280;
/** Longest value the JSON keeps. */
export const CODEX_JSON_VALUE_MAX = 4_000;
/** Holder names the Markdown lists per statement before "and N more". */
const CODEX_MARKDOWN_HOLDERS_MAX = 12;

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
  /**
   * The entities were already folded across sessions (the campaign memory projection): every
   * entity id is one real-world thing, so the build keys on it instead of guessing from names.
   */
  entitiesMerged?: boolean;
}

/** Characters in the story who hold a statement, by how they hold it. */
export interface CampaignCodexHolders {
  /** "Known by", "Believed by" or "Heard by". */
  state: string;
  names: string[];
}

export interface CampaignCodexStatement {
  label: string;
  value: string;
  session: number;
  /** The same statement is recorded in full under this entry; this one is an excerpt. */
  sameAs?: string;
  /** Who knows, believes or has heard it. Listed once here instead of under every holder. */
  heldBy?: CampaignCodexHolders[];
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
  /** Unverified statements about this entity that someone in the story holds. */
  claims: CampaignCodexStatement[];
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

const HOLDER_LABELS: Record<string, string> = {
  knows: "Known by",
  believes: "Believed by",
  rumor: "Heard by",
};

/** A value cut to `max` characters at a word break, marked with an ellipsis. */
export function codexExcerpt(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}

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
    if (input.entitiesMerged) return `record:${entity.entityId}`;
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
            claims: [],
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
  const factById = new Map<string, CampaignMemoryFact>();
  const stateByProperty = new Map<string, { statement: CampaignCodexStatement; order: string }>();
  const relationshipByKey = new Map<string, { owner: CampaignCodexEntity; relationship: CampaignCodexRelationship }>();
  // Statements by subject, predicate and value: a fact re-read in a later session, or known by
  // many characters, is one entry. The same statement under another subject is an excerpt that
  // points at the first, so a long campaign's text is carried once.
  const factStatements = new Map<string, CampaignCodexStatement>();
  const claimStatements = new Map<string, CampaignCodexStatement>();
  const firstOwnerByStatement = new Map<string, string>();
  const statementFor = (
    ownerName: string,
    predicate: string,
    value: CampaignMemoryJson,
    session: number,
  ): CampaignCodexStatement => {
    const label = humanize(predicate);
    const text = codexValueText(value);
    const globalKey = `${normalizeName(predicate)}\u0000${stableJson(value)}`;
    const first = firstOwnerByStatement.get(globalKey);
    if (first === undefined) {
      firstOwnerByStatement.set(globalKey, ownerName);
      return { label, value: codexExcerpt(text, CODEX_JSON_VALUE_MAX), session };
    }
    if (text.length <= CODEX_MARKDOWN_VALUE_MAX) return { label, value: text, session };
    return { label, value: codexExcerpt(text, CODEX_MARKDOWN_VALUE_MAX), session, sameAs: first };
  };
  const statementKey = (subject: { key: string }, predicate: string, value: CampaignMemoryJson) =>
    `${subject.key}\u0000${normalizeName(predicate)}\u0000${stableJson(value)}`;

  for (const session of sessions) {
    for (const fact of session.facts) factById.set(fact.factId, fact);
  }

  // Every verified fact first, so knowledge of a fact verified in a later session still joins it.
  for (const session of sessions) {
    for (const fact of session.facts) {
      if (fact.status !== "verified") continue;
      const subject = entityFor(fact.subjectEntityId);
      if (!subject) continue;
      const key = statementKey(subject, fact.predicate, fact.value);
      if (factStatements.has(key)) continue;
      const statement = statementFor(subject.name, fact.predicate, fact.value, session.number);
      factStatements.set(key, statement);
      subject.facts.push(statement);
    }
  }

  for (const session of sessions) {
    for (const item of session.knowledge) {
      if (item.epistemicState === "unknown") continue;
      const holder = entityFor(item.holderEntityId);
      if (!holder) continue;
      const fact = item.factId ? factById.get(item.factId) : undefined;
      const claim = fact
        ? { subjectEntityId: fact.subjectEntityId, predicate: fact.predicate, value: fact.value }
        : item.attributedClaim;
      if (!claim) continue;
      const subject = entityFor(claim.subjectEntityId);
      if (!subject) continue;
      const key = statementKey(subject, claim.predicate, claim.value);
      let statement = factStatements.get(key) ?? claimStatements.get(key);
      if (!statement) {
        statement = statementFor(subject.name, claim.predicate, claim.value, session.number);
        claimStatements.set(key, statement);
        subject.claims.push(statement);
      }
      const state = HOLDER_LABELS[item.epistemicState] ?? `Held by (${humanize(item.epistemicState).toLowerCase()})`;
      const heldBy = (statement.heldBy ??= []);
      let holders = heldBy.find((entry) => entry.state === state);
      if (!holders) {
        holders = { state, names: [] };
        heldBy.push(holders);
      }
      if (!holders.names.includes(holder.name)) holders.names.push(holder.name);
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
      claims: [...entity.claims].sort(bySession),
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

/** One statement as a list item: the value cut to a readable length, then who holds it. */
function statementLine(item: CampaignCodexStatement): string {
  const parts = [`- ${inline(item.label)}: ${inline(codexExcerpt(item.value, CODEX_MARKDOWN_VALUE_MAX))}`];
  if (item.sameAs) parts.push(`(as under ${inline(item.sameAs)})`);
  parts.push(sessionTag(item.session));
  for (const holders of item.heldBy ?? []) {
    const more = holders.names.length - CODEX_MARKDOWN_HOLDERS_MAX;
    const names = holders.names.slice(0, CODEX_MARKDOWN_HOLDERS_MAX).map(inline).join(", ");
    parts.push(`${holders.state}: ${names}${more > 0 ? ` and ${more} more` : ""}.`);
  }
  return parts.join(" ");
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
        for (const item of entity.currentState) lines.push(statementLine(item));
        lines.push("");
      }
      if (entity.facts.length) {
        lines.push("**Verified facts**", "");
        for (const item of entity.facts) lines.push(statementLine(item));
        lines.push("");
      }
      if (entity.claims.length) {
        lines.push("**Unverified, as held in the story**", "");
        for (const item of entity.claims) lines.push(statementLine(item));
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
      lines.push(`- ${when}${inline(codexExcerpt(event.summary, CODEX_MARKDOWN_VALUE_MAX * 2))}${where}${who}`);
      for (const change of event.changes)
        lines.push(`  - ${inline(change.label)}: ${inline(codexExcerpt(change.value, CODEX_MARKDOWN_VALUE_MAX))}`);
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

type ChatRow = typeof chats.$inferSelect;

export interface CampaignSessionChats {
  /** The chat the request came from. */
  chat: ChatRow;
  gameId: string;
  gameName: string;
  /** Whether the request came from inside a branch. */
  fromBranch: boolean;
  /** The sessions of the line being read, oldest first. */
  sessions: ChatRow[];
  sessionNumber: (row: ChatRow) => number | null;
}

/**
 * The session chats of the game a chat belongs to, oldest first, following the canonical
 * line; asked from inside a branch, the branch stands in for the chain it forked from.
 * Shared by the codex and the campaign log so both read the same sessions. Null for an
 * unknown chat.
 */
export async function resolveCampaignSessionChats(db: DB, chatId: string): Promise<CampaignSessionChats | null> {
  const chat = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
  if (!chat) return null;
  const meta = parseMetadata(chat.metadata);
  const gameId = readString(meta.gameId) || chat.groupId || chat.id;
  const grouped = chat.groupId ? await db.select().from(chats).where(eq(chats.groupId, chat.groupId)) : [];
  // Only sessions of this game (the campaign memory projection's rule): a row in the group
  // that carries another game's id is not part of it.
  const candidates = grouped.filter(
    (session) =>
      session.mode === "game" && (readString(parseMetadata(session.metadata).gameId) || session.groupId) === gameId,
  );
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
  // Canonical sessions after the fork continue the line the branch left, not the branch. A
  // session started from a branch inherits its branchParentChatId, so one that carries the
  // branch's own parent may be its continuation and stays.
  const branchNumber = isBranch(chat) ? sessionNumber(chat) : null;
  if (branchNumber !== null) {
    const branchParent = readString(parseMetadata(chat.metadata).branchParentChatId);
    chosen = chosen.filter((session) => {
      if (session.id === chat.id || isBranch(session)) return true;
      const number = sessionNumber(session);
      if (number === null || number <= branchNumber) return true;
      return branchParent !== "" && readString(parseMetadata(session.metadata).branchParentChatId) === branchParent;
    });
  }
  chosen.sort((left, right) => {
    const diff = (sessionNumber(left) ?? 0) - (sessionNumber(right) ?? 0);
    if (diff !== 0) return diff;
    return String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
  });

  // Later sessions are named "<game> — Session N"; the game's own name is the part before it.
  const gameName = (readString(chosen[0]?.name) || readString(chat.name)).replace(/ — Session \d+$/, "") || "Campaign";
  return { chat, gameId, gameName, fromBranch: isBranch(chat), sessions: chosen, sessionNumber };
}

/**
 * Read every session of the chat's game and build its codex. Read-only: it lists memory
 * through the storage readers and never writes. Returns null for an unknown chat.
 */
export async function loadCampaignCodex(db: DB, chatId: string): Promise<CampaignCodex | null> {
  const resolved = await resolveCampaignSessionChats(db, chatId);
  if (!resolved) return null;
  const { gameId, gameName, sessions: chosen, sessionNumber } = resolved;
  const generatedAt = new Date().toISOString();

  if (!resolved.fromBranch && chosen.length > 0) {
    const newest = chosen[chosen.length - 1]!;
    const projection = await readCampaignMemoryProjection(db, newest.id);
    const expected = chosen.map((session) => session.id);
    if (
      projection.sessionChatIds.length === expected.length &&
      projection.sessionChatIds.every((id, index) => id === expected[index])
    ) {
      return buildCampaignCodex({
        gameId,
        gameName,
        generatedAt,
        sessions: codexSessionsFromProjection(
          projection,
          chosen.map((session) => ({ chatId: session.id, sessionNumber: sessionNumber(session), name: readString(session.name) })),
        ),
        entitiesMerged: true,
      });
    }
  }

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

  return buildCampaignCodex({ gameId, gameName, generatedAt, sessions });
}

/**
 * Split a campaign projection back into per-session inputs so every record keeps the tag
 * of the session it came from. A merged entity is listed in each session it was seen in.
 */
export function codexSessionsFromProjection(
  projection: Pick<
    CampaignMemoryProjection,
    "entities" | "facts" | "knowledge" | "events" | "currentState" | "relationships"
  >,
  sessions: ReadonlyArray<{ chatId: string; sessionNumber: number | null; name: string }>,
): CampaignCodexSessionInput[] {
  const inputs: CampaignCodexSessionInput[] = sessions.map((session) => ({
    ...session,
    entities: [],
    facts: [],
    knowledge: [],
    events: [],
    currentState: [],
    relationships: [],
  }));
  const byChat = new Map(inputs.map((input) => [input.chatId, input]));
  const byNumber = new Map<number, CampaignCodexSessionInput>();
  for (const input of inputs) if (input.sessionNumber != null) byNumber.set(input.sessionNumber, input);
  const home = (record: { originChatId: string }) => byChat.get(record.originChatId) ?? inputs[inputs.length - 1];
  const push = <K extends Exclude<keyof CampaignCodexSessionInput, "chatId" | "sessionNumber" | "name">>(
    target: CampaignCodexSessionInput | undefined,
    key: K,
    item: CampaignCodexSessionInput[K][number],
  ) => {
    if (target) (target[key] as Array<CampaignCodexSessionInput[K][number]>).push(item);
  };

  for (const entity of projection.entities) {
    const seen = new Set<CampaignCodexSessionInput>();
    for (const number of entity.sessionNumbers ?? []) {
      const target = byNumber.get(number);
      if (target) seen.add(target);
    }
    if (seen.size === 0) {
      const target = home(entity);
      if (target) seen.add(target);
    }
    // Oldest session first, so the entry records where the thing was first met.
    for (const target of inputs) if (seen.has(target)) push(target, "entities", entity);
  }
  for (const item of projection.facts) push(home(item), "facts", item);
  for (const item of projection.knowledge) push(home(item), "knowledge", item);
  for (const item of projection.events) push(home(item), "events", item);
  for (const item of projection.currentState) push(home(item), "currentState", item);
  for (const item of projection.relationships) push(home(item), "relationships", item);
  return inputs;
}
