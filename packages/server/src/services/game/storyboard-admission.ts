const active = new Set<string>();

/** Deduplicate one turn without queuing unrelated turns behind its images. */
export function claimStoryboardTurn(chatId: string, messageId: string, swipeIndex: number): (() => void) | null {
  const key = JSON.stringify([chatId, messageId, swipeIndex]);
  if (active.has(key)) return null;
  active.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.delete(key);
  };
}

export function parseStoryboardCast(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) value = parsed;
    } catch {
      /* Legacy comma-separated names remain supported. */
    }
  }
  const names = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]/) : [];
  return [...new Set(names.flatMap((name) => (typeof name === "string" && name.trim() ? [name.trim()] : [])))].slice(
    0,
    20,
  );
}
