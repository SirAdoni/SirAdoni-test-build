import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { GamePrepBoard } from "../game/GamePrepBoard";
import { useFeatureEnabled } from "../../hooks/use-feature-settings";

export function PrepBoardModal({ open, onClose, chatId }: { open: boolean; onClose: () => void; chatId: string }) {
  const { t } = useTranslation();
  const enabled = useFeatureEnabled("gamePrepBoard");
  if (!enabled) return null;
  return (
    <Modal open={open} onClose={onClose} title={t("ui.prepBoard.title")} width="max-w-6xl" mobileFullscreen>
      <div className="mx-auto w-full max-w-6xl">
        <GamePrepBoard chatId={chatId || null} variant="full" onNavigate={onClose} />
      </div>
    </Modal>
  );
}
