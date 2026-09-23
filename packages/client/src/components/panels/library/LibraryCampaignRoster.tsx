// ──────────────────────────────────────────────
// Campaign roster: who a Game Mode campaign uses, by role
// (game master, party, linked NPC cards, added by hand).
// Shown above the Characters list while it is filtered to
// one campaign; a tap opens the character card.
// ──────────────────────────────────────────────
import { useMemo, useState } from "react";
import { ChevronRight, User, Users } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { normalizeAvatarCrop } from "@marinara-engine/shared";
import { useCharacterSummaries } from "../../../hooks/use-characters";
import type { LibraryCampaign } from "../../../hooks/use-library-campaigns";
import { buildCampaignRosterGroups, type CampaignRosterRole } from "../../../lib/library-campaign-roster";
import { AvatarImage } from "../../characters/AvatarImage";
import { SmoothFolderContent } from "../../ui/SmoothFolderContent";
import { cn, getAvatarCropStyle } from "../../../lib/utils";

/** Chips shown per role before a "+N more" button; a big NPC list would bury the character list. */
const ROSTER_GROUP_PREVIEW = 8;

const ROLE_LABEL_KEYS: Record<CampaignRosterRole, string> = {
  gm: "ui.panels.libraryorganize.rosterGm",
  party: "ui.panels.libraryorganize.rosterParty",
  npc: "ui.panels.libraryorganize.rosterNpcs",
  other: "ui.panels.libraryorganize.rosterOther",
};

interface LibraryCampaignRosterProps {
  campaign: LibraryCampaign;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenCharacter: (characterId: string) => void;
}

export function LibraryCampaignRoster({ campaign, open, onOpenChange, onOpenCharacter }: LibraryCampaignRosterProps) {
  const { t: localizeUi } = useUiTranslation();
  const groups = useMemo(() => buildCampaignRosterGroups(campaign), [campaign]);
  const [expandedRoles, setExpandedRoles] = useState<ReadonlySet<string>>(() => new Set());
  const memberIds = useMemo(() => groups.flatMap((group) => group.characterIds), [groups]);
  const summaries = useCharacterSummaries(memberIds, open);
  const summaryById = useMemo(
    () => new Map((summaries.data ?? []).map((summary) => [summary.id, summary])),
    [summaries.data],
  );
  if (memberIds.length === 0) return null;

  return (
    <section
      data-component="LibraryCampaignRoster"
      className="rounded-xl border border-[var(--border)]/60 bg-[var(--secondary)]/30"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex min-h-8 w-full items-center gap-1.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-[var(--sidebar-accent)]/40"
      >
        <ChevronRight
          size="0.75rem"
          className={cn(
            "mari-chrome-accent-icon mari-accent-animated shrink-0 transition-transform duration-200 ease-out",
            open && "rotate-90",
          )}
        />
        <Users size="0.6875rem" className="shrink-0 text-[var(--muted-foreground)]" />
        <span className="min-w-0 flex-1 truncate text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {localizeUi("ui.panels.libraryorganize.rosterTitle")}
        </span>
        <span className="shrink-0 rounded-md bg-[var(--secondary)] px-1.5 text-[0.5625rem] text-[var(--muted-foreground)]">
          {memberIds.length}
        </span>
      </button>
      <SmoothFolderContent open={open} className="px-2 pb-2" innerClassName="flex flex-col gap-1.5">
        {open &&
          groups.map((group) => (
            <div key={group.role} className="flex flex-col gap-1" data-roster-role={group.role}>
              <div className="text-[0.5625rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                {localizeUi(ROLE_LABEL_KEYS[group.role])}
              </div>
              <div className="flex flex-wrap gap-1">
                {(expandedRoles.has(group.role)
                  ? group.characterIds
                  : group.characterIds.slice(0, ROSTER_GROUP_PREVIEW)
                ).map((id) => {
                  const summary = summaryById.get(id);
                  const name = summary?.name ?? "...";
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => onOpenCharacter(id)}
                      title={localizeUi("ui.game.npcsview.openCharacterCard")}
                      className="mari-chrome-control mari-chrome-control--compact inline-flex max-w-[10rem] items-center gap-1 py-0.5 pl-0.5 pr-2"
                    >
                      <span className="mari-avatar-placeholder mari-avatar-placeholder--character relative flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full">
                        {summary?.avatarUrl ? (
                          <AvatarImage
                            src={summary.avatarUrl}
                            alt=""
                            loading="lazy"
                            iconSize="0.625rem"
                            className="absolute inset-0 h-full w-full object-cover"
                            style={getAvatarCropStyle(normalizeAvatarCrop(summary.avatarCrop) ?? undefined)}
                          />
                        ) : (
                          <User size="0.625rem" />
                        )}
                      </span>
                      <span className="truncate text-[0.625rem]">{name}</span>
                    </button>
                  );
                })}
                {group.characterIds.length > ROSTER_GROUP_PREVIEW && (
                  <button
                    type="button"
                    aria-expanded={expandedRoles.has(group.role)}
                    onClick={() =>
                      setExpandedRoles((current) => {
                        const next = new Set(current);
                        if (next.has(group.role)) next.delete(group.role);
                        else next.add(group.role);
                        return next;
                      })
                    }
                    className="mari-chrome-control mari-chrome-control--compact px-2 py-0.5 text-[0.625rem]"
                  >
                    {expandedRoles.has(group.role)
                      ? localizeUi("ui.panels.libraryorganize.rosterShowFewer")
                      : localizeUi("ui.panels.libraryorganize.rosterShowMore", {
                          count: group.characterIds.length - ROSTER_GROUP_PREVIEW,
                        })}
                  </button>
                )}
              </div>
            </div>
          ))}
      </SmoothFolderContent>
    </section>
  );
}
