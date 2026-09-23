import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

interface SmoothFolderContentProps {
  open: boolean;
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}

export function SmoothFolderContent({ open, children, className, innerClassName }: SmoothFolderContentProps) {
  return (
    <div
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0",
      )}
    >
      <div className={cn("min-h-0 overflow-hidden", className)}>
        <div className={innerClassName}>{children}</div>
      </div>
    </div>
  );
}
