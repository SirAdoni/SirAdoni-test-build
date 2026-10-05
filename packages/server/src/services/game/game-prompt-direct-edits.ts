import { measureContextBudget } from "../llm/base-provider.js";

/** Edits made in the full Game prompt editor. Each edit is applied once to the
 * newly assembled request, so live history and campaign state are rebuilt on
 * every turn rather than saved as a stale prompt snapshot. */
export interface GamePromptDirectEdit {
  role: string;
  find: string;
  replace: string;
}

export interface GamePromptDirectEditIssue {
  editIndex: number;
  reason: "missing" | "ambiguous";
}

export interface GamePromptDirectEditApplication<T> {
  messages: T[];
  issues: GamePromptDirectEditIssue[];
}

const MAX_EDITS = 128;
const MAX_FIND_LENGTH = 128_000;
const MAX_REPLACE_LENGTH = 128_000;
const MAX_TOTAL_LENGTH = 900_000;

export function assertGameGenerationOptionalFeaturesEnabled(args: {
  promptEditsApplied: boolean;
  gmReasoningApplied: boolean;
  promptEditingEnabled: boolean;
  gmReasoningEnabled: boolean;
}): void {
  if (args.promptEditsApplied && !args.promptEditingEnabled) {
    throw new Error("Game prompt editing was disabled during generation; retry the request.");
  }
  if (args.gmReasoningApplied && !args.gmReasoningEnabled) {
    throw new Error("GM narration reasoning was disabled during generation; retry the request.");
  }
}

export async function dispatchWithGameGenerationFeatures<T>(
  snapshot: Parameters<typeof assertGameGenerationOptionalFeaturesEnabled>[0],
  dispatch: () => Promise<T> | T,
): Promise<T> {
  assertGameGenerationOptionalFeaturesEnabled(snapshot);
  return dispatch();
}

export function disabledGameFeatureMetadataWriteError(
  incoming: Record<string, unknown>,
  promptEditingEnabled: boolean,
  gmReasoningEnabled: boolean,
): string | null {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(incoming, key);
  if ((has("gamePromptDirectEdits") || has("gamePromptDirectEditsRevision")) && !promptEditingEnabled) {
    return "Game prompt editing is disabled";
  }
  if (has("gameGmReasoningEffort") && !gmReasoningEnabled) return "Game GM reasoning is disabled";
  return null;
}

export function assertGameFeatureMetadataWriteAllowed(
  incoming: Record<string, unknown>,
  promptEditingEnabled: boolean,
  gmReasoningEnabled: boolean,
): void {
  const message = disabledGameFeatureMetadataWriteError(incoming, promptEditingEnabled, gmReasoningEnabled);
  if (message) throw Object.assign(new Error(message), { statusCode: 403 });
}

export function parseGamePromptDirectEdits(value: unknown): GamePromptDirectEdit[] | null {
  if (!Array.isArray(value) || value.length > MAX_EDITS) return null;
  const edits: GamePromptDirectEdit[] = [];
  let totalLength = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { role, find, replace } = item as Record<string, unknown>;
    if (
      typeof role !== "string" ||
      !/^[a-z_]{3,32}$/.test(role) ||
      typeof find !== "string" ||
      find.length < 3 ||
      find.length > MAX_FIND_LENGTH ||
      typeof replace !== "string" ||
      replace.length > MAX_REPLACE_LENGTH
    )
      return null;
    totalLength += find.length + replace.length;
    if (totalLength > MAX_TOTAL_LENGTH) return null;
    edits.push({ role, find, replace });
  }
  return edits;
}

/** Reject edited requests that exceed the same context budget used before edits. */
export function assertGamePromptRequestFits(
  messages: Parameters<typeof measureContextBudget>[0],
  options: Parameters<typeof measureContextBudget>[1],
): void {
  if (!measureContextBudget(messages, options).fits) {
    throw new Error("GAME_PROMPT_EDITS_EXCEED_CONTEXT");
  }
}

/** Legacy metadata can outlive a chat-mode change; only Game requests may use it. */
export function gamePromptDirectEditsForMode(mode: string, value: unknown): GamePromptDirectEdit[] | null {
  return mode === "game" ? parseGamePromptDirectEdits(value) : [];
}

/** Preserve roles, attachments and provider metadata. A match is deliberately
 * changed only once per edit across the request, even if that phrase later
 * appears in unrelated history. Edits are sequential so a later save can
 * refine text changed by an earlier save. */
export function applyGamePromptDirectEdits<T extends { role: string; content: string }>(
  messages: readonly T[],
  edits: readonly GamePromptDirectEdit[],
): T[] {
  return applyGamePromptDirectEditsWithIssues(messages, edits).messages;
}

export function applyGamePromptDirectEditsWithIssues<T extends { role: string; content: string }>(
  messages: readonly T[],
  edits: readonly GamePromptDirectEdit[],
): GamePromptDirectEditApplication<T> {
  const result = messages.map((message) => ({ ...message }));
  const issues: GamePromptDirectEditIssue[] = [];
  for (const [editIndex, edit] of edits.entries()) {
    let match: { messageIndex: number; offset: number } | null = null;
    let ambiguous = false;
    for (let messageIndex = 0; messageIndex < result.length; messageIndex += 1) {
      const message = result[messageIndex]!;
      if (message.role !== edit.role) continue;
      const index = message.content.indexOf(edit.find);
      if (index < 0) continue;
      if (match || message.content.indexOf(edit.find, index + 1) >= 0) {
        ambiguous = true;
        break;
      }
      match = { messageIndex, offset: index };
    }
    if (!match || ambiguous) {
      issues.push({ editIndex, reason: ambiguous ? "ambiguous" : "missing" });
      continue;
    }
    const message = result[match.messageIndex]!;
    message.content =
      message.content.slice(0, match.offset) + edit.replace + message.content.slice(match.offset + edit.find.length);
  }
  return { messages: result, issues };
}
