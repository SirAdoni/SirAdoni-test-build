import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CampaignWiki } from "../../../packages/client/src/components/game/CampaignWiki";
import { initializeLocalization } from "../../../packages/client/src/localization/i18n";

async function main() {
  await initializeLocalization("en");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const chatId = new URL(window.location.href).searchParams.get("chat") ?? "e2e-chat";
  createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><CampaignWiki chatId={chatId} /></QueryClientProvider>);
}
void main();
