import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { normalizeGenerationTokenUsage, type GenerationTokenUsageInput } from "../../lib/generation-token-usage";

interface GenerationTokenUsageProps {
  generationInfo: GenerationTokenUsageInput | null | undefined;
  className?: string;
}

function count(value: number | null, notReported: string): string {
  return value == null ? notReported : value.toLocaleString();
}

function percent(value: number | null, notReported: string): string {
  if (value == null) return notReported;
  if (value >= 1) return "100%";
  const floored = Math.floor(Math.max(0, value * 10000)) / 100;
  return `${floored.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

export function GenerationTokenUsage({ generationInfo, className }: GenerationTokenUsageProps) {
  const { t } = useTranslation();
  const usage = normalizeGenerationTokenUsage(generationInfo);
  if (!usage) return null;
  const notReported = t("ui.generationtokenusage.notReported");
  const summary = [
    usage.inputTotal != null
      ? `${t("ui.generationtokenusage.inputShort")} ${count(usage.inputTotal, notReported)}`
      : null,
    usage.output != null ? `${t("ui.generationtokenusage.outputShort")} ${count(usage.output, notReported)}` : null,
    usage.cacheHitRatio != null ? `${percent(usage.cacheHitRatio, notReported)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <details
      className={cn("group/usage min-w-0 max-w-full text-[0.625rem]", className)}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      data-game-skip-bg-nav="true"
    >
      <summary className="inline-flex min-h-11 max-w-full cursor-pointer select-none flex-wrap items-center rounded-md px-1.5 py-1 font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)]/40 hover:text-[var(--foreground)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/40">
        <ChevronDown size={12} aria-hidden="true" className="mr-1 shrink-0 group-open/usage:rotate-180" />
        {summary ? t("ui.generationtokenusage.summary", { details: summary }) : t("ui.generationtokenusage.tokens")}
      </summary>
      <div className="mt-1 grid w-max min-w-0 max-w-full grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--foreground)] shadow-lg">
        <div className="col-span-2 mb-1 text-[var(--muted-foreground)]">
          {t("ui.generationtokenusage.mainResponseOnly")}
        </div>
        <span className="text-[var(--muted-foreground)]">{t("ui.generationtokenusage.input")}</span>
        <span className="tabular-nums">
          {count(usage.inputTotal, notReported)}
          {usage.inputTotal == null && usage.freshInput != null
            ? t("ui.generationtokenusage.freshCount", { tokens: count(usage.freshInput, notReported) })
            : ""}
        </span>
        <span className="text-[var(--muted-foreground)]">{t("ui.generationtokenusage.output")}</span>
        <span className="tabular-nums">{count(usage.output, notReported)}</span>
        <span className="text-[var(--muted-foreground)]">{t("ui.generationtokenusage.cacheRead")}</span>
        <span className="tabular-nums">{count(usage.cacheRead, notReported)}</span>
        <span className="text-[var(--muted-foreground)]">{t("ui.generationtokenusage.cacheWrite")}</span>
        <span className="tabular-nums">{count(usage.cacheWrite, notReported)}</span>
        <span className="text-[var(--muted-foreground)]">{t("ui.generationtokenusage.hitRatio")}</span>
        <span className="tabular-nums">{percent(usage.cacheHitRatio, notReported)}</span>
      </div>
    </details>
  );
}
