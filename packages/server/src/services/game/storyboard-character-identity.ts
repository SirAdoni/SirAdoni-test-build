/**
 * Keep intrinsic identity separate from a scene's temporary clothing/action.
 * Supplemental card text can contain private lore which is irrelevant to an
 * ordinary scene image and should never be copied into the provider prompt.
 */
export function compactStoryboardCharacterIdentity(description: string, maxCharacters = 600): string {
  if (maxCharacters <= 0) return "";
  const sections = description.split(
    /\n|(?=\b(?:OVERALL|FACE|HAIR|SKIN|BUILD|HEIGHT AND BUILD|ATTIRE|GRACE|PRIVATE|INTIMATE|SEXUAL(?: HISTORY|ITY)?|RELATIONSHIP):)/iu,
  );
  let privateSection = false;
  const identity = sections
    .filter((section) => {
      const header = section.match(
        /^\s*(?:OVERALL|FACE|HAIR|SKIN|BUILD|HEIGHT AND BUILD|ATTIRE|GRACE|PRIVATE|INTIMATE|SEXUAL(?: HISTORY|ITY)?|RELATIONSHIP):/iu,
      );
      if (header) {
        privateSection = /^(?:GRACE|PRIVATE|INTIMATE|SEXUAL(?: HISTORY|ITY)?|RELATIONSHIP):/iu.test(header[0].trim());
        return !privateSection && !/^\s*GRACE:/iu.test(header[0]);
      }
      return !privateSection;
    })
    .map((section) => {
      const fragments = section.split(/(?<=[.!?;])\s+|,\s+|\s+(?=(?:and|or)\s+)/giu);
      return fragments
        .filter(
          (fragment) =>
            !/\b(?:genitals?|vulva|vagina|penis|testicles?|breasts?|bust|nipples?|concubine|concubinage|sexual|sexually|erotic|intercourse|orgasm|virginity|virgin|arousal|lactation|pheromones?|menstruation)\b/iu.test(
              fragment,
            ),
        )
        .join(" ")
        .replace(/\s+/g, " ")
        .replace(/\s+,/g, ",")
        .replace(/,{2,}/g, ",")
        .replace(/(^|[.!?])\s*(?:and|or)\s+/giu, "$1 ")
        .replace(/\bvoluptuous\b/giu, "curvy")
        .trim();
    })
    .filter(Boolean);
  const priority = (section: string) =>
    /FACE:/.test(section) ? 1 : /HAIR:/.test(section) ? 2 : /SKIN:/.test(section) ? 3 : /BUILD:/.test(section) ? 4 : 0;
  const text = identity
    .sort((a, b) => priority(a) - priority(b))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxCharacters) return text;
  if (maxCharacters <= 3) return text.slice(0, maxCharacters);
  const clipped = text.slice(0, maxCharacters - 3);
  return `${clipped.slice(0, clipped.lastIndexOf(" "))}...`;
}

export function uniqueStoryboardCards<T extends { id: string; data: string }>(rows: T[], names: string[]): T[] {
  const normalize = (name: string) => name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  const wanted = new Set(names.map(normalize));
  const matches = new Map<string, T[]>();
  for (const row of rows) {
    try {
      const name = normalize(JSON.parse(row.data).name ?? "");
      if (wanted.has(name)) matches.set(name, [...(matches.get(name) ?? []), row]);
    } catch {
      /* Invalid cards cannot supply image identity. */
    }
  }
  return [...matches.values()].filter((group) => group.length === 1).map((group) => group[0]!);
}
