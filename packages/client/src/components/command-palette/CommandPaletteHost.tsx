import { useEffect } from "react";
import { countModalOverlays } from "../../lib/modal-overlay-registry";
import { isPaletteShortcut } from "../../lib/command-palette";
import { useCommandPaletteStore } from "../../stores/command-palette.store";
import { useFeatureEnabled } from "../../hooks/use-feature-settings";
import { CommandPalette } from "./CommandPalette";

export function CommandPaletteHost() {
  const open = useCommandPaletteStore((state) => state.paletteOpen);
  const enabled = useFeatureEnabled("libraryNavigation");
  const closePalette = useCommandPaletteStore((state) => state.closePalette);
  useEffect(() => {
    if (!enabled) {
      closePalette();
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !isPaletteShortcut(event)) return;
      const palette = useCommandPaletteStore.getState();
      if (countModalOverlays() > (palette.paletteOpen ? 1 : 0)) return;
      event.preventDefault();
      palette.togglePalette();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePalette, enabled]);
  return enabled && open ? <CommandPalette /> : null;
}
