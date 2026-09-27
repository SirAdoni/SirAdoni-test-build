import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GameTurnReview } from "../../../packages/client/src/components/game/GameTurnReview";
import { initializeLocalization } from "../../../packages/client/src/localization/i18n";

function FixtureApp() {
  const [source, setSource] = useState("No source selected");
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode") ?? "normal";
  return (
    <main className="mx-auto min-h-screen max-w-3xl bg-[#090714] p-3 text-white sm:p-8" data-fixture-mode={mode}>
      <div className="rounded-2xl border border-white/10 bg-black/35 p-3 shadow-xl sm:p-5">
        <p className="mb-3 text-sm text-white/70">Completed narration fixture: The lantern room is quiet again.</p>
        <GameTurnReview
          chatId="fixture-chat"
          messageId="fixture-message"
          swipeIndex={0}
          onSourceSelect={(evidence) => setSource(`Source selected: ${evidence.messageId} / ${evidence.swipeIndex} / ${evidence.quote}`)}
        />
        <p data-source-selection className="mt-3 text-xs text-cyan-200/80">{source}</p>
      </div>
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
