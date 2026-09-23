// ──────────────────────────────────────────────
// Folder-level lorebook switch: one small power button
// per lorebook folder that enables or disables every
// lorebook in the folder and its subfolders, after a
// confirmation, with an Undo on the notice that follows.
// ──────────────────────────────────────────────
import { useCallback, useMemo, type ReactNode } from "react";
import { Power, PowerOff } from "lucide-react";
import { toast } from "sonner";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useSetLorebooksEnabled } from "../../../hooks/use-lorebooks";
import { showConfirmDialog } from "../../../lib/app-dialogs";
import {
  collectLibraryFolderItemIdsByFolder,
  planLibraryFolderLorebookToggle,
  type LibraryFolderNode,
} from "../../../lib/library-folder-view";

export function useLorebookFolderToggle(
  folders: LibraryFolderNode[],
  lorebooks: ReadonlyArray<{ id: string; enabled: boolean }>,
) {
  const { t: localizeUi } = useUiTranslation();
  const setEnabled = useSetLorebooksEnabled();
  const enabledById = useMemo(
    () => new Map(lorebooks.map((lorebook) => [lorebook.id, lorebook.enabled])),
    [lorebooks],
  );
  // One plan per folder, rebuilt only when folders or lorebook states change.
  const planByFolder = useMemo(() => {
    const plans = new Map<string, ReturnType<typeof planLibraryFolderLorebookToggle>>();
    for (const [folderId, itemIds] of collectLibraryFolderItemIdsByFolder(folders)) {
      plans.set(folderId, planLibraryFolderLorebookToggle(itemIds, enabledById));
    }
    return plans;
  }, [enabledById, folders]);

  const showError = useCallback(
    (error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : localizeUi("ui.panels.libraryorganize.couldNotSwitchLorebooks"),
      ),
    [localizeUi],
  );

  const toggleFolder = useCallback(
    async (folder: LibraryFolderNode) => {
      const plan = planByFolder.get(folder.id);
      if (!plan) return;
      const { enable, ids } = plan;
      const confirmed = await showConfirmDialog({
        title: enable
          ? localizeUi("ui.panels.libraryorganize.enableFolderLorebooks")
          : localizeUi("ui.panels.libraryorganize.disableFolderLorebooks"),
        message: localizeUi(
          enable
            ? "ui.panels.libraryorganize.enableFolderLorebooksMessage"
            : "ui.panels.libraryorganize.disableFolderLorebooksMessage",
          { count: ids.length, value1: folder.name },
        ),
        confirmLabel: enable
          ? localizeUi("ui.panels.libraryorganize.enable")
          : localizeUi("ui.panels.libraryorganize.disable"),
      });
      if (!confirmed) return;
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
          enable ? "ui.panels.libraryorganize.enabledFolderLorebooks" : "ui.panels.libraryorganize.disabledFolderLorebooks",
          { count: changedIds.length, value1: folder.name },
        ),
        {
          action: {
            label: localizeUi("ui.chat.chatresourcedropoverlay.undo"),
            // Undo flips back exactly the lorebooks this switch changed.
            onClick: () => setEnabled.mutate({ ids: changedIds, enabled: !enable }, { onError: showError }),
          },
        },
      );
    },
    [localizeUi, planByFolder, setEnabled, showError],
  );

  const renderFolderActions = useCallback(
    (folder: LibraryFolderNode): ReactNode => {
      const plan = planByFolder.get(folder.id);
      if (!plan) return null;
      const label = plan.enable
        ? localizeUi("ui.panels.libraryorganize.enableFolderLorebooks")
        : localizeUi("ui.panels.libraryorganize.disableFolderLorebooks");
      return (
        <button
          type="button"
          data-folder-lorebook-toggle={plan.enable ? "enable" : "disable"}
          disabled={setEnabled.isPending}
          onClick={(event) => {
            event.stopPropagation();
            void toggleFolder(folder);
          }}
          className="mari-chrome-control mari-chrome-control--small p-1"
          title={label}
          aria-label={label}
        >
          {plan.enable ? <PowerOff size="0.6875rem" /> : <Power size="0.6875rem" />}
        </button>
      );
    },
    [localizeUi, planByFolder, setEnabled.isPending, toggleFolder],
  );

  /** Every known lorebook in the folder (and its subfolders) is disabled. */
  const isFolderDimmed = useCallback(
    (folder: LibraryFolderNode) => planByFolder.get(folder.id)?.enable === true,
    [planByFolder],
  );

  return { renderFolderActions, isFolderDimmed };
}
