export type GameAddressMode = "party" | "gm";

/** Resolve explicit player-to-controller prefixes from the actual current input. */
export function resolveGameAddressMode(value: unknown): GameAddressMode | undefined {
  const content = typeof value === "string" ? value.trimStart() : "";
  if (/^\[\s*(?:to\s+(?:the\s+)?)?gm\s*\]/iu.test(content) || /^\[\s*ooc\s*\]/iu.test(content)) {
    return "gm";
  }
  if (/^ooc\s*:/iu.test(content)) return "gm";
  if (/^\[\s*(?:to\s+(?:the\s+)?)?party\s*\]/iu.test(content)) return "party";
  return undefined;
}
