const NPC_ROLE_WORDS =
  /^(?:(?:senior|junior|head|relief|resident|indoor|household|principal|private|guest|cold|prepared|carriage|independent|night|day)\s+)*(?:butler|manager|housemaid|maid|cook|courtesan|courier|driver|steward|servant|clerk|guard|soldier|captain|healer|merchant|innkeeper|baker|blacksmith|scholar|priest(?:ess)?|mage|wizard|witch|ranger|hunter|farmer|noble|officer|porter|stablehand|secretary|attendant|librarian|sailor|pilot|engineer|doctor|nurse)\b/iu;

/**
 * Extract explicitly named people from roster-style prose such as
 * "Ysanne Korr, butler and manager". The role vocabulary keeps ordinary
 * comma-separated prose, places, and object lists out of the candidate set.
 */
export function extractNamedRoleNpcNames(text: string): string[] {
  if (!text.trim()) return [];
  const names = new Set<string>();
  const pattern =
    /\b([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)?)\s*,\s*([^.;:\n]+?)(?=;|\.|\n|,\s*[A-Z][A-Za-z'’-]+\s*,|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1]?.trim();
    const role = match[2]?.trim() ?? "";
    if (name && NPC_ROLE_WORDS.test(role)) names.add(name);
  }
  return [...names];
}
