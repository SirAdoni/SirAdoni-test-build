import type { ComponentProps } from "react";
import { useWikiFeatureEnabled } from "../../hooks/use-feature-settings";

export function GameCalendarModal(props: ComponentProps<typeof GameCalendarModalContent>) {
  return useWikiFeatureEnabled("gameCalendar") ? <GameCalendarModalContent {...props} /> : null;
}

import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { GameCalendarTool } from "../tools/GameCalendarTool";

function GameCalendarModalContent({ open, onClose, chatId }: { open: boolean; onClose: () => void; chatId: string }) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} title={t("ui.gameCalendar.title")} width="max-w-md">
      <GameCalendarTool chatId={chatId} />
    </Modal>
  );
}
