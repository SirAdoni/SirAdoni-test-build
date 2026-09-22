import { useUIStore } from "../stores/ui.store";

/** Searchable Settings controls that other surfaces (palette, snippet picker) can jump to. */
export const TEXT_SNIPPETS_SETTINGS_CONTROL_ID = "text-snippets" as const;
export const USAGE_DASHBOARD_SETTINGS_CONTROL_ID = "usage-dashboard" as const;

/** Opens the Settings panel on `tab`, optionally scrolling to a searchable control. */
export function openSettingsTarget(tab: string, controlId: string | null = null) {
  const ui = useUIStore.getState();
  ui.setSettingsTab(tab);
  ui.setSettingsTargetControlId(controlId);
  ui.openRightPanel("settings");
}
