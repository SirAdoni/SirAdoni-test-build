export interface GameSegmentEdit {
  content?: string;
  speaker?: string;
  readableContent?: string;
  readableType?: "note" | "book";
}

export function normalizeGameSegmentEdit(value: unknown): GameSegmentEdit | null {
  if (typeof value === "string") {
    return { content: value };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const content = typeof record.content === "string" ? record.content : undefined;
  const speaker =
    typeof record.speaker === "string" && record.speaker.trim().length > 0 ? record.speaker.trim() : undefined;
  const readableContent = typeof record.readableContent === "string" ? record.readableContent : undefined;
  const readableType =
    record.readableType === "book" || record.readableType === "note" ? record.readableType : undefined;

  return content !== undefined || speaker !== undefined || readableContent !== undefined || readableType !== undefined
    ? { content, speaker, readableContent, readableType }
    : null;
}

export function serializeGameSegmentEdit(edit: GameSegmentEdit): GameSegmentEdit | null {
  const content = typeof edit.content === "string" ? edit.content : undefined;
  const speaker = typeof edit.speaker === "string" && edit.speaker.trim().length > 0 ? edit.speaker.trim() : undefined;
  const readableContent = typeof edit.readableContent === "string" ? edit.readableContent : undefined;
  const readableType = edit.readableType === "book" || edit.readableType === "note" ? edit.readableType : undefined;

  return content !== undefined || speaker !== undefined || readableContent !== undefined || readableType !== undefined
    ? {
        ...(content !== undefined ? { content } : {}),
        ...(speaker ? { speaker } : {}),
        ...(readableContent !== undefined ? { readableContent } : {}),
        ...(readableType ? { readableType } : {}),
      }
    : null;
}
