// ──────────────────────────────────────────────
// Store: Library organization (per browser)
// Remembers each library panel's campaign filter, the
// "group by campaign" view and which folders and campaign
// sections are open.
// ──────────────────────────────────────────────
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type LibraryOrganizePanel = "lorebooks" | "characters";
/** "all", "none" (not in any campaign) or a campaign id. */
export type LibraryCampaignFilter = string;

type PanelState = {
  campaignFilter: LibraryCampaignFilter;
  groupByCampaign: boolean;
  expandedFolderIds: string[];
  collapsedCampaignIds: string[];
};

const DEFAULT_PANEL_STATE: PanelState = {
  campaignFilter: "all",
  groupByCampaign: false,
  expandedFolderIds: [],
  collapsedCampaignIds: [],
};

interface LibraryOrganizeState {
  panels: Partial<Record<LibraryOrganizePanel, PanelState>>;
  setCampaignFilter: (panel: LibraryOrganizePanel, filter: LibraryCampaignFilter) => void;
  setGroupByCampaign: (panel: LibraryOrganizePanel, value: boolean) => void;
  setFolderExpanded: (panel: LibraryOrganizePanel, folderId: string, expanded: boolean) => void;
  setCampaignSectionCollapsed: (panel: LibraryOrganizePanel, campaignId: string, collapsed: boolean) => void;
}

const MAX_REMEMBERED_IDS = 500;

function toggleId(ids: string[], id: string, present: boolean) {
  const without = ids.filter((candidate) => candidate !== id);
  return present ? [...without, id].slice(-MAX_REMEMBERED_IDS) : without;
}

export const useLibraryOrganizeStore = create<LibraryOrganizeState>()(
  persist(
    (set) => {
      const patch = (panel: LibraryOrganizePanel, update: (state: PanelState) => Partial<PanelState>) =>
        set((state) => {
          const current = { ...DEFAULT_PANEL_STATE, ...state.panels[panel] };
          return { panels: { ...state.panels, [panel]: { ...current, ...update(current) } } };
        });
      return {
        panels: {},
        setCampaignFilter: (panel, filter) => patch(panel, () => ({ campaignFilter: filter || "all" })),
        setGroupByCampaign: (panel, value) => patch(panel, () => ({ groupByCampaign: value })),
        setFolderExpanded: (panel, folderId, expanded) =>
          patch(panel, (current) => ({ expandedFolderIds: toggleId(current.expandedFolderIds, folderId, expanded) })),
        setCampaignSectionCollapsed: (panel, campaignId, collapsed) =>
          patch(panel, (current) => ({
            collapsedCampaignIds: toggleId(current.collapsedCampaignIds, campaignId, collapsed),
          })),
      };
    },
    {
      name: "marinara-library-organize-v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ panels: state.panels }),
    },
  ),
);

export function useLibraryOrganizePanel(panel: LibraryOrganizePanel): PanelState {
  const state = useLibraryOrganizeStore((store) => store.panels[panel]);
  return state ? { ...DEFAULT_PANEL_STATE, ...state } : DEFAULT_PANEL_STATE;
}
