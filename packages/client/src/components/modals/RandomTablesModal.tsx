import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { RandomTablesTool } from "../tools/RandomTablesTool";

export function RandomTablesModal({ open, onClose, chatId }: { open: boolean; onClose: () => void; chatId: string }) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} title={t("ui.randomTables.title")} width="max-w-md">
      <RandomTablesTool chatId={chatId || null} />
    </Modal>
  );
}
