import { Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";

interface EditorAvatarTileActionsProps {
  generationAvailable: boolean;
  onGenerate: () => void;
}

export function EditorAvatarTileActions({ generationAvailable, onGenerate }: EditorAvatarTileActionsProps) {
  const { t } = useTranslation();

  return (
    <>
      {generationAvailable && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onGenerate();
          }}
          className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--card)]/95 text-[var(--primary)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
          title={t("editor.avatar.generate.label")}
          aria-label={t("editor.avatar.generate.label")}
        >
          <Wand2 size="0.75rem" />
        </button>
      )}
    </>
  );
}
