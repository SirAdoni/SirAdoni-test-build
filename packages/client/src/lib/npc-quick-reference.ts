// ──────────────────────────────────────────────
// NPC quick reference: the short card summary shown when a linked character
// name in chat or Game narration is hovered or tapped.
// ──────────────────────────────────────────────

export const NPC_PEEK_DESCRIPTION_LIMIT = 300;
export const NPC_PEEK_TAG_LIMIT = 8;

export interface NpcPeekSummary {
  description: string;
  tags: string[];
}

/** Collapse whitespace and cut at a word boundary near the limit, marking the cut with an ellipsis. */
export function shortenPeekDescription(value: unknown, limit = NPC_PEEK_DESCRIPTION_LIMIT): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/gu, " ").trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/u, "")}…`;
}

function parseCardData(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.data;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/** Read the description and tags from a character row (list or detail shape) or a bare card. */
export function readNpcPeekSummary(row: unknown): NpcPeekSummary {
  if (!row || typeof row !== "object") return { description: "", tags: [] };
  const record = row as Record<string, unknown>;
  const card = { ...record, ...parseCardData(record) };
  const tags = Array.isArray(card.tags)
    ? [
        ...new Set(
          card.tags
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  return { description: shortenPeekDescription(card.description), tags: tags.slice(0, NPC_PEEK_TAG_LIMIT) };
}

export interface PeekAnchorRect {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

/** Place a popover below its anchor (above when there is no room), clamped inside the viewport. */
export function placeNpcPeek(
  anchor: PeekAnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { top: number; left: number; above: boolean } {
  const gap = 6;
  const fitsBelow = anchor.bottom + gap + size.height <= viewport.height - margin;
  const fitsAbove = anchor.top - gap - size.height >= margin;
  const above = !fitsBelow && fitsAbove;
  const rawTop = above ? anchor.top - gap - size.height : anchor.bottom + gap;
  const top = Math.max(margin, Math.min(rawTop, viewport.height - margin - size.height));
  const centered = anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.max(margin, Math.min(centered, viewport.width - margin - size.width));
  return { top, left, above };
}
