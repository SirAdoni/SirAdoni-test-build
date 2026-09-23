// ──────────────────────────────────────────────
// "Group by campaign" view: one collapsible section per
// campaign (an item in two campaigns shows in both), then
// the items that belong to no campaign.
// ──────────────────────────────────────────────
import type { ReactNode } from "react";
import { ChevronRight, Swords } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { LibraryCampaign } from "../../../hooks/use-library-campaigns";
import { SmoothFolderContent } from "../../ui/SmoothFolderContent";
import { cn } from "../../../lib/utils";

export const NO_CAMPAIGN_SECTION_ID = "__no-campaign__";

interface LibraryCampaignSectionsProps<T extends { id: string }> {
  campaigns: LibraryCampaign[];
  items: T[];
  membership: Map<string, LibraryCampaign[]>;
  collapsedIds: ReadonlySet<string>;
  onToggle: (sectionId: string, collapsed: boolean) => void;
  renderItem: (item: T, sectionId: string) => ReactNode;
  /** Show the "not in any campaign" section (hidden while filtering to one campaign). */
  showUnassigned?: boolean;
}

export function LibraryCampaignSections<T extends { id: string }>({
  campaigns,
  items,
  membership,
  collapsedIds,
  onToggle,
  renderItem,
  showUnassigned = true,
}: LibraryCampaignSectionsProps<T>) {
  const { t: localizeUi } = useUiTranslation();
  const sections: Array<{ id: string; name: string; meta?: string; items: T[] }> = [];
  for (const campaign of campaigns) {
    const sectionItems = items.filter((item) =>
      membership.get(item.id)?.some((candidate) => candidate.id === campaign.id),
    );
    if (sectionItems.length === 0) continue;
    sections.push({
      id: campaign.id,
      name: campaign.name,
      meta: localizeUi("ui.panels.libraryorganize.sessionCount", { count: campaign.sessionCount }),
      items: sectionItems,
    });
  }
  if (showUnassigned) {
    const unassigned = items.filter((item) => !membership.get(item.id)?.length);
    if (unassigned.length > 0) {
      sections.push({
        id: NO_CAMPAIGN_SECTION_ID,
        name: localizeUi("ui.panels.libraryorganize.notInAnyCampaign"),
        items: unassigned,
      });
    }
  }

  return (
    <div className="flex flex-col gap-1" data-component="LibraryCampaignSections">
      {sections.map((section) => {
        const open = !collapsedIds.has(section.id);
        return (
          <section key={section.id} className="flex flex-col">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => onToggle(section.id, open)}
              className="group flex min-h-8 w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--sidebar-accent)]/40"
            >
              <ChevronRight
                size="0.75rem"
                className={cn(
                  "mari-chrome-accent-icon mari-accent-animated shrink-0 transition-transform duration-200 ease-out",
                  open && "rotate-90",
                )}
              />
              {section.id !== NO_CAMPAIGN_SECTION_ID && (
                <Swords size="0.6875rem" className="shrink-0 text-[var(--muted-foreground)]" />
              )}
              <span className="min-w-0 flex-1 truncate text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                {section.name}
              </span>
              {section.meta && (
                <span className="shrink-0 text-[0.5625rem] text-[var(--muted-foreground)] max-[360px]:hidden">
                  {section.meta}
                </span>
              )}
              <span className="shrink-0 rounded-md bg-[var(--secondary)] px-1.5 text-[0.5625rem] text-[var(--muted-foreground)]">
                {section.items.length}
              </span>
            </button>
            <SmoothFolderContent
              open={open}
              className="ml-3 border-l border-[var(--border)]/30 pb-1 pl-1 md:ml-4"
              innerClassName="flex flex-col gap-0.5"
            >
              {/* Closed sections skip their rows: a big library can list hundreds per campaign. */}
              {open && section.items.map((item) => renderItem(item, section.id))}
            </SmoothFolderContent>
          </section>
        );
      })}
    </div>
  );
}
