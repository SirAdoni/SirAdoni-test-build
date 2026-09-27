import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initializeLocalization } from "../../../packages/client/src/localization/i18n";
import { WorldHistoryModal } from "../../../packages/client/src/components/modals/WorldHistoryModal";

await initializeLocalization("en");
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <WorldHistoryModal
      open
      chatId="fixture"
      onClose={() => {
        document.body.dataset.closed = "true";
      }}
    />
  </QueryClientProvider>,
);
