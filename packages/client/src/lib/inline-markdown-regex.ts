export const MD_LINK_TARGET_SOURCE = String.raw`(?:https?:\/\/[^)\s]+|card:\/\/[^)\s]+|\/api\/[^)\s]+)`;

/** Discord-style line-level subtext, which must be checked before unordered lists. */
export const DISCORD_SUBTEXT_RE = /^\s*-#(?:\s+(.*)|\s*)$/;

export const INLINE_MD_RE = new RegExp(
  "\\\\([-\\\\*_~`#|>!=\\[\\]{}])|(!?\\[([^\\]]*)\\]\\((" +
    MD_LINK_TARGET_SOURCE +
    ")\\))|`([^`\\n]+)`|==(.+?)==|~~(.+?)~~|\\*\\*\\*(.+?)\\*\\*\\*|\\*\\*(.+?)\\*\\*|__(.+?)__|(?<!\\*)\\*(?!\\*)(.+?)(?<!\\*)\\*(?!\\*)|(?<![_\\w])_([^_]+?)_(?![_\\w])",
  "g",
);
