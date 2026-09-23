// ──────────────────────────────────────────────
// Library organizer: per-panel campaign filter and
// grouping, remembered folder expansion, and the pickers
// behind "Campaigns..." and "Move to...".
// ──────────────────────────────────────────────
import { useCallback, useMemo, useState } from "react";
import { Folder, FolderOpen, Swords } from "lucide-react";
import { toast } from "sonner";
import { useTranslation as useUiTranslation } from "react-i18next";
import { LIBRARY_CAMPAIGN_NONE, checkLibraryFolderParent } from "@marinara-engine/shared";
import {
  campaignFilterRevision,
  getCampaignItemIds,
  useCampaignMembership,
  useLibraryCampaigns,
  useUpdateLibraryCampaignItems,
  type LibraryCampaignItemType,
} from "../../../hooks/use-library-campaigns";
import {
  useLibraryOrganizePanel,
  useLibraryOrganizeStore,
  type LibraryOrganizePanel,
} from "../../../stores/library-organize.store";
import {
  listLibraryFolderChoices,
  type LibraryFolderNode,
  type LibraryFolderView,
} from "../../../lib/library-folder-view";
import { CAMPAIGN_FILTER_ALL, CAMPAIGN_FILTER_NONE } from "./LibraryCampaignBar";
import { LibraryPickerModal, type LibraryPickerOption } from "./LibraryPickerModal";

export const ROOT_FOLDER_KEY = "__root__";

type MovePickerRequest = {
  title: string;
  message?: string;
  /** Folder being moved (its own subtree is not a valid target); null when moving items. */
  movingFolderId: string | null;
  /** Where the moving thing sits now (marked and disabled); undefined when items come from several places. */
  currentFolderId?: string | null;
  onPick: (folderId: string | null) => void;
};

export function useLibraryOrganizer(panel: LibraryOrganizePanel, itemType: LibraryCampaignItemType) {
  const { t: localizeUi } = useUiTranslation();
  const panelState = useLibraryOrganizePanel(panel);
  const setCampaignFilterStore = useLibraryOrganizeStore((store) => store.setCampaignFilter);
  const setGroupByStore = useLibraryOrganizeStore((store) => store.setGroupByCampaign);
  const setFolderExpandedStore = useLibraryOrganizeStore((store) => store.setFolderExpanded);
  const setSectionCollapsedStore = useLibraryOrganizeStore((store) => store.setCampaignSectionCollapsed);
  const campaignsQuery = useLibraryCampaigns();
  const campaigns = useMemo(() => campaignsQuery.data ?? [], [campaignsQuery.data]);
  const membership = useCampaignMembership(campaigns, itemType);
  const updateCampaignItems = useUpdateLibraryCampaignItems();

  // A remembered campaign that no longer exists falls back to "all" once campaigns have loaded.
  const campaignFilter =
    panelState.campaignFilter === CAMPAIGN_FILTER_NONE ||
    panelState.campaignFilter === CAMPAIGN_FILTER_ALL ||
    !campaignsQuery.isSuccess ||
    campaigns.some((campaign) => campaign.id === panelState.campaignFilter)
      ? panelState.campaignFilter
      : CAMPAIGN_FILTER_ALL;
  const campaignsAvailable = campaigns.length > 0;
  // While campaigns load, keep the remembered filter so the list does not flash unfiltered.
  const activeCampaignFilter = campaignsAvailable || campaignsQuery.isPending ? campaignFilter : CAMPAIGN_FILTER_ALL;
  const serverCampaignParam =
    activeCampaignFilter === CAMPAIGN_FILTER_ALL
      ? undefined
      : activeCampaignFilter === CAMPAIGN_FILTER_NONE
        ? LIBRARY_CAMPAIGN_NONE
        : activeCampaignFilter;
  const filteredCampaignId =
    activeCampaignFilter !== CAMPAIGN_FILTER_ALL && activeCampaignFilter !== CAMPAIGN_FILTER_NONE
      ? activeCampaignFilter
      : null;
  const serverCampaignRevision = useMemo(
    () =>
      serverCampaignParam === undefined
        ? undefined
        : campaignFilterRevision(
            campaigns,
            itemType,
            serverCampaignParam === LIBRARY_CAMPAIGN_NONE ? null : serverCampaignParam,
          ),
    [campaigns, itemType, serverCampaignParam],
  );
  const groupByCampaign = campaignsAvailable && panelState.groupByCampaign;
  const expandedFolderIds = useMemo(() => new Set(panelState.expandedFolderIds), [panelState.expandedFolderIds]);
  const collapsedCampaignIds = useMemo(
    () => new Set(panelState.collapsedCampaignIds),
    [panelState.collapsedCampaignIds],
  );

  const setCampaignFilter = useCallback(
    (value: string) => setCampaignFilterStore(panel, value),
    [panel, setCampaignFilterStore],
  );
  const setGroupByCampaign = useCallback((value: boolean) => setGroupByStore(panel, value), [panel, setGroupByStore]);
  const setFolderExpanded = useCallback(
    (folderId: string, expanded: boolean) => setFolderExpandedStore(panel, folderId, expanded),
    [panel, setFolderExpandedStore],
  );
  const setCampaignSectionCollapsed = useCallback(
    (campaignId: string, collapsed: boolean) => setSectionCollapsedStore(panel, campaignId, collapsed),
    [panel, setSectionCollapsedStore],
  );

  // ── Campaign membership picker ──
  const [campaignPickerItemIds, setCampaignPickerItemIds] = useState<string[] | null>(null);
  const openCampaignPicker = useCallback((itemIds: string[]) => {
    const ids = Array.from(new Set(itemIds));
    if (ids.length > 0) setCampaignPickerItemIds(ids);
  }, []);
  const campaignOptions = useMemo<LibraryPickerOption[]>(() => {
    if (!campaignPickerItemIds) return [];
    return campaigns.map((campaign) => {
      const members = new Set(getCampaignItemIds(campaign, itemType));
      const inCount = campaignPickerItemIds.filter((id) => members.has(id)).length;
      return {
        key: campaign.id,
        label: campaign.name,
        icon: <Swords size="0.75rem" />,
        hint: localizeUi("ui.panels.libraryorganize.sessionCount", { count: campaign.sessionCount }),
        checked: inCount === 0 ? false : inCount === campaignPickerItemIds.length ? true : "mixed",
      };
    });
  }, [campaignPickerItemIds, campaigns, itemType, localizeUi]);
  const toggleCampaign = useCallback(
    (campaignId: string) => {
      if (!campaignPickerItemIds) return;
      const option = campaignOptions.find((candidate) => candidate.key === campaignId);
      updateCampaignItems.mutate(
        {
          campaignId,
          itemType,
          itemIds: campaignPickerItemIds,
          action: option?.checked === true ? "remove" : "add",
        },
        {
          onError: (error) =>
            toast.error(
              error instanceof Error ? error.message : localizeUi("ui.panels.libraryorganize.couldNotUpdateCampaign"),
            ),
        },
      );
    },
    [campaignOptions, campaignPickerItemIds, itemType, localizeUi, updateCampaignItems],
  );

  // ── Folder move picker ──
  const [movePicker, setMovePicker] = useState<
    (MovePickerRequest & { view: LibraryFolderView; folders: LibraryFolderNode[] }) | null
  >(null);
  const openMovePicker = useCallback(
    (folders: LibraryFolderNode[], view: LibraryFolderView, request: MovePickerRequest) =>
      setMovePicker({ ...request, folders, view }),
    [],
  );
  const moveOptions = useMemo<LibraryPickerOption[]>(() => {
    if (!movePicker) return [];
    const { folders, view, movingFolderId, currentFolderId } = movePicker;
    const rootCheck = movingFolderId ? checkLibraryFolderParent(folders, movingFolderId, null) : { ok: true };
    const options: LibraryPickerOption[] = [
      {
        key: ROOT_FOLDER_KEY,
        label: localizeUi("ui.panels.libraryorganize.topLevel"),
        icon: <FolderOpen size="0.75rem" />,
        disabled: !rootCheck.ok || currentFolderId === null,
        hint: currentFolderId === null ? localizeUi("ui.panels.libraryorganize.current") : undefined,
      },
    ];
    for (const { folder, depth } of listLibraryFolderChoices(view.tree)) {
      const check = movingFolderId ? checkLibraryFolderParent(folders, movingFolderId, folder.id) : { ok: true };
      const isCurrent = folder.id === currentFolderId;
      options.push({
        key: folder.id,
        label: folder.name,
        depth: depth + 1,
        icon: <Folder size="0.75rem" />,
        disabled: !check.ok || isCurrent,
        hint: isCurrent ? localizeUi("ui.panels.libraryorganize.current") : undefined,
      });
    }
    return options;
  }, [localizeUi, movePicker]);

  const modals = (
    <>
      <LibraryPickerModal
        open={campaignPickerItemIds !== null}
        title={localizeUi("ui.panels.libraryorganize.campaigns")}
        message={localizeUi("ui.panels.libraryorganize.campaignPickerHelp", {
          count: campaignPickerItemIds?.length ?? 0,
        })}
        options={campaignOptions}
        emptyText={localizeUi("ui.panels.libraryorganize.noCampaignsYet")}
        mode="toggle"
        busy={updateCampaignItems.isPending}
        onPick={toggleCampaign}
        onClose={() => setCampaignPickerItemIds(null)}
      />
      <LibraryPickerModal
        open={movePicker !== null}
        title={movePicker?.title ?? ""}
        message={movePicker?.message}
        options={moveOptions}
        emptyText={localizeUi("ui.panels.libraryorganize.noFoldersYet")}
        onPick={(key) => movePicker?.onPick(key === ROOT_FOLDER_KEY ? null : key)}
        onClose={() => setMovePicker(null)}
      />
    </>
  );

  return {
    campaigns,
    campaignsAvailable,
    membership,
    campaignFilter: activeCampaignFilter,
    filteredCampaignId,
    serverCampaignParam,
    serverCampaignRevision,
    setCampaignFilter,
    groupByCampaign,
    setGroupByCampaign,
    expandedFolderIds,
    setFolderExpanded,
    collapsedCampaignIds,
    setCampaignSectionCollapsed,
    openCampaignPicker,
    openMovePicker,
    modals,
  };
}
