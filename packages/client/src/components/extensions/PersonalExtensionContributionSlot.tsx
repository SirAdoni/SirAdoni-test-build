import type {
  PersonalExtensionContributionPosition,
  PersonalExtensionContributionSurface,
} from "@marinara-engine/shared";
import {
  activatePersonalExtensionContribution,
  usePersonalExtensionContributions,
} from "../../lib/personal-extension-contributions";
import { cn } from "../../lib/utils";
import { PersonalExtensionContributionIcon } from "./PersonalExtensionContributionIcon";

export function PersonalExtensionContributionSlot({
  surface,
  position,
  className,
}: {
  surface: Exclude<PersonalExtensionContributionSurface, "top-bar">;
  position: PersonalExtensionContributionPosition;
  className?: string;
}) {
  const { contributions } = usePersonalExtensionContributions();
  const buttons = contributions.filter(
    (contribution) =>
      contribution.kind === "button" &&
      contribution.surface === surface &&
      (contribution.position ?? "header") === position,
  );

  if (buttons.length === 0) return null;

  const compact = position === "header";
  return (
    <div
      className={cn(
        compact
          ? "flex min-w-0 items-center gap-1 overflow-x-auto"
          : "flex min-w-0 flex-wrap items-center gap-1.5 px-3 py-2",
        className,
      )}
      role="group"
    >
      {buttons.map((contribution) => (
        <button
          key={contribution.key}
          type="button"
          onClick={() => activatePersonalExtensionContribution(contribution.key)}
          className={cn(
            "mari-chrome-control mari-accent-animated shrink-0",
            compact ? "mari-chrome-control--small h-8 w-8 p-0" : "max-w-full text-xs",
          )}
          title={contribution.description || contribution.label}
          aria-label={contribution.label}
        >
          <PersonalExtensionContributionIcon icon={contribution.icon} size="0.8125rem" />
          {!compact && <span className="min-w-0 truncate">{contribution.label}</span>}
        </button>
      ))}
    </div>
  );
}
