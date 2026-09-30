import { useState, type CSSProperties } from "react";
import { User } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * Avatar <img> for library rows and cards. A missing or unreadable file falls back to the
 * placeholder person icon instead of the browser's broken-image glyph and clipped alt text.
 */
export function AvatarImage({
  src,
  alt,
  className,
  style,
  loading,
  iconSize = "1rem",
  fallbackClassName,
}: {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  loading?: "lazy" | "eager";
  iconSize?: string;
  fallbackClassName?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) {
    return (
      // Absolutely centred so it fills the avatar frame even through wrappers that have no height.
      <span
        className={cn("absolute inset-0 flex items-center justify-center", fallbackClassName)}
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
      >
        <User size={iconSize} aria-hidden="true" />
      </span>
    );
  }
  return (
    <img src={src} alt={alt} loading={loading} className={className} style={style} onError={() => setFailedSrc(src)} />
  );
}
