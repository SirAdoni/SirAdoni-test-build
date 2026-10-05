import { SUPPORTED_MACROS, normalizeTextForMatch } from "@marinara-engine/shared";

export interface PromptInspectorMessage {
  role: string;
  content: string;
}

export interface PromptInspectorSectionBlock {
  kind: "section";
  inspectorId?: string;
  label: string;
  role: string;
  content: string;
}

export interface PromptInspectorHistoryEntry {
  inspectorId?: string;
  role: string;
  content: string;
}

export interface PromptInspectorHistoryBlock {
  kind: "chat-history";
  inspectorId?: string;
  entries: PromptInspectorHistoryEntry[];
  rawContent: string;
}

export type PromptInspectorItem = PromptInspectorSectionBlock | PromptInspectorHistoryBlock;
export type PromptInspectorScope = "all" | "sections" | "chat-history";

export type PromptInspectorDiagnostic =
  | { kind: "empty-message"; messageIndex: number; role: string }
  | { kind: "empty-section"; sectionIndex: number; label: string }
  | { kind: "unresolved-macro"; sectionIndex: number; label: string; macros: string[] };

function matchesSearchTerms(value: string, terms: string[]): boolean {
  const normalized = normalizeTextForMatch(value.replace(/[_-]+/g, " "));
  return terms.every((term) => normalized.includes(term));
}

/**
 * Filters the inspector's derived display items without changing the raw prompt.
 * Chat-history entries are matched individually so unrelated turns do not crowd
 * the result list.
 */
export function filterPromptInspectorItems(
  items: PromptInspectorItem[],
  rawQuery: string,
  scope: PromptInspectorScope,
): PromptInspectorItem[] {
  const terms = normalizeTextForMatch(rawQuery.replace(/[_-]+/g, " ")).split(" ").filter(Boolean);
  const includeSections = scope === "all" || scope === "sections";
  const includeChatHistory = scope === "all" || scope === "chat-history";

  return items.flatMap((item): PromptInspectorItem[] => {
    if (item.kind === "section") {
      if (!includeSections) return [];
      if (terms.length === 0 || matchesSearchTerms(`${item.label} ${item.role} ${item.content}`, terms)) {
        return [item];
      }
      return [];
    }

    if (!includeChatHistory) return [];
    if (terms.length === 0) return [item];

    const entries = item.entries.filter((entry) => matchesSearchTerms(`${entry.role} ${entry.content}`, terms));
    if (entries.length === 0) return [];
    return [{ ...item, entries, rawContent: entries.map((entry) => entry.content).join("\n\n") }];
  });
}

export function countPromptInspectorResults(items: PromptInspectorItem[]): number {
  return items.reduce((count, item) => count + (item.kind === "chat-history" ? item.entries.length : 1), 0);
}

/** Serializes the role/content text view in its original message order. */
export function serializePromptMessages(messages: PromptInspectorMessage[]): string {
  return JSON.stringify(
    messages.map(({ role, content }) => ({ role, content })),
    null,
    2,
  );
}

function isEmptySectionContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  if (/^<([a-z_][a-z0-9_-]*)>\r?\n\s*<\/\1>$/i.test(trimmed)) return true;
  return /^##\s+(?:Context|Commands|Output Format)\s*$/i.test(trimmed);
}

const KNOWN_SIMPLE_MACRO_NAMES = new Set(
  SUPPORTED_MACROS.flatMap((definition) =>
    [...definition.syntax.matchAll(/{{\s*([a-z_][a-z0-9_.-]{0,63})\s*}}/gi)].map((match) => match[1]!),
  )
    .filter((name) => name !== "NAME")
    .map((name) => name.toLocaleLowerCase()),
);

function findMacroNames(content: string): string[] {
  const names = new Map<string, string>();
  const macroPattern = /{{\s*([a-z_][a-z0-9_.-]{0,63})\s*}}/gi;

  for (const match of content.matchAll(macroPattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (content[start - 1] === "\\" || content[start - 1] === "{" || content[end] === "}") continue;
    const name = match[1]!;
    const normalizedName = name.toLocaleLowerCase();
    if (!KNOWN_SIMPLE_MACRO_NAMES.has(normalizedName)) continue;
    if (!names.has(normalizedName)) names.set(normalizedName, name);
  }

  return [...names.values()];
}

/**
 * Reports only directly observable syntax conditions. It intentionally avoids
 * judging prompt quality, intent, or literal macro examples in user/assistant
 * text.
 */
export function inspectPromptMessages(
  messages: PromptInspectorMessage[],
  items: PromptInspectorItem[],
  source?: "cached" | "live_preview" | "raw_messages" | "assembled",
): PromptInspectorDiagnostic[] {
  const diagnostics: PromptInspectorDiagnostic[] = [];

  messages.forEach((message, messageIndex) => {
    if (!message.content.trim()) diagnostics.push({ kind: "empty-message", messageIndex, role: message.role });
  });

  items.forEach((item, sectionIndex) => {
    if (item.kind !== "section") return;
    const role = item.role.toLocaleLowerCase();
    const isUserOrAssistantText = role === "user" || role === "assistant";

    if (!isUserOrAssistantText && isEmptySectionContent(item.content)) {
      diagnostics.push({ kind: "empty-section", sectionIndex, label: item.label });
    }

    if (source === "raw_messages" || /last.?message/i.test(item.label) || isUserOrAssistantText) {
      return;
    }
    const macros = findMacroNames(item.content);
    if (macros.length > 0) {
      diagnostics.push({ kind: "unresolved-macro", sectionIndex, label: item.label, macros });
    }
  });

  return diagnostics;
}
