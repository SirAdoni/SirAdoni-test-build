export type PaletteSection = "actions" | "chats" | "characters";

export type PaletteCommand = {
  id: string;
  title: string;
  subtitle?: string;
  section: PaletteSection;
  run: () => void | Promise<void>;
};

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Returns a higher score for closer matches, or null when no ordered match exists. */
export function fuzzyScore(query: string, text: string): number | null {
  const normalizedQuery = normalize(query.trim());
  const normalizedText = normalize(text);
  if (!normalizedQuery) return 0;
  if (!normalizedText) return null;
  if (normalizedText === normalizedQuery) return 1000;
  if (normalizedText.startsWith(normalizedQuery))
    return 900 - Math.min(normalizedText.length - normalizedQuery.length, 100);
  const wordIndex = normalizedText.search(
    new RegExp(`(^|[\\s\\-_/.:(])${normalizedQuery.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
  );
  if (wordIndex >= 0) return 800 - Math.min(wordIndex, 100);
  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex >= 0) return 700 - Math.min(substringIndex, 100);

  let score = 0;
  let textIndex = 0;
  let previousMatch = -2;
  for (const char of normalizedQuery) {
    if (char === " ") continue;
    const found = normalizedText.indexOf(char, textIndex);
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s\-_/.:(]/u.test(normalizedText[found - 1]!);
    score += found === previousMatch + 1 ? 12 : wordStart ? 9 : 2;
    previousMatch = found;
    textIndex = found + 1;
  }
  return Math.min(600, score * 10 - Math.min(normalizedText.length, 100));
}

export function rankCommands(
  commands: readonly PaletteCommand[],
  query: string,
  recentIds: readonly string[],
  options: { limit?: number; emptyQueryFallback?: (command: PaletteCommand) => boolean } = {},
): PaletteCommand[] {
  const limit = options.limit ?? 60;
  const recentRank = new Map(recentIds.map((id, index) => [id, index]));
  if (!query.trim()) {
    const recent = commands
      .filter((command) => recentRank.has(command.id))
      .sort((left, right) => recentRank.get(left.id)! - recentRank.get(right.id)!);
    const fallback = options.emptyQueryFallback
      ? commands.filter((command) => !recentRank.has(command.id) && options.emptyQueryFallback!(command))
      : [];
    return [...recent, ...fallback].slice(0, limit);
  }

  const scored: Array<{ command: PaletteCommand; score: number; order: number }> = [];
  commands.forEach((command, order) => {
    const score = Math.max(
      fuzzyScore(query, command.title) ?? -Infinity,
      fuzzyScore(query, command.subtitle ?? "") ?? -Infinity,
    );
    if (!Number.isFinite(score)) return;
    const recentIndex = recentRank.get(command.id);
    scored.push({ command, score: score + (recentIndex == null ? 0 : Math.max(5, 40 - recentIndex * 2)), order });
  });
  scored.sort((left, right) => right.score - left.score || left.order - right.order);
  return scored.slice(0, limit).map(({ command }) => command);
}

export const PALETTE_RECENTS_STORAGE_KEY = "marinara-command-palette-recents";
const PALETTE_RECENTS_LIMIT = 12;

export function pushRecent(recentIds: readonly string[], id: string): string[] {
  return [id, ...recentIds.filter((item) => item !== id)].slice(0, PALETTE_RECENTS_LIMIT);
}

export function parseRecents(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, PALETTE_RECENTS_LIMIT)
      : [];
  } catch {
    return [];
  }
}

interface KeyLike {
  key: string;
  code?: string;
  repeat?: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function isPaletteShortcut(event: KeyLike): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.repeat) return false;
  const key = event.key.toLowerCase();
  if (key === "k") return true;
  return !/^[a-z]$/u.test(key) && event.code === "KeyK";
}
