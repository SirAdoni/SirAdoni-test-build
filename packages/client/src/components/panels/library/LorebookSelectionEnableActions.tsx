// ──────────────────────────────────────────────
// Selection bar extras for the Lorebooks panel:
// "Enable" and "Disable" for the selected lorebooks,
// with an Undo on the notice (like the folder switch).
// ──────────────────────────────────────────────
import { useCallback, useMemo } from "react";
import { Power, PowerOff } from "lucide-react";
import { toast } from "sonner";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useSetLorebooksEnabled } from "../../../hooks/use-lorebooks";
import { planLorebookSelectionEnable } from "../../../lib/lorebook-selection";
import {
  SELECTION_EXTRA_ACTION_BUTTON_CLASS,
  SELECTION_EXTRA_ACTION_LABEL_CLASS,
} from "../../ui/selection-action-classes";

interface LorebookSelectionEnableActionsProps {
  selectedIds: ReadonlySet<string>;
  lorebooks: ReadonlyArray<{ id: string; enabled: boolean }>;
}

export function LorebookSelectionEnableActions({ selectedIds, lorebooks }: LorebookSelectionEnableActionsProps) {
  const { t: localizeUi } = useUiTranslation();
  const setEnabled = useSetLorebooksEnabled();
  const enabledById = useMemo(() => new Map(lorebooks.map((lorebook) => [lorebook.id, lorebook.enabled])), [lorebooks]);
  const toEnable = useMemo(
    () => planLorebookSelectionEnable(selectedIds, enabledById, true),
    [enabledById, selectedIds],
  );
  const toDisable = useMemo(
    () => planLorebookSelectionEnable(selectedIds, enabledById, false),
    [enabledById, selectedIds],
  );

  const showError = useCallback(
    (error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : localizeUi("ui.panels.libraryorganize.couldNotSwitchLorebooks"),
      ),
    [localizeUi],
  );

  const apply = useCallback(
    async (ids: string[], enable: boolean) => {
      if (ids.length === 0) return;
      let changedIds: string[];
      try {
        changedIds = (await setEnabled.mutateAsync({ ids, enabled: enable })).changedIds;
      } catch (error) {
        showError(error);
        return;
      }
      if (changedIds.length === 0) return;
      toast.success(
        localizeUi(
          enable
            ? "ui.panels.lorebookspanel.enabledSelectedLorebooks"
            : "ui.panels.lorebookspanel.disabledSelectedLorebooks",
          { count: changedIds.length },
        ),
        {
          action: {
            label: localizeUi("ui.chat.chatresourcedropoverlay.undo"),
            // Undo flips back exactly the lorebooks this action changed.
            onClick: () => setEnabled.mutate({ ids: changedIds, enabled: !enable }, { onError: showError }),
          },
        },
      );
    },
    [localizeUi, setEnabled, showError],
  );

  const enableLabel = localizeUi("ui.panels.lorebookspanel.enableSelectedLorebooks");
  const disableLabel = localizeUi("ui.panels.lorebookspanel.disableSelectedLorebooks");
  return (
    <>
      <button
        type="button"
        data-lorebook-selection-enable="enable"
        onClick={() => void apply(toEnable, true)}
        disabled={setEnabled.isPending || toEnable.length === 0}
        className={SELECTION_EXTRA_ACTION_BUTTON_CLASS}
        title={enableLabel}
        aria-label={enableLabel}
      >
        <Power size="0.75rem" className="shrink-0" />
        <span className={SELECTION_EXTRA_ACTION_LABEL_CLASS}>{localizeUi("ui.panels.libraryorganize.enable")}</span>
      </button>
      <button
        type="button"
        data-lorebook-selection-enable="disable"
        onClick={() => void apply(toDisable, false)}
        disabled={setEnabled.isPending || toDisable.length === 0}
        className={SELECTION_EXTRA_ACTION_BUTTON_CLASS}
        title={disableLabel}
        aria-label={disableLabel}
      >
        <PowerOff size="0.75rem" className="shrink-0" />
        <span className={SELECTION_EXTRA_ACTION_LABEL_CLASS}>{localizeUi("ui.panels.libraryorganize.disable")}</span>
      </button>
    </>
  );
}
