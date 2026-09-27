import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Loader2, Pencil } from "lucide-react";
import type { GameTurnClock } from "@marinara-engine/shared";
import { useTranslation } from "react-i18next";
import { useCorrectGameTurnReview, useGameTurnReview } from "../../hooks/use-game-turn-review";

interface GameTurnReviewProps {
  chatId: string;
  messageId: string;
  swipeIndex: number;
  onSourceSelect?: (evidence: { messageId: string; swipeIndex: number; quote: string }) => void;
}

function formatClock(clock: GameTurnClock | null, empty: string, dayLabel: string) {
  if (!clock) return empty;
  return `${dayLabel} ${clock.day}, ${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
}

function displayValue(value: string | null, empty: string) {
  return value?.trim() || empty;
}

export function GameTurnReview({ chatId, messageId, swipeIndex, onSourceSelect }: GameTurnReviewProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [correctionsOpen, setCorrectionsOpen] = useState(false);
  const [time, setTime] = useState<GameTurnClock>({ day: 1, hour: 0, minute: 0 });
  const [locationId, setLocationId] = useState("");
  const [personName, setPersonName] = useState("");
  const hydratedRevision = useRef<string | null>(null);
  const { data, isLoading, isError, refetch } = useGameTurnReview(chatId, messageId, swipeIndex);
  const correction = useCorrectGameTurnReview(chatId, messageId, swipeIndex);

  useEffect(() => {
    if (!data) return;
    if (hydratedRevision.current === data.revision) return;
    if (correctionsOpen && hydratedRevision.current !== null) return;
    setTime(data.editableTime ?? data.after.time ?? data.before.time ?? { day: 1, hour: 0, minute: 0 });
    setLocationId(data.after.location?.id ?? data.locations[0]?.id ?? "");
    hydratedRevision.current = data.revision;
  }, [correctionsOpen, data]);

  const people = useMemo(() => {
    if (!data) return [];
    return Array.from(
      new Set([
        ...(data.before.present ?? []),
        ...(data.after.present ?? []),
        ...data.changes
          .filter((change) => change.field === "presence")
          .flatMap((change) => (change.subject ? [change.subject] : [])),
      ]),
    ).sort((a, b) => a.localeCompare(b));
  }, [data]);

  if (isLoading) return null;
  if (isError || !data) {
    return (
      <section className="mt-2 border-t border-white/10 pt-2" aria-label={t("ui.game.turnReview.title")}>
        <div className="flex items-center justify-between gap-2 px-1.5 text-xs text-[var(--muted-foreground)]">
          <span>{t("ui.game.turnReview.loadFailed")}</span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="text-[var(--primary)] underline underline-offset-2"
          >
            {t("ui.game.turnReview.retry")}
          </button>
        </div>
      </section>
    );
  }

  const submit = (payload: Parameters<typeof correction.mutate>[0]) => {
    if (!data.canCorrect || data.pending || correction.isPending) return;
    correction.mutate(payload);
  };

  return (
    <section className="mt-2 border-t border-white/10 pt-2" aria-label={t("ui.game.turnReview.title")}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-9 w-full items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-left text-xs text-white/75 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-semibold">{t("ui.game.turnReview.title")}</span>
          {data.changes.length > 0 && (
            <span className="rounded-full bg-[var(--primary)]/15 px-1.5 py-0.5 text-[0.65rem] text-[var(--primary)]">
              {data.changes.length}
            </span>
          )}
        </span>
        {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>

      {open && (
        <div className="space-y-3 px-1.5 pb-1 pt-2 text-xs">
          {data.pending && <p className="text-[var(--muted-foreground)]">{t("ui.game.turnReview.pending")}</p>}
          {!data.pending && (
            <div className="grid gap-1 text-[var(--muted-foreground)] sm:grid-cols-3">
              <span>
                <strong className="font-medium text-white/70">{t("ui.game.turnReview.time")}:</strong>{" "}
                {formatClock(data.after.time, t("ui.game.turnReview.unknown"), t("ui.game.turnReview.clockDay"))}
              </span>
              <span>
                <strong className="font-medium text-white/70">{t("ui.game.turnReview.location")}:</strong>{" "}
                {data.after.location?.name ?? t("ui.game.turnReview.unknown")}
              </span>
              <span>
                <strong className="font-medium text-white/70">{t("ui.game.turnReview.presence")}:</strong>{" "}
                {data.after.present === null
                  ? t("ui.game.turnReview.unknown")
                  : data.after.present.length > 0
                    ? data.after.present.join(", ")
                    : t("ui.game.turnReview.noOnePresent")}
              </span>
            </div>
          )}
          {!data.pending && data.changes.length === 0 && (
            <p className="text-[var(--muted-foreground)]">{t("ui.game.turnReview.noChanges")}</p>
          )}

          {data.changes.map((change) => (
            <div key={change.id} className="space-y-1 rounded-lg border border-white/10 bg-black/10 px-2.5 py-2">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-white/85">
                  {t(`ui.game.turnReview.field.${change.field}`)}
                  {change.subject ? [": ", change.subject].join("") : ""}
                </span>
                {change.corrected && <span className="text-[var(--primary)]">{t("ui.game.turnReview.corrected")}</span>}
              </div>
              <div className="text-[var(--muted-foreground)]">
                {change.field === "time" ? (
                  <>
                    {displayValue(change.before, t("ui.game.turnReview.unknown"))} →{" "}
                    {displayValue(change.after, t("ui.game.turnReview.unknown"))}
                  </>
                ) : (
                  <>
                    {displayValue(change.before, t("ui.game.turnReview.absent"))} →{" "}
                    {displayValue(change.after, t("ui.game.turnReview.absent"))}
                  </>
                )}
              </div>
              {change.evidence ? (
                <div>
                  <blockquote className="mt-1 border-l-2 border-[var(--border)] pl-2 text-[var(--muted-foreground)] [overflow-wrap:anywhere]">
                    {change.evidence.quote}
                  </blockquote>
                  <button
                    type="button"
                    onClick={() => onSourceSelect?.(change.evidence!)}
                    className="inline-flex min-h-7 items-center gap-1 text-left text-[var(--primary)] underline decoration-[var(--primary)]/40 underline-offset-2 hover:decoration-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                  >
                    <ExternalLink size={11} aria-hidden="true" />
                    <span>{t("ui.game.turnReview.sourceLine")}</span>
                  </button>
                </div>
              ) : (
                <span className="text-[var(--muted-foreground)]">{t("ui.game.turnReview.noSource")}</span>
              )}
            </div>
          ))}

          {data.canCorrect && !data.pending && (
            <div className="border-t border-white/10 pt-2">
              <button
                type="button"
                onClick={() => setCorrectionsOpen((value) => !value)}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1 text-[0.7rem] font-medium text-white/75 hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
              >
                <Pencil size={12} aria-hidden="true" />
                {t("ui.game.turnReview.correct")}
              </button>

              {correctionsOpen && (
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <form
                    className="space-y-1.5 rounded-md border border-white/10 p-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submit({ field: "time", value: time });
                    }}
                  >
                    <label className="block font-medium text-white/75">{t("ui.game.turnReview.time")}</label>
                    <div className="grid grid-cols-3 gap-1">
                      {(["day", "hour", "minute"] as const).map((field) => (
                        <label key={field} className="space-y-1 text-[0.65rem] text-white/55">
                          <span className="block">{t(`ui.game.turnReview.${field}`)}</span>
                          <input
                            type="number"
                            min={field === "day" ? 1 : 0}
                            max={field === "hour" ? 23 : field === "minute" ? 59 : undefined}
                            value={time[field]}
                            onChange={(event) =>
                              setTime((current) => ({ ...current, [field]: Number(event.target.value) }))
                            }
                            aria-label={t(`ui.game.turnReview.${field}`)}
                            className="h-8 w-full min-w-0 rounded-md border border-white/10 bg-black/20 px-1.5 text-xs text-white outline-none focus:border-[var(--primary)]"
                          />
                        </label>
                      ))}
                    </div>
                    <button
                      type="submit"
                      disabled={correction.isPending}
                      className="text-[var(--primary)] hover:underline disabled:opacity-50"
                    >
                      {t("ui.game.turnReview.apply")}
                    </button>
                  </form>

                  <form
                    className="space-y-1.5 rounded-md border border-white/10 p-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (locationId) submit({ field: "location", locationId });
                    }}
                  >
                    <label className="block font-medium text-white/75" htmlFor={`turn-review-location-${messageId}`}>
                      {t("ui.game.turnReview.location")}
                    </label>
                    <select
                      id={`turn-review-location-${messageId}`}
                      value={locationId}
                      onChange={(event) => setLocationId(event.target.value)}
                      className="h-8 w-full rounded-md border border-white/10 bg-black/20 px-1.5 text-xs text-white outline-none focus:border-[var(--primary)]"
                    >
                      {data.locations.map((location) => (
                        <option key={location.id} value={location.id ?? ""}>
                          {location.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      disabled={!locationId || correction.isPending}
                      className="text-[var(--primary)] hover:underline disabled:opacity-50"
                    >
                      {t("ui.game.turnReview.apply")}
                    </button>
                  </form>

                  <form
                    className="space-y-1.5 rounded-md border border-white/10 p-2 sm:col-span-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = personName.trim();
                      if (!name) return;
                      submit({ field: "presence", name, present: true });
                      setPersonName("");
                    }}
                  >
                    <label className="block font-medium text-white/75">{t("ui.game.turnReview.presence")}</label>
                    <div className="max-h-24 space-y-1 overflow-y-auto">
                      {people.map((name) => {
                        const present = data.after.present?.includes(name) ?? false;
                        return (
                          <label key={name} className="flex items-center gap-1.5 text-white/70">
                            <input
                              type="checkbox"
                              checked={present}
                              onChange={() => submit({ field: "presence", name, present: !present })}
                              disabled={correction.isPending}
                            />
                            <span className="truncate">{name}</span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="flex gap-1">
                      <input
                        value={personName}
                        onChange={(event) => setPersonName(event.target.value)}
                        placeholder={t("ui.game.turnReview.addPerson")}
                        aria-label={t("ui.game.turnReview.addPerson")}
                        className="h-8 min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-1.5 text-xs text-white outline-none placeholder:text-white/35 focus:border-[var(--primary)]"
                      />
                      <button
                        type="submit"
                        disabled={!personName.trim() || correction.isPending}
                        className="text-[var(--primary)] hover:underline disabled:opacity-50"
                      >
                        {t("ui.game.turnReview.add")}
                      </button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          )}
          {data.readOnlyReason && (
            <p className="text-[var(--muted-foreground)]">
              {t(
                data.readOnlyReason.includes("different saved swipe")
                  ? "ui.game.turnReview.readOnlySwipe"
                  : data.readOnlyReason.includes("latest completed")
                    ? "ui.game.turnReview.readOnlyHistory"
                    : data.readOnlyReason.includes("snapshot")
                      ? "ui.game.turnReview.readOnlySnapshot"
                      : "ui.game.turnReview.readOnlyBusy",
              )}
            </p>
          )}
          {correction.isPending && (
            <Loader2
              size={14}
              className="animate-spin text-[var(--primary)]"
              aria-label={t("ui.game.turnReview.saving")}
            />
          )}
        </div>
      )}
    </section>
  );
}
