// ──────────────────────────────────────────────
// Game: Compact Party Portraits Bar (top-left, horizontal)
// ──────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useGameModeStore } from "../../stores/game-mode.store";
import type { AvatarCrop } from "@marinara-engine/shared";
import { cn, getAvatarCropStyle } from "../../lib/utils";
import { NEUTRAL_SURFACE_VARIABLES } from "../ui/neutral-surface-styles";
import { useReducedAmbientEffects } from "../../hooks/use-reduced-ambient-effects";
import { useTranslation as useUiTranslation } from "react-i18next";
import { findBestNamedEntry } from "../../lib/game-character-name-match";

interface PartyBarMember {
  id: string;
  name: string;
  avatarUrl?: string | null;
  avatarCrop?: AvatarCrop | null;
  nameColor?: string;
  canRemove?: boolean;
}

interface PartyBarCard {
  title: string;
  subtitle?: string;
  mood?: string;
  status?: string;
  level?: number;
  avatarUrl?: string | null;
  avatarCrop?: AvatarCrop | null;
  stats?: Array<{ name: string; value: number; max?: number; color?: string }>;
  inventory?: Array<{ name: string; quantity?: number; location?: string }>;
  customFields?: Record<string, string>;
}

interface GamePartyBarProps {
  partyMembers: PartyBarMember[];
  partyCards: Record<string, PartyBarCard>;
  mobileMenuLabel?: string;
  onRemovePartyMember?: (member: PartyBarMember) => void;
  removingPartyMemberId?: string | null;
}

type PartyMemberVisual = {
  member: PartyBarMember;
  sheetId: string;
  avatarSrc?: string | null;
  avatarCrop?: AvatarCrop | null;
  hp?: { value: number; max: number } | null;
};

const HP_STAT_NAME = /^(hp|health|hit ?points?|vitality)$/i;

function resolveHpStat(card: PartyBarCard | undefined) {
  const stat = card?.stats?.find((entry) => HP_STAT_NAME.test(entry.name.trim()));
  if (!stat || typeof stat.max !== "number" || !(stat.max > 0) || !Number.isFinite(stat.value)) return null;
  return { value: Math.max(0, Math.min(stat.value, stat.max)), max: stat.max };
}

function PartyHpBar({ hp }: { hp?: { value: number; max: number } | null }) {
  if (!hp) return null;
  const ratio = hp.value / hp.max;
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-1 bottom-0.5 h-[3px] overflow-hidden rounded-full bg-black/55"
    >
      <span
        className={cn(
          "block h-full rounded-full",
          ratio > 0.5 ? "bg-emerald-400" : ratio > 0.25 ? "bg-amber-400" : "bg-red-500",
        )}
        style={{ width: Math.round(ratio * 100) + "%" }}
      />
    </span>
  );
}

function resolvePartyCardEntry(member: PartyBarMember, cards: Record<string, PartyBarCard>) {
  if (cards[member.id]) return [member.id, cards[member.id]] as const;
  const best = findBestNamedEntry(
    Object.entries(cards),
    member.name,
    ([, card]) => card.title,
    ([sheetId]) => sheetId,
  );
  return best ?? ([member.id, undefined] as const);
}

function PartyAvatar({
  visual,
  className,
  onOpen,
  label,
}: {
  visual: PartyMemberVisual;
  className?: string;
  onOpen?: () => void;
  label?: string;
}) {
  const { member, avatarSrc, avatarCrop, hp } = visual;
  const accessibleName = label ?? member.name;
  const focusClass =
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)]";

  if (avatarSrc) {
    if (!onOpen) {
      return (
        <span className={cn("relative block h-8 w-8 overflow-hidden rounded-lg", className)}>
          <img
            src={avatarSrc}
            alt={accessibleName}
            className="h-full w-full object-cover object-top"
            style={getAvatarCropStyle(avatarCrop)}
          />
          <PartyHpBar hp={hp} />
        </span>
      );
    }
    // The party bar promises "click to open character sheet", so the portrait opens the sheet directly
    // instead of going through the photo lightbox first.
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={accessibleName}
        className={cn(
          "relative block h-8 w-8 overflow-hidden rounded-lg border border-[var(--marinara-chat-chrome-button-border)] shadow-lg shadow-black/25 transition-colors group-hover:border-[var(--marinara-chat-chrome-button-border-hover)]",
          focusClass,
          className,
        )}
      >
        <img
          src={avatarSrc}
          alt=""
          draggable={false}
          className="h-full w-full object-cover object-top"
          style={getAvatarCropStyle(avatarCrop)}
        />
        <PartyHpBar hp={hp} />
      </button>
    );
  }

  const fallbackClass = cn(
    "relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-button-bg)] text-xs font-bold text-[var(--marinara-chat-chrome-button-text-hover)] shadow-lg shadow-black/25 transition-colors group-hover:border-[var(--marinara-chat-chrome-button-border-hover)]",
    className,
  );
  const fallbackStyle = member.nameColor ? { color: member.nameColor } : undefined;
  const initial = member.name.trim().charAt(0) || "?";

  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={cn(fallbackClass, focusClass)}
        style={fallbackStyle}
        aria-label={accessibleName}
      >
        {initial}
        <PartyHpBar hp={hp} />
      </button>
    );
  }

  return (
    <span className={fallbackClass} style={fallbackStyle} role="img" aria-label={accessibleName}>
      {initial}
      <PartyHpBar hp={hp} />
    </span>
  );
}

export function GamePartyBar({
  partyMembers,
  partyCards,
  mobileMenuLabel,
  onRemovePartyMember,
  removingPartyMemberId,
}: GamePartyBarProps) {
  const { t: localizeUi } = useUiTranslation();
  const openCharacterSheet = useGameModeStore((s) => s.openCharacterSheet);
  const reduceAmbientEffects = useReducedAmbientEffects();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  // Rotation pauses while the preview is pressed or focused so a tap or keypress opens the member it aimed at.
  const [previewHeld, setPreviewHeld] = useState(false);
  const [previewFocused, setPreviewFocused] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);
  const mobileMenuToggleRef = useRef<HTMLButtonElement | null>(null);

  const memberVisuals = useMemo(
    () =>
      partyMembers.map((member) => {
        const [sheetId, card] = resolvePartyCardEntry(member, partyCards);
        return {
          member,
          sheetId,
          avatarSrc: card?.avatarUrl ?? member.avatarUrl,
          avatarCrop: card?.avatarUrl ? (card.avatarCrop ?? null) : (member.avatarCrop ?? null),
          hp: resolveHpStat(card),
        };
      }),
    [partyCards, partyMembers],
  );

  useEffect(() => {
    setPreviewIndex((index) => (memberVisuals.length > 0 ? Math.min(index, memberVisuals.length - 1) : 0));
    if (memberVisuals.length <= 1) setMobileMenuOpen(false);
  }, [memberVisuals.length]);

  const rotationPaused = mobileMenuOpen || previewHeld || previewFocused;

  useEffect(() => {
    if (reduceAmbientEffects || rotationPaused || memberVisuals.length <= 1) return undefined;
    const intervalId = window.setInterval(() => {
      setPreviewIndex((index) => (index + 1) % memberVisuals.length);
    }, 2500);
    return () => window.clearInterval(intervalId);
  }, [memberVisuals.length, reduceAmbientEffects, rotationPaused]);

  useEffect(() => {
    if (!previewHeld) return undefined;
    // A pointer released outside the preview never fires its own pointerup, so listen on the window.
    const release = () => setPreviewHeld(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [previewHeld]);

  useEffect(() => {
    if (!mobileMenuOpen) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (mobileMenuRef.current?.contains(target)) return;
      setMobileMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setMobileMenuOpen(false);
      mobileMenuToggleRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileMenuOpen]);

  const describeMember = (visual: PartyMemberVisual) =>
    visual.hp
      ? localizeUi("ui.game.gamepartybar.value1HpValue2OfValue3", {
          value1: visual.member.name,
          value2: visual.hp.value,
          value3: visual.hp.max,
        })
      : visual.member.name;

  const canRemoveMember = (member: PartyBarMember) => Boolean(member.canRemove && onRemovePartyMember);

  const renderRemoveButton = (member: PartyBarMember, extraClassName?: string) => (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onRemovePartyMember?.(member);
      }}
      disabled={removingPartyMemberId === member.id}
      className={cn(
        "absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-button-bg)] text-[var(--marinara-chat-chrome-button-text-hover)] shadow-md transition-colors hover:bg-[var(--destructive)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60 before:absolute before:-inset-2 before:content-['']",
        extraClassName,
      )}
      aria-label={localizeUi("ui.game.gamepartybar.removeValue1FromParty", { value1: member.name })}
      title={localizeUi("ui.game.gamepartybar.removeValue1FromParty", { value1: member.name })}
    >
      <X className="h-2.5 w-2.5" aria-hidden="true" />
    </button>
  );

  if (partyMembers.length === 0) return null;

  return (
    <>
      <div ref={mobileMenuRef} className="relative shrink-0 lg:hidden">
        {memberVisuals[previewIndex] && (
          <div
            className="flex items-center gap-1"
            onPointerDown={() => setPreviewHeld(true)}
            onFocus={() => setPreviewFocused(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPreviewFocused(false);
            }}
          >
            <div className="group relative shrink-0">
              <PartyAvatar
                visual={memberVisuals[previewIndex]}
                className="h-9 w-9"
                label={describeMember(memberVisuals[previewIndex])}
                onOpen={() => openCharacterSheet(memberVisuals[previewIndex].sheetId)}
              />
              {/* With one member there is no menu, so the remove control lives on the preview itself. */}
              {memberVisuals.length === 1 &&
                canRemoveMember(memberVisuals[0].member) &&
                renderRemoveButton(memberVisuals[0].member)}
            </div>
            {memberVisuals.length > 1 && (
              <button
                ref={mobileMenuToggleRef}
                type="button"
                onClick={() => setMobileMenuOpen((open) => !open)}
                className="group relative block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)] before:absolute before:-inset-2 before:content-['']"
                aria-expanded={mobileMenuOpen}
                aria-label={
                  mobileMenuOpen
                    ? localizeUi("ui.game.gamepartybar.closePartyMembers")
                    : (mobileMenuLabel ?? localizeUi("ui.game.gamepartybar.openPartyMembers"))
                }
                title={mobileMenuLabel ?? localizeUi("ui.game.gamepartybar.openPartyMembers")}
              >
                <span className="flex h-6 min-w-6 items-center justify-center rounded-lg border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-button-bg)] px-1 text-xs font-bold leading-none text-[var(--marinara-chat-chrome-button-text-hover)] shadow-md">
                  {memberVisuals.length}
                </span>
              </button>
            )}
          </div>
        )}

        {mobileMenuOpen && memberVisuals.length > 1 && (
          <div
            className={cn(
              NEUTRAL_SURFACE_VARIABLES,
              "marinara-chat-popover absolute left-0 top-[calc(100%+0.375rem)] z-50 rounded-xl border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-panel-bg)] p-1.5 shadow-2xl backdrop-blur-md",
            )}
          >
            {/* p-1 keeps the corner remove buttons inside the scroll box instead of clipping them. */}
            <div className="flex max-h-[min(44svh,18rem)] flex-col items-center gap-1.5 overflow-y-auto overscroll-contain p-1 [-webkit-overflow-scrolling:touch]">
              {memberVisuals.map((visual) => (
                <div key={visual.member.id} className="group relative shrink-0">
                  <div
                    title={localizeUi("ui.game.gamepartybar.value1ClickToOpenCharacterSheet", {
                      value1: visual.member.name,
                    })}
                  >
                    <PartyAvatar
                      visual={visual}
                      className="h-9 w-9"
                      label={describeMember(visual)}
                      onOpen={() => {
                        openCharacterSheet(visual.sheetId);
                        setMobileMenuOpen(false);
                      }}
                    />
                  </div>
                  {canRemoveMember(visual.member) && renderRemoveButton(visual.member)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="scrollbar-hide hidden max-w-full touch-pan-x items-center gap-1.5 overflow-x-auto px-0.5 py-1 [-webkit-overflow-scrolling:touch] lg:flex">
        {memberVisuals.map((visual) => {
          const { member } = visual;

          return (
            <div
              key={member.id}
              className="group relative shrink-0 origin-left transition-transform duration-150 ease-out hover:scale-[1.03] active:scale-[0.98]"
            >
              <div title={localizeUi("ui.game.gamepartybar.value1ClickToOpenCharacterSheet", { value1: member.name })}>
                <PartyAvatar
                  visual={visual}
                  label={describeMember(visual)}
                  onOpen={() => openCharacterSheet(visual.sheetId)}
                />
              </div>
              {/* The lg: prefix is needed on the reveal states too; a bare group-hover/focus loses to lg:opacity-0. */}
              {canRemoveMember(member) &&
                renderRemoveButton(
                  member,
                  "lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 lg:focus-visible:opacity-100",
                )}
            </div>
          );
        })}
      </div>
    </>
  );
}
