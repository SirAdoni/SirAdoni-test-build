import { Trash2, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { useTranslation as useUiTranslation } from "react-i18next";
import { SELECTION_ACTION_BUTTON_CLASS, SELECTION_ACTION_LABEL_CLASS } from "./selection-action-classes";

interface SelectionActionBarProps {
  selectedCount: number;
  /** Optional extra button rendered before Export (e.g. "Move to folder"). */
  extraAction?: ReactNode;
  onExport: () => void;
  onDelete: () => void;
  deleteTone?: "accent" | "danger";
  exportDisabled?: boolean;
  deleteDisabled?: boolean;
  exporting?: boolean;
  placement?: "sticky" | "panel";
  className?: string;
}

export function SelectionActionBar({
  selectedCount,
  extraAction,
  onExport,
  onDelete,
  deleteTone = "danger",
  exportDisabled = false,
  deleteDisabled = false,
  exporting = false,
  placement = "sticky",
  className,
}: SelectionActionBarProps) {
  const { t: localizeUi } = useUiTranslation();
  const isPanelFooter = placement === "panel";
  const exportLabel = localizeUi("ui.characters.spritestab.export");
  const deleteLabel = localizeUi("lorebook.editor.batch.delete");

  const actionBar = (
    <div
      className={cn(
        isPanelFooter
          ? "mari-selection-action-bar fixed bottom-0 right-0 z-[60] w-[min(var(--mari-right-panel-width,20rem),100vw)] px-3 pb-[calc(0.625rem+var(--mari-safe-area-inset-bottom,env(safe-area-inset-bottom)))] pt-2.5"
          : "mari-selection-action-bar sticky bottom-0 z-20 -mx-3 mt-auto px-3 py-2.5",
        className,
      )}
    >
      <div className="mb-2 text-center text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
        {selectedCount} {localizeUi("ui.agents.agenteditor.selected")}
      </div>
      <div className="flex gap-2">
        {extraAction}
        <button
          type="button"
          onClick={onExport}
          disabled={selectedCount === 0 || exportDisabled || exporting}
          className={SELECTION_ACTION_BUTTON_CLASS}
          title={exportLabel}
          aria-label={exportLabel}
        >
          <Upload size="0.75rem" className="shrink-0" />
          <span className={SELECTION_ACTION_LABEL_CLASS}>{exportLabel}</span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={selectedCount === 0 || deleteDisabled || exporting}
          title={deleteLabel}
          aria-label={deleteLabel}
          className={cn(
            SELECTION_ACTION_BUTTON_CLASS,
            deleteTone === "danger" ? "mari-chrome-control--danger" : "mari-chrome-control--primary",
          )}
        >
          <Trash2 size="0.75rem" className="shrink-0" />
          <span className={SELECTION_ACTION_LABEL_CLASS}>{deleteLabel}</span>
        </button>
      </div>
    </div>
  );

  if (isPanelFooter) {
    return (
      <>
        <div
          aria-hidden="true"
          className="h-[calc(6rem+var(--mari-safe-area-inset-bottom,env(safe-area-inset-bottom)))] shrink-0"
        />
        {actionBar}
      </>
    );
  }

  return actionBar;
}
