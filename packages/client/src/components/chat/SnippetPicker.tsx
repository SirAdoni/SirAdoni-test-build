// ──────────────────────────────────────────────
// Chat: text snippet picker (opened from the composer's quick menu)
// ──────────────────────────────────────────────
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Search, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TextSnippet } from "@marinara-engine/shared";
import { filterSnippets } from "../../lib/text-snippets";
import { openSettingsTarget, TEXT_SNIPPETS_SETTINGS_CONTROL_ID } from "../../lib/settings-targets";
import { cn } from "../../lib/utils";

interface SnippetPickerProps {
  open: boolean;
  onClose: () => void;
  /** Element the picker floats above (the composer bar). */
  anchorRef: RefObject<HTMLElement | null>;
  snippets: readonly TextSnippet[];
  onPick: (snippet: TextSnippet) => void;
}

const VIEWPORT_PADDING = 8;
const PICKER_MAX_WIDTH = 352;

export function SnippetPicker({ open, onClose, anchorRef, snippets, onPick }: SnippetPickerProps) {
  const { t } = useTranslation();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => filterSnippets(snippets, query), [snippets, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(PICKER_MAX_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2);
      const left = Math.min(
        Math.max(VIEWPORT_PADDING, rect.right - width),
        window.innerWidth - VIEWPORT_PADDING - width,
      );
      setPosition({ left, width, bottom: Math.max(VIEWPORT_PADDING, window.innerHeight - rect.top + 6) });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [onClose, open]);

  if (!open || !position) return null;

  const pick = (snippet: TextSnippet | undefined) => {
    if (!snippet) return;
    onClose();
    onPick(snippet);
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("snippets.pickerTitle")}
      className="fixed z-[9999] flex max-h-[min(22rem,60vh)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] shadow-2xl"
      style={{ left: position.left, bottom: position.bottom, width: position.width }}
    >
      <label className="relative flex shrink-0 items-center border-b border-[var(--border)]/70">
        <Search
          size="0.8125rem"
          className="pointer-events-none absolute left-2.5 text-[var(--muted-foreground)]"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => (results.length ? (index + 1) % results.length : 0));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => (results.length ? (index - 1 + results.length) % results.length : 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              pick(results[active]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
              // Hand focus back to the composer instead of dropping it on the page.
              anchorRef.current?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])")?.focus();
            }
          }}
          placeholder={t("snippets.pickerSearch")}
          aria-label={t("snippets.pickerSearch")}
          aria-controls={listId}
          aria-activedescendant={results[active] ? `${listId}-${results[active].id}` : undefined}
          role="combobox"
          aria-expanded="true"
          className="h-10 w-full bg-transparent pl-8 pr-3 text-xs outline-none placeholder:text-[var(--muted-foreground)]"
        />
      </label>
      <div id={listId} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1">
        {results.length === 0 ? (
          <p className="px-2.5 py-3 text-center text-[0.6875rem] text-[var(--muted-foreground)]">
            {snippets.length === 0 ? t("snippets.empty") : t("snippets.noMatches")}
          </p>
        ) : (
          results.map((snippet, index) => (
            <button
              key={snippet.id}
              id={`${listId}-${snippet.id}`}
              type="button"
              role="option"
              aria-selected={index === active}
              onPointerEnter={() => setActive(index)}
              onClick={() => pick(snippet)}
              className={cn(
                "flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors",
                index === active ? "bg-[var(--accent)]" : "hover:bg-[var(--accent)]/60",
              )}
            >
              <code className="shrink-0 rounded bg-[var(--secondary)] px-1.5 py-0.5 text-[0.6875rem] text-[var(--marinara-chat-chrome-button-text-active)]">
                {snippet.trigger}
              </code>
              <span className="min-w-0 truncate text-[0.6875rem] text-[var(--muted-foreground)]">
                {snippet.expansion}
              </span>
            </button>
          ))
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          onClose();
          openSettingsTarget("general", TEXT_SNIPPETS_SETTINGS_CONTROL_ID);
        }}
        className="flex min-h-9 shrink-0 items-center justify-center gap-1.5 border-t border-[var(--border)]/70 text-[0.6875rem] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)]/60 hover:text-[var(--foreground)]"
      >
        <Settings2 size="0.75rem" aria-hidden="true" />
        {t("snippets.manage")}
      </button>
    </div>,
    document.body,
  );
}
