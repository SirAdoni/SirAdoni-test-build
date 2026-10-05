import { z } from "zod";

/**
 * App-wide feature switches (Settings > Advanced > Features), stored as one JSON
 * object in the `features` app setting. This file is the single registry: every
 * switch and its default live here.
 *
 * Every switch defaults OFF, so an install that never opens the Features section
 * behaves exactly as before. An absent key means "use the default"; the client
 * only stores values that differ from it.
 */
export const FEATURE_SETTINGS_KEY = "features";

export const FEATURE_SWITCH_NAMES = [
  "campaignRoster",
  "stableLorebookGroupPicks",
  "providerRetry",
  "providerDiagnostics",
  "usageAndActivationStats",
  "messageTrash",
  "backgroundCallCap",
  "gameContinuity",
  "campaignMemory",
  "campaignIndex",
  "gameMemoryControls",
  "campaignMemoryRecall",
  "campaignWiki",
  "familyTree",
  "factionWeb",
  "gameCalendar",
  "worldHistory",
  "sceneTimeline",
  "privateNotebook",
  "libraryNavigation",
  "gamePrepBoard",
  "randomTables",
  "diceLog",
  "recapFactualReview",
  "gameKeeperConsolidation",
  "savedCharacterProfiles",
  "draftRewrites",
  "localRewriteConnection",
  "gameContactBook",
  "campaignPortraits",
  "galleryBrowsing",
  "floatingMediaPlacement",
  "speechDiagnostics",
  "promptInspector",
  "gamePromptEditing",
  "gmNarrationReasoning",
  "chatgptCacheAffinity",
  "backupModes",
  "inventoryBrowsing",
  "gameGuide",
  "extendedHudWidgets",
  "playerStatus",
  "mobileHudArrangement",
  "hudListVisibility",
] as const;
export type FeatureSwitchName = (typeof FEATURE_SWITCH_NAMES)[number];

/** Default of each switch when nothing is saved and no environment variable pins it. */
export const FEATURE_SWITCH_DEFAULTS: Readonly<Record<FeatureSwitchName, boolean>> = {
  campaignRoster: false,
  stableLorebookGroupPicks: false,
  providerRetry: false,
  providerDiagnostics: false,
  usageAndActivationStats: false,
  messageTrash: false,
  backgroundCallCap: false,
  gameContinuity: false,
  campaignMemory: false,
  campaignIndex: false,
  gameMemoryControls: false,
  campaignMemoryRecall: false,
  campaignWiki: false,
  familyTree: false,
  factionWeb: false,
  gameCalendar: false,
  worldHistory: false,
  sceneTimeline: false,
  privateNotebook: false,
  libraryNavigation: false,
  gamePrepBoard: false,
  randomTables: false,
  diceLog: false,
  recapFactualReview: false,
  gameKeeperConsolidation: false,
  savedCharacterProfiles: false,
  draftRewrites: false,
  localRewriteConnection: false,
  gameContactBook: false,
  campaignPortraits: false,
  galleryBrowsing: false,
  floatingMediaPlacement: false,
  speechDiagnostics: false,
  promptInspector: false,
  gamePromptEditing: false,
  gmNarrationReasoning: false,
  chatgptCacheAffinity: false,
  backupModes: false,
  inventoryBrowsing: false,
  gameGuide: false,
  extendedHudWidgets: false,
  playerStatus: false,
  mobileHudArrangement: false,
  hudListVisibility: false,
};

export const FEATURE_NUMBER_NAMES = ["backgroundCallsPerHour"] as const;
export type FeatureNumberName = (typeof FEATURE_NUMBER_NAMES)[number];
export const FEATURE_NUMBER_DEFAULTS: Readonly<Record<FeatureNumberName, number>> = {
  backgroundCallsPerHour: 600,
};

export type FeatureSettings = Partial<Record<FeatureSwitchName, boolean> & Record<FeatureNumberName, number>>;

export const featureSettingsSchema = z
  .object({
    campaignRoster: z.boolean().optional(),
    stableLorebookGroupPicks: z.boolean().optional(),
    providerRetry: z.boolean().optional(),
    providerDiagnostics: z.boolean().optional(),
    usageAndActivationStats: z.boolean().optional(),
    messageTrash: z.boolean().optional(),
    backgroundCallCap: z.boolean().optional(),
    gameContinuity: z.boolean().optional(),
    campaignMemory: z.boolean().optional(),
    campaignIndex: z.boolean().optional(),
    gameMemoryControls: z.boolean().optional(),
    campaignMemoryRecall: z.boolean().optional(),
    backgroundCallsPerHour: z.number().int().min(1).max(100_000).optional(),
    campaignWiki: z.boolean().optional(),
    familyTree: z.boolean().optional(),
    factionWeb: z.boolean().optional(),
    gameCalendar: z.boolean().optional(),
    worldHistory: z.boolean().optional(),
    sceneTimeline: z.boolean().optional(),
    privateNotebook: z.boolean().optional(),
    libraryNavigation: z.boolean().optional(),
    gamePrepBoard: z.boolean().optional(),
    randomTables: z.boolean().optional(),
    diceLog: z.boolean().optional(),
    recapFactualReview: z.boolean().optional(),
    gameKeeperConsolidation: z.boolean().optional(),
    savedCharacterProfiles: z.boolean().optional(),
    draftRewrites: z.boolean().optional(),
    localRewriteConnection: z.boolean().optional(),
    gameContactBook: z.boolean().optional(),
    campaignPortraits: z.boolean().optional(),
    galleryBrowsing: z.boolean().optional(),
    floatingMediaPlacement: z.boolean().optional(),
    speechDiagnostics: z.boolean().optional(),
    promptInspector: z.boolean().optional(),
    gamePromptEditing: z.boolean().optional(),
    gmNarrationReasoning: z.boolean().optional(),
    chatgptCacheAffinity: z.boolean().optional(),
    backupModes: z.boolean().optional(),
    inventoryBrowsing: z.boolean().optional(),
    gameGuide: z.boolean().optional(),
    extendedHudWidgets: z.boolean().optional(),
    playerStatus: z.boolean().optional(),
    mobileHudArrangement: z.boolean().optional(),
    hudListVisibility: z.boolean().optional(),
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
    if (typeof raw[name] === "number" && Number.isInteger(raw[name]) && raw[name] >= 1 && raw[name] <= 100_000) {
      settings[name] = raw[name];
    }
  }
  return settings;
}

export function resolveFeatureEnabled(settings: FeatureSettings | null | undefined, name: FeatureSwitchName): boolean {
  return settings?.[name] ?? FEATURE_SWITCH_DEFAULTS[name];
}

export function resolveFeatureNumber(settings: FeatureSettings | null | undefined, name: FeatureNumberName): number {
  return settings?.[name] ?? FEATURE_NUMBER_DEFAULTS[name];
}

export interface FeatureSettingsResponse {
  /** What is saved; absent keys use their defaults. */
  settings: FeatureSettings;
  /** Switches pinned by a server environment variable, with the variable name. Env wins over the saved value. */
  envOverrides: Partial<Record<FeatureSwitchName, string>>;
  /** For switches pinned by an environment variable: the value actually in effect. */
  effective?: Partial<Record<FeatureSwitchName, boolean>>;
}
