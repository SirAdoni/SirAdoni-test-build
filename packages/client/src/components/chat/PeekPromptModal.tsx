// ──────────────────────────────────────────────
// Peek Prompt Modal — collapsible section viewer
// ──────────────────────────────────────────────
import { useEffect, useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getCachedFeatureEnabled, useFeatureEnabled } from "../../hooks/use-feature-settings";
import { Copy, Search, X, ChevronRight, ChevronDown } from "lucide-react";
import { cn, copyToClipboard } from "../../lib/utils";
import { useBackdropDismiss } from "../../hooks/use-backdrop-dismiss";
import {
  NEUTRAL_PANEL_HEADER,
  NEUTRAL_PANEL_SCROLL_AREA,
  NEUTRAL_PANEL_SHELL,
  NEUTRAL_PANEL_TITLE,
} from "../ui/neutral-surface-styles";
import { useTranslation as useUiTranslation } from "react-i18next";
import { estimateTextTokens, type GameToolPlanningInfo, type DecisionDebugPreview } from "@marinara-engine/shared";
import { DecisionDebugPanel } from "./DecisionDebugPanel";
import {
  countPromptInspectorResults,
  filterPromptInspectorItems,
  inspectPromptMessages,
  serializePromptMessages,
  type PromptInspectorScope,
} from "../../lib/peek-prompt-inspector";

const PROMPT_TAG_CLASS =
  "border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-highlight-text)]";
const PROMPT_TAG_ACTIVE_CLASS =
  "border border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--marinara-chat-chrome-button-bg-active)] text-[var(--marinara-chat-chrome-button-text-active)]";

function estimateTokens(text: string): number {
  return estimateTextTokens(text);
}

function fmtTokens(n: number): string {
  return n.toLocaleString();
}

interface GenerationInfo {
  model?: string;
  provider?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  showThoughts?: boolean | null;
  reasoningEffort?: string | null;
  verbosity?: string | null;
  serviceTier?: string | null;
  assistantPrefill?: string | null;
  tokensPrompt?: number | null;
  tokensCompletion?: number | null;
  tokensLastRequestInput?: number | null;
  requestCount?: number;
  tokensCachedPrompt?: number | null;
  tokensCacheWritePrompt?: number | null;
  durationMs?: number | null;
  finishReason?: string | null;
}

interface PeekPromptModalProps {
  data: {
    chatId?: string;
    messages: Array<{ role: string; content: string }>;
    chatMode?: string;
    parameters: unknown;
    source?: "cached" | "live_preview" | "raw_messages" | "assembled";
    exact?: boolean;
    generationInfo?: GenerationInfo | null;
    gameToolPlanning?: GameToolPlanningInfo | null;
    agentNote?: string;
    decisions?: { unanswered: string[]; dropped?: string[]; decisionModelSet: boolean };
  };
  onClose: () => void;
}

function sourceBadgeClass(data: PeekPromptModalProps["data"]): string {
  if (data.exact) return PROMPT_TAG_ACTIVE_CLASS;
  return PROMPT_TAG_CLASS;
}

function prettifyTag(tag: string): string {
  return tag.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ═══════════════════════════════════════════════
//  Section types for the final display list
// ═══════════════════════════════════════════════

interface SectionBlock {
  kind: "section";
  label: string;
  role: string;
  content: string;
}

interface ChatHistoryEntry {
  role: string;
  content: string;
}

interface ChatHistoryBlock {
  kind: "chat-history";
  entries: ChatHistoryEntry[];
  rawContent: string; // for token counting
}

type DisplaySection = SectionBlock | ChatHistoryBlock;

interface PromptSegment {
  role: string;
  content: string;
  inChatHistory: boolean;
}

function isDisplayedChatHistoryRole(role: string): boolean {
  return role === "user" || role === "assistant";
}

function isConversationMembershipNotice(segment: PromptSegment): boolean {
  return (
    (segment.role === "system" || segment.role === "narrator" || segment.role === "user") &&
    /\bhas (?:joined|left) the chat\.\s*$/u.test(segment.content)
  );
}

function conversationHistoryDisplayRole(role: string, content: string): string {
  return isConversationMembershipNotice({ role, content, inChatHistory: true }) ? "system" : role;
}

// ═══════════════════════════════════════════════
//  Parsing: works on the WHOLE messages array
// ═══════════════════════════════════════════════

/**
 * Parse XML sections from a single message's content.
 * Only matches tags whose opening AND closing appear on their own line
 * (prompt-level sections like <system_prompt>, <character_info>, etc.).
 * Returns named blocks; anything between/around sections becomes a block
 * named after the message role.
 */
function parseXmlSections(content: string, fallbackLabel: string): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  // Match <tag_name>\n...\n</tag_name> where both tags sit on their own line.
  const tagRegex = /(?:^|\n)(<([a-z_][a-z0-9_-]*)>\n[\s\S]*?\n<\/\2>)(?:\n|$)/gi;
  let lastIndex = 0;

  for (const match of content.matchAll(tagRegex)) {
    const matchStart = match.index!;
    const realStart = content[matchStart] === "\n" ? matchStart + 1 : matchStart;
    const before = content.slice(lastIndex, realStart);
    if (before.trim()) {
      blocks.push({ kind: "section", label: fallbackLabel, role: fallbackLabel, content: before.trim() });
    }
    const tagName = match[2]!;
    const tagContent = match[1]!;
    blocks.push({ kind: "section", label: tagName, role: fallbackLabel, content: tagContent.trimEnd() });
    lastIndex = match.index! + match[0].length;
  }

  const remaining = content.slice(lastIndex);
  if (remaining.trim()) {
    blocks.push({ kind: "section", label: fallbackLabel, role: fallbackLabel, content: remaining.trim() });
  }

  return blocks.length > 0 ? blocks : [{ kind: "section", label: fallbackLabel, role: fallbackLabel, content }];
}

function splitPromptSegments(
  messages: Array<{ role: string; content: string }>,
  preserveChatRoleContent = false,
): PromptSegment[] {
  const segments: PromptSegment[] = [];
  let inXmlChatHistory = false;
  let inMarkdownChatHistory = false;

  const pushSegment = (role: string, content: string, inChatHistory: boolean) => {
    if (!content.trim()) return;
    segments.push({ role, content: content.trim(), inChatHistory });
  };

  for (const message of messages) {
    let remaining = message.content;

    // Conversation user/assistant text is authored dialogue; prompt-like tags in it must not become sections.
    if (preserveChatRoleContent && isDisplayedChatHistoryRole(message.role)) {
      pushSegment(message.role, remaining, true);
      continue;
    }

    while (remaining.length > 0) {
      if (inXmlChatHistory) {
        const closeIdx = remaining.search(/\n?<\/chat_history>/i);
        if (closeIdx >= 0) {
          const closeMatch = remaining.slice(closeIdx).match(/^\n?<\/chat_history>/i);
          pushSegment(message.role, remaining.slice(0, closeIdx), true);
          remaining = remaining.slice(closeIdx + (closeMatch?.[0].length ?? 0));
          inXmlChatHistory = false;
          continue;
        }
        pushSegment(message.role, remaining, true);
        break;
      }

      if (inMarkdownChatHistory) {
        const lastMessageIdx = remaining.search(/^## Last Message\n?/im);
        if (lastMessageIdx >= 0) {
          pushSegment(message.role, remaining.slice(0, lastMessageIdx), true);
          remaining = remaining.slice(lastMessageIdx);
          inMarkdownChatHistory = false;
          continue;
        }
        pushSegment(message.role, remaining, true);
        break;
      }

      const xmlOpenIdx = remaining.search(/<chat_history>\n?/i);
      const markdownOpenIdx = remaining.search(/^## Chat History\n?/im);
      const hasXmlOpen = xmlOpenIdx >= 0;
      const hasMarkdownOpen = markdownOpenIdx >= 0;
      const useXmlOpen = hasXmlOpen && (!hasMarkdownOpen || xmlOpenIdx <= markdownOpenIdx);
      const openIdx = useXmlOpen ? xmlOpenIdx : markdownOpenIdx;

      if (openIdx >= 0) {
        pushSegment(message.role, remaining.slice(0, openIdx), false);
        const openMatch = remaining.slice(openIdx).match(useXmlOpen ? /<chat_history>\n?/i : /^## Chat History\n?/i);
        remaining = remaining.slice(openIdx + (openMatch?.[0].length ?? 0));
        if (useXmlOpen) inXmlChatHistory = true;
        else inMarkdownChatHistory = true;
        continue;
      }

      pushSegment(message.role, remaining, false);
      break;
    }
  }

  return segments;
}

function appendPromptSection(result: DisplaySection[], segment: PromptSegment) {
  const openIdx = segment.content.search(/<last_message>/i);
  const closingIdx = segment.content.search(/<\/last_message>/i);
  if (openIdx >= 0 && closingIdx >= 0) {
    const beforeOpen = segment.content.slice(0, openIdx).trim();
    const innerContent = segment.content.slice(segment.content.indexOf(">", openIdx) + 1, closingIdx).trim();
    const afterClose = segment.content.slice(segment.content.indexOf(">", closingIdx) + 1).trim();

    if (beforeOpen) {
      const pre = parseXmlSections(beforeOpen, segment.role);
      for (const block of pre) result.push(block);
    }
    if (innerContent) {
      result.push({ kind: "section", label: "last_message", role: segment.role, content: innerContent });
    }
    if (afterClose) {
      const post = parseXmlSections(afterClose, segment.role);
      for (const block of post) result.push(block);
    }
    return;
  }

  if (/^## Last Message\n?/i.test(segment.content)) {
    result.push({
      kind: "section",
      label: "last_message",
      role: segment.role,
      content: segment.content.replace(/^## Last Message\n?/i, "").trim(),
    });
    return;
  }

  const blocks = parseXmlSections(segment.content, segment.role);
  for (const block of blocks) result.push(block);
}

export function buildDisplaySections(
  messages: Array<{ role: string; content: string }>,
  groupAllChatRoles = false,
): Array<DisplaySection & { inspectorId: string }> {
  const result: DisplaySection[] = [];
  const historyEntries: ChatHistoryEntry[] = [];
  const historyRawParts: string[] = [];

  const flushChatHistory = () => {
    if (historyEntries.length === 0) return;
    result.push({ kind: "chat-history", entries: [...historyEntries], rawContent: historyRawParts.join("\n\n") });
    historyEntries.length = 0;
    historyRawParts.length = 0;
  };

  for (const segment of splitPromptSegments(messages, groupAllChatRoles)) {
    if (groupAllChatRoles && isDisplayedChatHistoryRole(segment.role)) {
      historyEntries.push({
        role: conversationHistoryDisplayRole(segment.role, segment.content),
        content: segment.content,
      });
      historyRawParts.push(segment.content);
      continue;
    }

    if (
      (segment.inChatHistory && isDisplayedChatHistoryRole(segment.role)) ||
      (groupAllChatRoles && isConversationMembershipNotice(segment))
    ) {
      historyEntries.push({
        role: conversationHistoryDisplayRole(segment.role, segment.content),
        content: segment.content,
      });
      historyRawParts.push(segment.content);
      continue;
    }

    flushChatHistory();
    appendPromptSection(result, segment);
  }

  flushChatHistory();
  return result.map((item, index) =>
    item.kind === "chat-history"
      ? {
          ...item,
          inspectorId: `prompt-item-${index}`,
          entries: item.entries.map((entry, entryIndex) => ({
            ...entry,
            inspectorId: `prompt-item-${index}-entry-${entryIndex}`,
          })),
        }
      : { ...item, inspectorId: `prompt-item-${index}` },
  );
}

// ═══════════════════════════════════════════════
//  UI Components
// ═══════════════════════════════════════════════

function CollapsibleBlock({
  label,
  content,
  defaultOpen,
  roleColor,
  revealKey,
}: {
  label: string;
  content: string;
  defaultOpen: boolean;
  roleColor: string;
  revealKey?: string;
}) {
  const { t: localizeUi } = useUiTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const tokens = estimateTokens(content);

  useEffect(() => {
    if (revealKey) setOpen(true);
  }, [revealKey]);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/50 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--accent)]/50"
      >
        {open ? (
          <ChevronDown size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
        ) : (
          <ChevronRight size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
        )}
        <span className={cn("rounded-md px-2 py-0.5 text-[0.625rem] font-bold uppercase tracking-wider", roleColor)}>
          {prettifyTag(label)}
        </span>
        <span className="ml-auto text-[0.625rem] text-[var(--muted-foreground)]">
          ~{fmtTokens(tokens)} {localizeUi("ui.chat.collapsibleblock.token")}
          {tokens !== 1 ? localizeUi("ui.noodle.stageprofileview.s") : ""}
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)]/50 px-3 py-2">
          <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--foreground)]/80">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

function ChatHistorySection({
  entries,
  rawContent,
  revealKey,
}: {
  entries: ChatHistoryEntry[];
  rawContent: string;
  revealKey?: string;
}) {
  const { t: localizeUi } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const tokens = estimateTokens(rawContent);

  useEffect(() => {
    if (revealKey) setOpen(true);
  }, [revealKey]);

  const msgRoleColor = (role: string) => {
    if (role === "assistant") return PROMPT_TAG_ACTIVE_CLASS;
    return PROMPT_TAG_CLASS;
  };

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/50 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--accent)]/50"
      >
        {open ? (
          <ChevronDown size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
        ) : (
          <ChevronRight size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
        )}
        <span
          className={cn(
            "rounded-md px-2 py-0.5 text-[0.625rem] font-bold uppercase tracking-wider",
            PROMPT_TAG_ACTIVE_CLASS,
          )}
        >
          {localizeUi("ui.chat.chathistorysection.chatHistory")}
        </span>
        <span className="text-[0.625rem] text-[var(--muted-foreground)]">
          {localizeUi("ui.chat.chathistorysection.value1Value2Value3", {
            value1: entries.length,
            value2: localizeUi("ui.chat.chathistorysection.message"),
            value3: entries.length !== 1 ? localizeUi("ui.noodle.stageprofileview.s") : "",
          })}
        </span>
        <span className="ml-auto text-[0.625rem] text-[var(--muted-foreground)]">
          ~{fmtTokens(tokens)} {localizeUi("ui.chat.collapsibleblock.token")}
          {tokens !== 1 ? localizeUi("ui.noodle.stageprofileview.s") : ""}
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)]/50 p-2 space-y-1">
          {entries.map((entry, i) => (
            <ChatHistoryMessage key={i} entry={entry} roleColor={msgRoleColor(entry.role)} revealKey={revealKey} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChatHistoryMessage({
  entry,
  roleColor,
  revealKey,
}: {
  entry: ChatHistoryEntry;
  roleColor: string;
  revealKey?: string;
}) {
  const [open, setOpen] = useState(false);
  const tokens = estimateTokens(entry.content);
  const preview = entry.content.split("\n")[0]?.slice(0, 80) ?? "";

  useEffect(() => {
    if (revealKey) setOpen(true);
  }, [revealKey]);

  return (
    <div className="rounded-md border border-[var(--border)]/30 bg-[var(--background)]/50 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--accent)]/30"
      >
        {open ? (
          <ChevronDown size="0.625rem" className="shrink-0 text-[var(--muted-foreground)]" />
        ) : (
          <ChevronRight size="0.625rem" className="shrink-0 text-[var(--muted-foreground)]" />
        )}
        <span className={cn("rounded px-1.5 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wider", roleColor)}>
          {entry.role}
        </span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-[0.625rem] text-[var(--muted-foreground)]">{preview}</span>
        )}
        <span className="shrink-0 ml-auto text-[0.5625rem] text-[var(--muted-foreground)]">~{fmtTokens(tokens)}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)]/30 px-2.5 py-1.5">
          <pre className="whitespace-pre-wrap break-words text-[0.6875rem] leading-relaxed text-[var(--foreground)]/80">
            {entry.content}
          </pre>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
//  Main Modal
// ═══════════════════════════════════════════════

export function PeekPromptModal({ data: originalData, onClose }: PeekPromptModalProps) {
  const inspectorEnabled = useFeatureEnabled("promptInspector");
  const queryClient = useQueryClient();
  const { t: localizeUi } = useUiTranslation();
  const [tested, setTested] = useState<DecisionDebugPreview | null>(null);
  const [showTest, setShowTest] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [inspectorScope, setInspectorScope] = useState<PromptInspectorScope>("all");
  const [copyResult, setCopyResult] = useState<"copied" | "failed" | null>(null);
  const data: PeekPromptModalProps["data"] =
    showTest && tested
      ? {
          messages: tested.prompt.messages,
          parameters: tested.parameters,
          decisions: tested.prompt.decisions,
          chatMode: originalData.chatMode,
          source: "live_preview",
          exact: false,
        }
      : originalData;
  const backdropDismiss = useBackdropDismiss(onClose);
  const sections = useMemo(
    () => buildDisplaySections(data.messages, data.chatMode === "conversation"),
    [data.chatMode, data.messages],
  );
  const filteredSections = useMemo(
    () => (inspectorEnabled ? filterPromptInspectorItems(sections, searchQuery, inspectorScope) : sections),
    [inspectorEnabled, inspectorScope, searchQuery, sections],
  );
  const resultCount = countPromptInspectorResults(filteredSections);
  const diagnostics = useMemo(
    () => (inspectorEnabled ? inspectPromptMessages(data.messages, sections, data.source) : []),
    [inspectorEnabled, data.messages, data.source, sections],
  );
  const revealKey = inspectorEnabled && searchQuery.trim() ? searchQuery : undefined;
  const totalTokens = useMemo(() => estimateTokens(data.messages.map((m) => m.content).join("")), [data.messages]);

  const gen = data.generationInfo;
  const planner = data.gameToolPlanning;
  const params = data.parameters as Record<string, unknown> | null;

  // Build parameter pills from generationInfo (cached) or assembled parameters
  const paramPills = useMemo(() => {
    const pills: Array<{ label: string; value: string }> = [];
    if (gen) {
      if (gen.temperature != null) pills.push({ label: "Temperature", value: String(gen.temperature) });
      if (gen.maxTokens != null) pills.push({ label: "Max Output Tokens", value: fmtTokens(gen.maxTokens) });
      if (gen.showThoughts) pills.push({ label: "Thinking", value: "On" });
      if (gen.reasoningEffort) pills.push({ label: "Reasoning", value: gen.reasoningEffort });
      if (gen.verbosity) pills.push({ label: "Verbosity", value: gen.verbosity });
      if (gen.serviceTier) pills.push({ label: "Service Tier", value: gen.serviceTier });
      if (gen.assistantPrefill) pills.push({ label: "Assistant Prefill", value: "On" });
    } else if (params) {
      if (params.temperature != null) pills.push({ label: "Temperature", value: String(params.temperature) });
      if (params.topP != null && params.topP !== 1) pills.push({ label: "Top P", value: String(params.topP) });
      if (params.topK != null && params.topK !== 0) pills.push({ label: "Top K", value: String(params.topK) });
      if (params.minP != null && params.minP !== 0) pills.push({ label: "Min P", value: String(params.minP) });
      if (params.maxTokens != null)
        pills.push({ label: "Max Output Tokens", value: fmtTokens(params.maxTokens as number) });
      if (params.frequencyPenalty != null && params.frequencyPenalty !== 0)
        pills.push({ label: "Freq Penalty", value: String(params.frequencyPenalty) });
      if (params.presencePenalty != null && params.presencePenalty !== 0)
        pills.push({ label: "Pres Penalty", value: String(params.presencePenalty) });
      if (params.showThoughts) pills.push({ label: "Thinking", value: "On" });
      if (params.reasoningEffort) pills.push({ label: "Reasoning", value: String(params.reasoningEffort) });
      if (params.verbosity) pills.push({ label: "Verbosity", value: String(params.verbosity) });
      if (params.serviceTier) pills.push({ label: "Service Tier", value: String(params.serviceTier) });
      if (params.assistantPrefill) pills.push({ label: "Assistant Prefill", value: "On" });
    }
    return pills;
  }, [gen, params]);

  const sectionRoleColor = (role: string, label: string) => {
    if (/last.?message/i.test(label) || role === "assistant") return PROMPT_TAG_ACTIVE_CLASS;
    return PROMPT_TAG_CLASS;
  };

  return (
    <div
      data-chat-floating-panel
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 max-md:pt-[env(safe-area-inset-top)]"
      {...backdropDismiss}
    >
      <div
        className={cn(NEUTRAL_PANEL_SHELL, "mx-4 flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={cn(NEUTRAL_PANEL_HEADER, "shrink-0 flex items-center justify-between gap-3 px-5 py-3")}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className={cn(NEUTRAL_PANEL_TITLE, "shrink-0 text-sm")}>
              {localizeUi("ui.chat.peekpromptmodal.assembledPrompt")}
            </h3>
            <span
              className={cn(
                "shrink-0 rounded-md border px-2 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wider",
                sourceBadgeClass(data),
              )}
            >
              {showTest
                ? localizeUi("decisionDebug.testedPrompt")
                : localizeUi(
                    data.exact
                      ? "ui.chat.peekpromptmodal.savedEngineInput"
                      : data.source === "live_preview"
                        ? "ui.chat.peekpromptmodal.livePreviewApproximate"
                        : data.source === "raw_messages"
                          ? "ui.chat.peekpromptmodal.rawMessagesApproximate"
                          : "ui.chat.peekpromptmodal.promptPreviewApproximate",
                  )}
            </span>
            <span className="min-w-0 text-[0.625rem] text-[var(--muted-foreground)]">
              {sections.length} {localizeUi("ui.chat.peekpromptmodal.section")}
              {sections.length !== 1 ? localizeUi("ui.noodle.stageprofileview.s") : ""}{" "}
              {localizeUi("ui.chat.peekpromptmodal.middot")}
              {fmtTokens(totalTokens)} {localizeUi("ui.agents.agenteditor.tokens")}
            </span>
          </div>
          <button
            onClick={onClose}
            className="mari-chrome-control mari-chrome-control--small p-1.5"
            aria-label={localizeUi("ui.chat.peekpromptmodal.closeAssembledPrompt")}
          >
            <X size="1rem" />
          </button>
        </div>
        <div className={cn(NEUTRAL_PANEL_SCROLL_AREA, "min-h-0 flex-1 overflow-y-auto p-4 space-y-2")}>
          {originalData.chatId && (
            <DecisionDebugPanel
              key={originalData.chatId}
              chatId={originalData.chatId}
              onPreview={(preview) => {
                setTested(preview);
                setShowTest(preview !== null);
              }}
            />
          )}
          {tested && (
            <div className="flex flex-col items-start gap-2 py-2 text-xs sm:flex-row sm:items-center">
              <p className="flex-1 text-[var(--muted-foreground)]">
                {localizeUi(showTest ? "decisionDebug.testedHint" : "decisionDebug.originalHint")}
              </p>
              <button
                type="button"
                className="mari-chrome-control min-h-10 px-3"
                onClick={() => setShowTest(!showTest)}
              >
                {localizeUi(showTest ? "decisionDebug.showOriginal" : "decisionDebug.showTest")}
              </button>
            </div>
          )}
          {/* A preview never asks the Decision model, so a decision branch it could not
              answer is shown as "no". Saying so keeps a preview from being read as final. */}
          {data.decisions && data.decisions.unanswered.length > 0 && (
            <div
              role="status"
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[0.6875rem] text-[var(--foreground)]"
            >
              <p>
                {localizeUi(
                  data.decisions.decisionModelSet
                    ? "ui.chat.peekpromptmodal.decisionsUnanswered"
                    : "ui.chat.peekpromptmodal.decisionsNoModel",
                  { count: data.decisions.unanswered.length },
                )}
              </p>
              <ul className="mt-1 list-disc pl-4 text-[var(--muted-foreground)]">
                {data.decisions.unanswered.slice(0, 12).map((statement) => (
                  <li key={statement}>{statement}</li>
                ))}
              </ul>
            </div>
          )}
          {/* Statements past Decision statements per turn are never asked, so they read as
              no every turn. Listing them shows an author what the limit costs. */}
          {data.decisions?.dropped && data.decisions.dropped.length > 0 && (
            <div
              role="status"
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[0.6875rem] text-[var(--foreground)]"
            >
              <p>{localizeUi("ui.chat.peekpromptmodal.decisionsDropped", { count: data.decisions.dropped.length })}</p>
              <ul className="mt-1 list-disc pl-4 text-[var(--muted-foreground)]">
                {data.decisions.dropped.slice(0, 12).map((statement) => (
                  <li key={statement}>{statement}</li>
                ))}
              </ul>
            </div>
          )}
          <div
            role="note"
            className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/30 px-3 py-2 text-xs text-[var(--muted-foreground)]"
          >
            {localizeUi(
              data.exact
                ? "ui.chat.peekpromptmodal.savedBoundaryNote"
                : data.source === "raw_messages"
                  ? "ui.chat.peekpromptmodal.rawBoundaryNote"
                  : "ui.chat.peekpromptmodal.previewBoundaryNote",
            )}
          </div>
          {/* Generation info panel */}
          {(gen || planner || paramPills.length > 0) && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/30 px-4 py-3 space-y-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.6875rem]">
                {gen?.model && (
                  <span className="font-medium text-[var(--foreground)]">
                    {gen.provider ? (
                      <span className="text-[var(--muted-foreground)] font-normal">{gen.provider} / </span>
                    ) : null}
                    {gen.model}
                  </span>
                )}
                <span className="text-[var(--muted-foreground)]">
                  ~{fmtTokens(totalTokens)} {localizeUi("ui.chat.peekpromptmodal.estTokens")}
                  {gen?.tokensPrompt != null && (
                    <>
                      {" "}
                      · {fmtTokens(gen.tokensPrompt)}{" "}
                      {(gen.requestCount ?? 0) > 1
                        ? localizeUi("ui.chat.peekpromptmodal.turnPromptTokens", { count: gen.requestCount })
                        : localizeUi("ui.chat.peekpromptmodal.reportedPromptTokens")}
                    </>
                  )}
                  {(gen?.tokensCachedPrompt ?? 0) > 0 && (
                    <>
                      {" "}
                      · {fmtTokens(gen?.tokensCachedPrompt ?? 0)} {localizeUi("ui.chat.peekpromptmodal.cached")}
                    </>
                  )}
                  {(gen?.tokensCacheWritePrompt ?? 0) > 0 && (
                    <>
                      {" "}
                      · {fmtTokens(gen?.tokensCacheWritePrompt ?? 0)} {localizeUi("ui.chat.peekpromptmodal.cacheWrite")}
                    </>
                  )}
                </span>
              </div>
              {gen?.tokensLastRequestInput != null && (
                <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
                  {localizeUi("ui.chat.peekpromptmodal.lastRequestInput", {
                    tokens: fmtTokens(gen.tokensLastRequestInput),
                  })}
                </p>
              )}
              {(gen?.requestCount ?? 0) > 1 && (
                <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
                  {localizeUi("ui.chat.peekpromptmodal.toolRequestUsageHint")}
                </p>
              )}
              {planner && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem] text-[var(--muted-foreground)]">
                  <span>
                    {localizeUi("ui.chat.peekpromptmodal.toolPlanner")}: {planner.provider} / {planner.model}
                  </span>
                  <span>
                    {planner.usage?.promptTokens != null && planner.usage.completionTokens != null
                      ? localizeUi("ui.chat.peekpromptmodal.plannerUsage", {
                          input: fmtTokens(planner.usage.promptTokens),
                          output: fmtTokens(planner.usage.completionTokens),
                        })
                      : localizeUi("ui.chat.peekpromptmodal.plannerUsageUnavailable")}
                  </span>
                </div>
              )}
              {paramPills.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {paramPills.map((p) => (
                    <span
                      key={p.label}
                      className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)]/50 px-2 py-0.5 text-[0.625rem]"
                    >
                      <span className="text-[var(--muted-foreground)]">{p.label}</span>
                      <span className="font-medium text-[var(--foreground)]">{p.value}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {data.agentNote && (
            <div className="rounded-lg border border-[var(--marinara-chat-chrome-button-border)] bg-[var(--marinara-chat-chrome-highlight-bg)] px-3 py-2 text-[0.6875rem] text-[var(--marinara-chat-chrome-panel-text)]">
              {localizeUi("ui.chat.peekpromptmodal.note")} {data.agentNote}
            </div>
          )}
          {inspectorEnabled && (
            <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/30 p-3 sm:flex-row sm:items-center">
              <label className="relative min-w-0 flex-1">
                <Search
                  aria-hidden="true"
                  size="0.875rem"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={localizeUi("ui.chat.peekpromptmodal.searchPlaceholder")}
                  aria-label={localizeUi("ui.chat.peekpromptmodal.searchPlaceholder")}
                  className="min-h-10 w-full rounded-md border border-[var(--border)] bg-[var(--background)] pl-9 pr-3 text-sm text-[var(--foreground)]"
                />
              </label>
              <label className="sr-only" htmlFor="peek-prompt-scope">
                {localizeUi("ui.chat.peekpromptmodal.filterScope")}
              </label>
              <select
                id="peek-prompt-scope"
                value={inspectorScope}
                onChange={(event) => setInspectorScope(event.target.value as PromptInspectorScope)}
                className="min-h-10 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
              >
                <option value="all">{localizeUi("ui.chat.peekpromptmodal.scopeAll")}</option>
                <option value="sections">{localizeUi("ui.chat.peekpromptmodal.scopeSections")}</option>
                <option value="chat-history">{localizeUi("ui.chat.peekpromptmodal.scopeChatHistory")}</option>
              </select>
              <button
                type="button"
                onClick={async () => {
                  if (!getCachedFeatureEnabled(queryClient, "promptInspector")) return;
                  const didCopy = await copyToClipboard(serializePromptMessages(data.messages));
                  setCopyResult(didCopy ? "copied" : "failed");
                }}
                className="mari-chrome-control min-h-10 px-3"
                aria-label={localizeUi("ui.chat.peekpromptmodal.copyMessages")}
              >
                <Copy aria-hidden="true" size="0.875rem" />
                {localizeUi("ui.chat.peekpromptmodal.copyMessages")}
              </button>
              <span role="status" className="text-xs text-[var(--muted-foreground)]">
                {localizeUi(
                  copyResult === "copied"
                    ? "ui.chat.peekpromptmodal.copied"
                    : copyResult === "failed"
                      ? "ui.chat.peekpromptmodal.copyFailed"
                      : "ui.chat.peekpromptmodal.resultCount",
                  { count: resultCount },
                )}
              </span>
            </div>
          )}
          {diagnostics.length > 0 && (
            <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
              <p className="font-medium">
                {localizeUi("ui.chat.peekpromptmodal.diagnosticCount", { count: diagnostics.length })}
              </p>
              <ul className="mt-1 list-disc pl-4 text-[var(--muted-foreground)]">
                {diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.kind}-${index}`}>
                    {localizeUi(
                      diagnostic.kind === "empty-message"
                        ? "ui.chat.peekpromptmodal.diagnosticEmptyMessage"
                        : diagnostic.kind === "empty-section"
                          ? "ui.chat.peekpromptmodal.diagnosticEmptySection"
                          : "ui.chat.peekpromptmodal.diagnosticUnresolvedMacro",
                      diagnostic.kind === "empty-message"
                        ? { index: diagnostic.messageIndex + 1, role: diagnostic.role }
                        : diagnostic.kind === "empty-section"
                          ? { index: diagnostic.sectionIndex + 1, label: diagnostic.label }
                          : {
                              index: diagnostic.sectionIndex + 1,
                              label: diagnostic.label,
                              macros: diagnostic.macros.join(", "),
                            },
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {filteredSections.length === 0 ? (
            <p
              role="status"
              className="rounded-lg border border-[var(--border)] px-3 py-6 text-center text-sm text-[var(--muted-foreground)]"
            >
              {localizeUi("ui.chat.peekpromptmodal.noMatches")}
            </p>
          ) : (
            filteredSections.map((s, i) =>
              s.kind === "chat-history" ? (
                <ChatHistorySection
                  key={s.inspectorId ?? `history-${i}`}
                  entries={s.entries}
                  rawContent={s.rawContent}
                  revealKey={revealKey}
                />
              ) : (
                <CollapsibleBlock
                  key={s.inspectorId ?? `section-${i}`}
                  label={s.label}
                  content={s.content}
                  defaultOpen={false}
                  roleColor={sectionRoleColor(s.role, s.label)}
                  revealKey={revealKey}
                />
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}
