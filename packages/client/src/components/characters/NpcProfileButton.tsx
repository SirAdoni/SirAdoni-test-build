import { useTranslation } from "react-i18next";
import type { CharacterData } from "@marinara-engine/shared";

export function NpcProfileButton({
  data,
  dirty,
  pending,
  onBuild,
}: {
  data: CharacterData;
  dirty: boolean;
  pending: boolean;
  onBuild: (chatId: string, npcId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const marinara = data.extensions?.marinara as Record<string, unknown> | undefined;
  const npc = marinara?.gameNpc as Record<string, unknown> | undefined;
  if (npc?.autoCreated !== true || typeof npc.sourceChatId !== "string" || typeof npc.npcId !== "string") return null;
  return (
    <button
      type="button"
      className="mari-chrome-control min-h-9 px-3 text-xs"
      disabled={dirty || pending}
      title={dirty ? t("characters.npcProfile.saveFirst") : undefined}
      onClick={() => void onBuild(npc.sourceChatId as string, npc.npcId as string)}
    >
      {t(pending ? "characters.npcProfile.building" : "characters.npcProfile.rebuild")}
    </button>
  );
}
