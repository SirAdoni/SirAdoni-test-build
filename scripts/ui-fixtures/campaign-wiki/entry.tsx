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
import { useChatStore } from "../../../packages/client/src/stores/chat.store";

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
  loreFetches: string[];
  /** The next memory write (preview or apply) answers 409 CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE. */
  crossSessionOnce: boolean;
  /** The next commitment transition answers 409 CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE. */
  crossSessionTransition: boolean;
  /** Query strings of every timeline request, in order. */
  timelineRequests: string[];
  /** Duplicate review: every resolve request ({ chatId, groupId, body, status }). */
  reviewResolves: Array<{ chatId: string; groupId: string; body: any; status: number }>;
  /** The next duplicate resolve answers 409 CAMPAIGN_MEMORY_CAS_MISMATCH. */
  reviewConflictOnce: boolean;
  /** The next duplicate resolve answers 409 CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE. */
  reviewCrossSessionOnce: boolean;
  /** Chat ids of every duplicates list request. */
  reviewListChats: string[];
  /** Fact writes sent to another session chat ({ chatId, body }). */
  sessionMutations: Array<{ chatId: string; body: any }>;
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
        : index === 3 || index === 6
          ? { type: "existing" as const, store: "characters", recordId: `char-${index}` }
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
// ?dupes=1: three imported lore pages share one title, and Ariadne has several relationships to one page.
const DUPES = new URL(window.location.href).searchParams.get("dupes") === "1";
if (DUPES)
  for (const index of [0, 1, 2])
    entities.push({
      ...entity(`entity-lore-${index}`, 2),
      kind: "lore",
      aliases: ["Game continuity 8"],
      summary: `Imported continuity entry ${index}.`,
    });
// ?lore=1: lore pages owned by lorebook entries (one in the chat's active lorebook, one in an earlier session's
// chat-scoped lorebook, one whose entry is gone) and one page owned by a whole lorebook.
const LORE = new URL(window.location.href).searchParams.get("lore") === "1";
if (LORE)
  (
    [
      ["entity-lore-near", "Fixture Lore Near", "lorebook-entries", "entry-near"],
      ["entity-lore-far", "Fixture Lore Far", "lorebook-entries", "entry-far"],
      ["entity-lore-gone", "Fixture Lore Gone", "lorebook-entries", "entry-gone"],
      ["entity-lore-book", "Fixture Lore Book", "lorebooks", "book-active"],
    ] as const
  ).forEach(([entityId, alias, store, recordId]) =>
    entities.push({
      ...entity(entityId, 2),
      entityId,
      kind: "lore",
      owner: { type: "existing" as const, store, recordId } as any,
      aliases: [alias],
      summary: `${alias} fixture page.`,
    }),
  );
const loreBooks = [
  { id: "book-active", name: "Fixture Active Book", chatId: null, hiddenFromLibrary: false },
  { id: "book-older", name: "Fixture Session Book", chatId: "chat-session-1", hiddenFromLibrary: true },
];
const loreEntries: Record<string, Array<{ id: string; lorebookId: string; name: string }>> = {
  "book-active": [{ id: "entry-near", lorebookId: "book-active", name: "Near Entry" }],
  "book-older": [{ id: "entry-far", lorebookId: "book-older", name: "Far Entry" }],
};
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

// ?review=none: no duplicate groups; ?review=legacy: an older server without review, facts or references routes.
const REVIEW_MODE = new URL(window.location.href).searchParams.get("review") ?? "groups";
type DuplicateFixture = {
  chatId: string;
  groupId: string;
  subjectEntityId: string;
  predicate: string;
  reason: "overlapping-evidence" | "similar-text";
  similarity: number | null;
  facts: Array<{ factId: string; value: unknown; evidence: string[]; order: string; pinned?: boolean }>;
};
const duplicateGroups: DuplicateFixture[] =
  REVIEW_MODE === "groups"
    ? [
        {
          chatId: "chat-demo",
          groupId: "dup-gate",
          subjectEntityId: "entity-0",
          predicate: "continuity.record",
          reason: "overlapping-evidence",
          similarity: 0.71,
          facts: [
            {
              factId: "fact-dup-gate-1",
              value: { text: "Ariadne swore to guard the northern gate until the thaw.", kind: "commitment" },
              evidence: ["msg-gate"],
              order: "m1|2026-09-11T12:00:00.000Z|msg-gate",
            },
            {
              factId: "fact-dup-gate-2",
              value: {
                text: "Ariadne swore an oath to keep the northern gate closed until the thaw comes.",
                kind: "commitment",
              },
              evidence: ["msg-gate", "msg-gate-2", "msg-gate-3"],
              order: "m1|2026-09-12T12:00:00.000Z|msg-gate-2",
            },
          ],
        },
        {
          chatId: "chat-demo",
          groupId: "dup-occupation",
          subjectEntityId: "entity-3",
          predicate: "occupation",
          reason: "similar-text",
          similarity: 1,
          facts: [
            {
              factId: "fact-dup-occ-1",
              value: "Archivist of the north",
              evidence: ["msg-occ"],
              order: "m1|2026-09-10T12:00:00.000Z|msg-occ",
            },
            {
              factId: "fact-dup-occ-2",
              value: "archivist of the north",
              evidence: ["msg-occ-2"],
              order: "m1|2026-09-12T12:00:00.000Z|msg-occ-2",
              pinned: true,
            },
          ],
        },
        {
          chatId: "chat-session-1",
          groupId: "dup-ferry",
          subjectEntityId: "entity-1",
          predicate: "continuity.record",
          reason: "similar-text",
          similarity: 0.86,
          facts: [
            {
              factId: "fact-dup-ferry-1",
              value: { text: "The ferry at Location 1 only runs at dawn.", kind: "rule" },
              evidence: ["msg-ferry"],
              order: "m1|2026-09-01T12:00:00.000Z|msg-ferry",
            },
            {
              factId: "fact-dup-ferry-2",
              value: { text: "The ferry at Location 1 runs only at dawn.", kind: "rule" },
              evidence: ["msg-ferry-2"],
              order: "m1|2026-09-02T12:00:00.000Z|msg-ferry-2",
            },
            {
              factId: "fact-dup-ferry-3",
              value: { text: "The Location 1 ferry only runs at dawn.", kind: "rule" },
              evidence: ["msg-ferry-3"],
              order: "m1|2026-09-03T12:00:00.000Z|msg-ferry-3",
            },
          ],
        },
      ]
    : [];
const duplicateRevisions: Record<string, number> = {};
for (const group of duplicateGroups) for (const fact of group.facts) duplicateRevisions[fact.factId] = 2;
function duplicateRecord(group: DuplicateFixture, fact: DuplicateFixture["facts"][number]) {
  const value =
    fact.pinned && typeof fact.value === "object" ? { ...(fact.value as object), pinned: true } : fact.value;
  return {
    factId: fact.factId,
    chatId: group.chatId,
    subjectEntityId: group.subjectEntityId,
    predicate: group.predicate,
    value: fact.pinned && typeof fact.value === "string" ? { text: fact.value, pinned: true } : value,
    conditions: [],
    status: "verified",
    sourceRevision: "rev-3",
    evidence: fact.evidence.map((messageId) => ({ messageId, quote: "Quoted line." })),
    author: "system",
    provenance,
    manualLock: Boolean(fact.pinned),
    revision: duplicateRevisions[fact.factId],
    validFromOrder: fact.order,
    createdAt: now,
    updatedAt: now,
  };
}
function duplicateView(group: DuplicateFixture) {
  return {
    groupId: group.groupId,
    subjectEntityId: group.subjectEntityId,
    predicate: group.predicate,
    reason: group.reason,
    similarity: group.similarity,
    facts: group.facts.map((fact) => ({
      factId: fact.factId,
      receiptId: null,
      status: "verified",
      text:
        fact.value && typeof fact.value === "object" && typeof (fact.value as { text?: unknown }).text === "string"
          ? (fact.value as { text: string }).text
          : JSON.stringify(fact.value),
      evidenceMessageIds: fact.evidence,
      sourceOrder: fact.order,
      historical: false,
    })),
  };
}
// Pinned canon recorded in session 1 about Location 1; unpinning writes to chat-session-1.
const sessionOnePinned: Record<string, Record<string, unknown>> = {
  "fact-canon-ferry": {
    factId: "fact-canon-ferry",
    chatId: "chat-session-1",
    subjectEntityId: "entity-1",
    predicate: "continuity.record",
    value: { text: "The ferryman never crosses after dark.", kind: "rule", pinned: true },
    conditions: [],
    status: "verified",
    sourceRevision: "rev-1",
    evidence: [{ messageId: "msg-canon-ferry", quote: "He never crosses after dark." }],
    author: "user",
    provenance,
    manualLock: true,
    revision: 3,
    validFromOrder: "m1|2026-09-02T12:00:00.000Z|msg-canon-ferry",
    createdAt: now,
    updatedAt: now,
    originChatId: "chat-session-1",
    originSessionNumber: 1,
  },
  "fact-canon-toll": {
    factId: "fact-canon-toll",
    chatId: "chat-session-1",
    subjectEntityId: "entity-1",
    predicate: "continuity.record",
    value: {
      text: "The crossing toll is one silver coin, paid in advance.",
      kind: "rule",
      pinned: true,
      lockedBeforePin: true,
    },
    conditions: [],
    status: "verified",
    sourceRevision: "rev-1",
    evidence: [{ messageId: "msg-canon-toll", quote: "One silver, before you step aboard." }],
    author: "user",
    provenance,
    manualLock: true,
    revision: 1,
    validFromOrder: "m1|2026-09-01T12:00:00.000Z|msg-canon-toll",
    createdAt: now,
    updatedAt: now,
    originChatId: "chat-session-1",
    originSessionNumber: 1,
  },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const missingRoute = (pathname: string) =>
  json({ message: `Route GET:${pathname} not found`, error: "Not Found", statusCode: 404 }, 404);

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
          ...(DUPES
            ? [
                { label: "Trusts", type: "trusts", status: "active" as const, direction: "outgoing" as const },
                { label: "allied with", type: "allied", status: "active" as const, direction: "incoming" as const },
                { label: "Owes", type: "owes", status: "proposed" as const, direction: "outgoing" as const },
              ].map((extra, index) => ({
                relationshipId: `rel-extra-${index}`,
                chatId: "chat-demo",
                sourceEntityId: extra.direction === "outgoing" ? id : target,
                targetEntityId: extra.direction === "outgoing" ? target : id,
                type: extra.type,
                inverseLabel: extra.type,
                status: extra.status,
                label: extra.label,
                direction: extra.direction,
                evidence: [{ messageId: "msg-rel", quote: "Ariadne allies with Location 1.", sourceHash: "hash-rel" }],
                provenance,
                manualLock: false,
              }))
            : []),
        ]
      : [];
  const referencedEvents = [
    {
      eventId: "event-1",
      chatId: "chat-demo",
      occurrenceOrder: "12",
      participantEntityIds: [id, "entity-3", "entity-2"],
      locationEntityId: "entity-1",
      transitions: ["archive opened", "key secured"],
      evidence: [{ messageId: "msg-event", quote: "The archive opened after the eclipse.", sourceHash: "hash-event" }],
    },
    {
      eventId: "event-stale",
      chatId: "chat-demo",
      occurrenceOrder: "13",
      participantEntityIds: [id, "entity-3"],
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
    relatedEntities: entities.filter(
      (item) => [target, "entity-1", "entity-2", "entity-3"].includes(item.entityId) && item.entityId !== id,
    ),
    referencedFacts: [
      ...factStates.map((item, index) => ({
        factId: `fact-${index}`,
        predicate: item.predicate,
        value: item.value,
        status: index === 0 ? "verified" : "verified",
      })),
      // Recorded in session 1 only: knowledge written to chat-demo that cites it is refused as cross-session.
      {
        factId: "fact-other-session",
        predicate: "met the ferryman",
        value: "Ariadne met the ferryman at the old crossing.",
        status: "verified",
        originChatId: "chat-session-1",
        originSessionNumber: 1,
      },
    ],
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
    loreFetches: [],
    crossSessionOnce: false,
    crossSessionTransition: false,
    timelineRequests: [],
    reviewResolves: [],
    reviewConflictOnce: false,
    reviewCrossSessionOnce: false,
    reviewListChats: [],
    sessionMutations: [],
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
          // Session chats are named "<campaign> — Session N"; the wiki front page shows the campaign name.
          name: "Fixture Campaign — Session 3",
          mode: "game",
          groupId: "group-fixture",
          metadata:
            control.branchMode === "no-metadata"
              ? {}
              : {
                  summary: null,
                  gameSessionNumber: 3,
                  ...(branch ? { campaignMemoryBranch: branch } : {}),
                  ...(LORE ? { activeLorebookIds: ["book-active", "book-deleted"] } : {}),
                },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (parsed.pathname === "/api/chats") {
      // The game group: sessions 1-3 (this chat is 3), a branch of session 2 and a later session 4 (both skipped).
      const session = (id: string, number: number, extra: Record<string, unknown> = {}) => ({
        id,
        name: `Fixture Campaign — Session ${number}`,
        mode: "game",
        groupId: "group-fixture",
        createdAt: now,
        updatedAt: now,
        metadata: { gameSessionNumber: number, ...extra },
      });
      return json([
        session("chat-demo", 3),
        session("chat-session-2", 2),
        session("chat-session-2-branch", 2, { branchName: "What if" }),
        session("chat-session-1", 1),
        session("chat-session-4", 4),
        {
          id: "chat-other",
          name: "Other chat",
          mode: "roleplay",
          groupId: null,
          createdAt: now,
          updatedAt: now,
          metadata: {},
        },
      ]);
    }
    const reviewList = parsed.pathname.match(/^\/api\/game\/([^/]+)\/memory\/review\/duplicates$/);
    if (reviewList) {
      control.reviewListChats.push(reviewList[1]);
      if (REVIEW_MODE === "legacy") return missingRoute(parsed.pathname);
      const groups = duplicateGroups.filter((group) => group.chatId === reviewList[1]).map(duplicateView);
      return json({ groups, nextCursor: null });
    }
    const reviewResolve = parsed.pathname.match(/^\/api\/game\/([^/]+)\/memory\/review\/duplicates\/([^/]+)\/resolve$/);
    if (reviewResolve && init?.method === "POST") {
      const [, resolveChatId, rawGroupId] = reviewResolve;
      const groupId = decodeURIComponent(rawGroupId);
      const body = JSON.parse(String(init.body ?? "{}"));
      const index = duplicateGroups.findIndex((group) => group.chatId === resolveChatId && group.groupId === groupId);
      const refuse = (status: number, code: string, message: string) => {
        control.reviewResolves.push({ chatId: resolveChatId, groupId, body, status });
        return json({ error: { code, message } }, status);
      };
      if (control.reviewCrossSessionOnce) {
        control.reviewCrossSessionOnce = false;
        return refuse(
          409,
          "CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE",
          "Location 1 has no page in that session yet. Add it there first.",
        );
      }
      if (control.reviewConflictOnce) {
        control.reviewConflictOnce = false;
        for (const factId of Object.keys(body.expectedRevisions ?? {})) duplicateRevisions[factId] += 1;
        return refuse(409, "CAMPAIGN_MEMORY_CAS_MISMATCH", "stale revision");
      }
      if (index < 0) return refuse(404, "CAMPAIGN_MEMORY_NOT_FOUND", "Campaign memory fact not found");
      const stale = Object.entries(body.expectedRevisions ?? {}).some(
        ([factId, revision]) => duplicateRevisions[factId] !== revision,
      );
      if (stale) return refuse(409, "CAMPAIGN_MEMORY_CAS_MISMATCH", "stale revision");
      duplicateGroups.splice(index, 1);
      control.reviewResolves.push({ chatId: resolveChatId, groupId, body, status: 200 });
      return json({
        groupId,
        keepFactId: body.keepFactId,
        retiredFactIds: body.retireFactIds,
        linkedFactId: body.retireFactIds[0] ?? null,
      });
    }
    const sectionFacts = parsed.pathname.match(/^\/api\/game\/([^/]+)\/memory\/entities\/([^/]+)\/facts$/);
    if (sectionFacts && parsed.searchParams.get("scope") === "session") {
      const records = duplicateGroups
        .filter((group) => group.chatId === sectionFacts[1] && group.subjectEntityId === sectionFacts[2])
        .flatMap((group) => group.facts.map((fact) => duplicateRecord(group, fact)));
      return json(emptyPage(records, records.length, 0, 100));
    }
    const references = parsed.pathname.match(/^\/api\/game\/chat-demo\/memory\/entities\/([^/]+)\/references$/);
    if (references) {
      if (REVIEW_MODE === "legacy") return missingRoute(parsed.pathname);
      return json({
        facts: FACT_TOTAL,
        knowledge: 3,
        events: 12,
        relationships: DUPES ? 4 : 1,
        states: 3,
        samples: {
          facts: ["fact-0"],
          knowledge: ["knowledge-1"],
          events: ["event-1"],
          relationships: ["rel-1"],
          states: ["state-1"],
        },
      });
    }
    if (parsed.pathname === "/api/game/chat-demo/memory/facts") {
      if (REVIEW_MODE === "legacy") return missingRoute(parsed.pathname);
      const isPinned = (fact: any) =>
        fact.manualLock &&
        fact.status !== "retracted" &&
        fact.value &&
        typeof fact.value === "object" &&
        fact.value.pinned === true;
      const subjectOf = (entityId: string) => {
        const found = entities.find((item) => item.entityId === entityId);
        return { entityId, alias: found?.aliases[0] ?? entityId };
      };
      const q = (parsed.searchParams.get("q") ?? "").toLowerCase();
      const all = [...allFacts("entity-0"), ...Object.values(sessionOnePinned)]
        .filter((fact) => parsed.searchParams.get("pinned") !== "true" || isPinned(fact))
        .filter((fact: any) => !q || `${fact.predicate} ${JSON.stringify(fact.value)}`.toLowerCase().includes(q))
        .map((fact: any) => ({ ...fact, subject: subjectOf(fact.subjectEntityId) }));
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 50);
      return json(emptyPage(all.slice(offset, offset + limit), all.length, offset, limit));
    }
    const sessionMutation = parsed.pathname.match(/^\/api\/game\/(chat-session-\d)\/memory\/mutations$/);
    if (sessionMutation && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      control.sessionMutations.push({ chatId: sessionMutation[1], body });
      const record = sessionOnePinned[body.recordId];
      if (!record) return json({ error: { code: "CAMPAIGN_MEMORY_NOT_FOUND", message: "not found" } }, 404);
      if (body.expectedRevision !== record.revision)
        return json({ error: { code: "CAMPAIGN_MEMORY_CAS_MISMATCH", message: "stale revision" } }, 409);
      Object.assign(record, body.patch ?? {}, { revision: Number(record.revision) + 1 });
      return json(record);
    }
    if (parsed.pathname === "/api/characters")
      // char-3 has a slow portrait (initials until it loads), char-6 a missing one (falls back to initials).
      return new Response(
        JSON.stringify([
          { id: "char-1", name: "Ariadne Character", avatarUrl: null },
          { id: "char-3", name: "Character Three", avatarUrl: null, avatarPath: "/fixture-portrait-slow.svg" },
          { id: "char-6", name: "Character Six", avatarUrl: null, avatarPath: "/fixture-portrait-missing.png" },
        ]),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
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
      const crossSessionRefusal = (message: string) =>
        new Response(JSON.stringify({ error: { code: "CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE", message } }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      // Like the server: knowledge in chat-demo cannot cite a fact that exists only in another session.
      if (body.recordType === "knowledge" && body.input?.factId === "fact-other-session")
        return crossSessionRefusal(
          "That fact belongs to another session and has no copy in this one, so this record cannot be written here. Write it in the session the fact comes from.",
        );
      if (control.crossSessionOnce) {
        control.crossSessionOnce = false;
        return crossSessionRefusal(
          "Mira Stonebridge has no page in that session yet, so this record cannot be written there. Add Mira Stonebridge to that session first.",
        );
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
          summary: "The archive opened after the eclipse and Ariadne secured the key.",
          originChatId: "chat-demo",
          originSessionNumber: 2,
          stateChanges: [{ entityId: "entity-0", key: "status", value: "watching the gate" }],
          sourceMessageId: "msg-event",
        },
        {
          eventId: "event-stale",
          occurrenceOrder: "13",
          campaignTime: null,
          location: null,
          participants: [{ entityId: "entity-0", alias: "Ariadne Vale" }],
          summary: "Ariadne kept watch at the gate while the old records were checked.",
          originChatId: "chat-demo",
          originSessionNumber: 3,
          stateChanges: [],
          sourceMessageId: "msg-event-stale",
        },
      ];
      control.timelineRequests.push(parsed.search);
      const entityFilter = parsed.searchParams.get("entityId");
      const filtered = entityFilter
        ? timelineItems.filter((item) => item.participants.some((p) => p.entityId === entityFilter))
        : timelineItems;
      // order=desc pages newest first; the cursor follows the same direction.
      const ordered = parsed.searchParams.get("order") === "desc" ? [...filtered].reverse() : filtered;
      const cursor = parsed.searchParams.get("cursor");
      const start = cursor ? ordered.findIndex((item) => item.eventId === cursor) + 1 : 0;
      const limit = Number(parsed.searchParams.get("limit") ?? 50);
      const items = ordered.slice(start, start + limit);
      const nextCursor = start + limit < ordered.length ? (items.at(-1)?.eventId ?? null) : null;
      return new Response(JSON.stringify({ items, nextCursor }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const transitionMatch = parsed.pathname.match(/^\/api\/game\/chat-demo\/memory\/commitments\/([^/]+)\/transition$/);
    if (transitionMatch && init?.method === "POST") {
      // Compare-and-set like the server: a stale expectedRevision answers 409.
      const body = JSON.parse(String(init.body ?? "{}"));
      const commitmentId = decodeURIComponent(transitionMatch[1]);
      const current = control.commitmentRevisions[commitmentId] ?? 1;
      if (control.crossSessionTransition) {
        control.crossSessionTransition = false;
        control.transitions.push({ commitmentId, body, status: 409 });
        return new Response(
          JSON.stringify({
            error: {
              code: "CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE",
              message:
                "Mira Stonebridge has no page in that session yet, so this record cannot be written there. Add Mira Stonebridge to that session first.",
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
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
    if (LORE && parsed.pathname === "/api/lorebooks") {
      control.loreFetches.push(parsed.pathname);
      return new Response(JSON.stringify(loreBooks), { headers: { "Content-Type": "application/json" } });
    }
    const loreEntriesMatch = parsed.pathname.match(/^\/api\/lorebooks\/([^/]+)\/entries$/);
    if (LORE && loreEntriesMatch) {
      control.loreFetches.push(parsed.pathname);
      const rows = loreEntries[loreEntriesMatch[1]];
      return rows
        ? new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ error: "not found" }), { status: 404 });
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
    // Like the server: pages of at most `limit` (this mock caps at 20), kindTotals before the kind filter,
    // sort=kind orders by kind then name.
    const limit = Math.min(Number(parsed.searchParams.get("limit") ?? 20) || 20, 20);
    const kindOrder = ["character", "persona", "location", "organization", "item", "quest", "lore", "note"];
    const kindTotals = Object.fromEntries(kindOrder.map((value) => [value, 0])) as Record<string, number>;
    for (const item of entities) kindTotals[item.kind] += 1;
    const filtered = entities.filter(
      (item) => (!q || item.aliases.some((alias) => alias.toLowerCase().includes(q))) && (!kind || item.kind === kind),
    );
    if (parsed.searchParams.get("sort") === "kind")
      filtered.sort((left, right) => kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind));
    const legacyList = new URL(window.location.href).searchParams.get("list") === "legacy";
    return new Response(
      JSON.stringify({
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
        ...(legacyList ? {} : { kindTotals }),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  // The wiki's owner link falls back to the active chat for its lorebook lookup, as it does inside a game.
  if (LORE) useChatStore.setState({ activeChatId: "chat-demo" });
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
      return {
        personaDetailId: state.personaDetailId,
        lorebookDetailId: state.lorebookDetailId,
        lorebookDetailInitialTab: state.lorebookDetailInitialTab,
      };
    },
  };
}
void main();
