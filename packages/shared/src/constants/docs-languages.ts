import type { TextDirection } from "../types/localization.js";

export const DOCS_LANGUAGE_SETTINGS_KEY = "docs-language";
export const DEFAULT_DOCS_LANGUAGE = "en";

export interface DocsLanguageLabel {
  /** Native name shown in language pickers (e.g. "Español") */
  label: string;
  /** English name for logs and secondary display (e.g. "Spanish") */
  englishLabel: string;
  /** Reading direction of the pack's prose; omitted means "ltr". */
  direction?: TextDirection;
}

/**
 * Languages the docs viewer knows how to label. The server discovers available
 * languages from the folders under docs/i18n/ at runtime; a discovered folder
 * missing from this map still works and displays its bare code until a label
 * entry is added here.
 */
export const DOCS_LANGUAGE_LABELS: Record<string, DocsLanguageLabel> = {
  en: { label: "English", englishLabel: "English" },
  es: { label: "Español", englishLabel: "Spanish" },
  de: { label: "Deutsch", englishLabel: "German" },
  fr: { label: "Français", englishLabel: "French" },
  "pt-br": { label: "Português (Brasil)", englishLabel: "Brazilian Portuguese" },
  pl: { label: "Polski", englishLabel: "Polish" },
  ru: { label: "Русский", englishLabel: "Russian" },
  ja: { label: "日本語", englishLabel: "Japanese" },
  ko: { label: "한국어", englishLabel: "Korean" },
  "zh-hans": { label: "简体中文", englishLabel: "Simplified Chinese" },
  hi: { label: "हिन्दी", englishLabel: "Hindi" },
};

/**
 * Reading direction for a docs language. The docs viewer applies this per
 * SERVED document — an English fallback file inside an RTL pack stays "ltr".
 * Unknown or unmarked codes read "ltr".
 */
export function docsLanguageDirection(code: string | null | undefined): TextDirection {
  return (code && DOCS_LANGUAGE_LABELS[code]?.direction) || "ltr";
}

/** BCP 47-ish subset: "es", "pt-br". One path segment, no separators beyond "-". */
const DOCS_LANGUAGE_CODE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

/** Lowercase and validate a docs-language code; null when the value is not a usable code. */
export function normalizeDocsLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase();
  return DOCS_LANGUAGE_CODE_RE.test(code) ? code : null;
}
