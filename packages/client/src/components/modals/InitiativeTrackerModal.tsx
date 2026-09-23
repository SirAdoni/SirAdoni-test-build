import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { InitiativeTracker } from "../tools/InitiativeTracker";

export function InitiativeTrackerModal({
  open,
  onClose,
  chatId,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string;
}) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} title={t("ui.initiative.title")} width="max-w-md">
      <InitiativeTracker chatId={chatId} />
    </Modal>
  );
}
