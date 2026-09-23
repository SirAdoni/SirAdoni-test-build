// ──────────────────────────────────────────────
// Game Mode: open a Session panel tab from another surface (the command palette)
// ──────────────────────────────────────────────

export type GameSessionPanelTab = "history" | "scenes" | "journal" | "tools";

export const GAME_SESSION_PANEL_OPEN_EVENT = "marinara:game-session-panel-open";

export function requestGameSessionPanel(tab: GameSessionPanelTab) {
  window.dispatchEvent(new CustomEvent<GameSessionPanelTab>(GAME_SESSION_PANEL_OPEN_EVENT, { detail: tab }));
}

export function readGameSessionPanelTab(event: Event): GameSessionPanelTab | null {
  const detail = (event as CustomEvent<unknown>).detail;
  return detail === "history" || detail === "scenes" || detail === "journal" || detail === "tools" ? detail : null;
}
