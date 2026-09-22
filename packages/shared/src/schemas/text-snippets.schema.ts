import { z } from "zod";

export const TEXT_SNIPPETS_SETTINGS_KEY = "text-snippets";
export const TEXT_SNIPPET_CATALOG_VERSION = 1;
export const TEXT_SNIPPET_MAX_COUNT = 200;
export const TEXT_SNIPPET_MAX_TRIGGER_LENGTH = 32;
export const TEXT_SNIPPET_MAX_EXPANSION_LENGTH = 10_000;

/** Triggers are typed inline, so they must be one whitespace-free "word". */
export const TEXT_SNIPPET_TRIGGER_PATTERN = /^\S+$/u;

const textSnippetSchema = z
  .object({
    id: z.string().min(1).max(64),
    trigger: z.string().min(1).max(TEXT_SNIPPET_MAX_TRIGGER_LENGTH).regex(TEXT_SNIPPET_TRIGGER_PATTERN),
    expansion: z
      .string()
      .max(TEXT_SNIPPET_MAX_EXPANSION_LENGTH)
      .refine((expansion) => expansion.trim().length > 0),
  })
  .strict();

const textSnippetListSchema = z
  .array(textSnippetSchema)
  .max(TEXT_SNIPPET_MAX_COUNT)
  .superRefine((snippets, context) => {
    const ids = new Set<string>();
    const triggers = new Set<string>();
    for (const [index, snippet] of snippets.entries()) {
      if (ids.has(snippet.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "id"], message: "Snippet ids must be unique" });
      }
      if (triggers.has(snippet.trigger)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "trigger"],
          message: "Snippet triggers must be unique",
        });
      }
      ids.add(snippet.id);
      triggers.add(snippet.trigger);
    }
  });

export const textSnippetCatalogSchema = z
  .object({
    version: z.literal(TEXT_SNIPPET_CATALOG_VERSION),
    snippets: textSnippetListSchema,
  })
  .strict();

export type TextSnippet = z.infer<typeof textSnippetSchema>;
export type TextSnippetCatalog = z.infer<typeof textSnippetCatalogSchema>;

export const EMPTY_TEXT_SNIPPET_CATALOG: TextSnippetCatalog = {
  version: TEXT_SNIPPET_CATALOG_VERSION,
  snippets: [],
};
