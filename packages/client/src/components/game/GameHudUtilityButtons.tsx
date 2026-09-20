import { BookUser, PanelsTopLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

export function GameHudUtilityButtons({
  statusVisible,
  contactsVisible,
  onToggleStatus,
  onToggleContacts,
  buttonClass,
}: {
  statusVisible: boolean;
  contactsVisible: boolean;
  onToggleStatus: () => void;
  onToggleContacts: () => void;
  buttonClass: (options: { open?: boolean }) => string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        data-chat-help="game-status"
        aria-pressed={statusVisible}
        onClick={onToggleStatus}
        className={buttonClass({ open: statusVisible })}
        title={t(statusVisible ? "ui.game.statusWidget.hide" : "ui.game.statusWidget.show")}
        aria-label={t(statusVisible ? "ui.game.statusWidget.hide" : "ui.game.statusWidget.show")}
      >
        <PanelsTopLeft size={14} />
      </button>
      <button
        type="button"
        data-chat-help="contact-book"
        aria-pressed={contactsVisible}
        onClick={onToggleContacts}
        className={buttonClass({ open: contactsVisible })}
        title={t(contactsVisible ? "ui.game.contactBook.hide" : "ui.game.contactBook.show")}
        aria-label={t(contactsVisible ? "ui.game.contactBook.hide" : "ui.game.contactBook.show")}
      >
        <BookUser size={14} />
      </button>
    </>
  );
}
