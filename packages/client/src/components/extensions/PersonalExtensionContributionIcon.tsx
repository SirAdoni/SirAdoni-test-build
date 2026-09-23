import { Puzzle } from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import type { PersonalExtensionContributionIcon } from "@marinara-engine/shared";

const CONTRIBUTION_ICON_NAMES = new Set<string>(iconNames);
const LEGACY_ICON_ALIASES: Record<string, IconName> = {
  message: "message-square-text",
  tool: "wrench",
};

function resolveContributionIcon(icon: PersonalExtensionContributionIcon | undefined): IconName {
  const name = icon ?? "puzzle";
  if (CONTRIBUTION_ICON_NAMES.has(name)) return name as IconName;
  return LEGACY_ICON_ALIASES[name] ?? "puzzle";
}

export function PersonalExtensionContributionIcon({
  icon,
  size = "0.875rem",
  className,
}: {
  icon?: PersonalExtensionContributionIcon;
  size?: string | number;
  className?: string;
}) {
  return (
    <DynamicIcon
      aria-hidden="true"
      className={className}
      fallback={() => <Puzzle aria-hidden="true" className={className} size={size} />}
      name={resolveContributionIcon(icon)}
      size={size}
    />
  );
}
