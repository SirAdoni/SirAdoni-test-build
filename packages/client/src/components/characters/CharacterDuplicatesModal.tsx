// ──────────────────────────────────────────────
// Character library: duplicate finder
// Read-only review of likely duplicates (same normalized name or overlapping
// description/personality). Offers open and compare; never deletes.
// ──────────────────────────────────────────────
import { useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Columns2, ExternalLink, Loader2, User } from "lucide-react";
import { Modal } from "../ui/Modal";
import { api } from "../../lib/api-client";
import { cn } from "../../lib/utils";
import { useCharacterDuplicates, type CharacterDuplicatesResult } from "../../hooks/use-characters";

type DuplicateGroup = CharacterDuplicatesResult["groups"][number];

const COMPARE_FIELDS = [
  "name",
  "creator",
  "character_version",
  "tags",
  "description",
  "personality",
  "scenario",
  "first_mes",
] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenCharacter: (id: string) => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

function fieldText(data: Record<string, unknown>, field: (typeof COMPARE_FIELDS)[number]) {
  const value = data[field];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join(", ");
  return typeof value === "string" ? value : "";
}

function CompareView({ group }: { group: DuplicateGroup }) {
  const { t } = useTranslation();
  const [cards, setCards] = useState<Array<Record<string, unknown>> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all(group.ids.map((id) => api.get<{ data: string | Record<string, unknown> }>(`/characters/${id}`)))
      .then((rows) => {
        if (cancelled) return;
        setCards(rows.map((row) => (typeof row.data === "string" ? JSON.parse(row.data) : row.data) ?? {}));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [group.ids]);

  if (failed) return <p className="text-xs text-[var(--destructive)]">{t("characters.duplicates.compareFailed")}</p>;
  if (!cards) return <Loader2 size="0.875rem" className="animate-spin text-[var(--muted-foreground)]" />;

  return (
    <div className="space-y-2">
      {COMPARE_FIELDS.map((field) => {
        const values = cards.map((card) => fieldText(card, field));
        const same = values.every((value) => value === values[0]);
        return (
          <div key={field} className="rounded-lg border border-[var(--border)] p-2">
            <div className="mb-1 flex items-center gap-2 text-[0.625rem] pointer-coarse:text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              {t(`characters.duplicates.field.${field}`)}
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-[0.5625rem] pointer-coarse:text-[0.6875rem] normal-case tracking-normal",
                  same ? "bg-emerald-400/15 text-emerald-500" : "bg-amber-400/15 text-amber-500",
                )}
              >
                {same ? t("characters.duplicates.same") : t("characters.duplicates.different")}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {values.map((value, index) => (
                <p
                  key={group.ids[index]}
                  className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[0.6875rem] leading-snug text-[var(--foreground)]"
                >
                  {value || (
                    <span className="italic text-[var(--muted-foreground)]">{t("characters.duplicates.empty")}</span>
                  )}
                </p>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CharacterDuplicatesModal({ open, onClose, onOpenCharacter, restoreFocusRef }: Props) {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch, isFetching } = useCharacterDuplicates(open);
  const [comparingKey, setComparingKey] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      restoreFocusRef={restoreFocusRef}
      title={t("characters.duplicates.title")}
      width="max-w-3xl"
      mobileFullscreen
    >
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{t("characters.duplicates.hint")}</p>
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <Loader2 size="0.875rem" className="animate-spin" />
            {t("characters.duplicates.scanning")}
          </div>
        ) : isError ? (
          <div className="flex items-center gap-2 text-xs text-[var(--destructive)]">
            {t("characters.duplicates.failed")}
            <button
              type="button"
              onClick={() => void refetch()}
              className="mari-chrome-control mari-chrome-control--compact pointer-coarse:min-h-9! pointer-coarse:min-w-9! pointer-coarse:text-[0.6875rem]!"
            >
              {t("characters.duplicates.retry")}
            </button>
          </div>
        ) : data && data.groups.length === 0 ? (
          <p className="text-xs text-[var(--muted-foreground)]">
            {t("characters.duplicates.none", { count: data.scanned })}
          </p>
        ) : (
          data && (
            <>
              <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
                {t("characters.duplicates.summary", { count: data.groups.length, scanned: data.scanned })}
                {isFetching && <Loader2 size="0.6875rem" className="ml-1.5 inline animate-spin" />}
              </p>
              <ul className="space-y-3">
                {data.groups.map((group) => {
                  const key = group.ids.join(",");
                  const comparing = comparingKey === key;
                  return (
                    <li key={key} className="space-y-2 rounded-xl border border-[var(--border)] p-2.5">
                      <div className="flex flex-wrap items-center gap-1.5 text-[0.625rem] pointer-coarse:text-[0.6875rem]">
                        {group.nameMatch && (
                          <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium">
                            {t("characters.duplicates.reasonName")}
                          </span>
                        )}
                        {group.similarity > 0 && (
                          <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium">
                            {t("characters.duplicates.reasonContent", { percent: Math.round(group.similarity * 100) })}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setComparingKey(comparing ? null : key)}
                          aria-pressed={comparing}
                          className={cn(
                            "mari-chrome-control mari-chrome-control--compact pointer-coarse:min-h-9! pointer-coarse:min-w-9! pointer-coarse:text-[0.6875rem]! ml-auto",
                            comparing && "mari-chrome-control--selected",
                          )}
                        >
                          <Columns2 size="0.625rem" />
                          {t("characters.duplicates.compare")}
                        </button>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {group.characters.map((character) => (
                          <div
                            key={character.id}
                            className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-[var(--secondary)]/40 p-2"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              {character.avatarPath ? (
                                <img
                                  src={character.avatarPath}
                                  alt=""
                                  loading="lazy"
                                  className="h-9 w-9 shrink-0 rounded-full object-cover"
                                />
                              ) : (
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]">
                                  <User size="0.875rem" />
                                </span>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-xs font-medium">{character.name}</div>
                                <div className="truncate text-[0.625rem] pointer-coarse:text-[0.6875rem] text-[var(--muted-foreground)]">
                                  {[
                                    character.comment,
                                    character.creator && t("characters.duplicates.by", { creator: character.creator }),
                                    character.version && `v${character.version}`,
                                    character.updatedAt &&
                                      t("characters.duplicates.updated", {
                                        date: new Date(character.updatedAt).toLocaleDateString(),
                                      }),
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => onOpenCharacter(character.id)}
                                className="mari-chrome-control mari-chrome-control--compact pointer-coarse:min-h-9! pointer-coarse:min-w-9! pointer-coarse:text-[0.6875rem]! shrink-0"
                                title={t("characters.duplicates.open")}
                              >
                                <ExternalLink size="0.625rem" />
                                <span className="max-sm:hidden">{t("characters.duplicates.open")}</span>
                              </button>
                            </div>
                            {character.tags.length > 0 && (
                              <div className="truncate text-[0.625rem] pointer-coarse:text-[0.6875rem] text-[var(--muted-foreground)]">
                                {character.tags.join(", ")}
                              </div>
                            )}
                            <p className="line-clamp-3 text-[0.6875rem] leading-snug text-[var(--foreground)]/85">
                              {character.description || (
                                <span className="italic text-[var(--muted-foreground)]">
                                  {t("characters.duplicates.empty")}
                                </span>
                              )}
                            </p>
                          </div>
                        ))}
                      </div>
                      {comparing && <CompareView group={group} />}
                    </li>
                  );
                })}
              </ul>
            </>
          )
        )}
      </div>
    </Modal>
  );
}
