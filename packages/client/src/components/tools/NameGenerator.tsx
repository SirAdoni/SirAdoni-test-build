// ──────────────────────────────────────────────
// Name generator: seeded fantasy names with lock, copy and regenerate
// ──────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Dices, Lock, LockOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "../../lib/utils";
import { useLorebookEntries, useLorebooks } from "../../hooks/use-lorebooks";
import { useCharacters } from "../../hooks/use-characters";
import {
  extractTrainingNames,
  generateNameAt,
  isUsableMarkovModel,
  randomNameSeed,
  trainMarkovNameModel,
  type GeneratedName,
  type NameGender,
  type NameStyleId,
} from "../../lib/name-generator";

type SourceId = Exclude<NameStyleId, "learned"> | "lorebook" | "characters";

const SOURCES: ReadonlyArray<{ id: SourceId; labelKey: string }> = [
  { id: "northern", labelKey: "ui.nameGenerator.styleNorthern" },
  { id: "elvish", labelKey: "ui.nameGenerator.styleElvish" },
  { id: "desert", labelKey: "ui.nameGenerator.styleDesert" },
  { id: "imperial", labelKey: "ui.nameGenerator.styleImperial" },
  { id: "lorebook", labelKey: "ui.nameGenerator.styleLorebook" },
  { id: "characters", labelKey: "ui.nameGenerator.styleCharacters" },
];

const GENDERS: ReadonlyArray<{ id: NameGender; labelKey: string }> = [
  { id: "neutral", labelKey: "ui.nameGenerator.genderAny" },
  { id: "feminine", labelKey: "ui.nameGenerator.genderFeminine" },
  { id: "masculine", labelKey: "ui.nameGenerator.genderMasculine" },
];

const SLOT_COUNT = 8;
const SELECT_CLASS =
  "h-8 min-w-0 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

function characterName(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const data = (row as { data?: unknown }).data;
  try {
    const card = typeof data === "string" ? (JSON.parse(data) as unknown) : data;
    const name = card && typeof card === "object" ? (card as { name?: unknown }).name : null;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

export function NameGenerator({ className }: { className?: string }) {
  const { t } = useTranslation();
  const [source, setSource] = useState<SourceId>("northern");
  const [gender, setGender] = useState<NameGender>("neutral");
  const [surname, setSurname] = useState(true);
  const [seed, setSeed] = useState(() => randomNameSeed());
  const [lorebookId, setLorebookId] = useState<string>("");
  const [locked, setLocked] = useState<Record<number, GeneratedName>>({});
  const [copied, setCopied] = useState<number | null>(null);

  const learned = source === "lorebook" || source === "characters";
  const lorebooks = useLorebooks(undefined);
  const entries = useLorebookEntries(source === "lorebook" && lorebookId ? lorebookId : null);
  const characters = useCharacters({ enabled: source === "characters" });

  const model = useMemo(() => {
    if (source === "lorebook") {
      const texts = (entries.data ?? []).map((entry) => entry.name);
      return trainMarkovNameModel(extractTrainingNames(texts));
    }
    if (source === "characters") {
      const names = (characters.data ?? []).map(characterName).filter((name): name is string => !!name);
      return trainMarkovNameModel(extractTrainingNames(names));
    }
    return null;
  }, [source, entries.data, characters.data]);

  const ready = !learned || isUsableMarkovModel(model);

  const names = useMemo<GeneratedName[]>(() => {
    if (!ready) return [];
    const options = {
      style: learned ? ("learned" as const) : source,
      gender,
      surname,
      seed,
      model,
    };
    const used = new Set(Object.values(locked).map((name) => name.given.toLocaleLowerCase()));
    return Array.from({ length: SLOT_COUNT }, (_, slot) => {
      const kept = locked[slot];
      if (kept) return kept;
      const name = generateNameAt(options, slot, used);
      used.add(name.given.toLocaleLowerCase());
      return name;
    });
  }, [ready, learned, source, gender, surname, seed, model, locked]);

  // Switching the training set starts from a clean slate; locks from another style would mislead.
  useEffect(() => setLocked({}), [source, lorebookId]);

  const regenerate = useCallback(() => setSeed(randomNameSeed()), []);

  const toggleLock = (slot: number, name: GeneratedName) =>
    setLocked((current) => {
      const next = { ...current };
      if (next[slot]) delete next[slot];
      else next[slot] = name;
      return next;
    });

  const copy = async (slot: number, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(slot);
      window.setTimeout(() => setCopied((current) => (current === slot ? null : current)), 1200);
    } catch {
      toast.error(t("ui.nameGenerator.copyFailed"));
    }
  };

  const status = (() => {
    if (source === "lorebook" && !lorebookId) return t("ui.nameGenerator.pickLorebook");
    if (source === "lorebook" && entries.isLoading) return t("ui.nameGenerator.loadingNames");
    if (source === "characters" && characters.isLoading) return t("ui.nameGenerator.loadingNames");
    if (learned && !ready) return t("ui.nameGenerator.notEnoughNames");
    return null;
  })();

  return (
    <div className={cn("space-y-2.5", className)}>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
            {t("ui.nameGenerator.style")}
          </span>
          <select
            className={SELECT_CLASS}
            value={source}
            onChange={(event) => setSource(event.target.value as SourceId)}
          >
            {SOURCES.map((item) => (
              <option key={item.id} value={item.id}>
                {t(item.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
            {t("ui.nameGenerator.seed")}
          </span>
          <input
            className={SELECT_CLASS}
            value={seed}
            maxLength={40}
            spellCheck={false}
            onChange={(event) => setSeed(event.target.value)}
            aria-label={t("ui.nameGenerator.seed")}
          />
        </label>
      </div>

      {source === "lorebook" && (
        <select
          className={cn(SELECT_CLASS, "w-full")}
          value={lorebookId}
          onChange={(event) => setLorebookId(event.target.value)}
          aria-label={t("ui.nameGenerator.lorebook")}
        >
          <option value="">{t("ui.nameGenerator.pickLorebook")}</option>
          {(lorebooks.data ?? []).map((book) => (
            <option key={book.id} value={book.id}>
              {book.name}
            </option>
          ))}
        </select>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex rounded-md border border-border p-0.5"
          role="group"
          aria-label={t("ui.nameGenerator.gender")}
        >
          {GENDERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={gender === item.id}
              onClick={() => setGender(item.id)}
              className={cn(
                "rounded px-2 py-0.5 text-[0.6875rem] font-medium transition-colors",
                gender === item.id
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          <input
            type="checkbox"
            checked={surname}
            onChange={(event) => setSurname(event.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--primary)]"
          />
          {t("ui.nameGenerator.surname")}
        </label>
        <button
          type="button"
          onClick={regenerate}
          className="ml-auto flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-secondary"
          title={t("ui.nameGenerator.regenerateHint")}
        >
          <Dices size={13} />
          {t("ui.nameGenerator.regenerate")}
        </button>
      </div>

      {status ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {status}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {names.map((name, slot) => {
            const isLocked = Boolean(locked[slot]);
            return (
              <li key={slot} className="flex items-center gap-1 px-2 py-1.5">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm",
                    isLocked ? "font-medium text-foreground" : "text-foreground/90",
                  )}
                  title={name.full}
                >
                  {name.full}
                </span>
                <button
                  type="button"
                  onClick={() => toggleLock(slot, name)}
                  aria-pressed={isLocked}
                  aria-label={t(isLocked ? "ui.nameGenerator.unlock" : "ui.nameGenerator.lock")}
                  title={t(isLocked ? "ui.nameGenerator.unlock" : "ui.nameGenerator.lock")}
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-secondary",
                    isLocked ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {isLocked ? <Lock size={13} /> : <LockOpen size={13} />}
                </button>
                <button
                  type="button"
                  onClick={() => void copy(slot, name.full)}
                  aria-label={t("ui.nameGenerator.copy")}
                  title={t("ui.nameGenerator.copy")}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  {copied === slot ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {learned && ready && model && (
        <p className="text-[0.625rem] text-muted-foreground">
          {t("ui.nameGenerator.trainedOn", { count: model.known.length })}
        </p>
      )}
    </div>
  );
}
