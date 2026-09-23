// ──────────────────────────────────────────────
// Library search field: keeps the typed text locally and
// hands it to the panel after a short pause, so a big
// library (hundreds of cards, nested folders) re-filters
// once per pause instead of once per keystroke.
// ──────────────────────────────────────────────
import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";

/** Pause before the panel sees the new text. Short enough to feel live. */
export const LIBRARY_SEARCH_COMMIT_DELAY_MS = 150;

type LibrarySearchInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  delayMs?: number;
};

export function LibrarySearchInput({
  value,
  onValueChange,
  delayMs = LIBRARY_SEARCH_COMMIT_DELAY_MS,
  onKeyDown,
  onBlur,
  ...inputProps
}: LibrarySearchInputProps) {
  const [draft, setDraft] = useState(value);
  const committedRef = useRef(value);
  const timerRef = useRef<number | null>(null);
  const draftRef = useRef(value);
  const onValueChangeRef = useRef(onValueChange);
  useEffect(() => {
    onValueChangeRef.current = onValueChange;
  }, [onValueChange]);

  // Outside changes (a clear button, a restored panel) replace the draft.
  useEffect(() => {
    if (value === committedRef.current) return;
    committedRef.current = value;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    draftRef.current = value;
    setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (next === committedRef.current) return;
    committedRef.current = next;
    onValueChangeRef.current(next);
  };

  // A pending edit still reaches the panel if the field unmounts mid-pause.
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
        if (draftRef.current !== committedRef.current) onValueChangeRef.current(draftRef.current);
      }
    },
    [],
  );

  return (
    <input
      {...inputProps}
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        draftRef.current = next;
        setDraft(next);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        // Clearing the field applies at once; typing waits for a pause.
        if (next === "") commit(next);
        else timerRef.current = window.setTimeout(() => commit(next), delayMs);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(event.currentTarget.value);
        onKeyDown?.(event);
      }}
      onBlur={(event) => {
        commit(event.currentTarget.value);
        onBlur?.(event);
      }}
    />
  );
}
