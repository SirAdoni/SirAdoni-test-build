// ──────────────────────────────────────────────
// File Browser — Action dropdown (3-dot menu)
// ──────────────────────────────────────────────
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContextMenuItem } from "../ui/ContextMenu";
import { cn } from "../../lib/utils";

/**
 * Fixed-position dropdown menu rendered via portal.
 *
 * Closes automatically on outside click or window scroll.
 * @param items - Menu items to display
 * @param x - Horizontal screen position (px)
 * @param y - Vertical screen position (px)
 * @param onClose - Callback when dropdown should close
 */
export function ActionDropdown({
  items,
  x,
  y,
  onClose,
}: {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const applyClampedPosition = () => {
      const rect = menu.getBoundingClientRect();
      setPosition({
        left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
        top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
      });
    };
    applyClampedPosition();
    window.addEventListener("resize", applyClampedPosition);
    return () => window.removeEventListener("resize", applyClampedPosition);
  }, [x, y]);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    const raf = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handle);
      window.addEventListener("scroll", onScroll, true);
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("mousedown", handle);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      data-chat-floating-panel
      ref={ref}
      role="menu"
      className="fixed z-[10002] min-w-[10rem] rounded-lg border border-[var(--border)] bg-[var(--card)] py-1 shadow-xl"
      style={{ left: position.left, top: position.top }}
    >
      {items.map((item, i) => (
        <button
          key={`${item.label}-${i}`}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
          className={cn(
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
            item.disabled
              ? "cursor-not-allowed text-[var(--muted-foreground)] opacity-50"
              : item.destructive
                ? "text-[var(--primary)] hover:bg-[var(--primary)]/10"
                : "text-[var(--foreground)] hover:bg-[var(--accent)]",
          )}
        >
          {item.icon}
          <span className="flex-1 truncate">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
