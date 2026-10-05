import { UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { gameAssetFileUrl } from "../../lib/game-asset-urls";
import { MobileTraySheetTab } from "./GameMobileStatus";

type PresentCharacter = { characterId?: string | null; name?: string | null; avatarPath?: string | null };

export function GameMobilePresence({
  characters,
  inline = false,
}: {
  characters: PresentCharacter[];
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const people = characters.filter((character) => character.name?.trim());
  if (!people.length) return null;
  const content = (
    <div className="max-h-[min(70dvh,32rem)] space-y-2 overflow-y-auto">
      {people.map((character, index) => {
        const name = character.name!.trim();
        const avatar = gameAssetFileUrl(character.avatarPath);
        return (
          <div
            key={character.characterId || `${name}:${index}`}
            className="flex items-center gap-3 rounded-lg px-2 py-1.5"
          >
            {avatar ? (
              <img src={avatar} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10"
              >
                {name.slice(0, 1)}
              </span>
            )}
            <span className="min-w-0 break-words text-sm">{name}</span>
          </div>
        );
      })}
    </div>
  );
  if (inline) {
    return (
      <section
        data-game-scene-presence
        aria-label={t("ui.game.hudLists.presence")}
        className="max-h-48 min-w-40 overflow-y-auto rounded-xl border border-white/10 bg-black/45 p-2 text-white/80 backdrop-blur-md"
      >
        <h3 className="mb-1 text-xs font-semibold">{t("ui.game.hudLists.presence")}</h3>
        {content}
      </section>
    );
  }
  return (
    <MobileTraySheetTab
      data-mobile-scene-presence
      icon={<UsersRound size={16} aria-hidden="true" />}
      label={t("ui.game.hudLists.presence")}
    >
      {content}
    </MobileTraySheetTab>
  );
}
