import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import type { ChatImage } from "../../hooks/use-gallery";
import { useTranslation } from "react-i18next";

const ChatImageLightbox = lazy(() =>
  import("../chat/ChatImageLightbox").then((module) => ({ default: module.ChatImageLightbox })),
);

interface CharacterPhotoProps {
  src: string;
  fallbackSrc?: string;
  name: string;
  alt?: string;
  className?: string;
  wrapperClassName?: string;
  children: ReactNode;
  onUpdate?: () => void;
  updateDisabled?: boolean;
  updateLabel?: string;
}

function portraitImage(src: string, name: string): ChatImage {
  return {
    id: `character-portrait:${name}:${src}`,
    chatId: "",
    filePath: "",
    prompt: "",
    provider: "",
    model: "",
    width: null,
    height: null,
    createdAt: "",
    url: src,
  };
}

export function CharacterPhoto({
  src,
  fallbackSrc,
  name,
  alt = name,
  className,
  wrapperClassName,
  children,
  onUpdate,
  updateDisabled = false,
  updateLabel,
}: CharacterPhotoProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const photoButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <span
      className={wrapperClassName ?? "relative inline-flex items-center gap-1"}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if ((open && event.key === "Escape") || event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      <button
        ref={photoButtonRef}
        type="button"
        className={`relative shrink-0 ${className ?? "block"}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        aria-label={t("ui.characterPhoto.open", { name })}
      >
        {children}
      </button>
      {open && (
        <Suspense fallback={null}>
          <ChatImageLightbox
            image={portraitImage(src, name)}
            fallbackSrc={fallbackSrc}
            alt={alt}
            pinEnabled={false}
            downloadEnabled={false}
            fullViewport
            onUpdate={
              onUpdate
                ? () => {
                    setOpen(false);
                    onUpdate();
                  }
                : undefined
            }
            updateDisabled={updateDisabled}
            updateLabel={updateLabel ?? t("ui.characterPhoto.update", { name })}
            onClose={() => {
              setOpen(false);
              requestAnimationFrame(() => photoButtonRef.current?.focus());
            }}
          />
        </Suspense>
      )}
    </span>
  );
}
