/**
 * @license Lucide 0.513.0, ISC License
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
 * All other copyright (c) for Lucide are held by Lucide Contributors 2022.
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee
 * is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE
 * INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE
 * FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 * OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
 * ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
import { createElement, useEffect, useState } from "react";
import vectors from "./location-vectors.json";
import { gameIcons, loadGameIcon, type GameIconGeometry } from "./game-icon-loader";
import { useSpatialMapTranslation } from "../localization";

// Lucide 0.513.0 SVG geometry, distributed under LUCIDE-LICENSE.txt.
// Stable name hashes fit the existing 16-character storage contract.
const byId = new Map(vectors.map((vector) => [vector.id, vector]));
const byName = new Map(vectors.map((vector) => [vector.name, vector.id]));
export function vectorIdForName(name: string): string | undefined {
  return byName.get(name);
}
function GameVector({
  icon,
  className,
  retry,
  onError,
}: {
  icon: string;
  className?: string;
  retry?: number;
  onError?: () => void;
}) {
  const [loaded, setLoaded] = useState<{ id: string; geometry: GameIconGeometry } | null>(null);
  useEffect(() => {
    let active = true;
    void loadGameIcon(icon).then(
      (geometry) => {
        if (active) setLoaded({ id: icon, geometry });
      },
      () => {
        if (active) onError?.();
      },
    );
    return () => {
      active = false;
    };
  }, [icon, retry, onError]);
  const geometry = loaded?.id === icon ? loaded.geometry : null;
  return (
    <span
      data-marinara-location-icon
      data-location-symbol={gameIcons.get(icon)?.name}
      aria-hidden="true"
      className={className}
    >
      {geometry ? (
        <svg
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          width="1em"
          height="1em"
          fill="currentColor"
          stroke="none"
        >
          {geometry.paths.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
      ) : (
        <span>⌖</span>
      )}
    </span>
  );
}
export function LocationVector({
  icon,
  className,
  retry,
  onError,
}: {
  icon: string;
  className?: string;
  retry?: number;
  onError?: () => void;
}) {
  if (gameIcons.has(icon)) return <GameVector icon={icon} className={className} retry={retry} onError={onError} />;
  const vector = byId.get(icon);
  if (!vector)
    return (
      <span aria-hidden="true" className={className}>
        ⌖
      </span>
    );
  return (
    <span data-marinara-location-icon data-location-symbol={vector.name} aria-hidden="true" className={className}>
      <svg
        viewBox="0 0 24 24"
        width="1em"
        height="1em"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {vector.nodes.map(([tag, attributes], index) =>
          createElement(tag as string, { ...(attributes as Record<string, unknown>), key: index }),
        )}
      </svg>
    </span>
  );
}

export function LocationVectorChoices({ onSelect }: { onSelect: (icon: string) => void }) {
  const { t } = useSpatialMapTranslation();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(72);
  const [open, setOpen] = useState(false);
  const [pack, setPack] = useState("all");
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  const [onError] = useState(() => () => setFailed(true));
  const all = [
    ...vectors.map((v) => ({ ...v, pack: "lucide", label: t(`ui.worldMaps.vectors.${v.name}`) })),
    ...Array.from(gameIcons.values(), (v) => ({ ...v, pack: "game", label: t(`ui.worldMaps.gameIcons.${v.name}`) })),
  ];
  const matches = all.filter(
    (vector) =>
      (pack === "all" || pack === vector.pack) &&
      `${vector.name} ${vector.label}`.replaceAll("-", " ").toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <details className="col-span-2 min-w-0" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs">
        {t("ui.worldMaps.vectors.choose")} ({all.length})
      </summary>
      {open && (
        <>
          <select
            aria-label={t("ui.worldMaps.vectorPicker.pack")}
            value={pack}
            onChange={(event) => {
              setPack(event.target.value);
              setLimit(72);
            }}
            className="mt-2 min-h-11 w-full rounded border border-[var(--border)] bg-[var(--background)] p-2 text-sm"
          >
            {["all", "lucide", "game"].map((value) => (
              <option key={value} value={value}>
                {t(`ui.worldMaps.vectorPicker.${value}`)}
              </option>
            ))}
          </select>
          <input
            type="search"
            value={query}
            aria-label={t("ui.worldMaps.vectorPicker.search")}
            placeholder={t("ui.worldMaps.vectorPicker.search")}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(72);
            }}
            className="mt-2 w-full rounded border border-[var(--border)] bg-[var(--background)] p-2 text-sm"
          />
          <div className="mt-2 flex max-h-72 flex-wrap gap-1 overflow-y-auto">
            {matches.slice(0, limit).map((vector) => (
              <button
                key={vector.id}
                type="button"
                title={`${vector.label} · ${vector.pack === "game" ? "Game Icons" : "Lucide"}`}
                aria-label={vector.label}
                onClick={() => onSelect(vector.id)}
                className="flex h-11 w-11 items-center justify-center rounded border border-[var(--border)] text-xl hover:bg-[var(--muted)] focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
              >
                <LocationVector icon={vector.id} retry={retry} onError={onError} />
              </button>
            ))}
            {!matches.length && <p className="text-sm">{t("ui.worldMaps.vectors.empty")}</p>}
          </div>
          {matches.length > limit && (
            <button
              type="button"
              onClick={() => setLimit(limit + 72)}
              className="mt-2 min-h-11 text-sm text-[var(--marinara-chat-chrome-accent)]"
            >
              {t("ui.worldMaps.vectors.more")}
            </button>
          )}
          {failed && (
            <button
              type="button"
              className="mt-2 min-h-11 text-sm"
              onClick={() => {
                setFailed(false);
                setRetry((n) => n + 1);
              }}
            >
              {t("ui.worldMaps.vectorPicker.retry")}
            </button>
          )}
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer">{t("ui.worldMaps.vectorPicker.credits")}</summary>
            <p className="my-2">{t("ui.worldMaps.vectorPicker.attribution")}</p>
            <a href="https://game-icons.net/about.html" target="_blank" rel="noreferrer" className="underline">
              GameIcons
            </a>
            {" · "}
            <a
              href="https://github.com/game-icons/icons/blob/master/license.txt"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              CC BY 3.0
            </a>
          </details>
        </>
      )}
    </details>
  );
}
