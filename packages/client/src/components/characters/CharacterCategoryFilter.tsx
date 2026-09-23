import { useTranslation } from "react-i18next";
import type { CharacterLibraryCategory } from "@marinara-engine/shared";
import { cn } from "../../lib/utils";

export function CharacterCategoryFilter({
  value,
  onChange,
}: {
  value: CharacterLibraryCategory | "all";
  onChange: (value: CharacterLibraryCategory | "all") => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mari-chrome-segmented flex" role="group" aria-label={t("characters.organization.label")}>
      {(["characters", "npcs", "all"] as const).map((category) => (
        <button
          key={category}
          type="button"
          aria-pressed={category === value}
          onClick={() => onChange(category)}
          className={cn(
            "mari-chrome-segmented__button min-h-9 flex-1 px-2 text-xs",
            category === value && "mari-chrome-control--selected",
          )}
        >
          {t(`characters.organization.${category}`)}
        </button>
      ))}
    </div>
  );
}
