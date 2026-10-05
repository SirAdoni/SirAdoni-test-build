import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { RandomTablesTool } from "../tools/RandomTablesTool";
import { useFeatureEnabled } from "../../hooks/use-feature-settings";

export function RandomTablesModal({ open, onClose, chatId }: { open: boolean; onClose: () => void; chatId: string }) {
  const { t } = useTranslation();
  const enabled = useFeatureEnabled("randomTables");
  if (!enabled) return null;
  return (
    <Modal open={open} onClose={onClose} title={t("ui.randomTables.title")} width="max-w-md">
      <RandomTablesTool chatId={chatId || null} />
    </Modal>
  );
}
