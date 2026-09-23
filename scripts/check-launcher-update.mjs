import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LATEST_RELEASE_URL = "https://github.com/Pasta-Devs/Marinara-Engine/releases/latest";

export function normalizeStableVersion(value) {
  const match = String(value).trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

export function isNewerStableVersion(currentVersion, latestVersion) {
  const current = normalizeStableVersion(currentVersion);
  const latest = normalizeStableVersion(latestVersion);
  if (!current || !latest) return false;

  for (let index = 0; index < latest.length; index += 1) {
    if (latest[index] > current[index]) return true;
    if (latest[index] < current[index]) return false;
  }

  return false;
}

export function getVersionFromReleaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://github.com") return null;
    const match = url.pathname.match(
      /^\/Pasta-Devs\/Marinara-Engine\/releases\/tag\/(v?\d+\.\d+\.\d+)\/?$/,
    );
    return match?.[1]?.replace(/^v/, "") ?? null;
  } catch {
    return null;
  }
}

export function formatUpdateReminder(currentVersion, latestVersion, releaseUrl) {
  return [
    `  [UPDATE] Marinara Engine v${latestVersion} is available (installed: v${currentVersion}).`,
    "           Automatic updates are disabled. Download the new version from:",
    `           ${releaseUrl}`,
  ].join("\n");
}

export async function checkForLauncherUpdate({
  currentVersion,
  fetchImpl = globalThis.fetch,
  latestReleaseUrl = LATEST_RELEASE_URL,
  timeoutMs = 8_000,
}) {
  if (typeof fetchImpl !== "function") return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(latestReleaseUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": `MarinaraEngine/${currentVersion}` },
    });
    if (!response.ok) return null;

    const latestVersion = getVersionFromReleaseUrl(response.url);
    if (!latestVersion || !isNewerStableVersion(currentVersion, latestVersion)) return null;

    return formatUpdateReminder(currentVersion, latestVersion, response.url);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  try {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const reminder = await checkForLauncherUpdate({ currentVersion: packageJson.version });
    if (reminder) process.stdout.write(`${reminder}\n`);
  } catch {
    // Update reminders are best-effort and must never prevent Marinara from starting.
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
