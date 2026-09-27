// ──────────────────────────────────────────────
// Character library search index: the fields the
// Characters panel searches, normalized once per
// loaded list so typing only runs substring checks.
// ──────────────────────────────────────────────
import {
  buildCardLibrarySearchIndex,
  formatCardLibraryMeta,
  getCardLibrarySummary,
  type CardLibrarySearchDocument,
  type CardLibrarySearchIndex,
} from "../../../lib/card-library-search";
import { getCharacterTitle } from "../../../lib/character-display";

type SearchableCharacter = {
  comment?: string | null;
  parsed: Record<string, any>;
};

export function getCharacterSearchDocument(character: SearchableCharacter, tags: string[]): CardLibrarySearchDocument {
  const c = character.parsed;
  return {
    name: c.name,
    title: getCharacterTitle({ name: c.name ?? "", comment: character.comment }),
    meta: formatCardLibraryMeta(c.creator, c.character_version),
    summary: getCardLibrarySummary([c.summary, c.creator_notes, c.description, c.personality]),
    tags,
    sections: [
      { content: c.description },
      { content: c.personality },
      { content: c.scenario },
      { content: c.first_mes },
    ],
  };
}

export function buildCharacterSearchIndex(character: SearchableCharacter, tags: string[]): CardLibrarySearchIndex {
  return buildCardLibrarySearchIndex(getCharacterSearchDocument(character, tags));
}
