import type { PersonalExtension, PersonalExtensionPolicy, PersonalExtensionSource } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { isExternalExtensionsEnvEnabled } from "../../config/runtime-config.js";
import { createAppSettingsStorage } from "../storage/app-settings.storage.js";
import { getPersonalExtensionSandboxStatus } from "./personal-extension-sandbox.js";

export const EXTERNAL_EXTENSIONS_SETTINGS_KEY = "external-extensions-enabled";

export function isExternalPersonalExtensionSource(source: PersonalExtensionSource): boolean {
  return source !== "professor_mari";
}

export async function getPersonalExtensionPolicy(db: DB): Promise<PersonalExtensionPolicy> {
  const externalExtensionsEnvEnabled = isExternalExtensionsEnvEnabled();
  const userEnabled = (await createAppSettingsStorage(db).get(EXTERNAL_EXTENSIONS_SETTINGS_KEY)) === "true";
  const sandbox = getPersonalExtensionSandboxStatus();
  return {
    externalExtensionsEnvEnabled,
    externalExtensionsEnabled: externalExtensionsEnvEnabled && userEnabled,
    serverSandboxAvailable: sandbox.available,
    serverSandboxBackend: sandbox.available ? sandbox.backend : null,
    serverSandboxReason: sandbox.available ? null : sandbox.reason,
  };
}

export function canExecutePersonalExtension(
  extension: Pick<PersonalExtension, "source">,
  policy: PersonalExtensionPolicy,
): boolean {
  return !isExternalPersonalExtensionSource(extension.source) || policy.externalExtensionsEnabled;
}

export async function setExternalExtensionsEnabled(db: DB, enabled: boolean): Promise<PersonalExtensionPolicy> {
  if (enabled && !isExternalExtensionsEnvEnabled()) {
    throw new Error("External Extensions are locked. Set ENABLE_EXTERNAL_EXTENSIONS=true in .env first.");
  }
  await createAppSettingsStorage(db).set(EXTERNAL_EXTENSIONS_SETTINGS_KEY, enabled ? "true" : "false");
  return getPersonalExtensionPolicy(db);
}
