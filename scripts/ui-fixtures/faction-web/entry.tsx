import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CampaignFactionWeb } from "../../../packages/client/src/components/game/CampaignFactionWeb";
import { initializeLocalization } from "../../../packages/client/src/localization/i18n";
import { api } from "../../../packages/client/src/lib/api-client";

const entities = ["North Council", "South Guild", "Harbor League"].map((alias, index) => ({
  entityId: `org-${index}`,
  chatId: "fixture",
  kind: "organization",
  aliases: [alias],
  status: "active",
  tags: [],
  attributes: {},
  owner: { type: "registry", store: "campaign-memory", recordId: `org-${index}` },
  revision: 1,
  manualLock: false,
  provenance: { actor: "user", source: "fixture", sourceRevision: "1" },
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
}));
let links = [
  {
    relationshipId: "link-1",
    chatId: "fixture",
    sourceEntityId: "org-0",
    targetEntityId: "org-1",
    type: "allied-with",
    inverseLabel: "allied-with",
    status: "proposed",
    notes: "Trade talks remain uncertain.",
    evidence: [],
    revision: 1,
    manualLock: true,
    provenance: { actor: "user", source: "fixture", sourceRevision: "1" },
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
];
const journal: unknown[] = [];
api.get = (async (url: string) => {
  const query = new URL(url, "http://fixture");
  if (query.pathname.endsWith("/entities")) {
    const items = entities.filter((entity) =>
      entity.aliases[0]!.toLowerCase().includes((query.searchParams.get("q") ?? "").toLowerCase()),
    );
    return { items, total: items.length, limit: 20, offset: 0 };
  }
  if (query.pathname.endsWith("/factions")) {
    const id = query.searchParams.get("entityId");
    const items = links.filter(
      (link) =>
        (link.sourceEntityId === id || link.targetEntityId === id) &&
        (link.status !== "ended" || query.searchParams.get("includeEnded") === "true"),
    );
    const ids = new Set([id, ...items.flatMap((link) => [link.sourceEntityId, link.targetEntityId])]);
    return {
      entities: entities.filter((entity) => ids.has(entity.entityId)),
      relationships: { items, total: items.length, offset: 0, limit: 8 },
    };
  }
  if (query.pathname.endsWith("/audit")) return { items: journal, total: journal.length, limit: 10, offset: 0 };
  throw new Error(`Unexpected fixture path: ${url}`);
}) as typeof api.get;
api.post = (async (_url: string, request: any) => {
  if ((request.action === "update" ? request.patch : request.input).manualLock !== true)
    throw new Error("Manual faction edits must be protected");
  const before = links.find((link) => link.relationshipId === request.recordId);
  const after =
    request.action === "update"
      ? { ...before, ...request.patch, revision: before!.revision + 1 }
      : { ...links[0], ...request.input, relationshipId: "link-2", revision: 1 };
  links =
    request.action === "update"
      ? links.map((link) => (link.relationshipId === request.recordId ? after : link))
      : [...links, after];
  journal.unshift({
    journalId: String(journal.length),
    actor: "user",
    createdAt: new Date().toISOString(),
    reason: request.reason,
    before,
    after,
  });
  return after;
}) as typeof api.post;
await initializeLocalization("en");
const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get("mode") ?? "dark";
document.documentElement.dataset.visualTheme = query.get("theme") ?? "default";
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CampaignFactionWeb
      chatId="fixture"
      onSelect={(id) => {
        document.getElementById("selected")!.textContent = id;
      }}
      onDirtyChange={() => {}}
    />
    <output id="selected" />
  </QueryClientProvider>,
);
