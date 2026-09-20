import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AvatarCrop } from "@marinara-engine/shared";
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { cn, getAvatarCropStyle } from "../../lib/utils";
import { Modal } from "../ui/Modal";
import { CharacterPhoto } from "../ui/CharacterPhoto";
import {
  contactCategoryId,
  displayOpinion,
  hasCategory,
  migrateContactState,
  removeCategoryAssignments,
  type ContactCategoryState,
} from "./game-contact-book-state";

export interface GameContact {
  id: string;
  characterId?: string;
  name: string;
  avatar?: string;
  avatarCrop?: AvatarCrop | null;
  opinion?: number | string;
  relationshipStatus?: string;
  automaticCategories: string[];
  evidenceMessageIds: string[];
}
interface ContactBookResult {
  contacts: GameContact[];
  coverage: { complete: boolean; pendingSessions: number };
}
export type ContactCategory = ContactCategoryState;
interface Props {
  chatId: string;
  campaignKey: string;
  refreshKey?: string;
  open: boolean;
  onClose: () => void;
  onOpenCharacter?: (characterId: string) => void;
}

const groupsKey = (campaignKey: string) => `marinara-game-contact-groups:${campaignKey}`;
const categoriesKey = (campaignKey: string) => `marinara-game-contact-categories:${campaignKey}`;

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
export function loadContactState(
  campaignKey: string,
  defaultNames: Record<string, string> = {},
): { categories: ContactCategory[]; groups: Record<string, string[]> } {
  return migrateContactState(readJson(groupsKey(campaignKey)), readJson(categoriesKey(campaignKey)), defaultNames);
}
function persistContactState(campaignKey: string, categories: ContactCategory[], groups: Record<string, string[]>) {
  try {
    localStorage.setItem(categoriesKey(campaignKey), JSON.stringify(categories));
    localStorage.setItem(groupsKey(campaignKey), JSON.stringify(groups));
  } catch {
    /* best effort device-local preferences */
  }
}

function CategoryTree({
  categories,
  selectedId,
  onSelect,
  onRename,
  onDelete,
  automaticSelected,
}: {
  categories: ContactCategory[];
  selectedId: string;
  onSelect: (id: string) => void;
  onRename: (category: ContactCategory) => void;
  onDelete: (category: ContactCategory) => void;
  automaticSelected: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const render = (category: ContactCategory, depth = 0): ReactNode => {
    const children = categories.filter((item) => item.parentId === category.id);
    const isExpanded = expanded[category.id] ?? true;
    return (
      <div key={category.id}>
        <div className="group flex items-center gap-0.5">
          {children.length ? (
            <button
              type="button"
              className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
              onClick={() => setExpanded((current) => ({ ...current, [category.id]: !isExpanded }))}
              aria-label={
                isExpanded ? t("ui.game.contactBook.collapseCategory") : t("ui.game.contactBook.expandCategory")
              }
            >
              {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : (
            <span className="w-6" />
          )}
          <button
            type="button"
            onClick={() => onSelect(category.id)}
            className={cn(
              "min-w-0 flex-1 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--accent)]",
              selectedId === category.id && "bg-[var(--accent)] font-semibold text-[var(--accent-foreground)]",
            )}
            style={{ paddingLeft: `${depth * 0.75 + 0.5}rem` }}
          >
            {category.name}
          </button>
          <span className="invisible flex gap-0.5 pr-1 group-hover:visible">
            <button
              type="button"
              onClick={() => onRename(category)}
              className="rounded p-1 hover:bg-[var(--accent)]"
              aria-label={t("ui.game.contactBook.renameCategory")}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              onClick={() => onDelete(category)}
              className="rounded p-1 text-[var(--destructive)] hover:bg-[var(--accent)]"
              aria-label={t("ui.game.contactBook.deleteCategory")}
            >
              <Trash2 size={12} />
            </button>
          </span>
        </div>
        {isExpanded && children.map((child) => render(child, depth + 1))}
      </div>
    );
  };
  return (
    <nav aria-label={t("ui.game.contactBook.categoriesLabel")} className="space-y-0.5">
      <button
        type="button"
        onClick={() => onSelect("all")}
        className={cn(
          "w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--accent)]",
          selectedId === "all" && "bg-[var(--accent)] font-semibold",
        )}
      >
        {t("ui.game.contactBook.allContacts")}
      </button>
      <div className="mt-2 border-t border-[var(--border)] pt-2">
        <p className="px-2 py-1 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
          {t("ui.game.contactBook.automaticCategories")}
        </p>
        {(["known", "trusted", "hostile"] as const).map((category) => (
          <button
            key={category}
            type="button"
            onClick={() => onSelect(`automatic:${category}`)}
            className={cn(
              "w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--accent)]",
              automaticSelected === `automatic:${category}` && "bg-[var(--accent)] font-semibold",
            )}
          >
            {t(`ui.game.contactBook.categories.${category}`)}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onSelect("uncategorized")}
        className={cn(
          "w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--accent)]",
          selectedId === "uncategorized" && "bg-[var(--accent)] font-semibold",
        )}
      >
        {t("ui.game.contactBook.uncategorized")}
      </button>
      {categories.filter((category) => !category.parentId).map((category) => render(category))}
    </nav>
  );
}

export function GameContactBookWidget({ chatId, campaignKey, refreshKey, open, onClose, onOpenCharacter }: Props) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<Record<string, string[]>>({});
  const [categories, setCategories] = useState<ContactCategory[]>([]);
  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryParent, setNewCategoryParent] = useState("");
  const contactsQuery = useQuery({
    queryKey: ["game-contact-book", chatId, refreshKey],
    queryFn: () => api.get<ContactBookResult>(`/game/${encodeURIComponent(chatId)}/contacts`),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  useEffect(() => {
    const state = loadContactState(campaignKey, {
      staff: t("ui.game.contactBook.defaultStaff"),
      friends: t("ui.game.contactBook.defaultFriends"),
      enemies: t("ui.game.contactBook.defaultEnemies"),
    });
    setGroups(state.groups);
    setCategories(state.categories);
  }, [campaignKey, t]);
  const result = contactsQuery.data ?? { contacts: [], coverage: { complete: true, pendingSessions: 0 } };
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return result.contacts
      .filter((contact) => !needle || contact.name.toLocaleLowerCase().includes(needle))
      .filter((contact) => {
        if (selectedCategory === "all") return true;
        if (selectedCategory.startsWith("automatic:"))
          return contact.automaticCategories.includes(selectedCategory.slice("automatic:".length));
        if (selectedCategory === "uncategorized")
          return !(groups[contact.id] ?? []).some((id) => categories.some((category) => category.id === id));
        return (groups[contact.id] ?? []).some((id) => hasCategory(id, selectedCategory, categories));
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [categories, groups, query, result.contacts, selectedCategory]);
  const persist = (nextCategories: ContactCategory[], nextGroups: Record<string, string[]>) => {
    setCategories(nextCategories);
    setGroups(nextGroups);
    persistContactState(campaignKey, nextCategories, nextGroups);
  };
  const assignCategory = (contactId: string, categoryId: string) => {
    const assigned = new Set(groups[contactId] ?? []);
    if (categoryId) assigned.add(categoryId);
    else assigned.clear();
    persist(categories, { ...groups, [contactId]: [...assigned] });
  };
  const addCategory = () => {
    const name = newCategoryName.trim();
    if (!name) return;
    const id = contactCategoryId(name, new Set(categories.map((category) => category.id)));
    persist([...categories, { id, name, parentId: newCategoryParent || undefined }], groups);
    setNewCategoryName("");
  };
  const renameCategory = (category: ContactCategory) => {
    const name = window.prompt(t("ui.game.contactBook.renamePrompt"), category.name)?.trim();
    if (name && name !== category.name)
      persist(
        categories.map((item) => (item.id === category.id ? { ...item, name } : item)),
        groups,
      );
  };
  const deleteCategory = (category: ContactCategory) => {
    if (!window.confirm(t("ui.game.contactBook.deletePrompt", { name: category.name }))) return;
    const result = removeCategoryAssignments(category.id, categories, groups);
    persist(result.categories, result.groups);
    const removed = result.removed;
    if (removed.has(selectedCategory)) setSelectedCategory("all");
  };
  if (contactsQuery.isPending)
    return (
      <Modal open={open} onClose={onClose} title={t("ui.game.contactBook.title")} width="max-w-none" fullScreen>
        <div className="p-4 text-sm text-[var(--muted-foreground)]">{t("ui.game.contactBook.loading")}</div>
      </Modal>
    );
  if (contactsQuery.isError)
    return (
      <Modal open={open} onClose={onClose} title={t("ui.game.contactBook.title")} width="max-w-none" fullScreen>
        <div className="space-y-2 p-4 text-sm">
          <p>{t("ui.game.contactBook.error")}</p>
          <button type="button" onClick={() => void contactsQuery.refetch()}>
            {t("ui.game.contactBook.retry")}
          </button>
        </div>
      </Modal>
    );
  const contactList = (
    <div className="space-y-2">
      {visible.length === 0 ? (
        <p className="p-4 text-sm text-[var(--muted-foreground)]">{t("ui.game.contactBook.noMatches")}</p>
      ) : (
        visible.map((contact) => (
          <article key={contact.id} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="flex items-start gap-3">
              {contact.avatar ? (
                <CharacterPhoto
                  src={contact.avatar}
                  name={contact.name}
                  className="block h-10 w-10 shrink-0 overflow-hidden rounded-full"
                  onUpdate={
                    contact.characterId
                      ? () => {
                          onClose();
                          onOpenCharacter?.(contact.characterId as string);
                        }
                      : undefined
                  }
                >
                  <img
                    src={contact.avatar}
                    alt={contact.name}
                    className="h-full w-full object-cover"
                    style={getAvatarCropStyle(contact.avatarCrop)}
                  />
                </CharacterPhoto>
              ) : (
                <div className="h-10 w-10 rounded-full bg-[var(--muted)]" />
              )}
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="truncate text-left font-semibold hover:underline"
                  onClick={() => {
                    if (!contact.characterId) return;
                    onClose();
                    onOpenCharacter?.(contact.characterId);
                  }}
                  disabled={!contact.characterId}
                >
                  {contact.name}
                </button>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]">
                  <span>
                    <strong className="text-[var(--foreground)]">{t("ui.game.contactBook.opinion")}:</strong>{" "}
                    {displayOpinion(contact.opinion) ?? t("ui.game.contactBook.unknown")}
                  </span>
                  <span>
                    <strong className="text-[var(--foreground)]">{t("ui.game.contactBook.relationshipStatus")}:</strong>{" "}
                    {contact.relationshipStatus || t("ui.game.contactBook.unknown")}
                  </span>
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value=""
                onChange={(event) => assignCategory(contact.id, event.target.value)}
                aria-label={t("ui.game.contactBook.assignCategory", { name: contact.name })}
                className="rounded-lg border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
              >
                <option value="">{t("ui.game.contactBook.addToCategory")}</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              {(groups[contact.id] ?? []).map((id) => (
                <span key={id} className="rounded-full bg-[var(--accent)] px-2 py-1 text-[0.6875rem]">
                  {categories.find((category) => category.id === id)?.name ?? id}
                  <button
                    type="button"
                    onClick={() =>
                      persist(categories, {
                        ...groups,
                        [contact.id]: (groups[contact.id] ?? []).filter((value) => value !== id),
                      })
                    }
                    className="ml-1"
                    aria-label={t("ui.game.contactBook.removeCategoryFrom", {
                      category: categories.find((item) => item.id === id)?.name ?? id,
                    })}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </article>
        ))
      )}
    </div>
  );
  const content = (
    <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
      <aside className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--sidebar)] p-2 sm:w-60">
        <CategoryTree
          categories={categories}
          selectedId={selectedCategory}
          automaticSelected={selectedCategory}
          onSelect={setSelectedCategory}
          onRename={renameCategory}
          onDelete={deleteCategory}
        />
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <div className="flex gap-1">
            <input
              value={newCategoryName}
              onChange={(event) => setNewCategoryName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && addCategory()}
              placeholder={t("ui.game.contactBook.newCategory")}
              aria-label={t("ui.game.contactBook.newCategory")}
              className="min-w-0 flex-1 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={addCategory}
              className="rounded bg-[var(--primary)] p-1 text-[var(--primary-foreground)]"
              aria-label={t("ui.game.contactBook.addCategory")}
            >
              <Plus size={14} />
            </button>
          </div>
          <select
            value={newCategoryParent}
            onChange={(event) => setNewCategoryParent(event.target.value)}
            aria-label={t("ui.game.contactBook.categoryParent")}
            className="mt-2 w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
          >
            <option value="">{t("ui.game.contactBook.topLevelCategory")}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mb-3 flex items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
            placeholder={t("ui.game.contactBook.search")}
            aria-label={t("ui.game.contactBook.search")}
          />
        </div>
        {contactList}
      </main>
    </div>
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("ui.game.contactBook.title")}
      width="max-w-none"
      mobileFullscreen
      fullScreen
      contentClassName="flex min-h-0 flex-col"
      panelClassName="h-full max-h-none max-w-none rounded-none"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--muted-foreground)]">{t("ui.game.contactBook.fullScreenDescription")}</p>
        <span className="text-xs text-[var(--muted-foreground)]">{result.contacts.length}</span>
      </div>
      {!result.coverage.complete && (
        <p role="status" className="mb-3 text-sm text-[var(--muted-foreground)]">
          {t("ui.game.contactBook.coveragePending")}
        </p>
      )}
      {content}
    </Modal>
  );
}
