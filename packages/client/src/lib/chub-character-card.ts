interface ChubImportSummary {
  name?: string;
  creator?: string;
  tags?: string[];
}

export interface ChubImportDetail {
  description?: string;
  personality?: string;
  scenario?: string;
  firstMessage?: string;
  exampleDialogs?: string;
  alternateGreetings?: string[];
  creatorNotes?: string;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  characterVersion?: string;
  embeddedLorebook?: unknown;
  extensions?: Record<string, unknown>;
}

function hasCharacterBookEntries(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entries = (value as Record<string, unknown>).entries;
  if (Array.isArray(entries)) return entries.length > 0;
  return !!entries && typeof entries === "object" && Object.keys(entries).length > 0;
}

function setStringField(target: Record<string, unknown>, field: string, value: string | undefined) {
  if (value !== undefined && value.trim()) target[field] = value;
}

function hasStringField(target: Record<string, unknown>, field: string) {
  const value = target[field];
  return typeof value === "string" && value.trim().length > 0;
}

function hasStringArrayField(target: Record<string, unknown>, field: string) {
  const value = target[field];
  return Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim().length > 0);
}

function nonEmptyStringArray(value: string[] | undefined) {
  const filtered = value?.map((item) => item.trim()).filter((item) => item.length > 0) ?? [];
  return filtered.length > 0 ? filtered : null;
}

function getCharacterDataTarget(raw: Record<string, unknown>) {
  const cloned: Record<string, unknown> = { ...raw };
  const target =
    (cloned.spec === "chara_card_v2" || cloned.spec === "chara_card_v3") &&
    cloned.data &&
    typeof cloned.data === "object"
      ? { ...(cloned.data as Record<string, unknown>) }
      : cloned;

  if (target !== cloned) cloned.data = target;
  return { cloned, target };
}

export function mergeChubDetailIntoCharacterJson(
  raw: Record<string, unknown>,
  summary: ChubImportSummary,
  detail: ChubImportDetail | null | undefined,
) {
  if (!detail) return raw;

  const { cloned, target } = getCharacterDataTarget(raw);

  setStringField(target, "description", detail.description);
  setStringField(target, "personality", detail.personality);
  setStringField(target, "scenario", detail.scenario);
  setStringField(target, "first_mes", detail.firstMessage);
  setStringField(target, "mes_example", detail.exampleDialogs);
  setStringField(target, "creator_notes", detail.creatorNotes);
  setStringField(target, "system_prompt", detail.systemPrompt);
  setStringField(target, "post_history_instructions", detail.postHistoryInstructions);
  setStringField(target, "character_version", detail.characterVersion);

  if (!hasStringField(target, "name") && summary.name?.trim()) target.name = summary.name;
  if (!hasStringField(target, "creator") && summary.creator?.trim()) target.creator = summary.creator;
  const summaryTags = nonEmptyStringArray(summary.tags);
  if (!hasStringArrayField(target, "tags") && summaryTags) target.tags = summaryTags;
  const alternateGreetings = nonEmptyStringArray(detail.alternateGreetings);
  if (alternateGreetings) {
    target.alternate_greetings = alternateGreetings;
  }

  if (detail.extensions) {
    const currentExtensions =
      target.extensions && typeof target.extensions === "object" ? (target.extensions as Record<string, unknown>) : {};
    target.extensions = { ...currentExtensions, ...detail.extensions };
  }

  if (!target.character_book && hasCharacterBookEntries(detail.embeddedLorebook)) {
    target.character_book = detail.embeddedLorebook;
  }

  return cloned;
}
