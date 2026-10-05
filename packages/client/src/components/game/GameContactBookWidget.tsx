import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { isCampaignFeatureEnabled, useFeatureEnabled } from "../../hooks/use-feature-settings";
import { useGameContactBook, type GameContact } from "../../hooks/use-game-contact-book";
import { Modal } from "../ui/Modal";
import {
  contactCategoryId,
  hasContactCategory,
  migrateContactCategories,
  removeContactCategory,
  type ContactCategory,
} from "./game-contact-book-state";

interface Props {
  chatId: string;
  campaignKey: string;
  refreshKey?: string;
  open: boolean;
  onClose: () => void;
  onOpenCharacter?: (characterId: string) => void;
  portraitGenerationEnabled?: boolean;
  onGenerateMissingCampaignPortraits?: (contacts: GameContact[]) => Promise<{ generated: number; failed: number }>;
}

const groupsKey = (campaignKey: string) => `marinara-game-contact-groups:${campaignKey}`;
const categoriesKey = (campaignKey: string) => `marinara-game-contact-categories:${campaignKey}`;
const EMPTY_CONTACTS: GameContact[] = [];

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function loadPreferences(campaignKey: string, names: Record<string, string>) {
  return migrateContactCategories(readJson(groupsKey(campaignKey)), readJson(categoriesKey(campaignKey)), names);
}

function CategoryTree({
  categories,
  selected,
  onSelect,
  onRename,
  onDelete,
}: {
  categories: ContactCategory[];
  selected: string;
  onSelect: (value: string) => void;
  onRename: (category: ContactCategory) => void;
  onDelete: (category: ContactCategory) => void;
}) {
  const { t } = useTranslation();
  const render = (category: ContactCategory, depth = 0) => (
    <div key={category.id}>
      <div className="group flex items-center gap-1">
        <button
          type="button"
          onClick={() => onSelect(category.id)}
          className={`min-w-0 flex-1 rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--accent)] ${selected === category.id ? "bg-[var(--accent)] font-semibold" : ""}`}
          style={{ paddingLeft: `${depth * 0.75 + 0.5}rem` }}
        >
          {category.name}
        </button>
        <button
          type="button"
          onClick={() => onRename(category)}
          className="px-1 text-xs opacity-70 hover:opacity-100"
          aria-label={t("ui.game.contactBook.renameCategory")}
        >
          ✎
        </button>
        <button
          type="button"
          onClick={() => onDelete(category)}
          className="px-1 text-xs text-[var(--destructive)]"
          aria-label={t("ui.game.contactBook.deleteCategory")}
        >
          ×
        </button>
      </div>
      {categories.filter((item) => item.parentId === category.id).map((child) => render(child, depth + 1))}
    </div>
  );
  return (
    <nav aria-label={t("ui.game.contactBook.categoriesLabel")} className="space-y-1">
      <button
        type="button"
        onClick={() => onSelect("all")}
        className={`w-full rounded px-2 py-1.5 text-left text-xs ${selected === "all" ? "bg-[var(--accent)] font-semibold" : ""}`}
      >
        {t("ui.game.contactBook.allContacts")}
      </button>
      {(["known", "trusted", "hostile"] as const).map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(`automatic:${id}`)}
          className={`w-full rounded px-2 py-1.5 text-left text-xs ${selected === `automatic:${id}` ? "bg-[var(--accent)] font-semibold" : ""}`}
        >
          {t(`ui.game.contactBook.categories.${id}`)}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onSelect("uncategorized")}
        className={`w-full rounded px-2 py-1.5 text-left text-xs ${selected === "uncategorized" ? "bg-[var(--accent)] font-semibold" : ""}`}
      >
        {t("ui.game.contactBook.uncategorized")}
      </button>
      {categories.filter((category) => !category.parentId).map((category) => render(category))}
    </nav>
  );
}

function contactMatches(contact: GameContact, query: string) {
  return !query || contact.name.toLocaleLowerCase().includes(query);
}

export function GameContactBookWidget({
  chatId,
  campaignKey,
  refreshKey,
  open,
  onClose,
  onOpenCharacter,
  portraitGenerationEnabled = false,
  onGenerateMissingCampaignPortraits,
}: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const contactBookEnabled = useFeatureEnabled("gameContactBook");
  const campaignPortraitsEnabled = useFeatureEnabled("campaignPortraits");
  const [categories, setCategories] = useState<ContactCategory[]>([]);
  const [groups, setGroups] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState("all");
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState("");
  const [portraitGenerationBusy, setPortraitGenerationBusy] = useState(false);
  const [portraitGenerationMessage, setPortraitGenerationMessage] = useState("");
  const contactsQuery = useGameContactBook(chatId, refreshKey, open);

  useEffect(() => {
    try {
      const state = loadPreferences(campaignKey, {
        staff: t("ui.game.contactBook.defaultStaff"),
        friends: t("ui.game.contactBook.defaultFriends"),
        enemies: t("ui.game.contactBook.defaultEnemies"),
      });
      setGroups(state.groups);
      setCategories(state.categories);
      setSelected("all");
    } catch {
      setGroups({});
      setCategories([]);
    }
  }, [campaignKey, t]);

  const persist = (nextCategories: ContactCategory[], nextGroups: Record<string, string[]>) => {
    if (!isCampaignFeatureEnabled(queryClient, "gameContactBook")) return;
    setCategories(nextCategories);
    setGroups(nextGroups);
    try {
      localStorage.setItem(categoriesKey(campaignKey), JSON.stringify(nextCategories));
      localStorage.setItem(groupsKey(campaignKey), JSON.stringify(nextGroups));
    } catch {
      // Preferences remain usable for the current view when local storage is unavailable.
    }
  };
  const addCategory = () => {
    const name = newName.trim();
    if (!name) return;
    const id = contactCategoryId(name, new Set(categories.map(({ id: value }) => value)));
    const parentId = categories.some((item) => item.id === newParent) ? newParent : undefined;
    persist([...categories, { id, name, parentId }], groups);
    setNewName("");
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
    const result = removeContactCategory(category.id, categories, groups);
    persist(result.categories, result.groups);
    if (result.removed.has(selected)) setSelected("all");
    if (result.removed.has(newParent)) setNewParent("");
  };
  const contacts = contactsQuery.data?.contacts ?? EMPTY_CONTACTS;
  const campaignPortraitCount = contacts.filter(
    (contact) => !contact.avatar && (!contact.id.startsWith("party:") || !!contact.portraitDescription?.trim()),
  ).length;
  const skippedPartyPortraits = contacts.filter(
    (contact) => !contact.avatar && contact.id.startsWith("party:") && !contact.portraitDescription?.trim(),
  ).length;
  const generateMissingPortraits = async () => {
    if (
      !isCampaignFeatureEnabled(queryClient, "campaignPortraits") ||
      !isCampaignFeatureEnabled(queryClient, "gameContactBook") ||
      !portraitGenerationEnabled
    )
      return;
    if (!onGenerateMissingCampaignPortraits || portraitGenerationBusy || campaignPortraitCount <= 0) return;
    setPortraitGenerationBusy(true);
    setPortraitGenerationMessage("");
    try {
      const result = await onGenerateMissingCampaignPortraits(contacts);
      if (
        !isCampaignFeatureEnabled(queryClient, "campaignPortraits") ||
        !isCampaignFeatureEnabled(queryClient, "gameContactBook")
      )
        return;
      setPortraitGenerationMessage(t("ui.game.contactBook.portraitGeneration.success", result));
      await contactsQuery.refetch();
    } catch (error) {
      setPortraitGenerationMessage(
        t("ui.game.contactBook.portraitGeneration.failure", {
          error: error instanceof Error && error.message ? error.message : t("ui.game.contactBook.retry"),
        }),
      );
    } finally {
      setPortraitGenerationBusy(false);
    }
  };
  const visible = useMemo(
    () =>
      contacts
        .filter((contact) => {
          if (!contactMatches(contact, query.trim().toLocaleLowerCase())) return false;
          if (selected === "all") return true;
          if (selected.startsWith("automatic:"))
            return contact.automaticCategories.includes(selected.slice("automatic:".length));
          if (selected === "uncategorized")
            return !(groups[contact.id] ?? []).some((id) => categories.some((item) => item.id === id));
          return (groups[contact.id] ?? []).some((id) => hasContactCategory(id, selected, categories));
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    [categories, contacts, groups, query, selected],
  );

  return (
    <Modal
      open={open && contactBookEnabled}
      onClose={onClose}
      title={t("ui.game.contactBook.title")}
      width="max-w-none"
      mobileFullscreen
      contentClassName="flex min-h-0 flex-col"
      panelClassName="h-full max-h-none max-w-none rounded-none"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--muted-foreground)]">{t("ui.game.contactBook.fullScreenDescription")}</p>
        <span className="text-xs text-[var(--muted-foreground)]">{contacts.length}</span>
      </div>
      {contactsQuery.isPending ? (
        <p className="p-4 text-sm text-[var(--muted-foreground)]">{t("ui.game.contactBook.loading")}</p>
      ) : contactsQuery.isError ? (
        <div className="space-y-2 p-4 text-sm">
          <p>{t("ui.game.contactBook.error")}</p>
          <button type="button" onClick={() => void contactsQuery.refetch()}>
            {t("ui.game.contactBook.retry")}
          </button>
        </div>
      ) : (
        <>
          {contactsQuery.data && !contactsQuery.data.coverage.complete && (
            <p role="status" className="mb-3 text-sm text-[var(--muted-foreground)]">
              {t("ui.game.contactBook.coveragePending", { count: contactsQuery.data.coverage.pendingSessions })}
            </p>
          )}
          {campaignPortraitsEnabled && onGenerateMissingCampaignPortraits && (
            <section className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--sidebar)] p-3">
              <button
                type="button"
                onClick={() => void generateMissingPortraits()}
                disabled={!portraitGenerationEnabled || campaignPortraitCount <= 0 || portraitGenerationBusy}
                className="min-h-11 rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-medium text-[var(--primary-foreground)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("ui.game.contactBook.portraitGeneration.generateMissing", { count: campaignPortraitCount })}
              </button>
              {!portraitGenerationEnabled && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  {t("ui.game.contactBook.portraitGeneration.unavailable")}
                </p>
              )}
              {skippedPartyPortraits > 0 && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  {t("ui.game.contactBook.portraitGeneration.skippedNoAppearance", { count: skippedPartyPortraits })}
                </p>
              )}
              {portraitGenerationMessage && (
                <p role="status" className="text-sm">
                  {portraitGenerationMessage}
                </p>
              )}
            </section>
          )}
          <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
            <aside className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--sidebar)] p-2 sm:w-60">
              <CategoryTree
                categories={categories}
                selected={selected}
                onSelect={setSelected}
                onRename={renameCategory}
                onDelete={deleteCategory}
              />
              <div className="mt-3 border-t border-[var(--border)] pt-3">
                <input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && addCategory()}
                  placeholder={t("ui.game.contactBook.newCategory")}
                  aria-label={t("ui.game.contactBook.newCategory")}
                  className="w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
                />
                <select
                  value={newParent}
                  onChange={(event) => setNewParent(event.target.value)}
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
                <button
                  type="button"
                  onClick={addCategory}
                  className="mt-2 rounded bg-[var(--primary)] px-2 py-1 text-xs text-[var(--primary-foreground)]"
                >
                  {t("ui.game.contactBook.addCategory")}
                </button>
              </div>
            </aside>
            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("ui.game.contactBook.search")}
                aria-label={t("ui.game.contactBook.search")}
                className="mb-3 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
              />
              {visible.length === 0 ? (
                <p className="p-4 text-sm text-[var(--muted-foreground)]">{t("ui.game.contactBook.noMatches")}</p>
              ) : (
                <div className="space-y-2">
                  {visible.map((contact) => {
                    const opinion =
                      typeof contact.opinion === "string" && contact.opinion.trim()
                        ? Number(contact.opinion)
                        : contact.opinion;
                    const validOpinion =
                      typeof opinion === "number" && Number.isFinite(opinion) && opinion >= -100 && opinion <= 100;
                    const relationship = contact.relationshipStatus?.trim();
                    return (
                      <article
                        key={contact.id}
                        className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          {contact.characterId ? (
                            <button
                              type="button"
                              className="font-semibold hover:underline"
                              onClick={() => onOpenCharacter?.(contact.characterId!)}
                            >
                              {contact.name}
                            </button>
                          ) : (
                            <h2 className="font-semibold">{contact.name}</h2>
                          )}
                          <span className="text-xs text-[var(--muted-foreground)]">
                            {t("ui.game.contactBook.opinion")}:{" "}
                            {validOpinion
                              ? t("ui.game.contactBook.opinionValue", { value: opinion })
                              : t("ui.game.contactBook.unknown")}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                          {t("ui.game.contactBook.relationshipStatus")}:{" "}
                          {relationship && !relationship.startsWith("reputation:")
                            ? relationship.replaceAll("-", " ")
                            : t("ui.game.contactBook.unknown")}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <select
                            value=""
                            onChange={(event) => {
                              const id = event.target.value;
                              if (id)
                                persist(categories, {
                                  ...groups,
                                  [contact.id]: [...new Set([...(groups[contact.id] ?? []), id])],
                                });
                            }}
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
                              {categories.find((item) => item.id === id)?.name ?? id}
                              <button
                                type="button"
                                className="ml-1"
                                onClick={() =>
                                  persist(categories, {
                                    ...groups,
                                    [contact.id]: (groups[contact.id] ?? []).filter((value) => value !== id),
                                  })
                                }
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
                    );
                  })}
                </div>
              )}
            </main>
          </div>
        </>
      )}
    </Modal>
  );
}
