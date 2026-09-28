import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { SettingsPanel } from "../../../packages/client/src/components/panels/SettingsPanel";
import { initializeLocalization } from "../../../packages/client/src/localization/i18n";
import { useUIStore } from "../../../packages/client/src/stores/ui.store";

function FixtureApp() {
  return (
    <main className="h-screen bg-[var(--background)] p-3 text-[var(--foreground)] sm:p-6">
      <div className="mx-auto h-full max-w-5xl overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--sidebar)]">
        <SettingsPanel />
      </div>
      <Toaster duration={800} />
    </main>
  );
}

void initializeLocalization("en").then(() => {
  useUIStore.getState().setSettingsTab("advanced");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <FixtureApp />
    </QueryClientProvider>,
  );
});
