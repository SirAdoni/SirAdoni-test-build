import { z } from "zod";

/** app_settings key for the usage dashboard's own settings (never stored with connection secrets). */
export const USAGE_DASHBOARD_SETTINGS_KEY = "usage-dashboard";
export const USAGE_DASHBOARD_SETTINGS_VERSION = 1;
export const USAGE_DASHBOARD_MAX_RANGE_DAYS = 366;

const pricePerMillionSchema = z.number().finite().min(0).max(100_000);

export const usageConnectionPriceSchema = z
  .object({
    /** Price per 1M input (prompt) tokens, in the user's own currency. */
    input: pricePerMillionSchema.nullable(),
    /** Price per 1M output (completion) tokens. */
    output: pricePerMillionSchema.nullable(),
  })
  .strict();

export const usageDashboardSettingsSchema = z
  .object({
    version: z.literal(USAGE_DASHBOARD_SETTINGS_VERSION),
    currency: z.string().trim().max(8).default("$"),
    prices: z.record(z.string().min(1).max(64), usageConnectionPriceSchema).default({}),
  })
  .strict();

export const usageSummaryQuerySchema = z.object({
  /** Inclusive local start day, YYYY-MM-DD. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  /** Inclusive local end day, YYYY-MM-DD. */
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  /** Minutes to add to UTC to get the viewer's local time (the negation of Date#getTimezoneOffset). */
  tzOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0),
});

export type UsageConnectionPrice = z.infer<typeof usageConnectionPriceSchema>;
export type UsageDashboardSettings = z.infer<typeof usageDashboardSettingsSchema>;
export type UsageSummaryQuery = z.infer<typeof usageSummaryQuerySchema>;

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface UsageConnectionBucket extends UsageTotals {
  connectionId: string | null;
  name: string | null;
  provider: string | null;
  models: string[];
}

export interface UsageChatBucket extends UsageTotals {
  chatId: string | null;
  name: string | null;
}

export interface UsageDayBucket extends UsageTotals {
  day: string;
}

export interface UsageSummary {
  from: string;
  to: string;
  totals: UsageTotals;
  byConnection: UsageConnectionBucket[];
  byChat: UsageChatBucket[];
  byDay: UsageDayBucket[];
}

export const DEFAULT_USAGE_DASHBOARD_SETTINGS: UsageDashboardSettings = {
  version: USAGE_DASHBOARD_SETTINGS_VERSION,
  currency: "$",
  prices: {},
};
