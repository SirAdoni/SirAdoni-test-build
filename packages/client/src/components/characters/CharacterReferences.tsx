import {
  Children,
  Fragment,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useCharacters } from "../../hooks/use-characters";
import { useUIStore } from "../../stores/ui.store";
import { createCharacterMatcher, type CharacterReference } from "../../lib/character-references";
import { CharacterPhoto } from "../ui/CharacterPhoto";

type VisualCharacterReference = CharacterReference & { avatarUrl?: string | null };
type ReferenceContext = {
  characters: VisualCharacterReference[];
  editableIds: Set<string>;
  open: (id: string) => void;
};
const Context = createContext<ReferenceContext>({ characters: [], editableIds: new Set(), open: () => {} });
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
  const value = useMemo(() => ({ characters, editableIds, open: openEditor }), [characters, editableIds]);
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
  const { characters, editableIds, open } = useContext(Context);
  const { t } = useTranslation();
  const match = useMemo(() => createCharacterMatcher(characters), [characters]);
  const ids = useMemo(() => new Set(characters.map((c) => c.id)), [characters]);
  const rendered = useMemo(() => {
    const label = (name: string) => t("ui.characterReferences.open", { name });
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
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  open(part.character!.id);
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
  }, [children, editableIds, match, currentNames, open, showAvatar, t]);
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
        if ((event.target as Element).closest("button")) return;
        const id = (event.target as Element).closest<HTMLElement>("[data-character-reference]")?.dataset
          .characterReference;
        if (!id || !ids.has(id)) return;
        event.preventDefault();
        event.stopPropagation();
        open(id);
      }}
      onKeyDownCapture={(event) => {
        const target = event.target as Element;
        const reference = target.closest<HTMLElement>("[data-character-reference]");
        if (reference && target !== reference) event.stopPropagation();
      }}
    >
      {rendered}
    </span>
  );
}
