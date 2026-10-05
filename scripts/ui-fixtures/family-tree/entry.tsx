import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FamilyTreeData } from "@marinara-engine/shared";
import { FamilyTreeAction } from "../../../packages/client/src/components/game/FamilyTreeAction";
import { ModalRenderer } from "../../../packages/client/src/components/layout/ModalRenderer";
import { initializeLocalization } from "../../../packages/client/src/localization/i18n";
import { useUIStore } from "../../../packages/client/src/stores/ui.store";
import "./fixture.css";

const image =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#685289"/><circle cx="40" cy="27" r="15" fill="#eee"/><path d="M12 80V63a28 28 0 0 1 56 0v17" fill="#eee"/></svg>',
  );
const graph: FamilyTreeData = {
  people: [
    {
      id: '["characters","a"]',
      name: "Robin",
      owner: { type: "existing", store: "characters", recordId: "a" },
      entityId: "ea",
      chatId: "s2",
      sessionNumber: 2,
      tags: ["House Rowan"],
      available: true,
      avatarUrl: image,
    },
    {
      id: '["characters","b"]',
      name: "Robin",
      owner: { type: "existing", store: "characters", recordId: "b" },
      entityId: "eb",
      chatId: "s2",
      sessionNumber: 2,
      tags: ["House Rowan"],
      available: true,
      avatarUrl: image,
    },
    {
      id: '["characters","c"]',
      name: "Tess",
      owner: { type: "existing", store: "characters", recordId: "c" },
      entityId: "ec",
      chatId: "s2",
      sessionNumber: 2,
      tags: ["House Rowan"],
      available: true,
      avatarUrl: image,
    },
    {
      id: '["entity","wiki-person"]',
      name: "Morgan",
      owner: { type: "registry", store: "campaign-memory", recordId: "wiki-person" },
      entityId: "wiki-person",
      chatId: "s2",
      sessionNumber: 2,
      tags: ["House Vale"],
      available: true,
    },
  ],
  links: [
    {
      id: "parent",
      chatId: "s2",
      sessionNumber: 2,
      revision: 1,
      recordType: "fact",
      sourceId: '["characters","a"]',
      targetId: '["characters","b"]',
      kind: "parent",
      note: "",
      confirmed: true,
    },
    {
      id: "suggestion",
      chatId: "s2",
      sessionNumber: 2,
      revision: 1,
      recordType: "relationship",
      sourceId: '["characters","a"]',
      targetId: '["characters","c"]',
      kind: "sibling",
      note: "",
      confirmed: false,
    },
    {
      id: "unknown-parent",
      chatId: "s2",
      sessionNumber: 2,
      revision: 1,
      recordType: "fact",
      sourceId: '["characters","a"]',
      targetId: null,
      kind: "parent",
      note: "Parentage recorded; identity unknown.",
      confirmed: true,
    },
  ],
};
const controls = {
  failSave: false,
  writes: [] as any[],
  profile: () => useUIStore.getState().characterDetailId,
  ownerQueries: [] as string[],
  requests: [] as string[],
};
(window as any).__family = controls;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
  controls.requests.push(url);
  const respond = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (url.includes("/api/game/s2/memory/entities")) {
    const request = new URL(url, location.origin);
    const entity = {
      entityId: "wiki-person",
      chatId: "s2",
      kind: "character",
      owner: { type: "registry", store: "campaign-memory", recordId: "wiki-person" },
      aliases: ["Morgan"],
      tags: ["House Vale"],
      summary: "Fixture wiki person",
      attributes: {},
      status: "active",
      manualLock: true,
      provenance: { source: "fixture", sourceRevision: "1", actor: "user" },
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    if (request.pathname.endsWith("/entities/wiki-person")) {
      const page = { items: [], total: 0, offset: 0, limit: 50 };
      return respond({
        entity,
        facts: page,
        knowledge: page,
        events: page,
        currentState: page,
        relationships: page,
        relatedEntities: [],
        referencedFacts: [],
        factSessions: [],
        factKinds: [],
      });
    }
    const owner = request.searchParams.get("owner") ?? "";
    controls.ownerQueries.push(owner);
    const items = owner === "campaign-memory:wiki-person" ? [entity] : [];
    return respond({
      items,
      total: items.length,
      offset: Number(request.searchParams.get("offset") ?? 0),
      limit: Number(request.searchParams.get("limit") ?? 40),
      kindTotals: {},
    });
  }
  if (!url.includes("/api/family-tree/")) {
    if (url.startsWith("/api/")) return respond({ items: [], nextCursor: null });
    return originalFetch(input, init);
  }
  if (init?.method === "GET") return respond(graph);
  if (init?.method === "POST") {
    const edit = JSON.parse(String(init.body));
    controls.writes.push(edit);
    if (controls.failSave) {
      controls.failSave = false;
      return respond({ code: "FAMILY_CONFLICT", error: "Stale revision" }, 409);
    }
    if (edit.sourceId === '["characters","b"]' && edit.targetId === '["characters","a"]' && edit.kind === "parent")
      return respond({ code: "FAMILY_CYCLE", error: "Parent cycle" }, 409);
    const index = graph.links.findIndex((link) => link.id === edit.id);
    if (edit.action === "remove") graph.links.splice(index, 1);
    else if (index >= 0)
      graph.links[index] = {
        ...graph.links[index]!,
        ...edit,
        revision: graph.links[index]!.revision + 1,
        confirmed: true,
      };
    else
      graph.links.push({
        ...edit,
        id: crypto.randomUUID(),
        chatId: "s2",
        sessionNumber: 2,
        recordType: "fact",
        revision: 1,
        confirmed: true,
      });
    return respond({});
  }
  return respond(graph);
};
function Harness() {
  return (
    <>
      <FamilyTreeAction chatId="s2" />
      <ModalRenderer />
    </>
  );
}
await initializeLocalization(useUIStore.getState().language);
const params = new URL(location.href).searchParams;
document.documentElement.dataset.theme = params.get("mode") ?? "dark";
document.documentElement.dataset.visualTheme = params.get("theme") ?? "default";
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <Harness />
  </QueryClientProvider>,
);
