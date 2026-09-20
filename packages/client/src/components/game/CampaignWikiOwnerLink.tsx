import { BookOpen, ImageOff, Loader2, UserRound } from "lucide-react";
import type { CampaignMemoryOwnerRef } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useCharacters, usePersonas } from "../../hooks/use-characters";
import { useGameModeStore } from "../../stores/game-mode.store";
import { useUIStore } from "../../stores/ui.store";
import { CharacterPhoto } from "../ui/CharacterPhoto";

interface CampaignWikiOwnerLinkProps {
  owner: CampaignMemoryOwnerRef;
  fallbackName: string;
}

type OwnerRecord = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

function readOwnerRecord(value: unknown): OwnerRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  const name = typeof row.name === "string" ? row.name : "";
  const avatar = row.avatarUrl ?? row.avatarPath;
  return {
    id: row.id,
    name,
    avatarUrl: typeof avatar === "string" && avatar.trim() ? avatar : null,
  };
}

export function CampaignWikiOwnerLink({ owner, fallbackName }: CampaignWikiOwnerLinkProps) {
  const { t } = useUiTranslation();
  const isCharacterOwner = owner.type === "existing" && owner.store === "characters";
  const isPersonaOwner = owner.type === "existing" && owner.store === "personas";
  const isLocationOwner = owner.type === "existing" && owner.store === "spatial-context";
  const characters = useCharacters({ enabled: isCharacterOwner });
  const personas = usePersonas(isPersonaOwner);
  const rows = isCharacterOwner ? characters.data : isPersonaOwner ? personas.data : undefined;
  const record = Array.isArray(rows)
    ? (rows.map(readOwnerRecord).find((candidate) => candidate?.id === owner.recordId) ?? null)
    : null;
  const loading = isCharacterOwner ? characters.isLoading : isPersonaOwner ? personas.isLoading : false;
  const canOpen = record !== null;
  const label = record?.name || fallbackName;
  const openOwner = () => {
    if (!record || owner.type !== "existing") return;
    if (isCharacterOwner) {
      useGameModeStore.getState().openCharacterSheet(record.id);
    } else if (isPersonaOwner) {
      useUIStore.getState().openPersonaDetail(record.id);
    }
  };

  if (loading) {
    return (
      <span className="mt-3 inline-flex min-h-9 items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
        <Loader2 size={13} className="animate-spin" aria-hidden="true" />
        {t("ui.game.campaignWiki.owner.loading")}
      </span>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      {isLocationOwner && (
        // Place images are only ever attached by stable association; none exists yet, so say so.
        <div
          role="img"
          aria-label={t("ui.game.campaignWiki.placeholder.location")}
          className="flex h-20 w-full max-w-xs items-center justify-center gap-2 rounded-md border border-dashed border-[var(--border)] bg-[var(--secondary)] px-3 text-center text-xs text-[var(--muted-foreground)]"
        >
          <ImageOff size={16} aria-hidden="true" />
          <span>{t("ui.game.campaignWiki.placeholder.location")}</span>
        </div>
      )}
      <div className="flex items-center gap-2">
        {record?.avatarUrl ? (
          <CharacterPhoto
            src={record.avatarUrl}
            name={label}
            alt={t("ui.game.campaignWiki.portrait.alt", { name: label })}
            className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
            onUpdate={canOpen ? openOwner : undefined}
            updateLabel={t("ui.game.campaignWiki.owner.open", { name: label })}
          >
            <img
              src={record.avatarUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-7 w-7 rounded-full object-cover"
            />
          </CharacterPhoto>
        ) : (
          <span
            role="img"
            aria-label={t("ui.game.campaignWiki.placeholder.portrait", { name: label })}
            title={t("ui.game.campaignWiki.placeholder.portrait", { name: label })}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--secondary)] text-[var(--muted-foreground)]"
          >
            <UserRound size={14} aria-hidden="true" />
          </span>
        )}
        {canOpen ? (
          <button
            type="button"
            onClick={openOwner}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-xs hover:bg-[var(--secondary)]"
            aria-label={t("ui.game.campaignWiki.owner.open", { name: label })}
          >
            <BookOpen size={13} aria-hidden="true" />
            {label}
          </button>
        ) : (
          <span className="text-xs text-[var(--muted-foreground)]">
            {label} · {t("ui.game.campaignWiki.owner.unavailable")}
          </span>
        )}
      </div>
    </div>
  );
}
