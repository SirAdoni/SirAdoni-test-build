import { z } from "zod";

export const HOME_CUSTOM_WIDGETS_SETTINGS_KEY = "home_custom_widgets";
export const HOME_CUSTOM_WIDGET_LIMIT = 24;

export const homeCustomWidgetSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    accent: z.enum(["cyan", "orange", "pink", "violet"]).default("cyan"),
    icon: z.enum(["sparkles", "note", "heart", "star", "book", "compass"]).default("sparkles"),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const homeCustomWidgetDraftSchema = homeCustomWidgetSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .strict();

export const homeCustomWidgetCatalogSchema = z
  .object({
    revision: z.number().int().nonnegative().default(0),
    widgets: z.array(homeCustomWidgetSchema).max(HOME_CUSTOM_WIDGET_LIMIT),
  })
  .strict()
  .superRefine(({ widgets }, context) => {
    const seen = new Set<string>();
    widgets.forEach((widget, index) => {
      if (seen.has(widget.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["widgets", index, "id"],
          message: "Widget IDs must be unique",
        });
      }
      seen.add(widget.id);
    });
  });

export type HomeCustomWidget = z.infer<typeof homeCustomWidgetSchema>;
export type HomeCustomWidgetDraft = z.infer<typeof homeCustomWidgetDraftSchema>;
export type HomeCustomWidgetCatalog = z.infer<typeof homeCustomWidgetCatalogSchema>;
