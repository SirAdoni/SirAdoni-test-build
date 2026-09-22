import { useState } from "react";
import { Check, Plus, Trash2, X } from "lucide-react";
import {
  TEXT_SNIPPET_MAX_COUNT,
  TEXT_SNIPPET_MAX_EXPANSION_LENGTH,
  TEXT_SNIPPET_MAX_TRIGGER_LENGTH,
  TEXT_SNIPPET_TRIGGER_PATTERN,
  type TextSnippet,
} from "@marinara-engine/shared";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSaveTextSnippets, useTextSnippets } from "../../../hooks/use-text-snippets";
import { showConfirmDialog } from "../../../lib/app-dialogs";
import { cn } from "../../../lib/utils";

type SnippetDraft = { id: string | null; trigger: string; expansion: string };

/** Shows the literal macro names in copy instead of letting i18next interpolate them. */
const MACRO_LITERALS = { cursor: "{{cursor}}", char: "{{char}}", user: "{{user}}" };

const EMPTY_DRAFT: SnippetDraft = { id: null, trigger: "", expansion: "" };

const FIELD_CLASS =
  "w-full rounded-lg bg-[var(--secondary)] px-2.5 py-2 text-xs outline-none ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/60 focus:ring-[var(--ring)]";

function makeSnippetId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `snippet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function TextSnippetsSettings() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useTextSnippets();
  const snippets = data?.snippets ?? [];
  const saveSnippets = useSaveTextSnippets();
  const [draft, setDraft] = useState<SnippetDraft>(EMPTY_DRAFT);
  const [formOpen, setFormOpen] = useState(false);
  const [validationKey, setValidationKey] = useState<string | null>(null);

  const resetForm = () => {
    setDraft(EMPTY_DRAFT);
    setFormOpen(false);
    setValidationKey(null);
  };

  const saveDraft = async () => {
    const trigger = draft.trigger.trim();
    const expansion = draft.expansion;
    let errorKey: string | null = null;
    if (!trigger || !TEXT_SNIPPET_TRIGGER_PATTERN.test(trigger)) errorKey = "snippets.validation.trigger";
    else if (trigger.length > TEXT_SNIPPET_MAX_TRIGGER_LENGTH) errorKey = "snippets.validation.triggerLength";
    else if (snippets.some((snippet) => snippet.id !== draft.id && snippet.trigger === trigger)) {
      errorKey = "snippets.validation.duplicate";
    } else if (!expansion.trim()) errorKey = "snippets.validation.expansion";
    else if (expansion.length > TEXT_SNIPPET_MAX_EXPANSION_LENGTH) errorKey = "snippets.validation.expansionLength";
    else if (!draft.id && snippets.length >= TEXT_SNIPPET_MAX_COUNT) errorKey = "snippets.validation.count";
    if (errorKey) {
      setValidationKey(errorKey);
      return;
    }

    const nextSnippet: TextSnippet = { id: draft.id ?? makeSnippetId(), trigger, expansion };
    const next = draft.id
      ? snippets.map((snippet) => (snippet.id === draft.id ? nextSnippet : snippet))
      : [...snippets, nextSnippet];
    try {
      await saveSnippets.mutateAsync(next);
      toast.success(t("snippets.saved"));
      resetForm();
    } catch {
      /* the mutation already reported the failure */
    }
  };

  const deleteSnippet = async (snippet: TextSnippet) => {
    const confirmed = await showConfirmDialog({
      title: t("snippets.deleteTitle"),
      message: t("snippets.deleteMessage", { trigger: snippet.trigger }),
      confirmLabel: t("snippets.deleteAction"),
      cancelLabel: t("chat.delete.dialog.cancel"),
      tone: "destructive",
    });
    if (!confirmed) return;
    try {
      await saveSnippets.mutateAsync(snippets.filter((candidate) => candidate.id !== snippet.id));
      if (draft.id === snippet.id) resetForm();
    } catch {
      /* the mutation already reported the failure */
    }
  };

  if (isLoading) {
    return <p className="text-xs text-[var(--muted-foreground)]">{t("snippets.loading")}</p>;
  }
  // Every save writes the whole list, so editing on top of a failed load would
  // replace the stored snippets with just the new one.
  if (!data && isError) {
    return (
      <div className="flex items-center justify-between gap-2 text-xs text-[var(--destructive)]">
        <span>{t("snippets.loadFailed")}</span>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mari-chrome-control mari-chrome-control--compact shrink-0 px-3"
        >
          {t("snippets.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{t("snippets.description")}</p>

      {snippets.length > 0 ? (
        <div className="space-y-1.5">
          {snippets.map((snippet) => (
            <div
              key={snippet.id}
              className="flex items-center gap-2 rounded-lg bg-[var(--background)]/55 px-2.5 py-2 ring-1 ring-[var(--border)]"
            >
              <button
                type="button"
                onClick={() => {
                  setDraft({ id: snippet.id, trigger: snippet.trigger, expansion: snippet.expansion });
                  setValidationKey(null);
                  setFormOpen(true);
                }}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-label={t("snippets.editAction", { trigger: snippet.trigger })}
              >
                <code className="shrink-0 rounded bg-[var(--secondary)] px-1.5 py-0.5 text-[0.6875rem] text-[var(--marinara-chat-chrome-button-text-active)]">
                  {snippet.trigger}
                </code>
                <span className="min-w-0 truncate text-[0.6875rem] text-[var(--muted-foreground)]">
                  {snippet.expansion}
                </span>
              </button>
              <div className="flex shrink-0">
                <button
                  type="button"
                  onClick={() => void deleteSnippet(snippet)}
                  disabled={saveSnippets.isPending}
                  className="mari-chrome-control mari-chrome-control--compact h-7 w-7 p-0 active:scale-90"
                  title={t("snippets.deleteNamed", { trigger: snippet.trigger })}
                  aria-label={t("snippets.deleteNamed", { trigger: snippet.trigger })}
                >
                  <Trash2 size="0.75rem" className="shrink-0 text-[var(--destructive)]" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        !formOpen && (
          <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--muted-foreground)]">
            {t("snippets.empty")}
          </div>
        )
      )}

      {formOpen ? (
        <div className="space-y-3 rounded-lg bg-[var(--background)]/55 p-3 ring-1 ring-[var(--border)]">
          <label className="block space-y-1">
            <span className="text-[0.625rem] font-medium text-[var(--muted-foreground)]">{t("snippets.trigger")}</span>
            <input
              value={draft.trigger}
              onChange={(event) => setDraft((current) => ({ ...current, trigger: event.target.value }))}
              placeholder={t("snippets.triggerPlaceholder")}
              maxLength={TEXT_SNIPPET_MAX_TRIGGER_LENGTH}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className={cn(FIELD_CLASS, "font-mono")}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[0.625rem] font-medium text-[var(--muted-foreground)]">
              {t("snippets.expansion")}
            </span>
            <textarea
              value={draft.expansion}
              onChange={(event) => setDraft((current) => ({ ...current, expansion: event.target.value }))}
              placeholder={t("snippets.expansionPlaceholder", MACRO_LITERALS)}
              rows={3}
              className={cn(FIELD_CLASS, "resize-y")}
            />
          </label>
          <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
            {t("snippets.macroHint", MACRO_LITERALS)}
          </p>
          {validationKey && (
            <p className="text-[0.625rem] text-amber-500">
              {t(validationKey, { max: TEXT_SNIPPET_MAX_COUNT, length: TEXT_SNIPPET_MAX_TRIGGER_LENGTH })}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={resetForm}
              className="mari-chrome-control mari-chrome-control--compact justify-center px-3"
            >
              <X size="0.75rem" />
              {t("chat.delete.dialog.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void saveDraft()}
              disabled={saveSnippets.isPending}
              className={cn(
                "mari-chrome-control mari-chrome-control--compact mari-chrome-control--selected justify-center px-3",
                saveSnippets.isPending && "opacity-60",
              )}
            >
              <Check size="0.75rem" />
              {t("snippets.save")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(EMPTY_DRAFT);
            setValidationKey(null);
            setFormOpen(true);
          }}
          disabled={snippets.length >= TEXT_SNIPPET_MAX_COUNT}
          className="mari-chrome-control mari-chrome-control--compact mari-chrome-control--selected w-full justify-center px-3"
        >
          <Plus size="0.75rem" />
          {t("snippets.add")}
        </button>
      )}
    </div>
  );
}
