import type { CustomTrackerField } from "../types/game-state.js";
import type { CharacterTrackerCustomFieldDefault } from "../types/character.js";

export function formatCustomTrackerFieldForPrompt(field: unknown): string {
  if (!field || typeof field !== "object" || Array.isArray(field)) return "- Field: ";
  const trackerField = field as Partial<CustomTrackerField>;
  const name = typeof trackerField.name === "string" ? trackerField.name : "Field";
  const value = typeof trackerField.value === "string" ? trackerField.value : "";
  const lockLabel = trackerField.locked === true ? " (locked)" : "";
  return `- ${name}: ${value}${lockLabel}`;
}

export function normalizeCharacterTrackerCustomFieldDefaults(value: unknown): CharacterTrackerCustomFieldDefault[] {
  if (!Array.isArray(value)) return [];

  const fields: CharacterTrackerCustomFieldDefault[] = [];
  const seenNames = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) continue;
    const comparableName = name.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
    if (seenNames.has(comparableName)) continue;
    seenNames.add(comparableName);
    fields.push({
      name,
      value: typeof record.value === "string" ? record.value : record.value == null ? "" : String(record.value),
    });
  }
  return fields;
}

export function characterTrackerCustomFieldDefaultsToRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    normalizeCharacterTrackerCustomFieldDefaults(value).map((field) => [field.name, field.value]),
  );
}
