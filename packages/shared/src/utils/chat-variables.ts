// Naming rules for chat variables — the per-chat `{{name}}` values a user
// defines in Chat Settings and types into messages and prompt fields.
//
// Storage (chat metadata `macroVariables`) is shared with `{{setvar}}`, which
// accepts `[\w.-]+`. These rules are deliberately stricter and apply only when
// a name is *created* in the UI, because the engine's bare `{{name}}` catch-all
// matches `\w+`: a name containing a dot or a dash could be stored but never
// read back as `{{story.day}}`. Values written by `{{setvar}}` keep their
// original names and stay editable.

import { CHARACTER_REFERENCE_ID_PATTERN, SUPPORTED_MACROS } from "./macro-engine.js";

/** Names addressable as a bare `{{name}}`: letter or underscore first, 64 chars max. */
export const CHAT_VARIABLE_NAME_RE = /^[A-Za-z_]\w{0,63}$/;

/**
 * Names accepted by the store, which `{{setvar}}` has always been free to use.
 * Broader than CHAT_VARIABLE_NAME_RE on purpose — see the note above.
 */
export const CHAT_VARIABLE_STORED_NAME_RE = /^[\w.-]+$/u;

/** Mirrors the cap enforced by normalizeChatMacroVariables on the server. */
export const MAX_CHAT_VARIABLES = 500;

/** Guards against a paste-bomb landing in chat metadata; generous enough for accumulated setvar text. */
export const MAX_CHAT_VARIABLE_VALUE_LENGTH = 10_000;

// Macro names the engine consumes before the `{{name}}` catch-all runs, which
// SUPPORTED_MACROS does not list as a plain `{{name}}` entry. Kept in sync by
// hand with the replace passes in macro-engine.ts; a miss only means a variable
// of that name is silently unreadable, which is why creation is blocked.
const EXTRA_RESERVED_MACRO_NAMES = [
  "original",
  "isotime",
  "trimend",
  "decvar",
  "banned",
  "prompt",
  "if",
  "else",
  "n",
  // Conversation placement macro aliases.
  "status",
  "commandlist",
  "emojireact",
  "memoryrecall",
  "lore",
  // Conditional operand keywords.
  "character",
  // Object members. The engine reads variables as own properties only, so
  // these are inert — but a stored "__proto__" is a trap for the next reader.
  "__proto__",
  "constructor",
  "prototype",
] as const;

function collectReservedMacroNames(): ReadonlySet<string> {
  const names = new Set<string>(EXTRA_RESERVED_MACRO_NAMES);
  for (const macro of SUPPORTED_MACROS) {
    const match = /^\{\{([A-Za-z_]\w*)(?:::|:|\}\})/.exec(macro.syntax);
    if (match) names.add(match[1]!.toLowerCase());
  }
  return names;
}

/**
 * Every macro name the engine resolves on its own, lowercased.
 *
 * Built-in passes run before the catch-all, so a chat variable sharing one of
 * these names would never resolve as `{{name}}` — only as `{{getvar::name}}`.
 */
export const RESERVED_MACRO_NAMES: ReadonlySet<string> = collectReservedMacroNames();

export function isReservedMacroName(name: string): boolean {
  // The built-in passes are case-insensitive ({{USER}} resolves), so the
  // reserved check has to be too, even though variable lookup is exact-case.
  return RESERVED_MACRO_NAMES.has(name.trim().toLowerCase());
}

export type ChatVariableNameIssue = "empty" | "format" | "reserved" | "duplicate";

/**
 * Validate a chat variable name typed by a user.
 *
 * `existing` is the set of names already defined in this chat; pass the other
 * rows only, so renaming a row to its current name is not a duplicate.
 */
export function validateChatVariableName(name: string, existing?: Iterable<string>): ChatVariableNameIssue | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (!CHAT_VARIABLE_NAME_RE.test(trimmed)) return "format";
  if (isReservedMacroName(trimmed) || new RegExp(CHARACTER_REFERENCE_ID_PATTERN.source).test(`{{${trimmed}}}`))
    return "reserved";
  if (existing) {
    for (const other of existing) {
      if (other === trimmed) return "duplicate";
    }
  }
  return null;
}
