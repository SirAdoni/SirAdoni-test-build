import { useId, useRef, useState, type ReactNode } from "react";

/** Native top-layer popover: escapes map clipping without taking up canvas space. */
export function MapToolsPopover({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 8, left: 8 });
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        aria-haspopup="dialog"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-lg text-[var(--marinara-chat-chrome-panel-muted)] pointer-coarse:h-11 pointer-coarse:w-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const width = Math.min(340, window.innerWidth - 16);
          setPosition({
            left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
            top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 260)),
          });
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={label}
        onToggle={(event) => setOpen(event.newState === "open")}
        className="fixed m-0 box-border overflow-x-hidden overflow-y-auto whitespace-normal break-words rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--background)] p-2 text-[0.6875rem] text-[var(--marinara-chat-chrome-panel-title)] shadow-xl"
        style={{
          ...position,
          right: "auto",
          bottom: "auto",
          width: "min(340px, calc(100vw - 16px))",
          maxHeight: `calc(100dvh - ${position.top + 8}px)`,
        }}
      >
        {children}
      </div>
    </>
  );
}
