// ──────────────────────────────────────────────
// Shared list states for sidebar and right-panel lists: a shimmer skeleton
// while loading, and an error with Retry when the list request fails. A failed
// request must never fall through to the "No items yet" empty state, which
// tells the user their data is gone.
// ──────────────────────────────────────────────
import type { ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

export function PanelListSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={localizeUi("ui.ui.panelstates.loading")}
      className={cn("flex flex-col gap-2 px-2 py-4", className)}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="shimmer h-10 rounded-lg" />
      ))}
    </div>
  );
}

export function PanelErrorState({
  message,
  onRetry,
  retrying = false,
  className,
  children,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <div role="alert" className={cn("flex flex-col items-center gap-2 px-3 py-10 text-center", className)}>
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--destructive)]/10">
        <AlertTriangle size="1.25rem" className="text-[var(--destructive)]" aria-hidden="true" />
      </div>
      <p className="max-w-64 text-xs text-[var(--muted-foreground)]">{message}</p>
      {children}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mari-chrome-control mari-chrome-control--compact mt-1 min-h-9 gap-1.5 px-3 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {retrying && <Loader2 size="0.75rem" className="animate-spin" aria-hidden="true" />}
          {localizeUi(retrying ? "ui.ui.panelstates.retrying" : "ui.panels.connectionspanel.retry")}
        </button>
      )}
    </div>
  );
}
