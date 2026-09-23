// ──────────────────────────────────────────────
// Campaign badges on library rows: the first campaign by
// name plus a "+N" count. Clicking a badge filters the
// panel to that campaign.
// ──────────────────────────────────────────────
import type { MouseEvent } from "react";
import { Swords } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { LibraryCampaign } from "../../../hooks/use-library-campaigns";
import { cn } from "../../../lib/utils";

interface LibraryCampaignBadgesProps {
  campaigns: LibraryCampaign[] | undefined;
  /** The campaign the panel is filtered to; its badge would only repeat the filter. */
  hideCampaignId?: string | null;
  onSelect?: (campaignId: string) => void;
  className?: string;
}

export function LibraryCampaignBadges({ campaigns, hideCampaignId, onSelect, className }: LibraryCampaignBadgesProps) {
  const { t: localizeUi } = useUiTranslation();
  const shown = (campaigns ?? []).filter((campaign) => campaign.id !== hideCampaignId);
  if (shown.length === 0) return null;
  const [first, ...rest] = shown;
  const allNames = shown.map((campaign) => campaign.name).join(", ");

  const select = (event: MouseEvent, campaignId: string) => {
    if (!onSelect) return;
    event.stopPropagation();
    onSelect(campaignId);
  };

  return (
    <span
      data-library-campaign-badges
      // The row title keeps priority: badges shrink first and truncate the campaign name.
      className={cn("inline-flex min-w-[2.75rem] max-w-full shrink-[4] items-center gap-0.5 align-middle", className)}
      title={localizeUi("ui.panels.libraryorganize.inCampaignsValue1", { value1: allNames })}
    >
      <span
        role={onSelect ? "button" : undefined}
        tabIndex={onSelect ? 0 : undefined}
        onClick={(event) => select(event, first!.id)}
        onKeyDown={(event) => {
          if (!onSelect || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          event.stopPropagation();
          onSelect(first!.id);
        }}
        className={cn(
          "mari-chrome-muted-badge inline-flex min-w-0 max-w-[7.5rem] items-center gap-0.5 px-1.5 py-px text-[0.5625rem] leading-tight",
          onSelect &&
            "cursor-pointer transition-colors hover:bg-[var(--marinara-chat-chrome-highlight-bg)] hover:text-[var(--marinara-chat-chrome-button-text-hover)]",
        )}
      >
        <Swords size="0.5rem" className="shrink-0" />
        <span className="truncate">{first!.name}</span>
      </span>
      {rest.length > 0 && (
        <span className="mari-chrome-muted-badge shrink-0 px-1 py-px text-[0.5625rem] leading-tight">
          +{rest.length}
        </span>
      )}
    </span>
  );
}
