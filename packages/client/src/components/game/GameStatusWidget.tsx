import { projectGameStatusStats, type GameStatusProjection } from "./game-status-widget";
import { useTranslation } from "react-i18next";

export function GameStatusWidget({ projection }: { projection: GameStatusProjection }) {
  const { t } = useTranslation();
  if (projection.bars.length === 0 && projection.attributes.length === 0) return null;
  return (
    <section aria-label={t("ui.game.statusWidget.title")} className="space-y-2 p-2 text-xs">
      <h2 className="font-semibold">{t("ui.game.statusWidget.title")}</h2>
      {projection.bars.map((bar) => (
        <div key={bar.id} className="space-y-1">
          <div className="flex justify-between gap-2">
            <span>{bar.label}</span>
            <span>
              {bar.value} / {bar.max}
            </span>
          </div>
          <div
            role="meter"
            aria-label={bar.label}
            aria-valuenow={bar.value}
            aria-valuemin={0}
            aria-valuemax={bar.max}
            className="h-1.5 overflow-hidden rounded-full bg-[var(--muted)]"
          >
            <div
              className="h-full rounded-full bg-[var(--primary)]"
              style={{ width: `${(bar.value / bar.max) * 100}%`, backgroundColor: bar.color }}
            />
          </div>
        </div>
      ))}
      {projection.attributes.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-[var(--border)] pt-2">
          {projection.attributes.map((attribute) => (
            <div key={attribute.id} className="flex justify-between gap-2">
              <dt className="text-[var(--muted-foreground)]">{attribute.label}</dt>
              <dd>{attribute.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export { projectGameStatusStats };
