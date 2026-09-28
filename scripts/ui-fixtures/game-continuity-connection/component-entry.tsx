import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GameContinuityPanel } from "../../../packages/client/src/components/game/GameContinuityPanel";
import { initializeLocalization } from "../../../packages/client/src/localization/i18n";

function FixtureApp() {
  return (
    <main
      data-fixture-scroll
      className="mx-auto max-w-2xl border border-border bg-background text-foreground"
      style={{ height: 320, overflowY: "auto" }}
    >
      <GameContinuityPanel chatId="fixture-chat" metadata={{ gameContinuity: { mode: "active" } }} />
    </main>
  );
}

void initializeLocalization("en").then(() => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <FixtureApp />
    </QueryClientProvider>,
  );
});
