import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { GamePrepBoard } from "../game/GamePrepBoard";

export function PrepBoardModal({ open, onClose, chatId }: { open: boolean; onClose: () => void; chatId: string }) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} title={t("ui.prepBoard.title")} fullScreen>
      <div className="mx-auto w-full max-w-6xl">
        <GamePrepBoard chatId={chatId || null} variant="full" onNavigate={onClose} />
      </div>
    </Modal>
  );
}
