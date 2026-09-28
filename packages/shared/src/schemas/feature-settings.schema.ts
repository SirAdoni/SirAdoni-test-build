import { z } from "zod";
import { MESSAGE_TRASH_RETENTION_DAYS } from "../utils/message-marks.js";

/**
 * App-wide feature switches (Settings > Features), stored as one JSON object in
 * the `features` app setting. Every switch defaults ON: an absent key keeps the
 * current behaviour, and `false` restores the upstream behaviour.
 */
export const FEATURE_SETTINGS_KEY = "features";

export const FEATURE_SWITCH_NAMES = [
  "chatgptHistoryReplay",
  "cacheFriendlyPromptLayout",
  "gameCacheStableLayout",
  "gameFreezeNpcCardsPerSession",
  "stableLorebookGroupPicks",
  "stableLoreOrder",
  "providerRetry",
  "backgroundCallCap",
  "messageTrash",
  "usageAndActivationStats",
  "consoleTray",
] as const;
export type FeatureSwitchName = (typeof FEATURE_SWITCH_NAMES)[number];

/** Personal-build defaults. Upstream's newer two-switch registry defaults off; existing personal settings default on. */
export const FEATURE_SWITCH_DEFAULTS: Readonly<Record<FeatureSwitchName, boolean>> = {
  chatgptHistoryReplay: true,
  cacheFriendlyPromptLayout: true,
  gameCacheStableLayout: true,
  gameFreezeNpcCardsPerSession: true,
  stableLorebookGroupPicks: true,
  stableLoreOrder: true,
  providerRetry: true,
  backgroundCallCap: true,
  messageTrash: true,
  usageAndActivationStats: true,
  consoleTray: true,
};

export const FEATURE_NUMBER_SETTINGS = {
  backgroundCallsPerHour: { defaultValue: 600, min: 1, max: 100_000 },
  messageTrashDays: { defaultValue: MESSAGE_TRASH_RETENTION_DAYS, min: 1, max: 365 },
  /** Turns a stopped keyword match may stay in the lore block (stableLoreOrder); 0 turns lingering off. */
  stableLoreLingerTurns: { defaultValue: 2, min: 0, max: 8 },
} as const;
export type FeatureNumberName = keyof typeof FEATURE_NUMBER_SETTINGS;
export const FEATURE_NUMBER_NAMES = Object.keys(FEATURE_NUMBER_SETTINGS) as FeatureNumberName[];

export type FeatureSettings = Partial<Record<FeatureSwitchName, boolean> & Record<FeatureNumberName, number>>;

const numberSchema = (name: FeatureNumberName) => {
  const { min, max } = FEATURE_NUMBER_SETTINGS[name];
  return z.number().int().min(min).max(max);
};

export const featureSettingsSchema = z
  .object({
    chatgptHistoryReplay: z.boolean().optional(),
    cacheFriendlyPromptLayout: z.boolean().optional(),
    gameCacheStableLayout: z.boolean().optional(),
    gameFreezeNpcCardsPerSession: z.boolean().optional(),
    stableLorebookGroupPicks: z.boolean().optional(),
    stableLoreOrder: z.boolean().optional(),
    providerRetry: z.boolean().optional(),
    backgroundCallCap: z.boolean().optional(),
    messageTrash: z.boolean().optional(),
    usageAndActivationStats: z.boolean().optional(),
    consoleTray: z.boolean().optional(),
    backgroundCallsPerHour: numberSchema("backgroundCallsPerHour").optional(),
    messageTrashDays: numberSchema("messageTrashDays").optional(),
    stableLoreLingerTurns: numberSchema("stableLoreLingerTurns").optional(),
  })
  .strict();

/** Keep only well-formed keys from a stored value; anything else falls back to the default. */
export function normalizeFeatureSettings(value: unknown): FeatureSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const settings: FeatureSettings = {};
  for (const name of FEATURE_SWITCH_NAMES) {
    if (typeof raw[name] === "boolean") settings[name] = raw[name];
  }
  for (const name of FEATURE_NUMBER_NAMES) {
    const parsed = numberSchema(name).safeParse(raw[name]);
    if (parsed.success) settings[name] = parsed.data;
  }
  return settings;
}

export function resolveFeatureEnabled(settings: FeatureSettings | null | undefined, name: FeatureSwitchName): boolean {
  return settings?.[name] ?? FEATURE_SWITCH_DEFAULTS[name];
}

export function resolveFeatureNumber(settings: FeatureSettings | null | undefined, name: FeatureNumberName): number {
  return settings?.[name] ?? FEATURE_NUMBER_SETTINGS[name].defaultValue;
}

/**
 * Why a switch has no effect on this server, so the UI can show it as unavailable.
 * `windowsOnly`: the switch drives a Windows-only helper (the console tray icon).
 */
export type FeatureUnavailableReason = "windowsOnly";

export interface FeatureSettingsResponse {
  /** What is saved; absent keys use their defaults. */
  settings: FeatureSettings;
  /** Settings pinned by a server environment variable, with the variable name. Env wins over the saved value. */
  envOverrides: Partial<Record<FeatureSwitchName | FeatureNumberName, string>>;
  /** For switches pinned by an on/off environment variable: the value actually in effect. */
  effective?: Partial<Record<FeatureSwitchName, boolean>>;
  /** Switches that cannot work on this server (for example a Windows-only switch on Linux), with the reason. */
  unavailable?: Partial<Record<FeatureSwitchName, FeatureUnavailableReason>>;
}
