import {
  BookOpen,
  ChevronRight,
  ImageOff,
  Loader2,
  Map as MapIcon,
  MapPin,
  User,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { CampaignMemoryOwnerRef, Lorebook } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useCharacters, usePersonas } from "../../hooks/use-characters";
import { useChat } from "../../hooks/use-chats";
import { lorebookKeys, useEntriesAcrossLorebooks } from "../../hooks/use-lorebooks";
import { api } from "../../lib/api-client";
import { openLorebookEntry } from "../../lib/lorebook-entry-focus";
import { useChatStore } from "../../stores/chat.store";
import { useGameModeStore } from "../../stores/game-mode.store";
import { useUIStore } from "../../stores/ui.store";
import { cn } from "../../lib/utils";
import { AvatarImage } from "../characters/AvatarImage";
import { EntityAvatar } from "./campaign-wiki-ui";

interface CampaignWikiOwnerLinkProps {
  owner: CampaignMemoryOwnerRef;
  fallbackName: string;
  /** Page chat; when given, a location owner offers to open that chat's map. */
  chatId?: string | null;
  className?: string;
}

type OwnerRecord = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

type OwnerType = "character" | "persona" | "location" | "lorebook" | "other";

const OWNER_ICONS: Record<OwnerType, LucideIcon> = {
  character: User,
  persona: UserRound,
  location: MapPin,
  lorebook: BookOpen,
  other: BookOpen,
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

function ownerTypeOf(owner: CampaignMemoryOwnerRef): OwnerType {
  if (owner.type !== "existing") return "other";
  switch (owner.store) {
    case "characters":
      return "character";
    case "personas":
      return "persona";
    case "spatial-context":
      return "location";
    case "lorebook-entries":
    case "lorebooks":
      return "lorebook";
    default:
      return "other";
  }
}

function activeLorebookIdsOf(metadata: unknown): string[] {
  try {
    const meta = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    const ids = meta && typeof meta === "object" ? (meta as Record<string, unknown>).activeLorebookIds : null;
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

type LorebookTarget = { lorebookId: string; entryId: string | null; name: string };

/**
 * Finds the lorebook that holds a lore page's entry. The owner ref carries only the entry id, so the entry is looked
 * up where the server allows lore owners to live: lorebooks scoped to the chat and the chat's active lorebooks first,
 * then (only on a miss) the other chat-scoped lorebooks, where earlier sessions of the campaign keep their entries.
 */
function useLorebookOwner(owner: CampaignMemoryOwnerRef, chatId: string | null) {
  const store = owner.type === "existing" ? owner.store : null;
  const isEntry = store === "lorebook-entries";
  const isBook = store === "lorebooks";
  // Same key and payload as useLorebooks(), so the library's cached list is reused; only fetched for lore owners.
  const books = useQuery({
    queryKey: lorebookKeys.list(),
    queryFn: () => api.get<Lorebook[]>("/lorebooks"),
    enabled: isEntry || isBook,
    staleTime: 5 * 60_000,
  });
  const chat = useChat(isEntry ? chatId : null);
  const bookList = Array.isArray(books.data) ? books.data : [];
  // The near lookup waits for the lorebook list and the chat, so an empty candidate list never reads as "not found".
  const nearReady = isEntry && Boolean(books.data) && (!chatId || Boolean(chat.data) || chat.isError);
  const nearIds = nearReady
    ? [
        ...bookList.filter((book) => chatId && book.chatId === chatId).map((book) => book.id),
        // A deleted active lorebook would fail its entries fetch; only look in books that still exist.
        ...activeLorebookIdsOf(chat.data?.metadata).filter((id) => bookList.some((book) => book.id === id)),
      ]
    : [];
  const near = useEntriesAcrossLorebooks(nearIds);
  const nearHit = near.entries?.find((entry) => entry.id === owner.recordId) ?? null;
  const farIds =
    nearReady && near.entries && !nearHit
      ? bookList.filter((book) => book.chatId && !nearIds.includes(book.id)).map((book) => book.id)
      : [];
  const far = useEntriesAcrossLorebooks(farIds);
  const farHit = far.entries?.find((entry) => entry.id === owner.recordId) ?? null;

  if (isBook) {
    const book = bookList.find((candidate) => candidate.id === owner.recordId);
    return {
      loading: books.isLoading,
      target: book ? ({ lorebookId: book.id, entryId: null, name: book.name } satisfies LorebookTarget) : null,
    };
  }
  if (!isEntry) return { loading: false, target: null };
  const hit = nearHit ?? farHit;
  const settled =
    books.isError ||
    (nearReady && (near.isError || (farIds.length > 0 ? Boolean(far.entries) || far.isError : Boolean(near.entries))));
  return {
    loading: !hit && !settled,
    target: hit ? ({ lorebookId: hit.lorebookId, entryId: hit.id, name: hit.name } satisfies LorebookTarget) : null,
  };
}

const BUTTON_CLASS =
  "group/owner inline-flex min-h-11 max-w-full items-center gap-2.5 rounded-xl border border-border bg-secondary/40 py-1.5 pl-1.5 pr-3 text-left transition-colors hover:border-primary/50 hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

/**
 * Link from a wiki page to the real record that owns it: the character card, persona, lorebook entry, or map location.
 * Characters and personas resolve from the lists the client already loads; lore owners look up their lorebook.
 */
export function CampaignWikiOwnerLink({ owner, fallbackName, chatId, className }: CampaignWikiOwnerLinkProps) {
  const { t } = useUiTranslation();
  const ownerType = ownerTypeOf(owner);
  const isCharacterOwner = ownerType === "character";
  const isPersonaOwner = ownerType === "persona";
  const isLocationOwner = ownerType === "location";
  const isLorebookOwner = ownerType === "lorebook";
  const activeChatId = useChatStore((s) => s.activeChatId);
  const lore = useLorebookOwner(owner, chatId ?? activeChatId ?? null);
  const characters = useCharacters({ enabled: isCharacterOwner });
  const personas = usePersonas(isPersonaOwner);
  const rows = isCharacterOwner ? characters.data : isPersonaOwner ? personas.data : undefined;
  const record = Array.isArray(rows)
    ? (rows.map(readOwnerRecord).find((candidate) => candidate?.id === owner.recordId) ?? null)
    : lore.target
      ? { id: lore.target.lorebookId, name: lore.target.name, avatarUrl: null }
      : null;
  const loading = isCharacterOwner
    ? characters.isLoading
    : isPersonaOwner
      ? personas.isLoading
      : isLorebookOwner
        ? lore.loading
        : false;
  const canOpen = record !== null;
  const canOpenMap = isLocationOwner && Boolean(chatId);
  const label = record?.name || fallbackName;
  const Icon = OWNER_ICONS[ownerType];

  const openOwner = () => {
    if (!record || owner.type !== "existing") return;
    if (isCharacterOwner) {
      useGameModeStore.getState().openCharacterSheet(record.id);
    } else if (isPersonaOwner) {
      useUIStore.getState().openPersonaDetail(record.id);
    } else if (lore.target) {
      if (lore.target.entryId) openLorebookEntry(lore.target.lorebookId, lore.target.entryId);
      else useUIStore.getState().openLorebookDetail(lore.target.lorebookId);
    }
  };

  // A wiki-only page has no outside record to link to.
  if (owner.type !== "existing") return null;

  if (loading) {
    return (
      <span
        data-component="campaign-wiki-owner-link"
        className={cn("mt-3 inline-flex min-h-11 items-center gap-2 text-xs text-muted-foreground", className)}
      >
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        {isLorebookOwner
          ? t("ui.game.campaignWiki.owner.loadingLorebook", { defaultValue: "Loading linked lorebook entry..." })
          : t("ui.game.campaignWiki.owner.loading")}
      </span>
    );
  }

  const actionLabel = isCharacterOwner
    ? t("ui.game.campaignWiki.owner.openCharacter", { defaultValue: "Open character card" })
    : isPersonaOwner
      ? t("ui.game.campaignWiki.owner.openPersona", { defaultValue: "Open persona" })
      : isLocationOwner
        ? t("ui.game.campaignWiki.owner.openMap", { defaultValue: "Open on the map" })
        : ownerType === "lorebook"
          ? owner.store === "lorebooks"
            ? t("ui.game.campaignWiki.owner.openLorebook", { defaultValue: "Open lorebook" })
            : t("ui.game.campaignWiki.owner.lorebookEntry", { defaultValue: "Lorebook entry" })
          : t("ui.game.campaignWiki.owner.linkedRecord", { defaultValue: "Linked record" });

  const avatar =
    record?.avatarUrl && canOpen ? (
      <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded-full">
        <AvatarImage
          src={record.avatarUrl}
          alt={t("ui.game.campaignWiki.portrait.alt", { name: label })}
          loading="lazy"
          className="h-8 w-8 rounded-full border border-border object-cover"
        />
      </span>
    ) : (
      <EntityAvatar
        name={label}
        kind={isCharacterOwner ? "character" : isPersonaOwner ? "persona" : isLocationOwner ? "location" : "lore"}
        size={32}
      />
    );

  const text = (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="flex items-center gap-1 text-xs font-semibold text-foreground">
        <Icon size={12} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        <span className="truncate">{actionLabel}</span>
      </span>
      <span className="truncate text-[0.6875rem] text-muted-foreground">{label}</span>
    </span>
  );

  if (canOpen) {
    // The portrait keeps its own fullscreen viewer, so it sits beside the button rather than inside it.
    return (
      <div
        data-component="campaign-wiki-owner-link"
        className={cn("mt-3 flex max-w-full items-center gap-2", className)}
      >
        {record?.avatarUrl && avatar}
        <button
          type="button"
          onClick={openOwner}
          className={cn(BUTTON_CLASS, record?.avatarUrl && "pl-3")}
          aria-label={t("ui.game.campaignWiki.owner.open", { name: label })}
        >
          {!record?.avatarUrl && avatar}
          {text}
          <ChevronRight
            size={14}
            aria-hidden="true"
            className="ml-auto shrink-0 text-muted-foreground transition-transform group-hover/owner:translate-x-0.5"
          />
        </button>
      </div>
    );
  }

  if (canOpenMap) {
    return (
      <div
        data-component="campaign-wiki-owner-link"
        className={cn("mt-3 flex flex-wrap items-center gap-2", className)}
      >
        <button
          type="button"
          onClick={() => chatId && useUIStore.getState().openSpatialMapDetail(chatId)}
          className={BUTTON_CLASS}
          aria-label={t("ui.game.campaignWiki.owner.openMapFor", {
            name: label,
            defaultValue: "Open {{name}} on the map",
          })}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
            <MapIcon size={15} aria-hidden="true" />
          </span>
          {text}
          <ChevronRight size={14} aria-hidden="true" className="ml-auto shrink-0 text-muted-foreground" />
        </button>
        <LocationImageNote />
      </div>
    );
  }

  return (
    <div data-component="campaign-wiki-owner-link" className={cn("mt-3 flex flex-wrap items-center gap-2", className)}>
      <div className="inline-flex min-h-11 max-w-full items-center gap-2.5 rounded-xl border border-dashed border-border py-1.5 pl-1.5 pr-3">
        {avatar}
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="flex items-center gap-1 text-xs font-semibold text-muted-foreground">
            <Icon size={12} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{label}</span>
          </span>
          <span className="text-[0.6875rem] text-muted-foreground">{t("ui.game.campaignWiki.owner.unavailable")}</span>
        </span>
      </div>
      {isLocationOwner && <LocationImageNote />}
    </div>
  );
}

/** Place images are only ever attached by stable association; none exists yet, so say so quietly. */
function LocationImageNote() {
  const { t } = useUiTranslation();
  return (
    <span
      role="img"
      aria-label={t("ui.game.campaignWiki.placeholder.location")}
      title={t("ui.game.campaignWiki.placeholder.location")}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-secondary/50 px-2.5 text-[0.6875rem] text-muted-foreground"
    >
      <ImageOff size={13} aria-hidden="true" />
      {t("ui.game.campaignWiki.owner.noPlaceImage", { defaultValue: "No place image yet" })}
    </span>
  );
}
