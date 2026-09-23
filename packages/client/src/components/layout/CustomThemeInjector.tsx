// ──────────────────────────────────────────────
// CustomThemeInjector: Injects the active custom theme.
// ──────────────────────────────────────────────
import { useEffect } from "react";
import { useThemes } from "../../hooks/use-themes";
import { sanitizeAppCss } from "../../lib/theme-css";

export function CustomThemeInjector() {
  const { data: syncedThemes = [] } = useThemes();
  const activeTheme = syncedThemes.find((theme) => theme.isActive) ?? null;

  // Inject active custom theme CSS
  useEffect(() => {
    const id = "marinara-custom-theme";
    let style = document.getElementById(id) as HTMLStyleElement | null;

    if (!activeTheme) {
      style?.remove();
      return;
    }

    if (!style) {
      style = document.createElement("style");
      style.id = id;
      document.head.appendChild(style);
    }
    style.textContent = sanitizeAppCss(activeTheme.css);

    return () => {
      style?.remove();
    };
  }, [activeTheme]);

  return null;
}
