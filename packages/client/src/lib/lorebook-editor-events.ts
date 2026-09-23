// ──────────────────────────────────────────────
// Lorebook editor: requests from other surfaces (the command palette)
// ──────────────────────────────────────────────
// The open Lorebook Editor answers by scrolling to its entries and opening
// the "Check lorebook" panel or the keyword test.

export type LorebookEditorTool = "check" | "test";

export const LOREBOOK_EDITOR_TOOL_EVENT = "marinara:lorebook-editor-tool";

export function requestLorebookEditorTool(tool: LorebookEditorTool) {
  window.dispatchEvent(new CustomEvent<LorebookEditorTool>(LOREBOOK_EDITOR_TOOL_EVENT, { detail: tool }));
}

export function readLorebookEditorTool(event: Event): LorebookEditorTool | null {
  const detail = (event as CustomEvent<unknown>).detail;
  return detail === "check" || detail === "test" ? detail : null;
}
