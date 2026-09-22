// ──────────────────────────────────────────────
// Selection bar extras for library panels: "Move to..."
// (folder tree picker) and "Campaigns..." (add/remove).
// ──────────────────────────────────────────────
import { FolderInput, Swords } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";

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
          className="mari-chrome-control min-w-0 flex-1 px-2 py-2 text-xs"
          title={localizeUi("ui.panels.libraryorganize.moveToFolder")}
          aria-label={localizeUi("ui.panels.libraryorganize.moveToFolder")}
        >
          <FolderInput size="0.75rem" className="shrink-0" />
          <span className="truncate max-[400px]:sr-only">{localizeUi("lorebook.editor.batch.move")}</span>
        </button>
      )}
      {onCampaigns && (
        <button
          type="button"
          onClick={onCampaigns}
          disabled={disabled}
          className="mari-chrome-control min-w-0 flex-1 px-2 py-2 text-xs"
          title={localizeUi("ui.panels.libraryorganize.addOrRemoveFromCampaign")}
          aria-label={localizeUi("ui.panels.libraryorganize.addOrRemoveFromCampaign")}
        >
          <Swords size="0.75rem" className="shrink-0" />
          <span className="truncate max-[400px]:sr-only">{localizeUi("ui.panels.libraryorganize.campaign")}</span>
        </button>
      )}
    </>
  );
}
