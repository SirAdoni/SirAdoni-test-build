export type WikiValue = unknown;

function readable(value: unknown, depth = 0): string {
  if (depth > 4) return "…";
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return readable(JSON.parse(trimmed), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => readable(item, depth + 1)).join(", ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const text = ["text", "description", "summary", "content", "title"].find(
      (key) => typeof record[key] === "string" && record[key].trim(),
    );
    if (text) return readable(record[text], depth + 1);
    return Object.entries(record)
      .map(([key, item]) => `${key}: ${readable(item, depth + 1)}`)
      .join(" · ");
  }
  return String(value);
}

export function wikiValueSummary(value: WikiValue): string {
  return readable(value);
}

export function wikiValueRecord(value: WikiValue): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return wikiValueRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
