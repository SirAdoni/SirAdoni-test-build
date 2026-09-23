// ──────────────────────────────────────────────
// NPC quick reference popover: avatar, a short description, tags, and buttons
// to open the card or list where the character is used. Shown for linked names
// in chat messages and Game narration when the setting is on.
// ──────────────────────────────────────────────
import { useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BarChart3, ExternalLink, Loader2, X } from "lucide-react";
import { useCharacter } from "../../hooks/use-characters";
import { useCharacterUsage } from "../../hooks/use-character-usage";
import { openChatFromPalette } from "../command-palette/palette-navigation";
import { formatRelativeContact } from "../../lib/relative-time";
import { placeNpcPeek, readNpcPeekSummary, type NpcPeekSummary } from "../../lib/npc-quick-reference";

export interface NpcPeekCharacter {
  id: string;
  name: string;
  avatarUrl?: string | null;
  summary?: NpcPeekSummary;
}

const USAGE_ROWS = 5;
const stopReactBubbling = (event: SyntheticEvent) => event.stopPropagation();

function UsageList({ characterId }: { characterId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useCharacterUsage(characterId);
  if (isLoading) return <Loader2 size="0.75rem" className="animate-spin text-[var(--muted-foreground)]" />;
  if (isError || !data) return <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{t("characters.usage.failed")}</p>;
  if (data.chats.length === 0)
    return <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{t("characters.usage.neverUsed")}</p>;
  const summary = [
    t("characters.usage.chatCount", { count: data.chats.length }),
    data.games.length > 0 ? t("characters.usage.gameCount", { count: data.games.length }) : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div>
      <p className="pb-1 text-[0.6875rem] text-[var(--muted-foreground)]">{summary}</p>
      <ul>
        {data.chats.slice(0, USAGE_ROWS).map((usage) => (
          <li key={usage.chatId}>
            <button
              type="button"
              onClick={() => void openChatFromPalette(usage.chatId)}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
              title={t("characters.usage.openChat")}
            >
              <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">{usage.chatName}</span>
              <span className="shrink-0 text-[0.625rem] text-[var(--muted-foreground)]">
                {formatRelativeContact(usage.lastActivityAt) ?? ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NpcQuickReferencePopover({
  character,
  anchor,
  library,
  focusOnOpen,
  onOpenCard,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: {
  character: NpcPeekCharacter;
  anchor: HTMLElement;
  /** Library cards can load their full description and usage; game-local NPCs only show what the game knows. */
  library: boolean;
  focusOnOpen: boolean;
  onOpenCard: () => void;
  onClose: (restoreFocus: boolean) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const detail = useCharacter(library ? character.id : null);
  const loaded = detail.data ? readNpcPeekSummary(detail.data) : null;
  const summary = loaded && (loaded.description || loaded.tags.length) ? loaded : (character.summary ?? loaded);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      setPosition(
        placeNpcPeek(
          rect,
          { width: element.offsetWidth, height: element.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [anchor]);

  useEffect(() => {
    if (focusOnOpen) ref.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [focusOnOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      // Only move focus back to the name when it was on the popover or the name, never out of the chat input.
      const active = document.activeElement;
      onClose(Boolean(active && (ref.current?.contains(active) || anchor.contains(active))));
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      onClose(false);
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      onClose(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={character.name}
      data-component="NpcQuickReference"
      style={{
        position: "fixed",
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        zIndex: 10050,
        visibility: position ? "visible" : "hidden",
      }}
      className="w-[min(18rem,calc(100vw-1rem))] select-none rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 text-[var(--foreground)] shadow-xl"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      // React bubbles portal events through the component tree, so without this a click or
      // double-click in the card would reach the message (tap actions, double-click to edit).
      onClick={stopReactBubbling}
      onDoubleClick={stopReactBubbling}
      onPointerDown={stopReactBubbling}
      onPointerUp={stopReactBubbling}
      onMouseDown={stopReactBubbling}
      onMouseUp={stopReactBubbling}
      onTouchStart={stopReactBubbling}
      onTouchEnd={stopReactBubbling}
      onContextMenu={stopReactBubbling}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Tab" || !ref.current) return;
        // Keep keyboard focus inside the popover until Escape closes it.
        const focusable = [...ref.current.querySelectorAll<HTMLElement>("button")];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="flex items-start gap-2.5">
        {character.avatarUrl ? (
          <img
            src={character.avatarUrl}
            alt=""
            className="h-11 w-11 shrink-0 rounded-lg object-cover ring-1 ring-[var(--border)]"
          />
        ) : (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[var(--secondary)] text-base font-semibold text-[var(--muted-foreground)]">
            {character.name.trim().charAt(0).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{character.name}</p>
          {summary?.tags.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {summary.tags.map((tag) => (
                <span
                  key={tag}
                  className="max-w-[8rem] truncate rounded-full bg-[var(--secondary)] px-1.5 py-px text-[0.625rem] text-[var(--muted-foreground)]"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onClose(true)}
          className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
          aria-label={t("ui.characterReferences.peek.close")}
          title={t("ui.characterReferences.peek.close")}
        >
          <X size="0.875rem" />
        </button>
      </div>
      {detail.isLoading && !summary ? (
        <Loader2 size="0.75rem" className="mt-2 animate-spin text-[var(--muted-foreground)]" />
      ) : summary?.description ? (
        <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-line text-xs leading-relaxed text-[var(--muted-foreground)]">
          {summary.description}
        </p>
      ) : (
        <p className="mt-2 text-xs italic text-[var(--muted-foreground)]">
          {t("ui.characterReferences.peek.noDescription")}
        </p>
      )}
      {showUsage && library ? (
        <div className="mt-2 border-t border-[var(--border)] pt-2">
          <UsageList characterId={character.id} />
        </div>
      ) : null}
      <div className="mt-2.5 flex gap-1.5">
        <button
          type="button"
          onClick={onOpenCard}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--primary)] px-2 py-1.5 text-xs font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
        >
          <ExternalLink size="0.75rem" />
          {t("ui.characterReferences.peek.openCard")}
        </button>
        {library ? (
          <button
            type="button"
            onClick={() => setShowUsage((value) => !value)}
            aria-expanded={showUsage}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] px-2 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
          >
            <BarChart3 size="0.75rem" />
            {t("ui.characterReferences.peek.usage")}
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
