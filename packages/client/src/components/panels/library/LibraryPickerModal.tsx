// ──────────────────────────────────────────────
// Library picker: a small list dialog used for
// "Move to..." (folder tree) and campaign membership.
// ──────────────────────────────────────────────
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Minus, Search } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { Modal } from "../../ui/Modal";
import { cn } from "../../../lib/utils";

export type LibraryPickerOption = {
  key: string;
  label: string;
  /** Tree depth for indentation (0 = top level). */
  depth?: number;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
  /** Toggle pickers show a check (true), a dash (mixed) or nothing. */
  checked?: boolean | "mixed";
};

interface LibraryPickerModalProps {
  open: boolean;
  title: string;
  message?: string;
  options: LibraryPickerOption[];
  emptyText: string;
  /** "select" closes after one pick; "toggle" stays open so several rows can be switched. */
  mode?: "select" | "toggle";
  busy?: boolean;
  onPick: (key: string) => void;
  onClose: () => void;
}

const SEARCH_THRESHOLD = 8;

export function LibraryPickerModal({
  open,
  title,
  message,
  options,
  emptyText,
  mode = "select",
  busy = false,
  onPick,
  onClose,
}: LibraryPickerModalProps) {
  const { t: localizeUi } = useUiTranslation();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const visibleOptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.label.toLowerCase().includes(needle));
  }, [options, query]);

  return (
    <Modal open={open} onClose={onClose} title={title} width="max-w-sm" chatFloatingPanel>
      <div className="flex flex-col gap-2">
        {message && <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{message}</p>}
        {options.length > SEARCH_THRESHOLD && (
          <div className="relative">
            <Search
              size="0.75rem"
              className="mari-chrome-field-icon pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={localizeUi("ui.panels.libraryorganize.filterList")}
              className="mari-chrome-field h-9 w-full py-0 pl-8 pr-3 text-xs"
            />
          </div>
        )}
        <div role="listbox" aria-label={title} className="flex max-h-[55vh] flex-col gap-0.5 overflow-y-auto">
          {visibleOptions.length === 0 && (
            <p className="py-4 text-center text-xs italic text-[var(--muted-foreground)]">{emptyText}</p>
          )}
          {visibleOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              role="option"
              aria-selected={option.checked === true}
              disabled={option.disabled || busy}
              onClick={() => {
                onPick(option.key);
                if (mode === "select") onClose();
              }}
              style={{ paddingLeft: `${0.5 + (query ? 0 : (option.depth ?? 0)) * 0.875}rem` }}
              className={cn(
                "flex min-h-9 w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-xs transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent",
                option.checked === true && "bg-[var(--marinara-chat-chrome-highlight-bg)]",
              )}
            >
              {mode === "toggle" && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                    option.checked
                      ? "border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--marinara-chat-chrome-button-bg-active)] text-[var(--marinara-chat-chrome-button-text-active)]"
                      : "border-[var(--muted-foreground)]/40",
                  )}
                >
                  {option.checked === true && <Check size="0.625rem" />}
                  {option.checked === "mixed" && <Minus size="0.625rem" />}
                </span>
              )}
              {option.icon && <span className="shrink-0 text-[var(--muted-foreground)]">{option.icon}</span>}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.hint && (
                <span className="max-w-[40%] shrink-0 truncate text-[0.625rem] text-[var(--muted-foreground)]">
                  {option.hint}
                </span>
              )}
            </button>
          ))}
        </div>
        {mode === "toggle" && (
          <button
            type="button"
            onClick={onClose}
            className="mari-chrome-control mari-chrome-control--primary mt-1 w-full py-2 text-xs"
          >
            {localizeUi("ui.panels.libraryorganize.done")}
          </button>
        )}
      </div>
    </Modal>
  );
}
