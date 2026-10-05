import type { ComponentProps } from "react";
import { useWikiFeatureEnabled } from "../../hooks/use-feature-settings";

export function FamilyTreeModal(props: ComponentProps<typeof FamilyTreeModalContent>) {
  return useWikiFeatureEnabled("familyTree") ? <FamilyTreeModalContent {...props} /> : null;
}

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FamilyPerson } from "@marinara-engine/shared";
import { Modal } from "../ui/Modal";
import { FamilyTree } from "../game/FamilyTree";
import { CampaignWikiWindow } from "../game/CampaignWikiWindow";
import { useUIStore } from "../../stores/ui.store";

function FamilyTreeModalContent({ open, onClose, chatId }: { open: boolean; onClose: () => void; chatId: string }) {
  const { t } = useTranslation();
  const wikiEnabled = useWikiFeatureEnabled("campaignWiki");
  const [wiki, setWiki] = useState<FamilyPerson | null>(null);
  const [editing, setEditing] = useState(false);
  const openPerson = (person: FamilyPerson) => {
    if (person.available && person.owner.type === "existing" && person.owner.store === "characters") {
      onClose();
      useUIStore.getState().openCharacterDetail(person.owner.recordId);
    } else if (person.available && person.owner.type === "existing" && person.owner.store === "personas") {
      onClose();
      useUIStore.getState().openPersonaDetail(person.owner.recordId);
    } else if (wikiEnabled) setWiki(person);
  };
  if (wiki && wikiEnabled)
    return (
      <CampaignWikiWindow
        chatId={wiki.chatId}
        onClose={() => setWiki(null)}
        target={{ kind: "owner", owner: `${wiki.owner.store}:${wiki.owner.recordId}`, name: wiki.name }}
      />
    );
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={editing}
      title={t("ui.familyTree.title")}
      mobileFullscreen
      width="max-w-none"
      panelClassName="!fixed !inset-0 !h-[100dvh] !max-h-none !w-screen !max-w-none !rounded-none"
      panelStyle={{ height: "100dvh", maxHeight: "100dvh", width: "100vw", maxWidth: "none" }}
      contentClassName="!min-h-0 !p-3 sm:!p-5"
    >
      <div className="mx-auto w-full max-w-7xl">
        <FamilyTree chatId={chatId} onOpen={openPerson} onEditingChange={setEditing} />
      </div>
    </Modal>
  );
}
