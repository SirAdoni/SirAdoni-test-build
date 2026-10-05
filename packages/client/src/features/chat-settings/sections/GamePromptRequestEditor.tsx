import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, RotateCcw, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { getCachedFeatureEnabled, useFeatureEnabled } from "../../../hooks/use-feature-settings";
import { usePeekPrompt } from "../../../hooks/use-chats";
import { ApiError } from "../../../lib/api-client";
import {
  createGamePromptDirectEdits,
  previewGamePromptDirectEditsWithIssues,
  type GamePromptDirectEdit,
} from "../game-prompt-direct-edits";

interface PromptMessage {
  role: string;
  content: string;
}

interface GamePromptRequestEditorProps {
  chatId: string;
  settingsRevision?: string | null;
  existingEdits: GamePromptDirectEdit[];
  onSave: (edits: GamePromptDirectEdit[]) => Promise<unknown>;
  onReset: () => Promise<unknown>;
  onClose: () => void;
}

export function GamePromptRequestEditor({
  chatId,
  settingsRevision,
  existingEdits,
  onSave,
  onReset,
  onClose,
}: GamePromptRequestEditorProps) {
  const { t } = useTranslation();
  const enabled = useFeatureEnabled("gamePromptEditing");
  const queryClient = useQueryClient();
  const preview = usePeekPrompt();
  const [original, setOriginal] = useState<PromptMessage[] | null>(null);
  const [draft, setDraft] = useState<PromptMessage[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewIsExact, setPreviewIsExact] = useState<boolean | null>(null);
  const [unappliedEditCount, setUnappliedEditCount] = useState(0);
  const textareaRefs = useRef(new Map<number, HTMLTextAreaElement>());

  const load = async () => {
    if (!getCachedFeatureEnabled(queryClient, "gamePromptEditing")) return;
    setError("");
    try {
      let response = await preview.mutateAsync(chatId);
      if (!getCachedFeatureEnabled(queryClient, "gamePromptEditing")) return;
      let isExact = response.source === "cached" && response.exact !== false;
      const revisionMatches = response.gamePromptDirectEditsRevision === (settingsRevision ?? null);
      if (isExact && (!revisionMatches || (existingEdits.length > 0 && settingsRevision == null))) {
        response = await preview.mutateAsync({ chatId, freshPreview: true });
        if (!getCachedFeatureEnabled(queryClient, "gamePromptEditing")) return;
        isExact = false;
      }
      const edited = isExact
        ? { messages: response.messages, issues: [] }
        : previewGamePromptDirectEditsWithIssues(response.messages, existingEdits);
      setPreviewIsExact(isExact);
      setUnappliedEditCount(edited.issues.length);
      setOriginal(edited.messages);
      setDraft(edited.messages.map((message) => ({ ...message })));
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 404
          ? t("ui.chatSettings.gamePromptRequestEditor.noExactPrompt")
          : cause instanceof Error
            ? cause.message
            : t("ui.chatSettings.gamePromptRequestEditor.loadFailed"),
      );
    }
  };

  useEffect(() => {
    if (enabled && original === null) void load();
    // The editor is mounted only while open; a metadata save must not replace
    // unsaved text with a newly assembled prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, enabled]);

  const save = async () => {
    if (!original || !getCachedFeatureEnabled(queryClient, "gamePromptEditing")) return;
    setError("");
    setSaving(true);
    try {
      const nextEdits = createGamePromptDirectEdits(original, draft);
      if (nextEdits.length === 0) {
        onClose();
        return;
      }
      const combined = [...existingEdits, ...nextEdits];
      if (
        combined.length > 128 ||
        combined.reduce((size, edit) => size + edit.find.length + edit.replace.length, 0) > 900_000
      ) {
        throw new Error("GAME_PROMPT_EDIT_TOO_MANY");
      }
      await onSave(combined);
      toast.success(t("ui.chatSettings.gamePromptRequestEditor.savedForFuture"));
      onClose();
    } catch (cause) {
      const knownErrors: Record<string, string> = {
        GAME_PROMPT_EDIT_AMBIGUOUS: t("ui.chatSettings.gamePromptRequestEditor.ambiguousEdit"),
        GAME_PROMPT_EDIT_STALE: t("ui.chatSettings.gamePromptRequestEditor.staleEdit"),
        GAME_PROMPT_EDIT_TOO_MANY: t("ui.chatSettings.gamePromptRequestEditor.tooManyEdits"),
      };
      const message = cause instanceof Error ? knownErrors[cause.message] : undefined;
      setError(
        message ?? (cause instanceof Error ? cause.message : t("ui.chatSettings.gamePromptRequestEditor.saveFailed")),
      );
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!getCachedFeatureEnabled(queryClient, "gamePromptEditing")) return;
    setError("");
    setSaving(true);
    try {
      await onReset();
      toast.success(t("ui.chatSettings.gamePromptRequestEditor.clearedForFuture"));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("ui.chatSettings.gamePromptRequestEditor.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const dirty = original?.some((message, index) => message.content !== draft[index]?.content) ?? false;
  const query = search.trim().toLowerCase();
  const visibleIndices = draft.flatMap((message, index) =>
    !query || message.content.toLowerCase().includes(query) || original?.[index]?.content.toLowerCase().includes(query)
      ? [index]
      : [],
  );
  const jumpToMatch = () => {
    const index = visibleIndices[0];
    if (index === undefined || !search.trim()) return;
    const textarea = textareaRefs.current.get(index);
    if (!textarea) return;
    const matchAt = draft[index]!.content.toLowerCase().indexOf(search.trim().toLowerCase());
    textarea.focus();
    if (matchAt >= 0) textarea.setSelectionRange(matchAt, matchAt + search.trim().length);
    textarea.scrollIntoView({ block: "center" });
  };

  // Keep the draft mounted while disabled; re-enabling must not discard unsaved text.
  if (!enabled) return null;
  return createPortal(
    <div
      data-chat-floating-panel="true"
      className="fixed inset-0 z-[110] flex flex-col bg-[var(--background)] text-[var(--foreground)]"
      role="dialog"
      aria-modal="true"
      aria-label={t("ui.chatSettings.gamePromptRequestEditor.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{t("ui.chatSettings.gamePromptRequestEditor.title")}</h2>
          <p className="text-xs text-[var(--muted-foreground)]">
            {t("ui.chatSettings.gamePromptRequestEditor.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={preview.isPending || saving || dirty}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs disabled:opacity-50"
          >
            <RotateCcw size="0.75rem" className="mr-1 inline" />
            {t("ui.chatSettings.gamePromptRequestEditor.refresh")}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("ui.chatSettings.gamePromptRequestEditor.close")}
            className="rounded-lg p-2 hover:bg-[var(--secondary)]"
          >
            <X size="1rem" />
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2">
        <input
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") jumpToMatch();
          }}
          placeholder={t("ui.chatSettings.gamePromptRequestEditor.search")}
          aria-label={t("ui.chatSettings.gamePromptRequestEditor.search")}
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-3 py-2 text-xs outline-none focus:border-[var(--primary)]"
        />
        <button
          type="button"
          onClick={jumpToMatch}
          disabled={!search.trim() || visibleIndices.length === 0}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-50"
        >
          {t("ui.chatSettings.gamePromptRequestEditor.jump")}
        </button>
        <span className="text-xs text-[var(--muted-foreground)]">
          {visibleIndices.length}/{draft.length}
        </span>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {previewIsExact === true && (
          <p className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/50 p-3 text-xs leading-relaxed">
            {t("ui.chatSettings.gamePromptRequestEditor.exactPreview")}
          </p>
        )}
        {previewIsExact === false && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed">
            {t("ui.chatSettings.gamePromptRequestEditor.approximatePreview")}
          </p>
        )}
        {unappliedEditCount > 0 && (
          <p
            role="status"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed"
          >
            {t("ui.chatSettings.gamePromptRequestEditor.unappliedEdits", { count: unappliedEditCount })}
          </p>
        )}
        {preview.isPending && !original ? <Loader2 className="mx-auto animate-spin" /> : null}
        {draft.map((message, index) =>
          visibleIndices.includes(index) ? (
            <section key={index} className="rounded-xl border border-[var(--border)] bg-[var(--secondary)]/40 p-3">
              <div className="mb-2 text-xs font-semibold">
                {index + 1}. {message.role.toUpperCase()}
              </div>
              <textarea
                ref={(element) => {
                  if (element) textareaRefs.current.set(index, element);
                  else textareaRefs.current.delete(index);
                }}
                value={message.content}
                onChange={(event) =>
                  setDraft((current) =>
                    current.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, content: event.target.value } : entry,
                    ),
                  )
                }
                aria-label={t("ui.chatSettings.gamePromptRequestEditor.messageContent", {
                  index: index + 1,
                  role: message.role,
                })}
                rows={Math.min(18, Math.max(6, message.content.split("\n").length))}
                spellCheck={false}
                className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-xs leading-relaxed outline-none focus:border-[var(--primary)]"
              />
            </section>
          ) : null,
        )}
      </div>
      {error ? (
        <p role="alert" className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--destructive)]">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-3">
        <button
          type="button"
          onClick={() => void reset()}
          disabled={saving || preview.isPending || dirty}
          className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-50"
        >
          {t("ui.chatSettings.gamePromptRequestEditor.restore")}
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs"
          >
            {t("ui.chatSettings.gamePromptRequestEditor.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving || preview.isPending}
            className="rounded-lg bg-[var(--primary)] px-3 py-2 text-xs text-[var(--primary-foreground)] disabled:opacity-50"
          >
            <Save size="0.75rem" className="mr-1 inline" />
            {t("ui.chatSettings.gamePromptRequestEditor.save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
