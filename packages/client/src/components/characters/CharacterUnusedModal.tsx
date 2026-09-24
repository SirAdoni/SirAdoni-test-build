// ──────────────────────────────────────────────
// Character library: cards never used in any chat
// Read-only report. A card counts as used when any chat names it as a member,
// the persona character, or a Game Mode party member, NPC or GM.
// ──────────────────────────────────────────────
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, Search, User } from "lucide-react";
import { Modal } from "../ui/Modal";
import { cn } from "../../lib/utils";
import { useUnusedCharacters } from "../../hooks/use-character-usage";

type CategoryFilter = "all" | "characters" | "npcs";

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenCharacter: (id: string) => void;
}

export function CharacterUnusedModal({ open, onClose, onOpenCharacter }: Props) {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useUnusedCharacters(open);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (data?.characters ?? []).filter(
      (character) =>
        (category === "all" || character.category === category) &&
        (!query || character.name.toLocaleLowerCase().includes(query)),
    );
  }, [data, category, search]);

  return (
    <Modal open={open} onClose={onClose} title={t("characters.unused.title")} width="max-w-lg" mobileFullscreen>
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{t("characters.unused.hint")}</p>
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <Loader2 size="0.875rem" className="animate-spin" />
            {t("characters.unused.scanning")}
          </div>
        ) : isError ? (
          <div className="flex items-center gap-2 text-xs text-[var(--destructive)]">
            {t("characters.unused.failed")}
            <button
              type="button"
              onClick={() => void refetch()}
              className="mari-chrome-control mari-chrome-control--compact"
            >
              {t("characters.duplicates.retry")}
            </button>
          </div>
        ) : data && data.total === 0 ? (
          <p className="text-xs text-[var(--muted-foreground)]">{t("characters.unused.none")}</p>
        ) : (
          data && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {(["all", "characters", "npcs"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setCategory(option)}
                    aria-pressed={category === option}
                    className={cn(
                      "mari-chrome-control mari-chrome-control--compact",
                      category === option && "mari-chrome-control--selected",
                    )}
                  >
                    {t(`characters.unused.category.${option}`)}
                  </button>
                ))}
                <div className="relative min-w-[8rem] flex-1">
                  <Search
                    size="0.75rem"
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
                  />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t("characters.unused.search")}
                    className="mari-chrome-field h-8 w-full py-0 pl-7 pr-2 text-xs"
                    aria-label={t("characters.unused.search")}
                  />
                </div>
              </div>
              <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
                {t("characters.unused.summary", { count: visible.length, total: data.total })}
              </p>
              <ul className="max-h-[60vh] divide-y divide-[var(--border)] overflow-y-auto rounded-xl border border-[var(--border)]">
                {visible.map((character) => (
                  <li key={character.id}>
                    <button
                      type="button"
                      onClick={() => onOpenCharacter(character.id)}
                      className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-[var(--accent)]"
                      title={t("characters.unused.open")}
                    >
                      {character.avatarPath ? (
                        <img
                          src={character.avatarPath}
                          alt=""
                          loading="lazy"
                          className="h-8 w-8 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]">
                          <User size="0.8125rem" />
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">
                          {character.name || t("characters.unused.unnamed")}
                        </span>
                        <span className="block truncate text-[0.625rem] pointer-coarse:text-[0.6875rem] text-[var(--muted-foreground)]">
                          {t(`characters.unused.category.${character.category}`)}
                          {" · "}
                          {t("characters.unused.added", { date: new Date(character.createdAt).toLocaleDateString() })}
                        </span>
                      </span>
                      <ExternalLink size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )
        )}
      </div>
    </Modal>
  );
}
