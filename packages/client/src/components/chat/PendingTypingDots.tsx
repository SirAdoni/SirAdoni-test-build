import { cn } from "../../lib/utils";

type PendingTypingDotsProps = {
  className?: string;
  dotClassName?: string;
  label?: string;
  small?: boolean;
};

export function PendingTypingDots({
  className,
  dotClassName,
  label = "Waiting for reply",
  small = false,
}: PendingTypingDotsProps) {
  const sizeClass = small ? "h-1.5 w-1.5" : "h-2 w-2";

  return (
    <div className={cn("mari-pending-typing-dots flex items-center gap-1", className)} role="status" aria-label={label}>
      <span className={cn(sizeClass, "rounded-full opacity-45", dotClassName)} />
      <span className={cn(sizeClass, "rounded-full opacity-65", dotClassName)} />
      <span className={cn(sizeClass, "rounded-full opacity-85", dotClassName)} />
    </div>
  );
}
