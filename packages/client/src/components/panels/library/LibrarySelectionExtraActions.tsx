// ──────────────────────────────────────────────
// Selection bar extras for library panels: "Move to..."
// (folder tree picker) and "Campaigns..." (add/remove).
// ──────────────────────────────────────────────
import { FolderInput, Swords } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import {
  SELECTION_EXTRA_ACTION_BUTTON_CLASS,
  SELECTION_EXTRA_ACTION_LABEL_CLASS,
} from "../../ui/selection-action-classes";

interface LibrarySelectionExtraActionsProps {
  disabled?: boolean;
  onMove?: () => void;
  onCampaigns?: () => void;
}

export function LibrarySelectionExtraActions({ disabled, onMove, onCampaigns }: LibrarySelectionExtraActionsProps) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <>
      {onMove && (
        <button
          type="button"
          onClick={onMove}
          disabled={disabled}
          className={SELECTION_EXTRA_ACTION_BUTTON_CLASS}
          title={localizeUi("ui.panels.libraryorganize.moveToFolder")}
          aria-label={localizeUi("ui.panels.libraryorganize.moveToFolder")}
        >
          <FolderInput size="0.75rem" className="shrink-0" />
          <span className={SELECTION_EXTRA_ACTION_LABEL_CLASS}>{localizeUi("lorebook.editor.batch.move")}</span>
        </button>
      )}
      {onCampaigns && (
        <button
          type="button"
          onClick={onCampaigns}
          disabled={disabled}
          className={SELECTION_EXTRA_ACTION_BUTTON_CLASS}
          title={localizeUi("ui.panels.libraryorganize.addOrRemoveFromCampaign")}
          aria-label={localizeUi("ui.panels.libraryorganize.addOrRemoveFromCampaign")}
        >
          <Swords size="0.75rem" className="shrink-0" />
          <span className={SELECTION_EXTRA_ACTION_LABEL_CLASS}>{localizeUi("ui.panels.libraryorganize.campaign")}</span>
        </button>
      )}
    </>
  );
}
