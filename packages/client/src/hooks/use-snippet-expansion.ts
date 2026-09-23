import {
  useCallback,
  useEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import type { TextSnippet } from "@marinara-engine/shared";
import { findSnippetExpansion, insertSnippetEdit } from "../lib/text-snippets";
import { replaceTextareaRange } from "../lib/textarea-editing";
import { useTextSnippets } from "./use-text-snippets";

const NO_SNIPPETS: TextSnippet[] = [];

/** Window event other surfaces (the command palette) fire to open the composer's snippet picker. */
export const OPEN_SNIPPET_PICKER_EVENT = "marinara:open-snippet-picker";

export function requestSnippetPicker() {
  window.dispatchEvent(new Event(OPEN_SNIPPET_PICKER_EVENT));
}

/**
 * Inline text snippet expansion for an uncontrolled chat textarea.
 *
 * - Call `expandOnInput(event)` first thing in the textarea's onInput: typing a
 *   trigger followed by a space expands it (works with mobile keyboards, which
 *   do not report a reliable keydown for space).
 * - Call `expandOnKeyDown(event)` after any autocomplete handling in onKeyDown:
 *   Tab right after a trigger expands it and returns true.
 *
 * Expansions go through the native undo stack, so Ctrl+Z restores the trigger.
 */
export function useSnippetExpansion(textareaRef: RefObject<HTMLTextAreaElement | null>, onPickerRequest?: () => void) {
  const { data } = useTextSnippets();
  const snippets = data?.snippets ?? NO_SNIPPETS;
  const expandingRef = useRef(false);

  const applyEdit = useCallback((el: HTMLTextAreaElement, edit: ReturnType<typeof insertSnippetEdit>) => {
    expandingRef.current = true;
    try {
      replaceTextareaRange(el, edit.start, edit.end, edit.replacement, edit.caret);
    } finally {
      expandingRef.current = false;
    }
  }, []);

  const tryExpand = useCallback(
    (delimiter: "space" | "tab") => {
      const el = textareaRef.current;
      if (!el || expandingRef.current || snippets.length === 0) return false;
      if (el.selectionStart !== el.selectionEnd) return false;
      const edit = findSnippetExpansion(el.value, el.selectionStart, snippets, delimiter);
      if (!edit) return false;
      applyEdit(el, edit);
      return true;
    },
    [applyEdit, snippets, textareaRef],
  );

  const expandOnInput = useCallback(
    (event?: FormEvent<HTMLTextAreaElement>) => {
      const native = event?.nativeEvent as InputEvent | undefined;
      // Mobile keyboards and autocorrect can insert "word " in one event, so
      // only the trailing space matters; the caret check happens in tryExpand.
      if (!native || native.isComposing || native.inputType !== "insertText" || !native.data?.endsWith(" ")) {
        return false;
      }
      return tryExpand("space");
    },
    [tryExpand],
  );

  const expandOnKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
      if (event.nativeEvent.isComposing) return false;
      if (!tryExpand("tab")) return false;
      event.preventDefault();
      return true;
    },
    [tryExpand],
  );

  /** Inserts a snippet at the caret (replacing any selection), for the snippet picker. */
  const insertSnippet = useCallback(
    (snippet: TextSnippet) => {
      const el = textareaRef.current;
      if (!el || el.disabled) return;
      el.focus();
      applyEdit(el, insertSnippetEdit(snippet, el.selectionStart, el.selectionEnd));
    },
    [applyEdit, textareaRef],
  );

  useEffect(() => {
    if (!onPickerRequest) return;
    const handleRequest = () => {
      const el = textareaRef.current;
      // Only the composer that is actually on screen answers.
      if (!el || el.disabled || el.getClientRects().length === 0) return;
      onPickerRequest();
    };
    window.addEventListener(OPEN_SNIPPET_PICKER_EVENT, handleRequest);
    return () => window.removeEventListener(OPEN_SNIPPET_PICKER_EVENT, handleRequest);
  }, [onPickerRequest, textareaRef]);

  return { snippets, expandOnInput, expandOnKeyDown, insertSnippet };
}
