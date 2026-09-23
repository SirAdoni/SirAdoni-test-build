// ──────────────────────────────────────────────
// Library campaign bar: filter a library panel to one
// Game Mode campaign (or to items in none) and switch the
// "group by campaign" view. Hidden until a campaign exists.
// ──────────────────────────────────────────────
import { useId } from "react";
import { ChevronDown, Layers, Swords } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { LibraryCampaign } from "../../../hooks/use-library-campaigns";
import { cn } from "../../../lib/utils";

export const CAMPAIGN_FILTER_ALL = "all";
export const CAMPAIGN_FILTER_NONE = "none";

interface LibraryCampaignBarProps {
  campaigns: LibraryCampaign[];
  value: string;
  onChange: (value: string) => void;
  groupByCampaign: boolean;
  onGroupByCampaignChange: (value: boolean) => void;
}

export function LibraryCampaignBar({
  campaigns,
  value,
  onChange,
  groupByCampaign,
  onGroupByCampaignChange,
}: LibraryCampaignBarProps) {
  const { t: localizeUi } = useUiTranslation();
  // Both library panels render this bar, so the label/select pair needs a per-instance id.
  const selectId = useId();
  if (campaigns.length === 0) return null;
  const filtered = value !== CAMPAIGN_FILTER_ALL;

  return (
    <div className="flex gap-1.5" data-component="LibraryCampaignBar">
      <label className="sr-only" htmlFor={selectId}>
        {localizeUi("ui.panels.libraryorganize.campaign")}
      </label>
      <div className="relative min-w-0 flex-1">
        <Swords
          size="0.75rem"
          className={cn(
            "mari-chrome-field-icon pointer-events-none absolute left-3 top-1/2 -translate-y-1/2",
            filtered && "text-[var(--marinara-chat-chrome-accent)]",
          )}
        />
        <select
          id={selectId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          title={localizeUi("ui.panels.libraryorganize.showOneCampaign")}
          className={cn(
            "mari-chrome-field h-10 w-full min-w-0 appearance-none truncate py-0 pl-8 pr-7 text-xs md:h-9",
            filtered && "ring-1 ring-[var(--marinara-chat-chrome-button-border-active)]",
          )}
        >
          <option value={CAMPAIGN_FILTER_ALL}>{localizeUi("ui.panels.libraryorganize.allCampaigns")}</option>
          {campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>
          ))}
          <option value={CAMPAIGN_FILTER_NONE}>{localizeUi("ui.panels.libraryorganize.notInAnyCampaign")}</option>
        </select>
        <ChevronDown
          size="0.75rem"
          className="mari-chrome-field-icon pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
        />
      </div>
      <button
        type="button"
        onClick={() => onGroupByCampaignChange(!groupByCampaign)}
        aria-pressed={groupByCampaign}
        className={cn(
          "mari-chrome-control mari-chrome-control--small h-10 shrink-0 px-2.5 md:h-9",
          groupByCampaign && "mari-chrome-control--selected",
        )}
        title={localizeUi("ui.panels.libraryorganize.groupByCampaign")}
        aria-label={localizeUi("ui.panels.libraryorganize.groupByCampaign")}
      >
        <Layers size="0.8125rem" />
      </button>
    </div>
  );
}
