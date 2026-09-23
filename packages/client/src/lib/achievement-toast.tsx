import { toast } from "sonner";
import { ACHIEVEMENT_DEFINITION_BY_ID, type AchievementProgress } from "@marinara-engine/shared";
import { translate } from "../localization/i18n";
import { localizeAchievementTitle } from "./achievement-localization";

export function showAchievementUnlockToasts(progress: AchievementProgress[]) {
  for (const item of progress) {
    const achievement = ACHIEVEMENT_DEFINITION_BY_ID.get(item.id);
    if (!achievement) continue;

    toast.success(translate("ui.achievements.unlocked"), {
      description: localizeAchievementTitle(translate, achievement),
    });
  }
}
