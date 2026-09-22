import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { NameGenerator } from "../tools/NameGenerator";

export function NameGeneratorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} title={t("ui.nameGenerator.title")} width="max-w-md">
      <NameGenerator />
    </Modal>
  );
}
