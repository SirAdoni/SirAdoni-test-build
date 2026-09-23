export type CharacterLibraryCategory = "characters" | "npcs";

/** Explicit organization wins over provenance, including after automatic updates. */
export function getCharacterLibraryCategory(data: unknown): CharacterLibraryCategory {
  if (!data || typeof data !== "object") return "characters";
  const extensions = (data as Record<string, unknown>).extensions as Record<string, unknown> | undefined;
  if (extensions?.libraryCategory === "characters" || extensions?.libraryCategory === "npcs") {
    return extensions.libraryCategory;
  }
  const marinara = extensions?.marinara as Record<string, unknown> | undefined;
  const npc = marinara?.gameNpc as Record<string, unknown> | undefined;
  return npc?.autoCreated === true ? "npcs" : "characters";
}
