import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  CampaignMemoryCurrentState,
  CampaignMemoryEntity,
  CampaignMemoryEvent,
  CampaignMemoryFact,
  CampaignMemoryKnowledge,
  CampaignMemoryRelationship,
} from "@marinara-engine/shared";

// Campaign codex export: per-session memory folds into one codex (entities merged across
// sessions, newest state wins, facts tagged by session, names instead of ids, one
// chronological timeline); the Markdown reads cleanly; the loader only reads.

const root = mkdtempSync(join(tmpdir(), "marinara-codex-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const provenance = { source: "fixture", sourceRevision: "r1", actor: "system" as const };
const stamp = "2026-09-01T10:00:00.000Z";

function entity(
  chatId: string,
  entityId: string,
  kind: CampaignMemoryEntity["kind"],
  aliases: string[],
  extra: Partial<CampaignMemoryEntity> = {},
): CampaignMemoryEntity {
  return {
    entityId,
    chatId,
    kind,
    owner: { type: "registry", store: "campaign-memory", recordId: entityId },
    aliases,
    tags: [],
    attributes: {},
    status: "active",
    manualLock: false,
    provenance,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    ...extra,
  };
}

function fact(
  chatId: string,
  factId: string,
  subjectEntityId: string,
  predicate: string,
  value: CampaignMemoryFact["value"],
  status: CampaignMemoryFact["status"] = "verified",
): CampaignMemoryFact {
  return {
    factId,
    chatId,
    subjectEntityId,
    predicate,
    value,
    conditions: [],
    status,
    sourceRevision: "r1",
    evidence: [],
    author: "system",
    provenance,
    manualLock: false,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function event(
  chatId: string,
  eventId: string,
  order: string,
  extra: Partial<CampaignMemoryEvent>,
): CampaignMemoryEvent {
  return {
    eventId,
    chatId,
    occurrenceOrder: order,
    participantEntityIds: [],
    sourceRevision: "r1",
    transitions: [],
    evidence: [],
    provenance,
    immutable: true,
    createdAt: stamp,
    ...extra,
  };
}

function state(
  chatId: string,
  stateId: string,
  entityId: string,
  property: string,
  value: CampaignMemoryCurrentState["value"],
  sourceEventId: string,
  validAtOrder: string,
): CampaignMemoryCurrentState {
  return {
    stateId,
    chatId,
    entityId,
    property,
    value,
    sourceEventId,
    validAtOrder,
    protected: false,
    provenance,
    manualLock: false,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function relationship(
  chatId: string,
  relationshipId: string,
  sourceEntityId: string,
  targetEntityId: string,
  type: string,
  status: CampaignMemoryRelationship["status"],
): CampaignMemoryRelationship {
  return {
    relationshipId,
    chatId,
    sourceEntityId,
    targetEntityId,
    type,
    inverseLabel: type,
    status,
    evidence: [],
    provenance,
    manualLock: false,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

try {
  const { buildCampaignCodex, renderCampaignCodexMarkdown, campaignCodexFileBase, codexValueText } =
    await import("../../packages/server/src/services/game/campaign-codex.js");

  const order = (n: number) => `m1|2026-09-0${n}T10:00:00.000Z|msg-${n}`;
  const knowledge: CampaignMemoryKnowledge = {
    knowledgeId: "k1",
    chatId: "s2",
    holderEntityId: "mira-2",
    factId: "f-secret",
    epistemicState: "believes",
    learnedFrom: [],
    provenance,
    manualLock: false,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };

  const codex = buildCampaignCodex({
    gameId: "game-1",
    gameName: "Ashes of Orm",
    generatedAt: "2026-09-22T12:00:00.000Z",
    sessions: [
      {
        chatId: "s1",
        sessionNumber: 1,
        name: "Session one",
        entities: [
          entity("s1", "mira-1", "character", ["Mira"], { summary: "A courier." }),
          entity("s1", "vel-1", "location", ["Orm"]),
          entity("s1", "guild-1", "organization", ["Ash Guild"]),
        ],
        facts: [
          fact("s1", "f1", "mira-1", "occupation", "courier"),
          fact("s1", "f-proposed", "mira-1", "secret_identity", "a queen", "proposed"),
        ],
        knowledge: [],
        events: [
          event("s1", "e1", order(1), {
            transitions: ["Mira arrives in Orm."],
            participantEntityIds: ["mira-1"],
            locationEntityId: "vel-1",
            campaignTime: "Day 1, dusk",
          }),
        ],
        currentState: [state("s1", "st1", "mira-1", "location", "Orm", "e1", order(1))],
        relationships: [relationship("s1", "r1", "mira-1", "guild-1", "member_of", "active")],
      },
      {
        chatId: "s2",
        sessionNumber: 2,
        name: "Session two",
        entities: [
          // Same person, new record id, one new alias: folds into the session-1 entry.
          entity("s2", "mira-2", "character", ["mira", "The Courier"], { summary: "A courier on the run." }),
          entity("s2", "vel-2", "location", ["Orm"]),
          entity("s2", "guild-2", "organization", ["Ash Guild"]),
        ],
        facts: [
          fact("s2", "f1-copy", "mira-2", "occupation", "courier"),
          fact("s2", "f2", "mira-2", "wanted_by", { faction: "Ash Guild", bounty: 50 }),
          fact("s2", "f-secret", "guild-2", "hidden_vault", "under the chapel", "proposed"),
        ],
        knowledge: [knowledge],
        events: [
          event("s2", "e2", order(3), {
            transitions: ["The guild turns on Mira."],
            participantEntityIds: ["mira-2", "guild-2"],
          }),
          event("s2", "e-empty", order(4), {}),
        ],
        currentState: [state("s2", "st2", "mira-2", "location", "Orm docks", "e2", order(3))],
        relationships: [relationship("s2", "r2", "mira-2", "guild-2", "member_of", "ended")],
      },
    ],
  });

  assert.equal(codex.format, "marinara-campaign-codex");
  assert.deepEqual(
    codex.sessions.map((session) => session.number),
    [1, 2],
  );
  assert.equal(codex.entities.length, 3, "one entry per real entity across sessions");
  assert.deepEqual(
    codex.entities.map((item) => `${item.kind}:${item.name}`),
    ["character:Mira", "location:Orm", "organization:Ash Guild"],
    "grouped in kind order",
  );
  const mira = codex.entities[0]!;
  assert.deepEqual(mira.aliases, ["The Courier"], "new aliases join, case-duplicates of the name do not");
  assert.equal(mira.summary, "A courier on the run.", "the newest summary wins");
  assert.deepEqual(mira.sessions, [1, 2]);
  assert.deepEqual(mira.currentState, [{ label: "Location", value: "Orm docks", session: 2 }], "newest state wins");
  assert.deepEqual(
    mira.facts,
    [
      { label: "Occupation", value: "courier", session: 1 },
      { label: "Wanted by", value: "Faction: Ash Guild; Bounty: 50", session: 2 },
    ],
    "verified facts only, deduplicated, tagged with their first session",
  );
  assert.equal("knowledge" in mira, false, "knowledge is not repeated under every holder");
  assert.deepEqual(
    codex.entities[2]!.claims,
    [{ label: "Hidden vault", value: "under the chapel", session: 2, heldBy: [{ state: "Believed by", names: ["Mira"] }] }],
    "an unverified statement someone holds is listed once under its subject, with who holds it",
  );
  assert.deepEqual(mira.relationships, [{ type: "member of", target: "Ash Guild", status: "ended", session: 2 }]);
  assert.equal(codex.events.length, 2, "an event with nothing to say is dropped");
  assert.deepEqual(codex.events[0], {
    session: 1,
    campaignTime: "Day 1, dusk",
    summary: "Mira arrives in Orm.",
    location: "Orm",
    participants: ["Mira"],
    changes: [{ label: "Mira, location", value: "Orm", session: 1 }],
  });
  assert.deepEqual(codex.events[1]!.participants, ["Mira", "Ash Guild"]);

  const json = JSON.stringify(codex);
  for (const rawId of ["mira-1", "mira-2", "guild-2", "vel-1", "f2", "e1", "st2"]) {
    assert.ok(!json.includes(`"${rawId}"`), `raw id ${rawId} never reaches the export`);
  }

  const markdown = renderCampaignCodexMarkdown(codex);
  assert.match(markdown, /^# Ashes of Orm: Campaign Codex\n/);
  assert.match(markdown, /## Characters\n\n### Mira\n/);
  assert.match(markdown, /\*\*Also known as:\*\* The Courier/);
  assert.match(markdown, /\*\*Seen in:\*\* Session 1, Session 2/);
  assert.match(
    markdown,
    /\*\*Verified facts\*\*\n\n- Occupation: courier \*\(S1\)\*\n- Wanted by: Faction: Ash Guild; Bounty: 50 \*\(S2\)\*/,
  );
  assert.match(markdown, /- Member of: Ash Guild \(ended\) \*\(S2\)\*/);
  assert.match(
    markdown,
    /\*\*Unverified, as held in the story\*\*\n\n- Hidden vault: under the chapel \*\(S2\)\* Believed by: Mira\./,
  );
  assert.match(markdown, /## Factions and organizations/);
  assert.match(
    markdown,
    /## Timeline\n\n### Session 1\n\n- \*\*Day 1, dusk\.\*\* Mira arrives in Orm\. \*At Orm\.\* \*With Mira\.\*\n  - Mira, location: Orm/,
  );
  assert.doesNotMatch(markdown, /a queen/, "proposed facts stay out");
  assert.doesNotMatch(markdown, /—/, "no em dashes");

  // ── Escaping: memory text can never restructure the document or carry raw HTML ──
  const { codexInline, codexBlock } = await import("../../packages/server/src/services/game/campaign-codex.js");
  assert.equal(codexInline("# Not a heading"), "\\# Not a heading");
  assert.equal(codexInline("- not a list"), "\\- not a list");
  assert.equal(codexInline("3. not a list"), "3\\. not a list");
  assert.equal(codexInline("<img src=x onerror=alert(1)>"), "\\<img src=x onerror=alert(1)\\>");
  assert.equal(codexInline("~~gone~~ and #tag"), "\\~\\~gone\\~\\~ and \\#tag");
  assert.equal(
    codexBlock("Intro\n---\n## Sub\n```\n<script>x</script>\n**kept**"),
    "Intro\n\\---\n\\## Sub\n\\```\n\\<script\\>x\\</script\\>\n**kept**",
  );
  const hostile = renderCampaignCodexMarkdown(
    buildCampaignCodex({
      gameId: "g",
      gameName: "Hostile",
      generatedAt: stamp,
      sessions: [
        {
          chatId: "h1",
          sessionNumber: 1,
          name: "One",
          entities: [entity("h1", "h-1", "character", ["Eve"], { summary: "# Takeover", body: "```\nunclosed fence" })],
          facts: [],
          knowledge: [],
          events: [],
          currentState: [],
          relationships: [],
        },
      ],
    }),
  );
  assert.doesNotMatch(hostile, /^# Takeover/m, "a summary cannot become a heading");
  assert.doesNotMatch(hostile, /^```/m, "notes cannot open a fence that swallows the rest of the file");

  const empty = renderCampaignCodexMarkdown(
    buildCampaignCodex({ gameId: "g", gameName: "Quiet", generatedAt: stamp, sessions: [] }),
  );
  assert.match(empty, /No campaign memory has been recorded/);
  assert.equal(campaignCodexFileBase("Ashes of Vél: Part 2!"), "ashes-of-vel-part-2-codex");
  assert.equal(campaignCodexFileBase("???"), "campaign-codex");
  assert.equal(codexValueText(["a", 2, true, null]), "a, 2, true, none");

  // ── Loader over the real storage: reads every session of the game, writes nothing ──
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { loadCampaignCodex } = await import("../../packages/server/src/services/game/campaign-codex.js");
  const db = await createFileNativeDB();
  for (const [id, number, extra] of [
    ["chat-1", 1, {}],
    ["chat-2", 2, {}],
    ["chat-branch", 2, { branchName: "What if", branchParentChatId: "chat-2" }],
    ["chat-lone", 3, {}],
  ] as const) {
    await db.insert(schema.chats).values({
      id,
      name:
        id === "chat-1" ? "Ashes of Orm" : id === "chat-lone" ? "Lone Road — Session 3" : "Ashes of Orm — Session 2",
      mode: "game",
      groupId: id === "chat-lone" ? "game-lone" : "game-9",
      metadata: JSON.stringify({ gameId: "game-9", gameSessionNumber: number, ...extra }),
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  const insertEntity = (chatId: string, entityId: string, alias: string) =>
    db.insert(schema.campaignMemoryEntities).values({
      entityId,
      chatId,
      kind: "character",
      owner: JSON.stringify({ type: "registry", store: "campaign-memory", recordId: entityId }),
      aliases: JSON.stringify([alias]),
      tags: "[]",
      attributes: "{}",
      provenance: JSON.stringify(provenance),
      createdAt: stamp,
      updatedAt: stamp,
    });
  await insertEntity("chat-1", "db-mira-1", "Mira");
  await insertEntity("chat-2", "db-mira-2", "Mira");
  await insertEntity("chat-branch", "db-ghost", "Branch Ghost");
  await db.insert(schema.campaignMemoryFacts).values({
    factId: "db-f1",
    chatId: "chat-2",
    subjectEntityId: "db-mira-2",
    predicate: "title",
    value: JSON.stringify("Warden"),
    status: "verified",
    sourceRevision: "r1",
    author: "system",
    provenance: JSON.stringify(provenance),
    createdAt: stamp,
    updatedAt: stamp,
  });
  const journalBefore = (await db.select().from(schema.campaignMemoryMutationJournal)).length;

  const loaded = await loadCampaignCodex(db, "chat-2");
  assert.ok(loaded);
  assert.equal(loaded.gameId, "game-9");
  assert.equal(loaded.gameName, "Ashes of Orm");
  assert.deepEqual(
    loaded.sessions.map((session) => session.number),
    [1, 2],
    "branches are left out when exporting from the canonical line",
  );
  assert.deepEqual(
    loaded.entities.map((item) => item.name),
    ["Mira"],
  );
  assert.deepEqual(loaded.entities[0]!.facts, [{ label: "Title", value: "Warden", session: 2 }]);
  const fromBranch = await loadCampaignCodex(db, "chat-branch");
  assert.ok(
    fromBranch?.entities.some((item) => item.name === "Branch Ghost"),
    "exporting from a branch includes it",
  );
  assert.deepEqual(
    fromBranch?.sessions.map((session) => session.number),
    [1, 2],
    "the branch stands in for the session it forked from instead of sitting beside it",
  );
  assert.deepEqual(
    fromBranch?.entities.find((item) => item.name === "Mira")?.facts,
    [],
    "nothing recorded on the parent session's line past the fork leaks into a branch export",
  );
  assert.equal(
    (await loadCampaignCodex(db, "chat-lone"))?.gameName,
    "Lone Road",
    "the session suffix is not part of the game's name",
  );
  assert.equal(await loadCampaignCodex(db, "nope"), null);
  assert.equal(
    (await db.select().from(schema.campaignMemoryMutationJournal)).length,
    journalBefore,
    "the export writes nothing",
  );

  // ── Wiring ──
  const routes = read("../../packages/server/src/routes/game-tools.routes.ts");
  assert.match(routes, /app\.get<\{ Params: \{ chatId: string \} \}>\("\/codex\/:chatId"/);
  assert.doesNotMatch(routes, /app\.(post|put|patch|delete)[^\n]*codex/, "the codex route is read-only");
  const panel = read("../../packages/client/src/components/game/GameToolsPanel.tsx");
  assert.match(panel, /downloadCampaignCodex\(chatId, format\)/);
  assert.doesNotMatch(read("../../packages/client/src/components/game/CampaignWiki.tsx"), /downloadCampaignCodex/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
