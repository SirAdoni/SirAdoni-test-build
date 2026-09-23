export type TextDirection = "ltr" | "rtl";

/**
 * Host-owned localization state exposed to downloadable capability clients.
 *
 * Capability packages own their translated copy. The Engine supplies the
 * selected locale and writing direction so package UI can select its matching
 * resources without coupling package strings to the Engine bundle.
 */
export interface CapabilityLocalizationContext {
  locale: string;
  direction: TextDirection;
}
