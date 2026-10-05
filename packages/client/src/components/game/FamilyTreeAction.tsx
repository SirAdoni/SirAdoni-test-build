import { Network } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/ui.store";
import { useQueryClient } from "@tanstack/react-query";
import { isWikiFeatureEnabled, useWikiFeatureEnabled } from "../../hooks/use-feature-settings";

export function FamilyTreeAction({ chatId }: { chatId: string }) {
  const { t } = useTranslation();
  const label = t("ui.familyTree.open");
  const queryClient = useQueryClient();
  const enabled = useWikiFeatureEnabled("familyTree");
  if (!enabled) return null;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        if (isWikiFeatureEnabled(queryClient, "familyTree")) useUIStore.getState().openModal("family-tree", { chatId });
      }}
      className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-2 text-[0.6875rem] font-medium text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Network size={14} aria-hidden="true" />
      {label}
    </button>
  );
}
