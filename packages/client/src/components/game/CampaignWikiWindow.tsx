import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight, DatabaseZap, Loader2 } from "lucide-react";
import type { CampaignMemoryEntity, CampaignMemoryEntityKind, CampaignMemoryPage } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { useGameModeStore, type CampaignWikiNavState } from "../../stores/game-mode.store";
import { Modal } from "../ui/Modal";
import { CampaignIndexDialog } from "./CampaignIndexDialog";

const CampaignWiki = lazy(async () => {
  const module = await import("./CampaignWiki");
  return { default: module.CampaignWiki };
});

/**
 * Where a deep link should land. `owner` is the stable `<store>:<recordId>`
 * identity of a game record (never a name); `search` only prefills the reader's
 * search and never selects a page on the reader's behalf.
 */
export type CampaignWikiTarget =
  | { kind: "owner"; owner: string; name: string; entityKind?: CampaignMemoryEntityKind }
  | { kind: "search"; query: string; entityKind?: CampaignMemoryEntityKind };

/**
 * Navigation contract between this window and the reader (CampaignWiki.tsx).
 * The window owns the selected page and its history; the reader reports
 * selection changes through `onSelectedEntityChange` and applies
 * `selectedEntityId` as its current page.
 */
export interface CampaignWikiNavigationProps {
  selectedEntityId: string | null;
  onSelectedEntityChange: (entityId: string | null) => void;
  /** Search text applied when the reader mounts (deep links by name). */
  initialSearch?: string;
  initialKind?: CampaignMemoryEntityKind | "all";
}

interface CampaignWikiWindowProps {
  chatId: string;
  onClose: () => void;
  target?: CampaignWikiTarget | null;
}

const HISTORY_LIMIT = 50;
const SCROLL_RESTORE_TIMEOUT_MS = 5000;

function emptyNav(chatId: string): CampaignWikiNavState {
  return { chatId, entityId: null, back: [], forward: [], scrollTop: 0 };
}

function readNav(chatId: string): CampaignWikiNavState {
  const nav = useGameModeStore.getState().campaignWikiNav;
  return nav?.chatId === chatId ? nav : emptyNav(chatId);
}

/** Open a page, recording the current one so back can return to it. */
export function pushCampaignWikiPage(chatId: string, entityId: string | null) {
  const current = readNav(chatId);
  if (current.entityId === entityId) return;
  useGameModeStore.getState().setCampaignWikiNav({
    chatId,
    entityId,
    back: [...current.back, current.entityId].slice(-HISTORY_LIMIT),
    forward: [],
    scrollTop: 0,
  });
}

/** Move one step through history; returns false when there is nothing to move to. */
export function stepCampaignWikiHistory(chatId: string, direction: "back" | "forward"): boolean {
  const current = readNav(chatId);
  const source = direction === "back" ? current.back : current.forward;
  if (!source.length) return false;
  const entityId = direction === "back" ? current.back[current.back.length - 1] : current.forward[0];
  useGameModeStore.getState().setCampaignWikiNav({
    chatId,
    entityId: entityId ?? null,
    back: direction === "back" ? current.back.slice(0, -1) : [...current.back, current.entityId],
    forward: direction === "back" ? [current.entityId, ...current.forward] : current.forward.slice(1),
    scrollTop: 0,
  });
  return true;
}

function ownerFallbackKind(owner: string): CampaignMemoryEntityKind | undefined {
  const store = owner.slice(0, owner.indexOf(":"));
  if (store === "characters" || store === "game-npcs") return "character";
  if (store === "personas") return "persona";
  if (store === "spatial-context") return "location";
  return undefined;
}

export function CampaignWikiWindow({ chatId, onClose, target = null }: CampaignWikiWindowProps) {
  const { t } = useUiTranslation();
  const [editorDirty, setEditorDirty] = useState(false);
  const [indexOpen, setIndexOpen] = useState(false);
  const handleDirtyChange = useCallback((dirty: boolean) => setEditorDirty(dirty), []);
  const storedNav = useGameModeStore((s) => s.campaignWikiNav);
  const nav = storedNav?.chatId === chatId ? storedNav : null;
  const selectedEntityId = nav?.entityId ?? null;
  const confirmLeave = useCallback(
    () => !editorDirty || window.confirm(t("ui.game.campaignWiki.editor.unsavedConfirm")),
    [editorDirty, t],
  );
  const close = useCallback(() => {
    if (confirmLeave()) onClose();
  }, [confirmLeave, onClose]);
  const step = (direction: "back" | "forward") => {
    if (!confirmLeave()) return;
    stepCampaignWikiHistory(chatId, direction);
  };
  const handleSelectedEntityChange = useCallback(
    (entityId: string | null) => pushCampaignWikiPage(chatId, entityId),
    [chatId],
  );

  // Deep link by stable owner identity: resolve owner -> entity, then open that page once.
  const ownerTarget = target?.kind === "owner" ? target : null;
  const ownerLookup = useQuery({
    queryKey: ["campaign-memory", "entities", chatId, "owner", ownerTarget?.owner ?? ""],
    queryFn: () =>
      api.get<CampaignMemoryPage<CampaignMemoryEntity>>(
        `/game/${chatId}/memory/entities?owner=${encodeURIComponent(ownerTarget?.owner ?? "")}&limit=1`,
      ),
    enabled: ownerTarget !== null,
    staleTime: 30_000,
  });
  const ownerResolvedRef = useRef(false);
  useEffect(() => {
    if (ownerResolvedRef.current || !ownerLookup.data) return;
    ownerResolvedRef.current = true;
    const entity = ownerLookup.data.items[0];
    if (entity) pushCampaignWikiPage(chatId, entity.entityId);
  }, [chatId, ownerLookup.data]);
  const ownerUnlinked = ownerTarget !== null && ownerLookup.data !== undefined && ownerLookup.data.items.length === 0;
  const initialSearch =
    target?.kind === "search" ? target.query : ownerUnlinked && ownerTarget ? ownerTarget.name : undefined;
  const initialKind =
    target?.kind === "search"
      ? (target.entityKind ?? "all")
      : ownerUnlinked && ownerTarget
        ? (ownerTarget.entityKind ?? ownerFallbackKind(ownerTarget.owner) ?? "all")
        : undefined;

  // Reader scroll offset: captured while open, written to the store on close, restored on reopen.
  // The Modal mounts its panel after its own state tick, so the wrapper node arrives via state.
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(nav?.scrollTop ?? 0);
  useEffect(() => {
    if (!wrapper) return;
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches('[data-campaign-wiki-scroll="reader"]')) {
        scrollTopRef.current = target.scrollTop;
      }
    };
    wrapper.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      wrapper.removeEventListener("scroll", onScroll, { capture: true });
      const current = readNav(chatId);
      useGameModeStore.getState().setCampaignWikiNav({ ...current, scrollTop: scrollTopRef.current });
    };
  }, [chatId, wrapper]);
  const restoredRef = useRef(false);
  useEffect(() => {
    const wanted = scrollTopRef.current;
    if (!wrapper || restoredRef.current || wanted <= 0) return;
    restoredRef.current = true;
    // ponytail: keep history restoration tied to the explicit reader scroll contract; ceiling is
    // a reader layout change, upgrade path is a scroll-container ref in CampaignWikiNavigationProps.
    const restore = () => {
      const container = wrapper.querySelector<HTMLElement>('[data-campaign-wiki-scroll="reader"]');
      if (!container || container.scrollHeight - container.clientHeight < wanted) return false;
      container.scrollTop = wanted;
      return true;
    };
    if (restore()) return;
    const observer = new MutationObserver(() => {
      if (restore()) stop();
    });
    const timer = window.setTimeout(() => stop(), SCROLL_RESTORE_TIMEOUT_MS);
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
    observer.observe(wrapper, { childList: true, subtree: true });
    return stop;
  }, [wrapper]);

  const readerProps: CampaignWikiNavigationProps & { chatId: string; onDirtyChange: (dirty: boolean) => void } = {
    chatId,
    onDirtyChange: handleDirtyChange,
    selectedEntityId,
    onSelectedEntityChange: handleSelectedEntityChange,
    initialSearch,
    initialKind,
  };
  const historyButtonClass =
    "inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--secondary)] disabled:opacity-40";

  return (
    <Modal
      open
      onClose={close}
      title={t("ui.game.campaignWiki.title")}
      mobileFullscreen
      panelClassName="!fixed !inset-0 !h-[100dvh] !max-h-none !w-screen !max-w-none !rounded-none"
      panelStyle={{ height: "100dvh", maxHeight: "100dvh", width: "100vw", maxWidth: "none" }}
      contentClassName="!min-h-0 !overflow-hidden !p-3 sm:!p-5"
    >
      <div ref={setWrapper} className="flex h-full min-h-0 flex-col">
        <nav
          className="mb-2 flex flex-wrap items-center gap-1"
          aria-label={t("ui.game.campaignWiki.nav.label")}
          data-campaign-wiki-nav
        >
          <button
            type="button"
            onClick={close}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-xs text-[var(--foreground)] hover:bg-[var(--secondary)]"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            {t("ui.game.campaignWiki.nav.backToRoleplay")}
          </button>
          <div className="ml-auto flex gap-1">
            <button
              type="button"
              onClick={() => setIndexOpen(true)}
              aria-label={t("ui.game.campaignIndex.open")}
              title={t("ui.game.campaignIndex.open")}
              className={historyButtonClass}
              data-campaign-index-open
            >
              <DatabaseZap size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => step("back")}
              disabled={!nav?.back.length}
              aria-label={t("ui.game.campaignWiki.nav.back")}
              title={t("ui.game.campaignWiki.nav.back")}
              className={historyButtonClass}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => step("forward")}
              disabled={!nav?.forward.length}
              aria-label={t("ui.game.campaignWiki.nav.forward")}
              title={t("ui.game.campaignWiki.nav.forward")}
              className={historyButtonClass}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        </nav>
        {ownerTarget && ownerLookup.isPending && (
          <p role="status" className="mb-2 flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            {t("ui.game.campaignWiki.nav.resolving", { name: ownerTarget.name })}
          </p>
        )}
        {ownerTarget && ownerLookup.isError && (
          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-[var(--destructive)]">
            <span>{t("ui.game.campaignWiki.nav.resolveError", { name: ownerTarget.name })}</span>
            <button
              type="button"
              onClick={() => void ownerLookup.refetch()}
              className="min-h-8 rounded border border-[var(--border)] px-2 text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"
            >
              {t("ui.game.campaignWiki.retry")}
            </button>
          </div>
        )}
        {ownerTarget && ownerUnlinked && (
          <p role="status" className="mb-2 rounded-md border border-[var(--border)] px-3 py-2 text-xs">
            {t("ui.game.campaignWiki.nav.unlinked", { name: ownerTarget.name })}
          </p>
        )}
        {indexOpen && <CampaignIndexDialog chatId={chatId} onClose={() => setIndexOpen(false)} />}
        <div className="flex min-h-0 flex-1 flex-col" data-campaign-wiki-reader>
          <Suspense
            fallback={
              <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--muted-foreground)]">
                {t("ui.game.campaignWiki.loading")}
              </div>
            }
          >
            <CampaignWiki {...readerProps} />
          </Suspense>
        </div>
      </div>
    </Modal>
  );
}
