import {
  Children,
  Fragment,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useCharacters } from "../../hooks/use-characters";
import { useUIStore } from "../../stores/ui.store";
import { createCharacterMatcher, type CharacterReference } from "../../lib/character-references";
import { CharacterPhoto } from "../ui/CharacterPhoto";
import { readNpcPeekSummary, type NpcPeekSummary } from "../../lib/npc-quick-reference";
import { NpcQuickReferencePopover } from "./NpcQuickReference";

type VisualCharacterReference = CharacterReference & { avatarUrl?: string | null };
type ReferenceContext = {
  characters: VisualCharacterReference[];
  editableIds: Set<string>;
  open: (id: string) => void;
  /** Library card summary for the NPC quick reference popover, read on demand. */
  summaryFor: (id: string) => NpcPeekSummary | undefined;
};
const Context = createContext<ReferenceContext>({
  characters: [],
  editableIds: new Set(),
  open: () => {},
  summaryFor: () => undefined,
});
const openEditor = (id: string) => useUIStore.getState().openCharacterDetail(id);
const protectedTags = new Set(["a", "button", "code", "pre", "script", "style", "textarea", "input", "select", "svg"]);
const linkClass =
  "cursor-pointer rounded-sm underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]";

export function CharacterReferencesProvider({ children }: { children: ReactNode }) {
  const { data } = useCharacters();
  const characters = useMemo(
    () =>
      ((data ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
        let card: Record<string, unknown> = {};
        try {
          card = typeof row.data === "string" ? JSON.parse(row.data) : ((row.data as Record<string, unknown>) ?? {});
        } catch {
          /* Incomplete imported record. */
        }
        const name = typeof row.name === "string" ? row.name : card.name;
        const extensions = card.extensions as Record<string, unknown> | undefined;
        const aliases = Array.isArray(extensions?.referenceNames)
          ? extensions.referenceNames.filter((v): v is string => typeof v === "string")
          : [];
        const avatarUrl = typeof row.avatarUrl === "string" ? row.avatarUrl : null;
        return typeof name === "string" && typeof row.id === "string" ? [{ id: row.id, name, aliases, avatarUrl }] : [];
      }),
    [data],
  );
  const editableIds = useMemo(() => new Set(characters.map((character) => character.id)), [characters]);
  const summaryFor = useMemo(() => {
    const rows = new Map(
      ((data ?? []) as Array<Record<string, unknown>>).flatMap((row) =>
        typeof row.id === "string" ? [[row.id, row] as const] : [],
      ),
    );
    const cache = new Map<string, NpcPeekSummary>();
    return (id: string) => {
      const row = rows.get(id);
      if (!row) return undefined;
      if (!cache.has(id)) cache.set(id, readNpcPeekSummary(row));
      return cache.get(id);
    };
  }, [data]);
  const value = useMemo(
    () => ({ characters, editableIds, open: openEditor, summaryFor }),
    [characters, editableIds, summaryFor],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Game sheets override library navigation for known party/NPC IDs. */
export function GameCharacterReferences({
  cards,
  onOpen,
  children,
}: {
  cards: Record<string, { title: string; avatarUrl?: string | null }>;
  onOpen: (id: string) => void;
  children: ReactNode;
}) {
  const parent = useContext(Context);
  const value = useMemo(() => {
    const merged = new Map(parent.characters.map((c) => [c.id, c]));
    for (const [id, card] of Object.entries(cards)) {
      // Name-derived local NPC IDs can also have a real library card. Use the real ID once.
      if (!merged.has(id) && !parent.characters.some((c) => c.name.toLowerCase() === card.title.toLowerCase())) {
        merged.set(id, { id, name: card.title, avatarUrl: card.avatarUrl });
      }
    }
    return {
      characters: [...merged.values()],
      editableIds: parent.editableIds,
      summaryFor: parent.summaryFor,
      open: (id: string) => {
        if (cards[id]) return onOpen(id);
        const reference = merged.get(id);
        const matchingCard = reference
          ? Object.entries(cards).find(([, card]) => card.title.toLowerCase() === reference.name.toLowerCase())
          : undefined;
        return matchingCard ? onOpen(matchingCard[0]) : parent.open(id);
      },
    };
  }, [parent, cards, onOpen]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Decorate only rendered text; never rewrite stored prose, HTML attributes, code or existing links. */
export function CharacterLinkedContent({
  children,
  currentNames = false,
  showAvatar = false,
}: {
  children: ReactNode;
  currentNames?: boolean;
  showAvatar?: boolean;
}) {
  const { characters, editableIds, open, summaryFor } = useContext(Context);
  const { t } = useTranslation();
  const peekEnabled = useUIStore((s) => s.npcQuickReference);
  const peek = useNpcPeek(peekEnabled, open);
  const match = useMemo(() => createCharacterMatcher(characters), [characters]);
  const ids = useMemo(() => new Set(characters.map((c) => c.id)), [characters]);
  const rendered = useMemo(() => {
    const label = (name: string) =>
      peekEnabled ? t("ui.characterReferences.peek.show", { name }) : t("ui.characterReferences.open", { name });
    const visibleName = (text: string, character: CharacterReference) =>
      !currentNames ? text : /\s/u.test(text.trim()) ? character.name : character.name.split(/\s/u)[0];
    const processHtml = (html: string) => {
      const template = document.createElement("template");
      template.innerHTML = html;
      const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (
          !node.parentElement?.closest(
            "a,button,code,pre,script,style,textarea,select,svg,[role=button],[role=link],[contenteditable],[data-character-reference]",
          )
        )
          texts.push(node);
      }
      for (const node of texts) {
        const parts = match(node.data);
        if (!parts.some((part) => part.character)) continue;
        const fragment = document.createDocumentFragment();
        for (const part of parts) {
          if (!part.character) {
            fragment.append(document.createTextNode(part.text));
            continue;
          }
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.characterReference = part.character.id;
          button.className = linkClass;
          button.title = label(part.character.name);
          button.setAttribute("aria-label", label(part.character.name));
          if (peekEnabled) button.setAttribute("aria-haspopup", "dialog");
          button.textContent = visibleName(part.text, part.character) ?? part.text;
          fragment.append(button);
        }
        node.replaceWith(fragment);
      }
      return template.innerHTML;
    };
    const visit = (nodes: ReactNode): ReactNode =>
      Children.map(nodes, (node) => {
        if (typeof node === "string")
          return match(node).map((part, i) =>
            part.character ? (
              <span
                key={i}
                role="button"
                tabIndex={0}
                data-character-reference={part.character.id}
                className={linkClass}
                title={label(part.character.name)}
                aria-label={label(part.character.name)}
                aria-haspopup={peekEnabled ? "dialog" : undefined}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  peek.activateRef.current(part.character!.id, event.currentTarget, true);
                }}
              >
                {showAvatar && part.character.avatarUrl ? (
                  <CharacterPhoto
                    src={part.character.avatarUrl}
                    name={part.character.name}
                    wrapperClassName="character-photo-reference relative inline-flex items-center gap-1 align-middle"
                    className="block h-4 w-4 overflow-hidden rounded-full"
                    onUpdate={editableIds.has(part.character!.id) ? () => openEditor(part.character!.id) : undefined}
                  >
                    <img src={part.character.avatarUrl} alt="" className="h-full w-full object-cover" />
                  </CharacterPhoto>
                ) : null}
                {visibleName(part.text, part.character)}
              </span>
            ) : (
              part.text
            ),
          );
        if (!isValidElement(node)) return node;
        const element = node as ReactElement<{
          children?: ReactNode;
          dangerouslySetInnerHTML?: { __html: string };
          contentEditable?: unknown;
          role?: string;
        }>;
        if (element.type === Fragment) return cloneElement(element, { children: visit(element.props.children) });
        if (
          (typeof element.type === "string" && protectedTags.has(element.type)) ||
          element.props.contentEditable ||
          element.props.role === "button"
        )
          return element;
        if (element.props.dangerouslySetInnerHTML)
          return cloneElement(element, {
            dangerouslySetInnerHTML: { __html: processHtml(element.props.dangerouslySetInnerHTML.__html) },
          });
        return element.props.children ? cloneElement(element, { children: visit(element.props.children) }) : element;
      });
    return visit(children);
  }, [children, editableIds, match, currentNames, peek.activateRef, peekEnabled, showAvatar, t]);
  const peekCharacter = peek.state ? characters.find((c) => c.id === peek.state!.id) : undefined;
  return (
    <span
      className="contents"
      onPointerDownCapture={(event) => {
        const target = event.target as Element;
        const reference = target.closest<HTMLElement>("[data-character-reference]");
        if (reference && !target.closest("button")) return;
        if (reference) event.stopPropagation();
      }}
      onClickCapture={(event) => {
        const target = event.target as Element;
        const reference = target.closest<HTMLElement>("[data-character-reference]");
        const button = target.closest("button");
        // Skip other buttons (e.g. inside an avatar), but not a reference that is itself a <button>.
        if (!reference || (button && button !== reference)) return;
        const id = reference.dataset.characterReference;
        if (!id || !ids.has(id)) return;
        event.preventDefault();
        event.stopPropagation();
        // A keyboard-activated native button reports detail 0.
        peek.activateRef.current(id, reference, event.detail === 0);
      }}
      onPointerOver={peekEnabled ? peek.onPointerOver : undefined}
      onPointerOut={peekEnabled ? peek.onPointerOut : undefined}
      onKeyDownCapture={(event) => {
        const target = event.target as Element;
        const reference = target.closest<HTMLElement>("[data-character-reference]");
        if (reference && target !== reference) event.stopPropagation();
      }}
    >
      {rendered}
      {peek.state && peekCharacter ? (
        <NpcQuickReferencePopover
          key={peek.state.id}
          character={{ ...peekCharacter, summary: summaryFor(peekCharacter.id) }}
          anchor={peek.state.anchor}
          library={editableIds.has(peekCharacter.id)}
          focusOnOpen={peek.state.focus}
          onOpenCard={peek.openCard}
          onClose={peek.close}
          onPointerEnter={peek.cancelHoverClose}
          onPointerLeave={peek.scheduleHoverClose}
        />
      ) : null}
    </span>
  );
}

type PeekState = { id: string; anchor: HTMLElement; focus: boolean; hover: boolean };
const HOVER_OPEN_MS = 400;
const HOVER_CLOSE_MS = 250;
/** Only one quick reference is open across all messages. */
let closeActivePeek: (() => void) | null = null;

/** Hover (mouse), tap and keyboard handling for the opt-in NPC quick reference popover. */
function useNpcPeek(enabled: boolean, open: (id: string) => void) {
  const [state, setState] = useState<PeekState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const hide = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    setState(null);
  }, []);
  const show = useCallback(
    (next: PeekState) => {
      if (closeActivePeek && closeActivePeek !== hide) closeActivePeek();
      closeActivePeek = hide;
      setState(next);
    },
    [hide],
  );
  const activateRef = useRef<(id: string, anchor: HTMLElement, viaKeyboard: boolean) => void>(open);
  activateRef.current = (id, anchor, viaKeyboard) => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    if (!enabled) return open(id);
    const current = stateRef.current;
    // A second click on a pinned popover's name closes it; a click on a hover preview pins it.
    if (current && current.anchor === anchor && !current.hover && !viaKeyboard) return hide();
    show({ id, anchor, focus: viaKeyboard, hover: false });
  };
  const close = useCallback(
    (restoreFocus: boolean) => {
      const anchor = stateRef.current?.anchor;
      hide();
      if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
    },
    [hide],
  );
  const openCard = useCallback(() => {
    const id = stateRef.current?.id;
    hide();
    if (id) open(id);
  }, [hide, open]);
  const cancelHoverClose = useCallback(() => window.clearTimeout(closeTimer.current), []);
  const scheduleHoverClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    if (!stateRef.current?.hover) return;
    closeTimer.current = window.setTimeout(hide, HOVER_CLOSE_MS);
  }, [hide]);
  const onPointerOver = useCallback(
    (event: ReactPointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const reference = (event.target as Element).closest<HTMLElement>("[data-character-reference]");
      if (!reference) return;
      window.clearTimeout(closeTimer.current);
      if (stateRef.current?.anchor === reference) return;
      window.clearTimeout(openTimer.current);
      const id = reference.dataset.characterReference;
      if (!id) return;
      openTimer.current = window.setTimeout(() => {
        // Never replace a popover the reader pinned with a click or the keyboard.
        if (!reference.isConnected || stateRef.current?.hover === false) return;
        show({ id, anchor: reference, focus: false, hover: true });
      }, HOVER_OPEN_MS);
    },
    [show],
  );
  const onPointerOut = useCallback(
    (event: ReactPointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const reference = (event.target as Element).closest<HTMLElement>("[data-character-reference]");
      if (!reference || reference.contains(event.relatedTarget as Node | null)) return;
      window.clearTimeout(openTimer.current);
      scheduleHoverClose();
    },
    [scheduleHoverClose],
  );
  useEffect(() => {
    if (!enabled) hide();
  }, [enabled, hide]);
  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
      if (closeActivePeek === hide) closeActivePeek = null;
    },
    [hide],
  );
  return {
    state: enabled ? state : null,
    activateRef,
    close,
    openCard,
    cancelHoverClose,
    scheduleHoverClose,
    onPointerOver,
    onPointerOut,
  };
}
