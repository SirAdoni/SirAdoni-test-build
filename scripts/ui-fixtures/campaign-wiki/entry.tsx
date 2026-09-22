import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CampaignWiki } from "../../../packages/client/src/components/game/CampaignWiki";
import { CampaignWikiWindow } from "../../../packages/client/src/components/game/CampaignWikiWindow";
import { GameInventory, type InventoryItem } from "../../../packages/client/src/components/game/GameInventory";
import { ChatSettingsDrawer } from "../../../packages/client/src/components/chat/ChatSettingsDrawer";
import { initializeLocalization } from "../../../packages/client/src/localization/i18n";
import { useGameModeStore } from "../../../packages/client/src/stores/game-mode.store";
import { useUIStore } from "../../../packages/client/src/stores/ui.store";

type MockControl = {
  delayMs: number;
  failList: number;
  failDetail: number;
  failFactPage: number;
  failCommitments: number;
  failApplyOnce: boolean;
  forceConflict: boolean;
  appliedOperationId: string | null;
  lastMutation: unknown;
  mutationIds: string[];
  audit: unknown[];
  branchMode: string;
  chatFailures: number;
  knowledgeMode: string;
  commitmentRevisions: Record<string, number>;
  commitmentListFetches: number;
  transitions: Array<{ commitmentId: string; body: any; status: number }>;
  ownerHold: boolean;
  releaseOwner: () => void;
  ownerLinked: Record<string, string>;
  ownerLookups: string[];
};
declare global {
  interface Window {
    __wikiMock: MockControl;
    __queryClient?: QueryClient;
    __ownerStores?: { game: () => unknown; ui: () => unknown };
  }
}

const source = "fixture-campaign";
const now = "2026-09-13T00:00:00.000Z";
const provenance = { source, sourceRevision: "rev-3", actor: "system" as const, authoredAt: now };

function entity(id: string, index: number) {
  const kind = index % 3 === 0 ? "character" : index % 3 === 1 ? "location" : "item";
  return {
    entityId: id,
    chatId: "chat-demo",
    kind,
    owner:
      index === 0
        ? { type: "existing" as const, store: "characters", recordId: "char-1" }
        : index === 1
          ? { type: "existing" as const, store: "personas", recordId: "persona-1" }
          : { type: "registry" as const, store: "campaign-memory" as const, recordId: id },
    aliases: [index === 0 ? "Ariadne Vale" : `${kind[0].toUpperCase()}${kind.slice(1)} ${index}`],
    tags: ["fixture", kind],
    summary: index === 0 ? "Ariadne guards the northern archive." : `Recorded fixture ${index}.`,
    attributes: {},
    status: "active" as const,
    manualLock: false,
    provenance,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

const entities = Array.from({ length: 121 }, (_, index) => entity(`entity-${index}`, index));
const entity0 = entities[0];
const factStates = [
  {
    predicate: "holds the northern archive key",
    value: { key: "archive", count: 7 },
    conditions: [{ kind: "scene", value: "After the eclipse" }],
    revision: 1,
  },
  { predicate: "has archive count", value: 42, conditions: [{ kind: "threshold", value: 10 }], revision: 1 },
  { predicate: "is trusted", value: true, conditions: [{ kind: "flag", value: true }], revision: 1 },
];
const emptyPage = <T,>(items: T[], total = items.length, offset = 0, limit = 50) => ({ items, total, offset, limit });

function InventoryHarness() {
  const [items, setItems] = React.useState<InventoryItem[]>([
    { itemId: "item-a", name: "Moonstone", quantity: 2 },
    { itemId: "item-b", name: "Moonstone", quantity: 5 },
  ]);
  const update = (item: InventoryItem, patch: Partial<InventoryItem>) =>
    setItems((current) =>
      current.map((candidate) => (candidate.itemId === item.itemId ? { ...candidate, ...patch } : candidate)),
    );
  return (
    <GameInventory
      open
      items={items}
      canInteract
      onClose={() => undefined}
      onRenameItem={(item, name) => {
        update(item, { name });
        return name;
      }}
      onIncrementItem={(item) => update(item, { quantity: item.quantity + 1 })}
      onRemoveItem={(item) =>
        setItems((current) =>
          current.flatMap((candidate) =>
            candidate.itemId === item.itemId
              ? candidate.quantity > 1
                ? [{ ...candidate, quantity: candidate.quantity - 1 }]
                : []
              : [candidate],
          ),
        )
      }
      onReorderItem={() => undefined}
    />
  );
}

function SettingsHarness() {
  const chat = {
    id: "chat-demo",
    name: "Fixture Game",
    mode: "game",
    characterIds: [],
    groupId: null,
    personaId: null,
    promptPresetId: null,
    connectionId: null,
    connectedChatId: null,
    folderId: null,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    metadata: { summary: null, enableAgents: true, gameNpcKnowledgeMode: "isolated" },
  } as any;
  return <ChatSettingsDrawer chat={chat} open onClose={() => undefined} />;
}

// 101 facts over sessions 3 (newest), 2 and 1, plus a few recorded before session numbers existed.
const FACT_TOTAL = 101;
const factOverrides: Record<string, Record<string, unknown>> = {};
function factSession(index: number): number | null {
  return index < 40 ? 3 : index < 70 ? 2 : index < 96 ? 1 : null;
}
function factValue(index: number): unknown {
  if (index < factStates.length) return factStates[index].value;
  if (index === 5) return { text: "Ariadne is the last sworn archivist of the north.", kind: "decision", pinned: true };
  if (index === 6) return { text: "Ariadne promised to guard the gate until the thaw.", kind: "commitment" };
  if (index === 7) return { text: "Ariadne was born in the southern marshes.", kind: "learning" };
  if (index % 7 === 3) return { text: `Ariadne learned archive rule ${index}.`, kind: "learning" };
  if (index % 7 === 4) return { text: `Ariadne agreed to escort caravan ${index}.`, kind: "commitment" };
  return `Recorded detail ${index} about Ariadne`;
}
function allFacts(id: string) {
  return Array.from({ length: FACT_TOTAL }, (_, i) => {
    const session = factSession(i);
    const base = {
      factId: `fact-${i}`,
      chatId: "chat-demo",
      subjectEntityId: id,
      predicate:
        i < factStates.length
          ? factStates[i].predicate
          : typeof factValue(i) === "string"
            ? ["occupation", "habit", "trait"][i % 3]
            : "continuity.record",
      value: factValue(i),
      conditions: i < factStates.length ? factStates[i].conditions : [],
      status: (i === 7 ? "retracted" : "verified") as "verified" | "retracted",
      sourceRevision: "rev-3",
      evidence:
        i === 0
          ? [
              { messageId: "msg-1", quote: "The archive key is kept here.", sourceHash: "hash-valid" },
              { messageId: "msg-stale", quote: "Stale source quote", sourceHash: "hash-stale" },
            ]
          : [{ messageId: "msg-1", quote: "The archive key is kept here." }],
      author: "system" as const,
      provenance,
      manualLock: i === 5 || i === 7,
      revision: i < factStates.length ? factStates[i].revision : 1,
      validFromOrder: `m1|2026-09-${String(10 + Math.floor((FACT_TOTAL - i) / 10)).padStart(2, "0")}T12:00:00.000Z|msg-${String(FACT_TOTAL - i).padStart(4, "0")}`,
      createdAt: now,
      updatedAt: now,
      ...(session === null ? {} : { originChatId: "chat-demo", originSessionNumber: session }),
      coHolders: i === 0 ? [{ entityId: "entity-1", alias: "Location 1", epistemicState: "believes" }] : [],
    };
    return { ...base, ...(factOverrides[base.factId] ?? {}) };
  });
}
const factKindOf = (fact: { predicate: string; value: unknown }) => {
  const kind =
    fact.value && typeof fact.value === "object" && !Array.isArray(fact.value)
      ? (fact.value as { kind?: unknown }).kind
      : undefined;
  return typeof kind === "string" && kind ? kind : fact.predicate.replace(/^continuity\./, "");
};

function detail(id: string, offset: number, params: URLSearchParams = new URLSearchParams()) {
  const target = id === "entity-0" ? "entity-1" : "entity-0";
  const every = allFacts(id);
  const q = (params.get("factQuery") ?? "").toLowerCase();
  const kindFilter = params.get("factKind");
  const sessionFilter = params.get("session");
  const matching = every.filter(
    (fact) =>
      (!q || `${fact.predicate}${JSON.stringify(fact.value)}`.toLowerCase().includes(q)) &&
      (!kindFilter || factKindOf(fact) === kindFilter) &&
      (!sessionFilter || String((fact as { originSessionNumber?: number }).originSessionNumber) === sessionFilter),
  );
  // The mock pages 20 at a time whatever the requested limit, so every list exercises "Load more".
  const facts = matching.slice(offset, offset + 20);
  const sessionTotals = new Map<number | null, number>();
  const kindTotals = new Map<string, number>();
  for (const fact of every) {
    const session = (fact as { originSessionNumber?: number }).originSessionNumber ?? null;
    sessionTotals.set(session, (sessionTotals.get(session) ?? 0) + 1);
    kindTotals.set(factKindOf(fact), (kindTotals.get(factKindOf(fact)) ?? 0) + 1);
  }
  const legacyFacts = new URL(window.location.href).searchParams.get("facts") === "legacy";
  const factMeta = legacyFacts
    ? {}
    : {
        factSessions: [...sessionTotals.entries()]
          .sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : b[0] - a[0]))
          .map(([sessionNumber, total]) => ({ sessionNumber, total })),
        factKinds: [...kindTotals.entries()].sort((a, b) => b[1] - a[1]).map(([kind, total]) => ({ kind, total })),
      };
  const knowledge = [
    {
      knowledgeId: "knowledge-1",
      chatId: "chat-demo",
      holderEntityId: id,
      factId: "fact-0",
      epistemicState: "knows" as const,
      learnedFrom: [{ messageId: "msg-2", quote: "Ariadne told me the key is safe." }],
      confidence: "high" as const,
      provenance,
      manualLock: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
  ];
  const relationships =
    offset === 0
      ? [
          {
            relationshipId: "rel-1",
            chatId: "chat-demo",
            sourceEntityId: id,
            targetEntityId: target,
            type: "allied",
            inverseLabel: "ally",
            status: "active" as const,
            label: "Allied with",
            direction: "outgoing" as const,
            evidence: [{ messageId: "msg-rel", quote: "Ariadne allies with Location 1.", sourceHash: "hash-rel" }],
            provenance,
            manualLock: false,
          },
        ]
      : [];
  const referencedEvents = [
    {
      eventId: "event-1",
      chatId: "chat-demo",
      occurrenceOrder: "12",
      transitions: ["archive opened", "key secured"],
      evidence: [{ messageId: "msg-event", quote: "The archive opened after the eclipse.", sourceHash: "hash-event" }],
    },
    {
      eventId: "event-stale",
      chatId: "chat-demo",
      occurrenceOrder: "13",
      transitions: ["stale cause transition"],
      evidence: [{ messageId: "msg-event-stale", quote: "Old event source", sourceHash: "hash-event-stale" }],
    },
  ];
  const events = offset === 0 ? [referencedEvents[0], referencedEvents[1]] : [];
  return {
    entity: entities.find((item) => item.entityId === id) ?? entities[0],
    facts: emptyPage(facts, matching.length, offset, 20),
    ...factMeta,
    knowledge: emptyPage(knowledge, 1, 0, 20),
    currentState: emptyPage(
      [
        {
          stateId: "state-1",
          chatId: "chat-demo",
          entityId: id,
          property: "status",
          value: "watching the gate",
          sourceEventId: "event-1",
          validAtOrder: "12",
          protected: false,
          provenance,
          manualLock: false,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          stateId: "state-missing",
          chatId: "chat-demo",
          entityId: id,
          property: "missing cause",
          value: "unknown",
          sourceEventId: "event-missing",
          validAtOrder: "13",
          protected: false,
          provenance,
          manualLock: false,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          stateId: "state-stale",
          chatId: "chat-demo",
          entityId: id,
          property: "stale cause",
          value: "legacy",
          sourceEventId: "event-stale",
          validAtOrder: "14",
          protected: false,
          provenance,
          manualLock: false,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      3,
      0,
      20,
    ),
    events: emptyPage(events, events.length, 0, 20),
    relationships: emptyPage(relationships, relationships.length, 0, 20),
    relatedEntities: entities.filter((item) => item.entityId === target),
    referencedFacts: factStates.map((item, index) => ({
      factId: `fact-${index}`,
      predicate: item.predicate,
      value: item.value,
      status: index === 0 ? "verified" : "verified",
    })),
    sourceChecks: {
      "fact-0": { state: "stale" },
      "fact-1": { state: "current" },
      "fact-2": { state: "current" },
      "event-1": { state: "current" },
      "event-stale": { state: "stale" },
      "rel-1": { state: "current" },
    },
    referencedEvents,
  };
}

async function main() {
  await initializeLocalization("en");
  const branchMode = new URL(window.location.href).searchParams.get("branch") ?? "none";
  window.__wikiMock = {
    delayMs: 0,
    failList: 0,
    failDetail: 0,
    failFactPage: 0,
    failCommitments: 0,
    failApplyOnce: false,
    forceConflict: false,
    appliedOperationId: null,
    lastMutation: null,
    mutationIds: [],
    audit: [],
    branchMode,
    chatFailures: branchMode === "error-once" ? 1 : branchMode === "error" ? 999 : 0,
    knowledgeMode: "isolated",
    commitmentRevisions: { "commitment-proposed": 1, "commitment-active": 1, "commitment-completed": 2 },
    commitmentListFetches: 0,
    transitions: [],
    ownerHold: false,
    releaseOwner: () => undefined,
    ownerLinked: {},
    ownerLookups: [],
  };
  const ownerWaiters: Array<() => void> = [];
  window.__wikiMock.releaseOwner = () => {
    window.__wikiMock.ownerHold = false;
    ownerWaiters.splice(0).forEach((resolve) => resolve());
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.url;
    const parsed = new URL(url, window.location.origin);
    const control = window.__wikiMock;
    if (parsed.pathname === "/api/chats/chat-demo/metadata") {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body ?? "{}"));
        if (body.gameNpcKnowledgeMode) control.knowledgeMode = body.gameNpcKnowledgeMode;
      }
      return new Response(JSON.stringify({ id: "chat-demo", gameNpcKnowledgeMode: control.knowledgeMode }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (parsed.pathname === "/api/chats/chat-demo") {
      if (control.chatFailures > 0) {
        control.chatFailures -= 1;
        return new Response(JSON.stringify({ error: "fixture chat failure" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      const held = [
        { recordType: "fact", recordId: "fact-held-1", reason: "Source revision was unavailable" },
        { recordType: "current-state", recordId: "state-held-1", reason: "Cause event was held" },
      ];
      const branch =
        control.branchMode === "held" || control.branchMode === "error-once" || control.branchMode === "error"
          ? {
              sourceChatId: "root-chat",
              operationId: "op-branch-1",
              copied: { entities: 1, facts: 2, knowledge: 1, events: 1, currentState: 1, relationships: 1 },
              held,
            }
          : control.branchMode === "empty"
            ? {
                sourceChatId: "root-chat",
                operationId: "op-branch-empty",
                copied: { entities: 1, facts: 2, knowledge: 1, events: 1, currentState: 1, relationships: 1 },
                held: [],
              }
            : undefined;
      return new Response(
        JSON.stringify({
          id: "chat-demo",
          metadata:
            control.branchMode === "no-metadata"
              ? {}
              : { summary: null, ...(branch ? { campaignMemoryBranch: branch } : {}) },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (parsed.pathname === "/api/characters")
      return new Response(JSON.stringify([{ id: "char-1", name: "Ariadne Character", avatarUrl: null }]), {
        headers: { "Content-Type": "application/json" },
      });
    if (parsed.pathname === "/api/characters/personas/list")
      return new Response(JSON.stringify([{ id: "persona-1", name: "Persona One", avatarUrl: null }]), {
        headers: { "Content-Type": "application/json" },
      });
    const sourceMatch = parsed.pathname.match(/^\/api\/game\/chat-demo\/memory\/sources\/([^/]+)$/);
    if (sourceMatch) {
      if (["hash-stale", "hash-event-stale"].includes(parsed.searchParams.get("sourceHash") ?? ""))
        return new Response(
          JSON.stringify({ error: { code: "CAMPAIGN_MEMORY_SOURCE_STALE", message: "stale source" } }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      return new Response(
        JSON.stringify({
          messageId: sourceMatch[1],
          sourceHash: "hash-valid",
          content: '<script>alert("xss")</script> & matched source text',
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    const mutation = parsed.pathname.match(/^\/api\/game\/chat-demo\/memory\/mutations(?:\/(preview|compensate))?$/);
    const audit = parsed.pathname === "/api/game/chat-demo/memory/audit";
    if (audit)
      return new Response(JSON.stringify({ items: control.audit, total: control.audit.length, offset: 0, limit: 20 }), {
        headers: { "Content-Type": "application/json" },
      });
    if (mutation) {
      console.log("MOCK_MUTATION", mutation[1]);
      const body = JSON.parse(String(init?.body ?? "{}"));
      control.lastMutation = body;
      if (!mutation[1]) control.mutationIds.push(body.operationId);
      if (mutation[1] === "compensate") {
        control.audit.unshift({
          journalId: `journal-${Date.now()}`,
          operationId: body.operationId,
          originalOperationId: body.originalOperationId,
          recordType: "fact",
          reason: body.reason,
        });
        return new Response(JSON.stringify(control.audit[0]), { headers: { "Content-Type": "application/json" } });
      }
      if (!mutation[1] && control.failApplyOnce) {
        control.failApplyOnce = false;
        throw new TypeError("simulated network failure");
      }
      if (!mutation[1] && control.forceConflict)
        return new Response(
          JSON.stringify({ error: { code: "CAMPAIGN_MEMORY_CAS_MISMATCH", message: "stale revision" } }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      const patch = body.patch ?? {};
      if (mutation[1] === "preview") {
        const previewFact = factStates.find((item, index) => `fact-${index}` === body.recordId) ?? factStates[0];
        const payload = {
          validated: true,
          persisted: false,
          recordType: body.recordType,
          action: body.action,
          before:
            body.recordType === "fact"
              ? { value: previewFact.value, conditions: previewFact.conditions, revision: previewFact.revision }
              : { manualLock: entity0.manualLock },
          after: patch,
          diff: patch,
        };
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => {
            console.log("MOCK_PREVIEW_JSON");
            return payload;
          },
        } as unknown as Response;
      }
      control.appliedOperationId = body.operationId;
      if (body.recordType === "entity") Object.assign(entity0, patch, { revision: entity0.revision + 1 });
      if (body.recordType === "fact" && ("status" in patch || "manualLock" in patch)) {
        const current = factOverrides[body.recordId] ?? {};
        factOverrides[body.recordId] = {
          ...current,
          ...("status" in patch ? { status: patch.status } : {}),
          ...("manualLock" in patch ? { manualLock: patch.manualLock } : {}),
          ...("value" in patch && !/^fact-[012]$/.test(body.recordId) ? { value: patch.value } : {}),
          revision: Number(current.revision ?? 1) + 1,
        };
      }
      if (body.recordType === "fact" && /^fact-[012]$/.test(String(body.recordId))) {
        const state =
          factStates.find(
            (item) =>
              item.predicate ===
              detail("entity-0", 0).facts.items.find((fact) => fact.factId === body.recordId)?.predicate,
          ) ?? factStates[0];
        if ("value" in patch) state.value = patch.value;
        if ("conditions" in patch) state.conditions = patch.conditions;
        state.revision += 1;
      }
      const journal = {
        journalId: `journal-${Date.now()}`,
        operationId: body.operationId,
        originalOperationId: body.operationId,
        recordType: body.recordType,
        reason: body.reason,
      };
      control.audit.unshift(journal);
      return new Response(JSON.stringify(journal), { headers: { "Content-Type": "application/json" } });
    }
    if (parsed.pathname === "/api/game/chat-demo/memory/timeline") {
      // Shape per the Pulses 6-8 wiki read-API contract, item 3 (sorted by occurrenceOrder).
      const timelineItems = [
        {
          eventId: "event-1",
          occurrenceOrder: "12",
          campaignTime: "Day 3, dusk",
          location: { entityId: "entity-1", alias: "Location 1" },
          participants: [{ entityId: "entity-0", alias: "Ariadne Vale" }],
          summary: "archive opened · key secured",
          stateChanges: [{ entityId: "entity-0", key: "status", value: "watching the gate" }],
          sourceMessageId: "msg-event",
        },
        {
          eventId: "event-stale",
          occurrenceOrder: "13",
          campaignTime: null,
          location: null,
          participants: [{ entityId: "entity-0", alias: "Ariadne Vale" }],
          summary: "stale cause transition",
          stateChanges: [],
          sourceMessageId: "msg-event-stale",
        },
      ];
      const entityFilter = parsed.searchParams.get("entityId");
      const items = entityFilter
        ? timelineItems.filter((item) => item.participants.some((p) => p.entityId === entityFilter))
        : timelineItems;
      return new Response(JSON.stringify({ items, nextCursor: null }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const transitionMatch = parsed.pathname.match(/^\/api\/game\/chat-demo\/memory\/commitments\/([^/]+)\/transition$/);
    if (transitionMatch && init?.method === "POST") {
      // Compare-and-set like the server: a stale expectedRevision answers 409.
      const body = JSON.parse(String(init.body ?? "{}"));
      const commitmentId = decodeURIComponent(transitionMatch[1]);
      const current = control.commitmentRevisions[commitmentId] ?? 1;
      const status = body.expectedRevision === current ? 200 : 409;
      control.transitions.push({ commitmentId, body, status });
      if (status === 409)
        return new Response(
          JSON.stringify({ error: { code: "CAMPAIGN_MEMORY_CAS_MISMATCH", message: "stale revision" } }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      control.commitmentRevisions[commitmentId] = current + 1;
      return new Response(JSON.stringify({ commitmentId, state: body.state, revision: current + 1 }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (parsed.pathname === "/api/game/chat-demo/memory/commitments") {
      control.commitmentListFetches += 1;
      if (control.failCommitments > 0) {
        control.failCommitments -= 1;
        return new Response(JSON.stringify({ error: "fixture commitments failure" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      const pageTwo = parsed.searchParams.get("cursor") === "commitments-page-2";
      const items = pageTwo
        ? [
            {
              commitmentId: "commitment-completed",
              subjectEntityId: "entity-0",
              kind: "quest",
              title: "Archive key recovered",
              state: "completed",
              conditions: [],
              deadline: null,
              notes: "The key reached the northern archive.",
              participants: [{ entityId: "entity-0", alias: "Ariadne Vale", role: "holder" }],
              evidence: [
                {
                  messageId: "msg-commitment-2",
                  quote: "The archive key is secured.",
                  sourceHash: "hash-commitment-2",
                },
              ],
              transitions: [
                {
                  factId: "fact-commitment-2",
                  state: "completed",
                  sourceOrder: "14",
                  evidenceMessageIds: ["msg-commitment-2"],
                },
              ],
              historical: false,
              openSince: null,
              revision: control.commitmentRevisions["commitment-completed"],
            },
          ]
        : [
            {
              commitmentId: "commitment-proposed",
              subjectEntityId: "entity-0",
              kind: "quest",
              title: "Recover the archive key",
              state: "proposed",
              conditions: ["After the eclipse"],
              deadline: "Day 5",
              notes: "Bring the key back intact.",
              participants: [{ entityId: "entity-0", alias: "Ariadne Vale", role: "quest giver" }],
              evidence: [
                { messageId: "msg-commitment-1", quote: "Recover the archive key.", sourceHash: "hash-commitment-1" },
              ],
              transitions: [
                {
                  factId: "fact-commitment-1",
                  state: "proposed",
                  sourceOrder: "12",
                  evidenceMessageIds: ["msg-commitment-1"],
                },
              ],
              historical: false,
              openSince: "12",
              revision: control.commitmentRevisions["commitment-proposed"],
            },
            {
              commitmentId: "commitment-active",
              subjectEntityId: "entity-0",
              kind: "promise",
              title: "Keep the archive watch",
              state: "active",
              conditions: [],
              deadline: null,
              notes: "The watch remains active.",
              participants: [{ entityId: "entity-0", alias: "Ariadne Vale", role: "watcher" }],
              evidence: [
                { messageId: "msg-commitment-1", quote: "I will keep watch.", sourceHash: "hash-commitment-1" },
              ],
              transitions: [
                {
                  factId: "fact-commitment-active",
                  state: "active",
                  sourceOrder: "13",
                  evidenceMessageIds: ["msg-commitment-1"],
                },
              ],
              historical: false,
              openSince: "13",
              revision: control.commitmentRevisions["commitment-active"],
            },
          ];
      return new Response(JSON.stringify({ items, nextCursor: pageTwo ? null : "commitments-page-2" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const match = parsed.pathname.match(/^\/api\/game\/chat-demo\/memory\/entities(?:\/([^/]+))?$/);
    if (!match) return originalFetch(input, init);
    const isDetail = Boolean(match[1]);
    if (control.delayMs) await new Promise((resolve) => setTimeout(resolve, control.delayMs));
    if (isDetail && control.failDetail > 0) {
      control.failDetail -= 1;
      return new Response(JSON.stringify({ error: "fixture detail failure" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!isDetail && control.failList > 0) {
      control.failList -= 1;
      return new Response(JSON.stringify({ error: "fixture list failure" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    const ownerRef = parsed.searchParams.get("owner");
    if (!isDetail && ownerRef) {
      // Owner lookup for the create form; ownerHold keeps it in flight until releaseOwner().
      control.ownerLookups.push(ownerRef);
      if (control.ownerHold) await new Promise<void>((resolve) => ownerWaiters.push(resolve));
      const linkedName = control.ownerLinked[ownerRef];
      const items = linkedName
        ? [{ ...entity("entity-owned", 2), entityId: "entity-owned", aliases: [linkedName] }]
        : [];
      return new Response(JSON.stringify({ items, total: items.length, offset: 0, limit: 5 }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (isDetail && control.failFactPage > 0 && Number(parsed.searchParams.get("offset") ?? 0) > 0) {
      control.failFactPage -= 1;
      return new Response(JSON.stringify({ error: "fixture fact page failure" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (isDetail)
      return new Response(
        JSON.stringify(detail(match[1], Number(parsed.searchParams.get("offset") ?? 0), parsed.searchParams)),
        { headers: { "Content-Type": "application/json" } },
      );
    const q = (parsed.searchParams.get("q") ?? "").toLowerCase();
    const kind = parsed.searchParams.get("kind");
    const offset = Number(parsed.searchParams.get("offset") ?? 0);
    const filtered = entities.filter(
      (item) => (!q || item.aliases.some((alias) => alias.toLowerCase().includes(q))) && (!kind || item.kind === kind),
    );
    return new Response(
      JSON.stringify({ items: filtered.slice(offset, offset + 20), total: filtered.length, offset, limit: 20 }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.__queryClient = queryClient;
  const surface = new URL(window.location.href).searchParams.get("surface");
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      {surface === "inventory" ? (
        <InventoryHarness />
      ) : surface === "settings" ? (
        <SettingsHarness />
      ) : surface === "window" ? (
        <CampaignWikiWindow chatId="chat-demo" onClose={() => undefined} />
      ) : (
        <CampaignWiki chatId="chat-demo" />
      )}
    </QueryClientProvider>,
  );
  window.__ownerStores = {
    game: () => {
      const state = useGameModeStore.getState() as any;
      return { characterSheetOpen: state.characterSheetOpen, characterSheetCharId: state.characterSheetCharId };
    },
    ui: () => {
      const state = useUIStore.getState() as any;
      return { personaDetailId: state.personaDetailId };
    },
  };
}
void main();
