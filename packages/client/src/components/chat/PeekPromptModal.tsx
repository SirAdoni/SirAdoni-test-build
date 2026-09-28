// ──────────────────────────────────────────────
// Peek Prompt Modal — collapsible section viewer
// ──────────────────────────────────────────────
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Search, TriangleAlert, X } from "lucide-react";
import { cn, copyToClipboard } from "../../lib/utils";
import {
  countPromptInspectorResults,
  filterPromptInspectorItems,
  inspectPromptMessages,
  serializePromptMessages,
  type PromptInspectorDiagnostic,
  type PromptInspectorHistoryEntry,
  type PromptInspectorItem,
  type PromptInspectorScope,
  type PromptInspectorSectionBlock,
} from "../../lib/peek-prompt-inspector";
import { NEUTRAL_PANEL_SCROLL_AREA } from "../ui/neutral-surface-styles";
import { Modal } from "../ui/Modal";
import { useTranslation as useUiTranslation } from "react-i18next";
import { estimateTextTokens, type GameToolPlanningInfo, type DecisionDebugPreview } from "@marinara-engine/shared";
import { GenerationTokenUsage } from "./GenerationTokenUsage";
import { DecisionDebugPanel } from "./DecisionDebugPanel";

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

interface PromptRequest {
  kind: "planner" | "actor";
  actorId?: string;
  actorName?: string;
  messages: Array<{ role: string; content: string }>;
  memoryProjection?: {
    includedCount: number;
    excludedCount: number;
    degraded: boolean;
    exclusions: Array<{ reason: string; count: number }>;
  };
}

/** Documented inspector metadata the peek-prompt route projects from a captured message. */
interface PromptMessageMetadata {
  campaignMemory?: {
    audience: string;
    includedIds: string[];
    exclusions: Array<{ id: string; reason: string }>;
    degraded: boolean;
    cutoffOrder: string | null;
    characterBoundaries: Array<{ entityId: string; kind: string; aliases: string[]; mayUseIds: string[] }> | null;
    omissions: { budgetOmitted: number; duplicatesMerged: number; mergedIds: string[] } | null;
  };
  continuity?: {
    mode: string;
    includedReceiptIds: string[];
    omittedRecordCount: number;
    pendingSourceMessageIds: string[];
    unresolvedSourceMessageIds: string[];
    unreviewedSourceMessageIds: string[];
    unreviewedCodepoints: number;
    omittedSourceCount: number;
    clippedCodepoints: number;
  };
}

interface PeekPromptModalProps {
  data: {
    chatId?: string;
    messages: Array<{ role: string; content: string; metadata?: PromptMessageMetadata }>;
    chatMode?: string;
    parameters: unknown;
    source?: "cached" | "live_preview" | "raw_messages";
    exact?: boolean;
    generationInfo?: GenerationInfo | null;
    gameToolPlanning?: GameToolPlanningInfo | null;
    agentNote?: string;
    promptRequests?: PromptRequest[];
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

function memoryReasonKey(reason: string): string {
  if (reason.includes("budget")) return "ui.chat.peekpromptmodal.characterMemoryReasonBudget";
  if (reason.includes("stale") || reason.includes("cross-chat") || reason.includes("source")) {
    return "ui.chat.peekpromptmodal.characterMemoryReasonStale";
  }
  if (reason.includes("future")) return "ui.chat.peekpromptmodal.characterMemoryReasonFuture";
  if (reason.includes("no longer valid")) return "ui.chat.peekpromptmodal.characterMemoryReasonExpired";
  if (reason.includes("outside") || reason.includes("another entity")) {
    return "ui.chat.peekpromptmodal.characterMemoryReasonOutOfScope";
  }
  if (reason.includes("not readable") || reason.includes("unknown")) {
    return "ui.chat.peekpromptmodal.characterMemoryReasonNotReadable";
  }
  if (reason.includes("unavailable") || reason.includes("missing") || reason.includes("invalid")) {
    return "ui.chat.peekpromptmodal.characterMemoryReasonUnavailable";
  }
  return "ui.chat.peekpromptmodal.characterMemoryReasonOther";
}

// ═══════════════════════════════════════════════
//  Section types for the final display list
// ═══════════════════════════════════════════════

type SectionBlock = PromptInspectorSectionBlock;
type ChatHistoryEntry = PromptInspectorHistoryEntry;
type DisplaySection = PromptInspectorItem;

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
    // Conversation users can legitimately quote prompt-like headings or
    // chat_history tags. Never let their authored text reclassify itself.
    if (preserveChatRoleContent && isDisplayedChatHistoryRole(message.role)) {
      pushSegment(message.role, message.content, true);
      continue;
    }

    let remaining = message.content;

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
): PromptInspectorItem[] {
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
  const contentId = useId();
  const tokens = estimateTokens(content);

  useEffect(() => {
    if (revealKey) setOpen(true);
  }, [revealKey]);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/50 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]/35 sm:min-h-10"
      >
        {open ? (
          <ChevronDown aria-hidden="true" size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
        ) : (
          <ChevronRight aria-hidden="true" size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
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
        <div id={contentId} className="border-t border-[var(--border)]/50 px-3 py-2">
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
  providerBlocks = false,
  revealKey,
}: {
  entries: ChatHistoryEntry[];
  rawContent: string;
  providerBlocks?: boolean;
  revealKey?: string;
}) {
  const { t: localizeUi } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const contentId = useId();
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
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--accent)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]/35 sm:min-h-10"
      >
        {open ? (
          <ChevronDown aria-hidden="true" size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
        ) : (
          <ChevronRight aria-hidden="true" size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" />
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
            value2: providerBlocks
              ? localizeUi("ui.chat.chathistorysection.providerBlock")
              : localizeUi("ui.chat.chathistorysection.message"),
            value3: entries.length !== 1 ? localizeUi("ui.noodle.stageprofileview.s") : "",
          })}
        </span>
        <span className="ml-auto text-[0.625rem] text-[var(--muted-foreground)]">
          ~{fmtTokens(tokens)} {localizeUi("ui.chat.collapsibleblock.token")}
          {tokens !== 1 ? localizeUi("ui.noodle.stageprofileview.s") : ""}
        </span>
      </button>
      {open && (
        <div id={contentId} className="border-t border-[var(--border)]/50 p-2 space-y-1">
          {entries.map((entry, i) => (
            <ChatHistoryMessage
              key={entry.inspectorId ?? `${entry.role}-${i}`}
              entry={entry}
              roleColor={msgRoleColor(entry.role)}
              revealKey={revealKey}
            />
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
  const contentId = useId();
  const tokens = estimateTokens(entry.content);
  const preview = entry.content.split("\n")[0]?.slice(0, 80) ?? "";

  useEffect(() => {
    if (revealKey) setOpen(true);
  }, [revealKey]);

  return (
    <div className="rounded-md border border-[var(--border)]/30 bg-[var(--background)]/50 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex min-h-11 w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--accent)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]/35 sm:min-h-10"
      >
        {open ? (
          <ChevronDown aria-hidden="true" size="0.625rem" className="shrink-0 text-[var(--muted-foreground)]" />
        ) : (
          <ChevronRight aria-hidden="true" size="0.625rem" className="shrink-0 text-[var(--muted-foreground)]" />
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
        <div id={contentId} className="border-t border-[var(--border)]/30 px-2.5 py-1.5">
          <pre className="whitespace-pre-wrap break-words text-[0.6875rem] leading-relaxed text-[var(--foreground)]/80">
            {entry.content}
          </pre>
        </div>
      )}
    </div>
  );
}

function PromptDiagnostics({ diagnostics }: { diagnostics: PromptInspectorDiagnostic[] }) {
  const { t: localizeUi } = useUiTranslation();
  const titleId = useId();
  const hasFindings = diagnostics.length > 0;
  const visibleDiagnostics = diagnostics.slice(0, 8);
  const hiddenDiagnosticCount = diagnostics.length - visibleDiagnostics.length;

  const diagnosticText = (diagnostic: PromptInspectorDiagnostic): string => {
    if (diagnostic.kind === "empty-message") {
      return localizeUi("ui.chat.peekpromptmodal.emptyMessageDiagnostic", {
        value1: diagnostic.messageIndex + 1,
        value2: diagnostic.role,
      });
    }
    if (diagnostic.kind === "empty-section") {
      return localizeUi("ui.chat.peekpromptmodal.emptySectionDiagnostic", {
        value1: prettifyTag(diagnostic.label),
      });
    }
    return localizeUi("ui.chat.peekpromptmodal.knownMacroDiagnostic", {
      value1: prettifyTag(diagnostic.label),
    });
  };

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "rounded-lg border px-3 py-2.5",
        hasFindings
          ? "border-[var(--warning)]/30 bg-[var(--warning)]/10"
          : "border-[var(--border)] bg-[var(--secondary)]/30",
      )}
    >
      <div className="flex items-start gap-2">
        {hasFindings ? (
          <TriangleAlert aria-hidden="true" size="0.875rem" className="mt-0.5 shrink-0 text-[var(--warning)]" />
        ) : (
          <Check aria-hidden="true" size="0.875rem" className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h4 id={titleId} className="text-xs font-semibold text-[var(--foreground)]">
              {localizeUi("ui.chat.peekpromptmodal.diagnostics")}
            </h4>
            {hasFindings && (
              <span className="text-[0.625rem] font-medium text-[var(--warning)]">
                {localizeUi("ui.chat.peekpromptmodal.diagnosticCount", { count: diagnostics.length })}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
            {localizeUi("ui.chat.peekpromptmodal.diagnosticsScope")}
          </p>
          {hasFindings ? (
            <ul className="mt-2 space-y-1 text-[0.6875rem] leading-relaxed text-[var(--foreground)]/85">
              {visibleDiagnostics.map((diagnostic, index) => (
                <li
                  key={`${diagnostic.kind}-${"sectionIndex" in diagnostic ? diagnostic.sectionIndex : diagnostic.messageIndex}-${index}`}
                  className="flex gap-2"
                >
                  <span aria-hidden="true" className="text-[var(--warning)]">
                    •
                  </span>
                  <span>
                    {diagnosticText(diagnostic)}
                    {diagnostic.kind === "unresolved-macro" && (
                      <>
                        {" "}
                        <code
                          dir="ltr"
                          className="rounded bg-[var(--background)]/70 px-1 py-0.5 font-mono text-[0.625rem]"
                        >
                          {diagnostic.macros.map((macro) => `{{${macro}}}`).join(", ")}
                        </code>
                      </>
                    )}
                  </span>
                </li>
              ))}
              {hiddenDiagnosticCount > 0 && (
                <li className="text-[var(--muted-foreground)]">
                  {localizeUi("ui.chat.peekpromptmodal.moreDiagnostics", { count: hiddenDiagnosticCount })}
                </li>
              )}
            </ul>
          ) : (
            <p className="mt-2 text-[0.6875rem] text-[var(--muted-foreground)]">
              {localizeUi("ui.chat.peekpromptmodal.noHighConfidenceIssues")}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

const METADATA_ID_LIST_LIMIT = 24;

function memoryRecordTypeKey(id: string): string {
  if (id.startsWith("cme_")) return "ui.chat.peekpromptmodal.memoryTypeEntity";
  if (id.startsWith("cmf_")) return "ui.chat.peekpromptmodal.memoryTypeFact";
  if (id.startsWith("cmk_")) return "ui.chat.peekpromptmodal.memoryTypeKnowledge";
  return "ui.chat.peekpromptmodal.memoryTypeRecord";
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()];
}

function MetadataIdList({ ids }: { ids: string[] }) {
  const { t: localizeUi } = useUiTranslation();
  const shown = ids.slice(0, METADATA_ID_LIST_LIMIT);
  return (
    <span dir="ltr" className="break-all font-mono text-[0.625rem] text-[var(--foreground)]/75">
      {shown.join(", ")}
      {ids.length > shown.length && (
        <span className="ml-1">
          {localizeUi("ui.chat.peekpromptmodal.memoryMoreIds", { count: ids.length - shown.length })}
        </span>
      )}
    </span>
  );
}

function MetadataSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-md border border-[var(--border)]/40 bg-[var(--background)]/40 px-2.5 py-1.5">
      <summary className="cursor-pointer select-none text-[0.6875rem] font-medium text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/35">
        {title}
      </summary>
      <div className="mt-1.5 space-y-1 text-[0.6875rem] text-[var(--muted-foreground)]">{children}</div>
    </details>
  );
}

/** Per-message memory and continuity metadata captured at the provider boundary. */
function PromptMessageMetadataPanel({
  index,
  role,
  content,
  metadata,
}: {
  index: number;
  role: string;
  content: string;
  metadata: PromptMessageMetadata;
}) {
  const { t: localizeUi } = useUiTranslation();
  const memory = metadata.campaignMemory;
  const continuity = metadata.continuity;
  const holderName = (boundary: { entityId: string; aliases: string[] }) => boundary.aliases[0] ?? boundary.entityId;
  const holdersFor = (id: string): string[] =>
    (memory?.characterBoundaries ?? []).filter((boundary) => boundary.mayUseIds.includes(id)).map(holderName);
  const audienceLabel =
    memory?.audience === "gm"
      ? localizeUi("ui.chat.peekpromptmodal.memoryAudienceGm")
      : memory?.audience === "character"
        ? localizeUi("ui.chat.peekpromptmodal.memoryAudienceCharacter")
        : (memory?.audience ?? "");

  return (
    <details className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/30 px-3 py-2 text-[0.6875rem]">
      <summary className="cursor-pointer select-none font-medium text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/35">
        {localizeUi("ui.chat.peekpromptmodal.memoryMetadataTitle", { index: index + 1, role })}
        <span className="ml-2 text-[0.625rem] font-normal text-[var(--muted-foreground)]">
          {localizeUi("ui.chat.peekpromptmodal.memoryBlockTokens", { tokens: fmtTokens(estimateTokens(content)) })}
        </span>
      </summary>
      <div className="mt-2 space-y-1.5">
        {memory && (
          <>
            <p className="text-[var(--muted-foreground)]">
              {localizeUi("ui.chat.peekpromptmodal.memoryAudience", { value: audienceLabel })}
              {" · "}
              {localizeUi("ui.chat.peekpromptmodal.memoryCutoff", {
                value: memory.cutoffOrder ?? localizeUi("ui.chat.peekpromptmodal.memoryCutoffCurrent"),
              })}
            </p>
            {memory.degraded && (
              <p className="font-medium text-[var(--warning)]">
                {localizeUi("ui.chat.peekpromptmodal.characterMemoryDegraded")}
              </p>
            )}
            <MetadataSection
              title={localizeUi("ui.chat.peekpromptmodal.memoryIncluded", { count: memory.includedIds.length })}
            >
              {memory.includedIds.length === 0 ? (
                <p>{localizeUi("ui.chat.peekpromptmodal.characterMemoryNoneIncluded")}</p>
              ) : (
                groupBy(memory.includedIds, memoryRecordTypeKey).map(([typeKey, ids]) => (
                  <div key={typeKey}>
                    <p className="font-medium text-[var(--foreground)]/85">
                      {localizeUi(typeKey)} ({ids.length})
                    </p>
                    <ul className="space-y-0.5 pl-3">
                      {ids.slice(0, METADATA_ID_LIST_LIMIT).map((id) => {
                        const holders = holdersFor(id);
                        return (
                          <li key={id}>
                            <code dir="ltr" className="font-mono text-[0.625rem] text-[var(--foreground)]/75">
                              {id}
                            </code>
                            {" · "}
                            {holders.length > 0
                              ? localizeUi("ui.chat.peekpromptmodal.memoryUsableBy", { value: holders.join(", ") })
                              : localizeUi("ui.chat.peekpromptmodal.memoryGmOnly")}
                          </li>
                        );
                      })}
                      {ids.length > METADATA_ID_LIST_LIMIT && (
                        <li>
                          {localizeUi("ui.chat.peekpromptmodal.memoryMoreIds", {
                            count: ids.length - METADATA_ID_LIST_LIMIT,
                          })}
                        </li>
                      )}
                    </ul>
                  </div>
                ))
              )}
            </MetadataSection>
            <MetadataSection
              title={localizeUi("ui.chat.peekpromptmodal.memoryExcluded", { count: memory.exclusions.length })}
            >
              {memory.exclusions.length === 0 ? (
                <p>{localizeUi("ui.chat.peekpromptmodal.memoryNoneExcluded")}</p>
              ) : (
                groupBy(memory.exclusions, (exclusion) => memoryReasonKey(exclusion.reason)).map(
                  ([reasonKey, exclusions]) => (
                    <div key={reasonKey}>
                      <p className="font-medium text-[var(--foreground)]/85">
                        {localizeUi(reasonKey)} ({exclusions.length})
                      </p>
                      <p className="pl-3">
                        <MetadataIdList ids={exclusions.map((exclusion) => exclusion.id)} />
                      </p>
                    </div>
                  ),
                )
              )}
            </MetadataSection>
            {memory.omissions && (
              <p>
                {localizeUi("ui.chat.peekpromptmodal.memoryOmissions", {
                  budget: memory.omissions.budgetOmitted,
                  duplicates: memory.omissions.duplicatesMerged,
                })}
              </p>
            )}
            <MetadataSection
              title={localizeUi("ui.chat.peekpromptmodal.memoryBoundaries", {
                count: memory.characterBoundaries?.length ?? 0,
              })}
            >
              {memory.characterBoundaries === null ? (
                <p>{localizeUi("ui.chat.peekpromptmodal.memoryBoundariesUnavailable")}</p>
              ) : memory.characterBoundaries.length === 0 ? (
                <p>{localizeUi("ui.chat.peekpromptmodal.memoryBoundariesNone")}</p>
              ) : (
                <ul className="space-y-0.5">
                  {memory.characterBoundaries.map((boundary) => (
                    <li key={boundary.entityId}>
                      {localizeUi("ui.chat.peekpromptmodal.memoryBoundaryHolder", {
                        name: holderName(boundary),
                        kind: boundary.kind,
                        count: boundary.mayUseIds.length,
                      })}
                      {boundary.mayUseIds.length > 0 && (
                        <>
                          {": "}
                          <MetadataIdList ids={boundary.mayUseIds} />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </MetadataSection>
          </>
        )}
        {continuity && (
          <MetadataSection
            title={localizeUi("ui.chat.peekpromptmodal.continuityReceipts", {
              count: continuity.includedReceiptIds.length,
              mode: continuity.mode,
            })}
          >
            {continuity.includedReceiptIds.length > 0 && (
              <p>
                <MetadataIdList ids={continuity.includedReceiptIds} />
              </p>
            )}
            <p>
              {localizeUi("ui.chat.peekpromptmodal.continuityOmissions", {
                records: continuity.omittedRecordCount,
                sources: continuity.omittedSourceCount,
                clipped: continuity.clippedCodepoints,
              })}
            </p>
            <p>
              {localizeUi("ui.chat.peekpromptmodal.continuitySources", {
                pending: continuity.pendingSourceMessageIds.length,
                unresolved: continuity.unresolvedSourceMessageIds.length,
                unreviewed: continuity.unreviewedSourceMessageIds.length,
                codepoints: continuity.unreviewedCodepoints,
              })}
            </p>
          </MetadataSection>
        )}
      </div>
    </details>
  );
}

// ═══════════════════════════════════════════════
//  Main Modal
// ═══════════════════════════════════════════════

export function PeekPromptModal({ data: originalData, onClose }: PeekPromptModalProps) {
  const { t: localizeUi } = useUiTranslation();
  const [tested, setTested] = useState<DecisionDebugPreview | null>(null);
  const [showTest, setShowTest] = useState(false);
  const data: PeekPromptModalProps["data"] =
    showTest && tested
      ? {
          ...originalData,
          messages: tested.prompt.messages,
          parameters: tested.parameters,
          decisions: tested.prompt.decisions,
          source: "live_preview",
          exact: false,
          promptRequests: undefined,
        }
      : originalData;
  const [searchQuery, setSearchQuery] = useState("");
  const [scope, setScope] = useState<PromptInspectorScope>("all");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [selectedRequestIndex, setSelectedRequestIndex] = useState(0);
  const searchInputId = useId();

  useEffect(() => {
    if (copyState === "idle") return;
    const resetTimer = window.setTimeout(() => setCopyState("idle"), 2_000);
    return () => window.clearTimeout(resetTimer);
  }, [copyState]);

  const promptRequests = data.promptRequests;
  const hasPromptRequests = Boolean(promptRequests && promptRequests.length > 0);
  const defaultRequestIndex = useMemo(
    () => promptRequests?.findIndex((request) => request.kind === "planner") ?? -1,
    [promptRequests],
  );

  useEffect(() => {
    setSelectedRequestIndex(defaultRequestIndex >= 0 ? defaultRequestIndex : 0);
  }, [defaultRequestIndex, promptRequests]);

  const selectedRequest = hasPromptRequests ? promptRequests?.[selectedRequestIndex] : undefined;
  const visibleMessages = selectedRequest?.messages ?? data.messages;

  const sections = useMemo(
    () => buildDisplaySections(visibleMessages, data.chatMode === "conversation"),
    [data.chatMode, visibleMessages],
  );
  const filteredSections = useMemo(
    () => filterPromptInspectorItems(sections, searchQuery, scope),
    [scope, searchQuery, sections],
  );
  const diagnostics = useMemo(
    () => inspectPromptMessages(visibleMessages, sections, data.source),
    [data.source, sections, visibleMessages],
  );
  const resultCount = useMemo(() => countPromptInspectorResults(filteredSections), [filteredSections]);
  const totalTokens = useMemo(() => estimateTokens(visibleMessages.map((m) => m.content).join("")), [visibleMessages]);
  const searchActive = searchQuery.trim().length > 0;
  const promptSourceLabel = showTest
    ? localizeUi("decisionDebug.testedPrompt")
    : data.exact
      ? localizeUi("ui.chat.peekpromptmodal.exactTextModelRequest")
      : data.source === "live_preview"
        ? localizeUi("ui.chat.peekpromptmodal.livePreview")
        : data.source === "raw_messages"
          ? localizeUi("ui.chat.peekpromptmodal.rawMessages")
          : localizeUi("ui.chat.peekpromptmodal.promptPreview");

  const handleCopyAll = async () => {
    const copied = await copyToClipboard(serializePromptMessages(visibleMessages));
    setCopyState(copied ? "copied" : "failed");
  };

  const promptRequestLabel = (request: PromptRequest, index: number): string => {
    if (request.kind === "planner") return localizeUi("ui.chat.peekpromptmodal.plannerRequest");
    if (request.actorName?.trim()) return request.actorName.trim();
    if (request.actorId?.trim()) return request.actorId.trim();
    return localizeUi("ui.chat.peekpromptmodal.actorRequest", { count: index + 1 });
  };

  const selectedMemoryProjection = selectedRequest?.kind === "actor" ? selectedRequest.memoryProjection : undefined;
  // Main-path captures carry per-message memory/continuity metadata; isolated requests expose memoryProjection instead.
  const metadataMessages = useMemo(
    () =>
      selectedRequest
        ? []
        : data.messages.flatMap((message, index) =>
            message.metadata
              ? [{ index, role: message.role, content: message.content, metadata: message.metadata }]
              : [],
          ),
    [data.messages, selectedRequest],
  );

  const clearFilters = () => {
    setSearchQuery("");
    setScope("all");
  };

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
    <Modal
      open
      onClose={onClose}
      title={localizeUi("ui.chat.peekpromptmodal.assembledPrompt")}
      width="max-w-3xl"
      mobileFullscreen
      panelClassName="sm:h-[min(90dvh,52rem)]"
      contentClassName="flex flex-col !overflow-hidden !p-0"
    >
      <div className="shrink-0 space-y-3 border-b border-[var(--border)] bg-[var(--secondary)]/20 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className={cn(
                "shrink-0 rounded-md border px-2 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wider",
                sourceBadgeClass(data),
              )}
            >
              {promptSourceLabel}
            </span>
            <span className="min-w-0 text-[0.6875rem] text-[var(--muted-foreground)]">
              {localizeUi("ui.chat.peekpromptmodal.promptSummary", {
                count: sections.length,
                tokens: fmtTokens(totalTokens),
              })}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void handleCopyAll()}
            className="mari-chrome-control min-h-11 px-3 py-2 text-xs sm:min-h-10"
            aria-label={localizeUi("ui.chat.peekpromptmodal.copyAllRawMessages")}
            title={localizeUi("ui.chat.peekpromptmodal.copyAllRawMessages")}
          >
            {copyState === "copied" ? (
              <Check aria-hidden="true" size="0.875rem" />
            ) : copyState === "failed" ? (
              <TriangleAlert aria-hidden="true" size="0.875rem" />
            ) : (
              <Copy aria-hidden="true" size="0.875rem" />
            )}
            <span aria-live="polite">
              {copyState === "copied"
                ? localizeUi("ui.chat.peekpromptmodal.copied")
                : copyState === "failed"
                  ? localizeUi("ui.chat.peekpromptmodal.copyFailed")
                  : localizeUi("ui.chat.peekpromptmodal.copyAll")}
            </span>
          </button>
        </div>
        {hasPromptRequests && (
          <label className="flex flex-col gap-1 text-[0.6875rem] text-[var(--muted-foreground)]">
            <span>{localizeUi("ui.chat.peekpromptmodal.promptRequestSelector")}</span>
            <select
              value={selectedRequestIndex}
              onChange={(event) => setSelectedRequestIndex(Number(event.target.value))}
              aria-label={localizeUi("ui.chat.peekpromptmodal.promptRequestSelector")}
              className="h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)] outline-none transition-colors focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/25 sm:h-10"
            >
              {promptRequests?.map((request, index) => (
                <option key={`${request.kind}-${request.actorId ?? index}-${index}`} value={index}>
                  {promptRequestLabel(request, index)}
                </option>
              ))}
            </select>
          </label>
        )}

        {selectedMemoryProjection && (
          <details className="rounded-lg border border-[var(--border)] bg-[var(--background)]/55 px-3 py-2 text-[0.6875rem]">
            <summary className="cursor-pointer select-none font-medium text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/35">
              {localizeUi("ui.chat.peekpromptmodal.characterMemory")}
            </summary>
            <div className="mt-2 space-y-1.5 text-[var(--muted-foreground)]">
              <p>
                {localizeUi("ui.chat.peekpromptmodal.characterMemoryCounts", {
                  included: selectedMemoryProjection.includedCount,
                  excluded: selectedMemoryProjection.excludedCount,
                })}
              </p>
              {selectedMemoryProjection.includedCount === 0 && selectedMemoryProjection.excludedCount === 0 && (
                <p>{localizeUi("ui.chat.peekpromptmodal.characterMemoryNoneIncluded")}</p>
              )}
              {selectedMemoryProjection.degraded && (
                <p className="font-medium text-[var(--warning)]">
                  {localizeUi("ui.chat.peekpromptmodal.characterMemoryDegraded")}
                </p>
              )}
              {selectedMemoryProjection.exclusions.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4">
                  {selectedMemoryProjection.exclusions.map((exclusion, index) => (
                    <li key={`${exclusion.reason}-${index}`}>
                      {localizeUi(memoryReasonKey(exclusion.reason))}: {exclusion.count}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <label htmlFor={searchInputId} className="sr-only">
              {localizeUi("ui.chat.peekpromptmodal.filterPromptContent")}
            </label>
            <Search
              aria-hidden="true"
              size="0.875rem"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
            />
            <input
              id={searchInputId}
              type="search"
              dir="auto"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && searchQuery) {
                  event.stopPropagation();
                  setSearchQuery("");
                }
              }}
              placeholder={localizeUi("ui.chat.peekpromptmodal.searchPlaceholder")}
              className="h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] pl-9 pr-11 text-sm text-[var(--foreground)] outline-none transition-colors placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/25 sm:h-10 sm:pr-10"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label={localizeUi("ui.chat.peekpromptmodal.clearSearch")}
                className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-r-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)]/50 hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]/35 sm:h-10 sm:w-10"
              >
                <X aria-hidden="true" size="0.875rem" />
              </button>
            )}
          </div>

          <div
            role="group"
            aria-label={localizeUi("ui.chat.peekpromptmodal.filterPromptContent")}
            className="grid grid-cols-3 gap-1 rounded-lg border border-[var(--border)] bg-[var(--background)] p-1 sm:flex"
          >
            {(
              [
                ["all", localizeUi("ui.chat.peekpromptmodal.all")],
                ["sections", localizeUi("ui.chat.peekpromptmodal.sections")],
                ["chat-history", localizeUi("ui.chat.peekpromptmodal.chatHistory")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={scope === value}
                onClick={() => setScope(value)}
                className={cn(
                  "min-h-11 rounded-md px-2.5 text-[0.6875rem] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/35 sm:min-h-10",
                  scope === value
                    ? PROMPT_TAG_ACTIVE_CLASS
                    : "border border-transparent text-[var(--muted-foreground)] hover:bg-[var(--accent)]/50 hover:text-[var(--foreground)]",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <p className="min-h-4 text-[0.6875rem] text-[var(--muted-foreground)]" role="status" aria-live="polite">
          {localizeUi("ui.chat.peekpromptmodal.resultCount", { count: resultCount })}
        </p>
      </div>

      <div className={cn(NEUTRAL_PANEL_SCROLL_AREA, "min-h-0 flex-1 overflow-y-auto p-4 space-y-2")}>
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
        {data.chatId && (
          <DecisionDebugPanel
            key={data.chatId}
            chatId={data.chatId}
            onPreview={(preview) => {
              setTested(preview);
              setShowTest(preview !== null);
            }}
          />
        )}
        {tested && (
          <button
            type="button"
            className="mari-chrome-control min-h-10 px-3"
            onClick={() => setShowTest((value) => !value)}
          >
            {localizeUi(showTest ? "decisionDebug.showOriginal" : "decisionDebug.showTest")}
          </button>
        )}
        {data.decisions?.dropped && data.decisions.dropped.length > 0 && (
          <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs">
            <p>{localizeUi("ui.chat.peekpromptmodal.decisionsDropped", { count: data.decisions.dropped.length })}</p>
            <ul className="mt-1 list-disc pl-4 text-[var(--muted-foreground)]">
              {data.decisions.dropped.slice(0, 12).map((statement) => (
                <li key={statement}>{statement}</li>
              ))}
            </ul>
          </div>
        )}{" "}
        <PromptDiagnostics diagnostics={diagnostics} />
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
              </span>
              {gen && <GenerationTokenUsage generationInfo={gen} />}
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
            {hasPromptRequests && gen && (
              <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
                {localizeUi("ui.chat.peekpromptmodal.generationInfoAggregateAllPromptRequests")}
              </p>
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
        {metadataMessages.map((entry) => (
          <PromptMessageMetadataPanel
            key={`metadata-${entry.index}`}
            index={entry.index}
            role={entry.role}
            content={entry.content}
            metadata={entry.metadata}
          />
        ))}
        {filteredSections.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--border)] px-4 py-10 text-center">
            <Search aria-hidden="true" size="1.25rem" className="text-[var(--muted-foreground)]" />
            <div>
              <p className="text-sm font-medium text-[var(--foreground)]">
                {localizeUi("ui.chat.peekpromptmodal.noMatches")}
              </p>
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                {localizeUi("ui.chat.peekpromptmodal.noMatchesDescription")}
              </p>
            </div>
            {(searchActive || scope !== "all") && (
              <button
                type="button"
                onClick={clearFilters}
                className="mari-chrome-control min-h-11 px-3 py-2 text-xs sm:min-h-10"
              >
                {localizeUi("ui.chat.peekpromptmodal.clearFilters")}
              </button>
            )}
          </div>
        ) : (
          filteredSections.map((section, index) =>
            section.kind === "chat-history" ? (
              <ChatHistorySection
                key={section.inspectorId ?? `history-${index}`}
                entries={section.entries}
                rawContent={section.rawContent}
                providerBlocks={data.exact}
                revealKey={searchActive ? searchQuery : undefined}
              />
            ) : (
              <CollapsibleBlock
                key={section.inspectorId ?? `section-${index}`}
                label={section.label}
                content={section.content}
                defaultOpen={searchActive}
                revealKey={searchActive ? searchQuery : undefined}
                roleColor={sectionRoleColor(section.role, section.label)}
              />
            ),
          )
        )}
      </div>
    </Modal>
  );
}
