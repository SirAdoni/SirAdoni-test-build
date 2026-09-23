import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui.store";

interface NameAliasesSectionProps {
  aliases: string[];
  onChange: (aliases: string[]) => void;
  nameColor?: string;
}

function NameAliasInput({ existing, onAdd }: { existing: string[]; onAdd: (aliases: string[]) => void }) {
  const { t: localizeUi } = useTranslation();
  const [value, setValue] = useState("");

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;

    const seen = new Set(existing.map((a) => a.toLowerCase()));
    const additions: string[] = [];
    for (const part of trimmed.split(",").map((p) => p.trim())) {
      if (!part || seen.has(part.toLowerCase())) continue;
      seen.add(part.toLowerCase());
      additions.push(part);
    }

    if (additions.length > 0) {
      onAdd(additions);
    }
    setValue("");
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
      <input
        type="text"
        aria-label={localizeUi("ui.characters.colorstab.nameAliases")}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={localizeUi("ui.characters.colorstab.nameAliasesPlaceholder")}
        className="w-full min-w-0 rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[0.6875rem] text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
        autoFocus={false}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!value.trim()}
        className="mari-editor-action mari-editor-action--accent mari-editor-action--primary rounded-xl px-3 py-1 text-[0.625rem]"
      >
        {localizeUi("ui.characters.colorstab.nameAliasesAdd")}
      </button>
    </div>
  );
}

export function NameAliasesSection({ aliases, onChange, nameColor }: NameAliasesSectionProps) {
  const { t: localizeUi } = useTranslation();
  const colorInlineNames = useUIStore((s) => s.colorInlineNames);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="text-[0.6875rem] font-medium text-[var(--foreground)]">
          {localizeUi("ui.characters.colorstab.nameAliases")}
        </label>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.5rem] font-semibold ring-1",
            colorInlineNames
              ? "bg-emerald-400/15 text-emerald-500 ring-emerald-400/20"
              : "bg-[var(--muted)] text-[var(--muted-foreground)] ring-[var(--border)]",
          )}
          title={
            colorInlineNames
              ? localizeUi("ui.characters.colorstab.nameAliasesActive")
              : localizeUi("ui.characters.colorstab.nameAliasesInactive")
          }
        >
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              colorInlineNames ? "bg-emerald-400" : "bg-[var(--muted-foreground)]",
            )}
          />
          {colorInlineNames
            ? localizeUi("ui.characters.colorstab.nameAliasesActive")
            : localizeUi("ui.characters.colorstab.nameAliasesInactive")}
        </span>
      </div>
      <p className="text-[0.625rem] text-[var(--muted-foreground)]">
        {localizeUi("ui.characters.colorstab.nameAliasesDescription")}
      </p>

      {aliases.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {aliases.map((alias, idx) => (
            <span
              key={`${alias}-${idx}`}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[0.625rem] text-[var(--foreground)]"
            >
              <span
                className="font-medium"
                style={
                  nameColor
                    ? nameColor.includes("gradient(")
                      ? {
                          backgroundImage: nameColor,
                          backgroundRepeat: "no-repeat",
                          backgroundSize: "100% 100%",
                          WebkitBackgroundClip: "text",
                          WebkitTextFillColor: "transparent",
                          backgroundClip: "text",
                          color: "transparent",
                        }
                      : { color: nameColor }
                    : undefined
                }
              >
                {alias}
              </span>
              <button
                type="button"
                aria-label={localizeUi("ui.characters.colorstab.nameAliasesRemove", { alias })}
                onClick={() => {
                  const next = aliases.filter((_, i) => i !== idx);
                  onChange(next);
                }}
                className="text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
              >
                <X size="0.625rem" />
              </button>
            </span>
          ))}
        </div>
      )}

      <NameAliasInput
        existing={aliases}
        onAdd={(additions) => {
          onChange([...aliases, ...additions]);
        }}
      />
    </div>
  );
}
