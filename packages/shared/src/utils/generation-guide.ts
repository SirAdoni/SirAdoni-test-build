export type GenerationGuideSource = "narrator" | "guide" | "game_start";

export function buildNarratorInstructionMessage(direction: string): string {
  return `[Narrator instruction — do not include a reply from {{user}}. Instead, write the next part of the narrative steering it toward the following: ${direction.trim()}]`;
}

export function buildGuidedGenerationInstructionMessage(direction: string): string {
  return `[Guided generation instruction — do not include a reply from {{user}}. Instead, write the next generated message steering it toward the following: ${direction.trim()}]`;
}

export function stripGenerationGuideInstruction(value: string): string {
  if (!value.endsWith("]")) return value;
  const prefixes = ["[Narrator instruction ", "[Guided generation instruction "];
  const prefix = prefixes.find((candidate) => value.startsWith(candidate));
  if (!prefix) return value;
  const marker = " following:";
  const markerIndex = value.indexOf(marker, prefix.length);
  if (markerIndex < 0 || value.indexOf("]", prefix.length) < markerIndex) return value;
  return value.slice(markerIndex + marker.length, -1).trim() || value;
}
