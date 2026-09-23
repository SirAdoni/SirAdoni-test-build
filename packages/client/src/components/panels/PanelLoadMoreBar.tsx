import type { ReactNode } from "react";

interface PanelLoadMoreBarProps {
  children: ReactNode;
  disabled?: boolean;
  onLoadMore: () => void;
}

export function PanelLoadMoreBar({ children, disabled = false, onLoadMore }: PanelLoadMoreBarProps) {
  return (
    <div className="sticky bottom-0 z-20 -mx-3 mt-2 border-t border-[var(--marinara-chat-chrome-panel-divider)] bg-[var(--sidebar)]/95 px-3 pb-3 pt-2 backdrop-blur-md">
      <button
        type="button"
        onClick={onLoadMore}
        disabled={disabled}
        className="mari-chrome-control mari-chrome-control--primary w-full justify-center text-xs"
      >
        {children}
      </button>
    </div>
  );
}
