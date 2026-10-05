import { lazy, Suspense, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Network } from "lucide-react";
import { isWikiFeatureEnabled, useWikiFeatureEnabled } from "../../hooks/use-feature-settings";
import { Modal } from "../ui/Modal";

const CampaignFactionWeb = lazy(() => import("./CampaignFactionWeb").then((m) => ({ default: m.CampaignFactionWeb })));
const CampaignWiki = lazy(() => import("./CampaignWiki").then((m) => ({ default: m.CampaignWiki })));

export function CampaignFactionAction({ chatId }: { chatId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const enabled = useWikiFeatureEnabled("factionWeb");
  const wikiEnabled = useWikiFeatureEnabled("campaignWiki");
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [entityId, setEntityId] = useState<string | null>(null);
  const leave = () => !dirty || window.confirm(t("ui.game.campaignWiki.editor.unsavedConfirm"));
  if (!enabled) return null;
  return (
    <>
      <button
        type="button"
        className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-2 text-[0.6875rem] font-medium hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary"
        onClick={() => {
          if (isWikiFeatureEnabled(queryClient, "factionWeb")) setOpen(true);
        }}
      >
        <Network size={14} aria-hidden="true" />
        {t("settings.features.factionWeb.label")}
      </button>
      <Modal
        open={open}
        onClose={() => {
          if (leave()) {
            setOpen(false);
            setEntityId(null);
            setDirty(false);
          }
        }}
        title={t("settings.features.factionWeb.label")}
        width="max-w-5xl"
      >
        {open && (
          <Suspense fallback={null}>
            {entityId && wikiEnabled ? (
              <>
                <button
                  type="button"
                  className="min-h-11 rounded border border-border px-3"
                  onClick={() => {
                    if (leave()) {
                      setEntityId(null);
                      setDirty(false);
                    }
                  }}
                >
                  {t("ui.worldHistory.back")}
                </button>
                <CampaignWiki
                  chatId={chatId}
                  selectedEntityId={entityId}
                  onSelectedEntityChange={setEntityId}
                  onDirtyChange={setDirty}
                />
              </>
            ) : (
              <CampaignFactionWeb
                chatId={chatId}
                onDirtyChange={setDirty}
                onSelect={(id) => {
                  if (isWikiFeatureEnabled(queryClient, "campaignWiki") && leave()) {
                    setEntityId(id);
                    setDirty(false);
                  }
                }}
              />
            )}
          </Suspense>
        )}
      </Modal>
    </>
  );
}
