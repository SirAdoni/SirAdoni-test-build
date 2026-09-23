import type { PromptOverrideKeyDef } from "../types.js";

export interface CharactersReferenceSheetCtx extends Record<string, string | number | undefined> {
  name: string;
  appearance: string;
}

export const CHARACTERS_REFERENCE_SHEET: PromptOverrideKeyDef<CharactersReferenceSheetCtx> = {
  key: "characters.referenceSheet",
  label: "Character Reference Sheet",
  description: "Production character reference sheet used by character and Persona gallery generation.",
  variables: [
    { name: "name", description: "Character or Persona name.", example: "Mira" },
    {
      name: "appearance",
      description: "Canonical appearance description.",
      example: "long brown hair, amber eyes, dark travel coat",
    },
  ],
  defaultBuilder: (ctx) =>
    [
      `Create a polished production character design sheet for ${ctx.name}.`,
      `Canonical appearance: ${ctx.appearance}.`,
      "Show multiple consistent views of the same character: one large full-body hero view, front and back turnaround views in neutral poses, close-up face and costume details, important accessories, and a compact color palette on a clean neutral background.",
      "Keep the same face, body proportions, hairstyle, outfit construction, colors, accessories, and distinguishing features in every view.",
      "Show only this character and keep every body view fully in frame.",
    ].join(" "),
  exampleContext: {
    name: "Mira",
    appearance: "long brown hair, amber eyes, dark travel coat",
  },
};
