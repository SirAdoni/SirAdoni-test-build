import { useState } from "react";
import { Sparkles } from "lucide-react";

interface AgentArtworkProps {
  imageUrl?: string | null;
  alt: string;
  iconSize: string;
}

function AgentArtworkImage({ imageUrl, alt, iconSize }: Omit<AgentArtworkProps, "imageUrl"> & { imageUrl: string }) {
  const [imageFailed, setImageFailed] = useState(false);

  if (!imageFailed) {
    return (
      <img
        src={imageUrl}
        alt={alt}
        className="h-full w-full object-cover"
        draggable={false}
        data-component="AgentArtwork"
        onError={() => setImageFailed(true)}
      />
    );
  }

  return <Sparkles size={iconSize} aria-hidden="true" data-component="AgentArtworkFallback" />;
}

export function AgentArtwork({ imageUrl, alt, iconSize }: AgentArtworkProps) {
  if (!imageUrl) {
    return <Sparkles size={iconSize} aria-hidden="true" data-component="AgentArtworkFallback" />;
  }

  return <AgentArtworkImage key={imageUrl} imageUrl={imageUrl} alt={alt} iconSize={iconSize} />;
}
