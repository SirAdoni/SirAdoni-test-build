import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { GameCalendarTool } from "../tools/GameCalendarTool";

export function GameCalendarModal({ open, onClose, chatId }: { open: boolean; onClose: () => void; chatId: string }) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} title={t("ui.gameCalendar.title")} width="max-w-md">
      <GameCalendarTool chatId={chatId} />
    </Modal>
  );
}
