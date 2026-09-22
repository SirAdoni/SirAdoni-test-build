import { useState, type CSSProperties } from "react";
import { User } from "lucide-react";

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
}: {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  loading?: "lazy" | "eager";
  iconSize?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) {
    return (
      <span className="flex h-full w-full items-center justify-center" role="img" aria-label={alt || undefined}>
        <User size={iconSize} aria-hidden="true" />
      </span>
    );
  }
  return (
    <img src={src} alt={alt} loading={loading} className={className} style={style} onError={() => setFailedSrc(src)} />
  );
}
