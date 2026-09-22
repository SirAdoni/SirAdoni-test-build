import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { Check, Loader2, Undo2, Wand2, X } from "lucide-react";
import { formatTextQuotes, LOCAL_SIDECAR_CONNECTION_ID, type Message, type QuoteFormat } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { toast } from "sonner";

import { useAgentSuiteRewrite } from "../../hooks/use-agents";
import { useConnections } from "../../hooks/use-connections";
import { appendLocalSidecarConnectionOption } from "../../lib/connection-filters";
import {
  applyTextRewriteResult,
  resolveTextRewriteTarget,
  type TextRewriteSelectionSnapshot,
} from "../../lib/text-rewrite";
import { cn } from "../../lib/utils";
import { useChatStore } from "../../stores/chat.store";
import { useSidecarStore } from "../../stores/sidecar.store";
import { applyTextareaQuoteFormat } from "../../lib/textarea-quotes";

type MessageRewriteMode = "natural-prose" | "natural-dialogue" | "improve-flow" | "tighten" | "grammar" | "custom";

type MessageRewriteConnection = {
  id: string;
  name: string;
  model?: string | null;
  provider?: string | null;
  isDefault?: boolean | string | null;
  defaultForAgents?: boolean | string | null;
};

const MESSAGE_REWRITE_INSTRUCTION_BY_MODE: Record<Exclude<MessageRewriteMode, "custom">, string> = {
  "natural-prose":
    "Make the prose sound natural and human. Remove canned, theatrical, aphoristic, overly polished, repetitive, and biography-reciting phrasing. Preserve the exact meaning, voice, profanity, subtext, facts, and action ownership. Do not add dialogue, actions, thoughts, emotions, motives, judgments, or new facts.",
  "natural-dialogue":
    "Make the dialogue sound like something this speaker would naturally say in this moment. Remove speeches, canned profundity, repeated biography, and overly formal phrasing. Preserve the speaker's intent, attitude, profanity, subtext, facts, and relationship dynamics. Do not change actions or invent thoughts, feelings, motives, judgments, or new facts.",
  "improve-flow":
    "Improve clarity, rhythm, and flow while preserving the exact meaning, tone, facts, chronology, speaker ownership, action ownership, and degree of certainty. Do not add or remove events, choices, dialogue, thoughts, feelings, motives, judgments, or new facts.",
  tighten:
    "Make this more concise without losing any concrete fact, decision, condition, emotional beat, relationship detail, profanity, ambiguity, speaker ownership, or action ownership. Do not summarize away meaningful information or add anything new.",
  grammar:
    "Correct grammar, spelling, punctuation, and obvious wording errors only. Preserve wording, voice, meaning, profanity, facts, chronology, speaker ownership, action ownership, and ambiguity as closely as possible. Do not add, remove, sanitize, or reinterpret content.",
};

export interface MessageEditTextareaProps {
  initialContent: string;
  messageRole: Message["role"];
  quoteFormat: QuoteFormat;
  saving?: boolean;
  fontSize?: string | number;
  textareaStyle?: CSSProperties;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  variant?: "conversation" | "roleplay";
  showSaveActions?: boolean;
  onDraftChange?: (content: string) => void;
  onSave: (content: string) => void | Promise<void>;
  onCancel: () => void;
}

/** Shared message editor with an optional, review-before-save AI rewrite panel. */
export const MessageEditTextarea = memo(function MessageEditTextarea({
  initialContent,
  messageRole,
  quoteFormat,
  saving = false,
  fontSize,
  textareaStyle,
  textareaRef,
  variant = "roleplay",
  showSaveActions = true,
  onDraftChange,
  onSave,
  onCancel,
}: MessageEditTextareaProps) {
  const { t: localizeUi } = useUiTranslation();
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? internalRef;
  const editorRef = useRef<HTMLDivElement>(null);
  const rewrite = useAgentSuiteRewrite();
  const { data: rawConnections } = useConnections();
  const activeChatConnectionId = useChatStore((state) => state.activeChat?.connectionId ?? null);
  const sidecarModelDownloaded = useSidecarStore((state) => state.modelDownloaded);
  const sidecarModelDisplayName = useSidecarStore((state) => state.modelDisplayName);
  const [aiOpen, setAiOpen] = useState(false);
  const [rewriteMode, setRewriteMode] = useState<MessageRewriteMode>("natural-prose");
  const [customInstruction, setCustomInstruction] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selection, setSelection] = useState<TextRewriteSelectionSnapshot | null>(null);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const [undoSnapshot, setUndoSnapshot] = useState<{
    before: string;
    after: string;
    start: number;
    end: number;
  } | null>(null);
  const editorAccessibleLabel =
    messageRole === "user"
      ? localizeUi("ui.chat.edittextarea.editUserMessage")
      : messageRole === "assistant"
        ? localizeUi("ui.chat.edittextarea.editAssistantMessage")
        : messageRole === "narrator"
          ? localizeUi("ui.chat.edittextarea.editNarratorMessage")
          : localizeUi("ui.chat.edittextarea.editSystemMessage");

  const connectionOptions = useMemo<MessageRewriteConnection[]>(
    () =>
      appendLocalSidecarConnectionOption(
        (rawConnections ?? []) as MessageRewriteConnection[],
        import.meta.env.VITE_MARINARA_LITE !== "true" &&
          (sidecarModelDownloaded || activeChatConnectionId === LOCAL_SIDECAR_CONNECTION_ID),
        sidecarModelDisplayName,
      ),
    [activeChatConnectionId, rawConnections, sidecarModelDisplayName, sidecarModelDownloaded],
  );
  const effectiveConnectionId = useMemo(() => {
    if (selectedConnectionId && connectionOptions.some((connection) => connection.id === selectedConnectionId)) {
      return selectedConnectionId;
    }
    if (activeChatConnectionId === "random") return "";
    const chatConnection = connectionOptions.find((connection) => connection.id === activeChatConnectionId);
    const agentDefault = connectionOptions.find(
      (connection) => connection.defaultForAgents === true || connection.defaultForAgents === "true",
    );
    const appDefault = connectionOptions.find(
      (connection) => connection.isDefault === true || connection.isDefault === "true",
    );
    return (chatConnection ?? agentDefault ?? appDefault ?? connectionOptions[0])?.id ?? "";
  }, [activeChatConnectionId, connectionOptions, selectedConnectionId]);
  const busy = saving || rewrite.isPending;

  const autoResize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = el.closest("[data-chat-scroll]") as HTMLElement | null;
    const scrollTop = scroller?.scrollTop ?? 0;
    el.style.height = "0";
    const maximumHeight = variant === "conversation" ? 300 : Number.POSITIVE_INFINITY;
    el.style.height = `${Math.min(el.scrollHeight, maximumHeight)}px`;
    if (scroller) scroller.scrollTop = scrollTop;
  }, [ref, variant]);

  useLayoutEffect(() => {
    autoResize();
    ref.current?.focus({ preventScroll: true });
    // Bring the save/cancel row into view when the editor opens below the fold,
    // without pushing the top of the draft out of the transcript.
    const scroller = ref.current?.closest("[data-chat-scroll]") as HTMLElement | null;
    if (!scroller) return;
    const frame = window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const scrollerRect = scroller.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const hiddenBelow = editorRect.bottom - scrollerRect.bottom + 8;
      const roomAbove = editorRect.top - scrollerRect.top - 8;
      if (hiddenBelow > 0 && roomAbove > 0) scroller.scrollTop += Math.min(hiddenBelow, roomAbove);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoResize, ref]);

  const handleSave = useCallback(() => {
    if (!busy && ref.current) void onSave(formatTextQuotes(ref.current.value, quoteFormat));
  }, [busy, onSave, quoteFormat, ref]);

  const captureSelection = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setSelection(
      el.selectionStart !== el.selectionEnd
        ? { start: el.selectionStart, end: el.selectionEnd, sourceText: el.value }
        : null,
    );
  }, [ref]);

  const applyDraft = useCallback(
    (next: string, start: number, end: number) => {
      const el = ref.current;
      if (!el) return;
      el.value = next;
      onDraftChange?.(next);
      autoResize();
      el.focus({ preventScroll: true });
      el.setSelectionRange(start, end);
      setSelection({ start, end, sourceText: next });
    },
    [autoResize, onDraftChange, ref],
  );

  const handleRewrite = useCallback(async () => {
    const el = ref.current;
    if (!el || busy || !effectiveConnectionId) return;
    const instruction =
      rewriteMode === "custom" ? customInstruction.trim() : MESSAGE_REWRITE_INSTRUCTION_BY_MODE[rewriteMode];
    if (!instruction) return;

    const target = resolveTextRewriteTarget(el.value, selection);
    if (!target.selectedText.trim()) {
      setRewriteError(localizeUi("ui.chat.edittextarea.noTextToRewrite"));
      return;
    }
    if (target.selectedText.length > 50000) {
      setRewriteError(localizeUi("ui.chat.edittextarea.rewriteSelectionTooLarge"));
      return;
    }

    setRewriteError(null);
    try {
      const result = await rewrite.mutateAsync({
        connectionId: effectiveConnectionId,
        instruction,
        selectedText: target.selectedText,
        documentText: target.isSelection && target.sourceText.length <= 100000 ? target.sourceText : undefined,
        dataLabel:
          messageRole === "user"
            ? "User-authored chat message"
            : messageRole === "assistant"
              ? "Assistant chat message"
              : "Chat message",
      });
      const current = ref.current;
      if (!current) return;
      const next = applyTextRewriteResult(current.value, target, result.rewrittenText);
      if (next === null) {
        setRewriteError(localizeUi("ui.chat.edittextarea.draftChangedWhileRewriting"));
        return;
      }

      const rewrittenEnd = target.start + result.rewrittenText.length;
      setUndoSnapshot({ before: target.sourceText, after: next, start: target.start, end: target.end });
      applyDraft(next, target.start, rewrittenEnd);
      toast.success(localizeUi("ui.chat.edittextarea.aiRewriteAppliedToDraft"));
    } catch (error) {
      setRewriteError(error instanceof Error ? error.message : localizeUi("ui.chat.edittextarea.aiRewriteFailed"));
    }
  }, [
    applyDraft,
    busy,
    customInstruction,
    effectiveConnectionId,
    localizeUi,
    messageRole,
    ref,
    rewrite,
    rewriteMode,
    selection,
  ]);

  const handleUndoRewrite = useCallback(() => {
    const el = ref.current;
    if (!el || !undoSnapshot || busy) return;
    if (el.value !== undoSnapshot.after) {
      setUndoSnapshot(null);
      setRewriteError(localizeUi("ui.chat.edittextarea.draftChangedSinceRewrite"));
      return;
    }
    applyDraft(undoSnapshot.before, undoSnapshot.start, undoSnapshot.end);
    setUndoSnapshot(null);
    setRewriteError(null);
  }, [applyDraft, busy, localizeUi, ref, undoSnapshot]);

  const selectedCharacterCount =
    selection && selection.sourceText === ref.current?.value && selection.start < selection.end
      ? selection.end - selection.start
      : 0;

  return (
    <div ref={editorRef} className="relative isolate z-20 flex flex-col gap-2">
      <textarea
        ref={ref}
        data-chat-message-editor="true"
        defaultValue={formatTextQuotes(initialContent, quoteFormat)}
        readOnly={busy}
        aria-busy={busy}
        aria-label={editorAccessibleLabel}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        rows={1}
        onInput={(event) => {
          applyTextareaQuoteFormat(event.currentTarget, quoteFormat, event.nativeEvent as InputEvent);
          onDraftChange?.(event.currentTarget.value);
          setSelection(null);
          setRewriteError(null);
          autoResize();
        }}
        onSelect={captureSelection}
        onKeyDown={(event) => {
          if (busy) return;
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) handleSave();
          if (event.key === "Escape") onCancel();
        }}
        className={cn(
          "relative z-0 w-full resize-none overflow-y-auto overscroll-contain rounded-lg px-3 py-2 outline-none",
          variant === "roleplay"
            ? "bg-black/30 text-white ring-1 ring-white/20 focus:ring-blue-400/50 max-md:max-h-[min(60dvh,32rem)]"
            : "border border-[var(--border)] bg-[var(--secondary)] text-[var(--foreground)] focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)]",
        )}
        style={{ fontSize, lineHeight: 1.5, ...textareaStyle }}
      />

      {aiOpen && (
        <div
          className="pointer-events-auto relative z-30 rounded-lg border border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--background)]/95 p-2.5 text-[var(--foreground)] shadow-lg"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setAiOpen(false);
            }
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold">{localizeUi("ui.chat.edittextarea.aiRewrite")}</div>
              <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                {selectedCharacterCount > 0
                  ? localizeUi("ui.chat.edittextarea.rewriteSelectedCharacters", {
                      count: selectedCharacterCount,
                    })
                  : localizeUi("ui.chat.edittextarea.rewriteWholeMessage")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAiOpen(false)}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              aria-label={localizeUi("ui.chat.edittextarea.closeAiRewrite")}
              title={localizeUi("ui.chat.edittextarea.closeAiRewrite")}
            >
              <X size="0.875rem" />
            </button>
          </div>

          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="min-w-0 text-[0.6875rem] font-medium">
              <span className="mb-1 block text-[var(--muted-foreground)]">
                {localizeUi("ui.chat.edittextarea.rewriteStyle")}
              </span>
              <select
                value={rewriteMode}
                onChange={(event) => {
                  setRewriteMode(event.target.value as MessageRewriteMode);
                  setRewriteError(null);
                }}
                disabled={busy}
                className="h-11 w-full rounded-md border border-[var(--input)] bg-[var(--secondary)] px-2 text-xs text-[var(--foreground)] outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)] disabled:opacity-60"
              >
                <option value="natural-prose">{localizeUi("ui.chat.edittextarea.styleNaturalProse")}</option>
                <option value="natural-dialogue">{localizeUi("ui.chat.edittextarea.styleNaturalDialogue")}</option>
                <option value="improve-flow">{localizeUi("ui.chat.edittextarea.styleImproveFlow")}</option>
                <option value="tighten">{localizeUi("ui.chat.edittextarea.styleTighten")}</option>
                <option value="grammar">{localizeUi("ui.chat.edittextarea.styleGrammarOnly")}</option>
                <option value="custom">{localizeUi("ui.chat.edittextarea.styleCustom")}</option>
              </select>
            </label>

            <label className="min-w-0 text-[0.6875rem] font-medium">
              <span className="mb-1 block text-[var(--muted-foreground)]">
                {localizeUi("ui.chat.edittextarea.rewriteConnection")}
              </span>
              <select
                value={effectiveConnectionId}
                onChange={(event) => {
                  setSelectedConnectionId(event.target.value);
                  setRewriteError(null);
                }}
                disabled={busy || connectionOptions.length === 0}
                className="h-11 w-full rounded-md border border-[var(--input)] bg-[var(--secondary)] px-2 text-xs text-[var(--foreground)] outline-none focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)] disabled:opacity-60"
              >
                {activeChatConnectionId === "random" && !effectiveConnectionId && (
                  <option value="">{localizeUi("ui.chat.edittextarea.randomRequiresSpecificConnection")}</option>
                )}
                {connectionOptions.length === 0 && (
                  <option value="">{localizeUi("ui.chat.edittextarea.noTextConnections")}</option>
                )}
                {connectionOptions.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                    {connection.model ? localizeUi("ui.chat.datablock.value1", { value1: connection.model }) : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {rewriteMode === "custom" && (
            <label className="mt-2 block text-[0.6875rem] font-medium">
              <span className="mb-1 block text-[var(--muted-foreground)]">
                {localizeUi("ui.chat.edittextarea.customRewriteInstruction")}
              </span>
              <textarea
                value={customInstruction}
                onChange={(event) => {
                  setCustomInstruction(event.target.value);
                  setRewriteError(null);
                }}
                rows={2}
                maxLength={4000}
                disabled={busy}
                placeholder={localizeUi("ui.chat.edittextarea.customRewritePlaceholder")}
                className="w-full resize-y rounded-md border border-[var(--input)] bg-[var(--secondary)] px-2 py-2 text-xs leading-relaxed text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:border-[var(--ring)] focus:ring-1 focus:ring-[var(--ring)] disabled:opacity-60"
              />
            </label>
          )}

          {rewriteError && (
            <p role="alert" className="mt-2 text-[0.6875rem] leading-relaxed text-[var(--destructive)]">
              {rewriteError}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="max-w-[36rem] text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
              {localizeUi("ui.chat.edittextarea.aiRewriteReviewNotice")}
            </p>
            <div className="ml-auto flex items-center gap-1.5">
              {undoSnapshot && (
                <button
                  type="button"
                  onClick={handleUndoRewrite}
                  disabled={busy}
                  className="inline-flex h-11 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50"
                >
                  <Undo2 size="0.8125rem" />
                  {localizeUi("ui.chat.edittextarea.undoAiRewrite")}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleRewrite()}
                disabled={busy || !effectiveConnectionId || (rewriteMode === "custom" && !customInstruction.trim())}
                className="inline-flex h-11 items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 text-xs font-semibold text-[var(--primary-foreground)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {rewrite.isPending ? <Loader2 size="0.8125rem" className="animate-spin" /> : <Wand2 size="0.8125rem" />}
                {rewrite.isPending
                  ? localizeUi("ui.chat.edittextarea.rewritingDraft")
                  : localizeUi("ui.chat.edittextarea.applyRewriteToDraft")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="pointer-events-auto relative z-30 flex items-center justify-between gap-1.5">
        <button
          type="button"
          onClick={() => {
            captureSelection();
            setAiOpen((open) => !open);
            setRewriteError(null);
          }}
          disabled={saving}
          aria-expanded={aiOpen}
          className={cn(
            "pointer-events-auto relative z-30 inline-flex h-11 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-50",
            aiOpen
              ? "bg-[var(--primary)]/15 text-[var(--primary)]"
              : variant === "roleplay"
                ? "text-white/55 hover:bg-white/10 hover:text-white/80"
                : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
          )}
          title={localizeUi("ui.chat.edittextarea.aiRewriteDescription")}
        >
          <Wand2 size="0.8125rem" />
          {localizeUi("ui.chat.edittextarea.aiRewrite")}
        </button>
        {showSaveActions && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              aria-label={localizeUi("ui.chat.edittextarea.cancelEdit")}
              className={cn(
                "pointer-events-auto relative z-30 flex h-11 w-11 shrink-0 items-center justify-center rounded-md disabled:pointer-events-none disabled:opacity-50",
                variant === "roleplay"
                  ? "text-white/40 hover:bg-white/10 hover:text-white/70"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
              )}
              title={localizeUi("ui.chat.edittextarea.cancelEsc")}
            >
              <X size="0.8125rem" />
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy}
              aria-label={localizeUi("ui.chat.edittextarea.saveEdit")}
              className="pointer-events-auto relative z-30 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-emerald-400/70 hover:bg-emerald-400/10 hover:text-emerald-400 disabled:pointer-events-none disabled:opacity-50"
              title={localizeUi("ui.chat.edittextarea.saveCmdEnter")}
            >
              <Check size="0.8125rem" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
