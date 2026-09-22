import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChatMetadata } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { cn } from "../../lib/utils";
import { chatKeys, useUpdateChatMetadata } from "../../hooks/use-chats";

type LorebookOwner = "keeper" | "continuity";

export interface ContinuityOwnershipValue {
  lorebook: LorebookOwner;
  fromSession: number;
}

interface GameMemorySettingsProps {
  chatId: string;
  metadata?: ChatMetadata | null;
  /** Saved continuity mode; the Keeper hand-off only applies while memory is On. */
  mode: "off" | "shadow" | "active";
  ownership?: ContinuityOwnershipValue | null;
  onContinuityChanged: () => void;
}

const DEFAULT_BUDGET = 10_000;
const MIN_BUDGET = 1_000;
const MAX_BUDGET = 100_000;
const RECAP_LIMITS = [1, 2, 3, 5, 10] as const;

const selectClass =
  "min-h-8 rounded-md border border-border bg-secondary px-2 py-1 text-xs text-foreground outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50";

function Row({ label, hint, children }: { label: string; hint?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="text-xs font-semibold text-foreground">{label}</div>
        {hint && <div className="text-[0.6875rem] leading-4 text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-md border border-border bg-secondary/40 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => value !== option.value && onChange(option.value)}
          className={cn(
            "min-h-7 rounded px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50",
            value === option.value
              ? "bg-primary/20 font-semibold text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Per-chat knobs for how the GM reads campaign memory. Each control saves on change. */
export function GameMemorySettings({
  chatId,
  metadata,
  mode,
  ownership,
  onContinuityChanged,
}: GameMemorySettingsProps) {
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const updateMetadata = useUpdateChatMetadata({ serialize: true });
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const sessionNumber =
    typeof meta.gameSessionNumber === "number" && meta.gameSessionNumber >= 1 ? meta.gameSessionNumber : 1;
  const recapLimit =
    typeof meta.gamePromptRecentSessionLimit === "number" && meta.gamePromptRecentSessionLimit > 0
      ? meta.gamePromptRecentSessionLimit
      : null;
  const scope: "campaign" | "session" = meta.gameCampaignMemoryScope === "session" ? "session" : "campaign";
  const savedBudget =
    typeof meta.gameCampaignMemoryMaxCharacters === "number" && meta.gameCampaignMemoryMaxCharacters > 0
      ? meta.gameCampaignMemoryMaxCharacters
      : null;
  const [budgetText, setBudgetText] = useState(savedBudget ? String(savedBudget) : "");
  useEffect(() => setBudgetText(savedBudget ? String(savedBudget) : ""), [chatId, savedBudget]);

  const saveOwnership = useMutation({
    mutationFn: (next: ContinuityOwnershipValue) => api.patch(`/game/${chatId}/continuity`, { ownership: next }),
    onSuccess: () => {
      onContinuityChanged();
      void queryClient.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
    },
  });
  const patchMeta = (patch: Record<string, unknown>) => updateMetadata.mutate({ id: chatId, ...patch });

  const keeperReplaced = ownership?.lorebook === "continuity";
  const busy = saveOwnership.isPending || updateMetadata.isPending;

  const commitBudget = () => {
    const trimmed = budgetText.trim();
    if (!trimmed) {
      if (savedBudget !== null) patchMeta({ gameCampaignMemoryMaxCharacters: null });
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setBudgetText(savedBudget ? String(savedBudget) : "");
      return;
    }
    const clamped = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.round(parsed)));
    setBudgetText(String(clamped));
    if (clamped !== savedBudget) patchMeta({ gameCampaignMemoryMaxCharacters: clamped });
  };

  const keeperHint = keeperReplaced
    ? t("ui.game.memorySettings.keeperOnHint", {
        defaultValue: "Memory keeps the lorebook from session {{session}} on.",
        session: ownership?.fromSession ?? sessionNumber,
      })
    : t("ui.game.memorySettings.keeperOffHint", {
        defaultValue: "The Lorebook Keeper still writes the lorebook after each session.",
      });

  return (
    <div data-component="GameMemorySettings" className="border-t border-border pt-2">
      <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("ui.game.memorySettings.title", { defaultValue: "How the GM uses memory" })}
      </div>
      <div className="divide-y divide-border/60">
        <Row
          label={t("ui.game.memorySettings.keeperLabel", { defaultValue: "Replace the Lorebook Keeper" })}
          hint={
            mode !== "active"
              ? `${keeperHint} ${t("ui.game.memorySettings.keeperNeedsOn", { defaultValue: "Applies while memory is On." })}`
              : keeperHint
          }
        >
          <button
            type="button"
            role="switch"
            aria-checked={keeperReplaced}
            aria-label={t("ui.game.memorySettings.keeperLabel", { defaultValue: "Replace the Lorebook Keeper" })}
            disabled={busy}
            onClick={() =>
              saveOwnership.mutate(
                keeperReplaced
                  ? { lorebook: "keeper", fromSession: ownership?.fromSession ?? sessionNumber }
                  : { lorebook: "continuity", fromSession: sessionNumber },
              )
            }
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50",
              keeperReplaced ? "border-primary bg-primary/70" : "border-border bg-secondary",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-foreground shadow transition-transform",
                keeperReplaced ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        </Row>

        <Row
          label={t("ui.game.memorySettings.recapsLabel", { defaultValue: "Recaps of earlier sessions" })}
          hint={t("ui.game.memorySettings.recapsHint", {
            defaultValue: "Fewer recaps once memory covers the older sessions.",
          })}
        >
          <select
            value={recapLimit ?? ""}
            disabled={busy}
            aria-label={t("ui.game.memorySettings.recapsLabel", { defaultValue: "Recaps of earlier sessions" })}
            onChange={(event) =>
              patchMeta({ gamePromptRecentSessionLimit: event.target.value ? Number(event.target.value) : null })
            }
            className={selectClass}
          >
            <option value="">{t("ui.game.memorySettings.recapsAll", { defaultValue: "All" })}</option>
            {recapLimit !== null && !(RECAP_LIMITS as readonly number[]).includes(recapLimit) && (
              <option value={recapLimit}>
                {t("ui.game.memorySettings.recapsLast", { defaultValue: "Last {{count}}", count: recapLimit })}
              </option>
            )}
            {RECAP_LIMITS.map((limit) => (
              <option key={limit} value={limit}>
                {t("ui.game.memorySettings.recapsLast", { defaultValue: "Last {{count}}", count: limit })}
              </option>
            ))}
          </select>
        </Row>

        <Row label={t("ui.game.memorySettings.scopeLabel", { defaultValue: "Memory covers" })}>
          <Segmented
            label={t("ui.game.memorySettings.scopeLabel", { defaultValue: "Memory covers" })}
            value={scope}
            disabled={busy}
            onChange={(next) => patchMeta({ gameCampaignMemoryScope: next })}
            options={[
              {
                value: "campaign",
                label: t("ui.game.memorySettings.scopeCampaign", { defaultValue: "Whole campaign" }),
              },
              { value: "session", label: t("ui.game.memorySettings.scopeSession", { defaultValue: "This session" }) },
            ]}
          />
        </Row>

        <Row
          label={t("ui.game.memorySettings.budgetLabel", { defaultValue: "Memory budget for the GM" })}
          hint={t("ui.game.memorySettings.budgetHint", {
            defaultValue: "Characters of memory per turn. Empty uses {{count}}.",
            count: DEFAULT_BUDGET,
          })}
        >
          <input
            type="number"
            inputMode="numeric"
            min={MIN_BUDGET}
            max={MAX_BUDGET}
            step={1000}
            value={budgetText}
            placeholder={String(DEFAULT_BUDGET)}
            disabled={updateMetadata.isPending}
            aria-label={t("ui.game.memorySettings.budgetLabel", { defaultValue: "Memory budget for the GM" })}
            onChange={(event) => setBudgetText(event.target.value)}
            onBlur={commitBudget}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className={cn(selectClass, "w-24 text-right tabular-nums")}
          />
        </Row>
      </div>
      {(saveOwnership.isError || updateMetadata.isError) && (
        <p role="alert" className="pt-1 text-xs text-destructive">
          {t("ui.game.memorySettings.saveFailed", { defaultValue: "Could not save that setting. Try again." })}
        </p>
      )}
    </div>
  );
}
