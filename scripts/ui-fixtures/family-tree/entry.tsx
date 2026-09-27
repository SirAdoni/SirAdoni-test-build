import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FamilyTreeData } from "@marinara-engine/shared";
import { FamilyTreeModal } from "../../../packages/client/src/components/modals/FamilyTreeModal";
import { initializeLocalization } from "../../../packages/client/src/localization/i18n";
import { useUIStore } from "../../../packages/client/src/stores/ui.store";

const image =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#685289"/><circle cx="40" cy="27" r="15" fill="#eee"/><path d="M12 80V63a28 28 0 0 1 56 0v17" fill="#eee"/></svg>',
  );
const graph: FamilyTreeData = {
  people: ["a", "b", "c", "d"].map((id, index) => ({
    id,
    name: index < 2 ? "Robin" : index === 2 ? "Tess" : "Morgan",
    owner: { type: "existing", store: "characters", recordId: id },
    entityId: id,
    chatId: "s1",
    sessionNumber: 1,
    tags: [index < 3 ? "House Rowan" : "House Vale"],
    available: true,
    avatarUrl: image,
  })),
  links: [
    {
      id: "parent",
      chatId: "s1",
      sessionNumber: 1,
      revision: 1,
      recordType: "fact",
      sourceId: "a",
      targetId: "b",
      kind: "parent",
      note: "",
      confirmed: true,
    },
    {
      id: "suggestion",
      chatId: "s1",
      sessionNumber: 1,
      revision: 1,
      recordType: "relationship",
      sourceId: "a",
      targetId: "c",
      kind: "sibling",
      note: "",
      confirmed: false,
    },
  ],
};
const controls = {
  failSave: false,
  writes: [] as any[],
  profile: () => useUIStore.getState().characterDetailId,
  wikiEdit: async () => {},
};
(window as any).__family = controls;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
  if (!url.includes("/api/family-tree/")) {
    if (url.startsWith("/api/")) return new Response("{}", { headers: { "Content-Type": "application/json" } });
    return originalFetch(input, init);
  }
  const respond = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (init?.method === "POST") {
    const edit = JSON.parse(String(init.body));
    controls.writes.push(edit);
    if (controls.failSave) {
      controls.failSave = false;
      return respond({ code: "FAMILY_CONFLICT", error: "Stale revision" }, 409);
    }
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
        chatId: "s1",
        sessionNumber: 1,
        recordType: "fact",
        revision: 1,
        confirmed: true,
      });
    return respond({});
  }
  return respond(graph);
};
function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open fixture</button>
      <FamilyTreeModal open={open} onClose={() => setOpen(false)} chatId="s2" />
    </>
  );
}
await initializeLocalization();
const params = new URL(location.href).searchParams;
document.documentElement.dataset.theme = params.get("mode") ?? "dark";
document.documentElement.dataset.visualTheme = params.get("theme") ?? "default";
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
controls.wikiEdit = async () => {
  graph.links[0]!.note = "Updated through the wiki";
  await client.invalidateQueries({ queryKey: ["campaign-memory"] });
};
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <Harness />
  </QueryClientProvider>,
);
