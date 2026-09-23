// ──────────────────────────────────────────────
// App-wide feature switches (Settings > Features)
// ──────────────────────────────────────────────
// One cached copy of the `features` app setting. Reads are synchronous and allocation free so hot
// paths (every provider call, every lorebook scan) can ask without touching storage. The cache is
// loaded when the app-settings routes register and replaced whenever app-settings storage writes
// or removes the key, so a save takes effect on the next call. Absent key or absent switch = ON.
import {
  FEATURE_SETTINGS_KEY,
  normalizeFeatureSettings,
  resolveFeatureEnabled,
  resolveFeatureNumber,
  type FeatureNumberName,
  type FeatureSettings,
  type FeatureSettingsResponse,
  type FeatureSwitchName,
} from "@marinara-engine/shared";
import { readEnvFlagOverride } from "../../config/runtime-config.js";

/**
 * Switches an operator can pin from the environment (the names upstream uses). When the variable
 * is set it wins, both on and off; unset falls through to the saved setting.
 */
export const FEATURE_ENV_FLAG_OVERRIDES: Partial<Record<FeatureSwitchName, string>> = {
  stableLorebookGroupPicks: "LOREBOOK_STABLE_GROUP_WINNERS",
  providerRetry: "PROVIDER_RETRY_TRANSIENT_ERRORS",
};

/** Owned by background-call-budget.ts, which parses it; listed here so the UI can show the lock. */
export const BACKGROUND_CALLS_PER_HOUR_ENV = "MARINARA_BACKGROUND_CALLS_PER_HOUR";

let cached: FeatureSettings = {};

/** Replace the cache from a stored JSON string (null = key removed). Bad JSON falls back to defaults. */
export function applyFeatureSettingsValue(value: string | null): FeatureSettings {
  let parsed: unknown = null;
  if (value) {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  cached = normalizeFeatureSettings(parsed);
  return cached;
}

/** Load the cache from storage. Called once at startup; writes keep it current afterwards. */
export async function loadFeatureSettings(storage: { get(key: string): Promise<string | null> }) {
  return applyFeatureSettingsValue(await storage.get(FEATURE_SETTINGS_KEY));
}

/**
 * Reload the cache after a write that bypassed app-settings storage (Professor Mari's generic
 * database commands and their restore). Returns true when the `features` row was touched.
 */
export async function reloadFeatureSettingsIfTouched(
  changes: ReadonlyArray<{ table: string; id: string }>,
  storage: { get(key: string): Promise<string | null> },
): Promise<boolean> {
  if (!changes.some((change) => change.table === "app_settings" && change.id === FEATURE_SETTINGS_KEY)) return false;
  await loadFeatureSettings(storage);
  return true;
}

export function getFeatureSettings(): FeatureSettings {
  return cached;
}

export function isFeatureEnabled(name: FeatureSwitchName): boolean {
  const envVar = FEATURE_ENV_FLAG_OVERRIDES[name];
  if (envVar) {
    const override = readEnvFlagOverride(envVar);
    if (override !== null) return override;
  }
  return resolveFeatureEnabled(cached, name);
}

export function getFeatureNumber(name: FeatureNumberName): number {
  return resolveFeatureNumber(cached, name);
}

export function featureEnvOverrides(): FeatureSettingsResponse["envOverrides"] {
  const overrides: FeatureSettingsResponse["envOverrides"] = {};
  for (const [name, envVar] of Object.entries(FEATURE_ENV_FLAG_OVERRIDES) as Array<[FeatureSwitchName, string]>) {
    if (readEnvFlagOverride(envVar) !== null) overrides[name] = envVar;
  }
  if (process.env[BACKGROUND_CALLS_PER_HOUR_ENV]?.trim()) {
    overrides.backgroundCallCap = BACKGROUND_CALLS_PER_HOUR_ENV;
    overrides.backgroundCallsPerHour = BACKGROUND_CALLS_PER_HOUR_ENV;
  }
  return overrides;
}

/** The in-effect value of each switch an on/off environment variable pins, so the UI shows it. */
export function featureEnvEffective(): NonNullable<FeatureSettingsResponse["effective"]> {
  const effective: NonNullable<FeatureSettingsResponse["effective"]> = {};
  for (const [name, envVar] of Object.entries(FEATURE_ENV_FLAG_OVERRIDES) as Array<[FeatureSwitchName, string]>) {
    const override = readEnvFlagOverride(envVar);
    if (override !== null) effective[name] = override;
  }
  return effective;
}

/** Tests only. */
export function resetFeatureSettingsForTests(settings: FeatureSettings = {}): void {
  cached = normalizeFeatureSettings(settings);
}
