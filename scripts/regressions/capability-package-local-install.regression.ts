import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as dns } from "node:dns";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-capability-local-install-"));
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");

const packagesRoot = join(dataDir, "capability-packages");
const settingsPath = join(dataDir, "settings.json");
const userDataPath = join(dataDir, "user-data.json");
const settingsBefore = Buffer.from('{"theme":"sillytavern","preserve":true}\n');
const userDataBefore = Buffer.from('{"profile":"unchanged"}\n');
writeFileSync(settingsPath, settingsBefore);
writeFileSync(userDataPath, userDataBefore);

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function archiveFor(id: string, version: string, options: { engineMin?: string; extraPath?: string } = {}) {
  const client = `// ${id} ${version}\nexport {};\n`;
  const manifest = {
    schemaVersion: 1,
    id,
    name: id,
    version,
    description: "Offline package install regression fixture.",
    engine: { min: options.engineMin ?? "2.3.0", maxExclusive: "3.0.0" },
    kind: ["agent"],
    entrypoints: { client: "client.js" },
    files: [{ path: "client.js", sha256: sha256(client), bytes: Buffer.byteLength(client) }],
    permissions: [],
    restartRequired: false,
  };
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
  zip.addFile("client.js", Buffer.from(client));
  if (options.extraPath) zip.addFile(options.extraPath, Buffer.from("undeclared"));
  return { manifest, bytes: zip.toBuffer() };
}

function catalogEntry(
  manifest: ReturnType<typeof archiveFor>["manifest"],
  bytes: Buffer,
  overrides: { size?: number; hash?: string; url?: string } = {},
) {
  return {
    manifest,
    category: "misc" as const,
    artifact: {
      url: overrides.url ?? "https://packages.example.test/package.zip",
      sha256: overrides.hash ?? sha256(bytes),
      bytes: overrides.size ?? bytes.byteLength,
    },
  };
}

function expectUnchangedDataAndSettings() {
  assert.deepEqual(readFileSync(settingsPath), settingsBefore, "Installation must preserve user settings bytes");
  assert.deepEqual(readFileSync(userDataPath), userDataBefore, "Installation must preserve unrelated user data bytes");
}

try {
  const { installLocalCapabilityPackageArchive, capabilityPackageManager } = await import(
    "../../packages/server/src/services/capability-packages/package-manager.service.js"
  );

  const v1 = archiveFor("offline-probe", "1.0.0");
  const installedV1 = await installLocalCapabilityPackageArchive(catalogEntry(v1.manifest, v1.bytes), v1.bytes);
  assert.equal(installedV1.version, "1.0.0");
  assert.equal(installedV1.previousVersion, undefined);

  const v2 = archiveFor("offline-probe", "1.1.0");
  const installedV2 = await installLocalCapabilityPackageArchive(catalogEntry(v2.manifest, v2.bytes), v2.bytes);
  assert.equal(installedV2.version, "1.1.0");
  assert.equal(installedV2.previousVersion, "1.0.0", "Upgrade must retain its previous-version rollback record");
  assert.equal(readFileSync(join(packagesRoot, "versions", "offline-probe", "1.0.0", "client.js"), "utf8"),
    "// offline-probe 1.0.0\nexport {};\n");
  expectUnchangedDataAndSettings();

  const sizeFixture = archiveFor("offline-size", "1.0.0");
  await assert.rejects(
    installLocalCapabilityPackageArchive(catalogEntry(sizeFixture.manifest, sizeFixture.bytes, { size: sizeFixture.bytes.byteLength + 1 }), sizeFixture.bytes),
    /size does not match the catalog/,
  );
  const hashFixture = archiveFor("offline-hash", "1.0.0");
  await assert.rejects(
    installLocalCapabilityPackageArchive(catalogEntry(hashFixture.manifest, hashFixture.bytes, { hash: "0".repeat(64) }), hashFixture.bytes),
    /checksum does not match the catalog/,
  );
  const actualManifest = archiveFor("offline-manifest", "1.0.0");
  const declaredManifest = archiveFor("offline-manifest", "1.0.1");
  await assert.rejects(
    installLocalCapabilityPackageArchive(catalogEntry(declaredManifest.manifest, actualManifest.bytes), actualManifest.bytes),
    /manifest does not match the catalog/,
  );
  const pathFixture = archiveFor("offline-path", "1.0.0", { extraPath: "../escape.txt" });
  await assert.rejects(
    installLocalCapabilityPackageArchive(catalogEntry(pathFixture.manifest, pathFixture.bytes), pathFixture.bytes),
    /path|entry|traversal|unsafe|undeclared or missing files/i,
  );
  const incompatible = archiveFor("offline-compat", "1.0.0", { engineMin: "99.0.0" });
  await assert.rejects(
    installLocalCapabilityPackageArchive(catalogEntry(incompatible.manifest, incompatible.bytes), incompatible.bytes),
    /requires Marinara Engine/,
  );
  const downgrade = archiveFor("offline-probe", "1.0.0");
  await assert.rejects(
    installLocalCapabilityPackageArchive(catalogEntry(downgrade.manifest, downgrade.bytes), downgrade.bytes),
    /downgrade/i,
  );
  expectUnchangedDataAndSettings();

  const cliFixture = archiveFor("offline-cli-probe", "1.0.0");
  const cliEntry = catalogEntry(cliFixture.manifest, cliFixture.bytes);
  const cliEntryPath = join(dataDir, "offline-cli-probe.entry.json");
  const cliArchivePath = join(dataDir, "offline-cli-probe.zip");
  const cliDataDir = mkdtempSync(join(dataDir, "cli-data-"));
  const cliSettingsPath = join(cliDataDir, "settings.json");
  const cliUserDataPath = join(cliDataDir, "user-data.json");
  const cliSettings = Buffer.from('{"theme":"light","retain":true}\n');
  const cliUserData = Buffer.from('{"history":"retain"}\n');
  writeFileSync(cliEntryPath, JSON.stringify(cliEntry));
  writeFileSync(cliArchivePath, cliFixture.bytes);
  writeFileSync(cliSettingsPath, cliSettings);
  writeFileSync(cliUserDataPath, cliUserData);
  const tsxCliPath = join(repositoryRoot, "packages/server/node_modules/tsx/dist/cli.mjs");
  const localInstallerPath = join(repositoryRoot, "scripts/install-capability-package-local.ts");
  const childEnvironment = { ...process.env };
  delete childEnvironment.DATA_DIR;
  delete childEnvironment.FILE_STORAGE_DIR;
  const cliArgs = [
    tsxCliPath,
    localInstallerPath,
    "--entry",
    cliEntryPath,
    "--archive",
    cliArchivePath,
    "--id",
    "offline-cli-probe",
    "--version",
    "1.0.0",
    "--sha256",
    cliEntry.artifact.sha256,
    "--data-dir",
    cliDataDir,
  ];
  const cliInstall = spawnSync(process.execPath, cliArgs, {
    windowsHide: true,
    cwd: repositoryRoot,
    env: childEnvironment,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(cliInstall.status, 0, cliInstall.stderr);
  assert.match(cliInstall.stdout, /Installed offline-cli-probe@1\.0\.0/);
  assert.equal(
    readFileSync(join(cliDataDir, "capability-packages/versions/offline-cli-probe/1.0.0/client.js"), "utf8"),
    "// offline-cli-probe 1.0.0\nexport {};\n",
  );
  const cliRegistryPath = join(cliDataDir, "capability-packages/installed.json");
  const cliRegistryBeforeMismatch = readFileSync(cliRegistryPath);
  const cliMismatch = spawnSync(
    process.execPath,
    [...cliArgs.slice(0, -3), "0".repeat(64), "--data-dir", cliDataDir],
    { windowsHide: true, cwd: repositoryRoot, env: childEnvironment, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(cliMismatch.status, 1);
  assert.match(cliMismatch.stderr, /does not match the reviewed id, version, and SHA-256/);
  assert.deepEqual(readFileSync(cliRegistryPath), cliRegistryBeforeMismatch, "Reviewed-hash refusal must leave registry bytes unchanged");
  assert.deepEqual(readFileSync(cliSettingsPath), cliSettings, "CLI install must preserve settings bytes");
  assert.deepEqual(readFileSync(cliUserDataPath), cliUserData, "CLI install must preserve unrelated data bytes");
  const networkFixture = archiveFor("safe-fetch-network", "1.0.0");
  const rawNetworkEntry = catalogEntry(networkFixture.manifest, networkFixture.bytes, { url: "https://8.8.8.8/package.zip" });
  const { capabilityCatalogPackageSchema } = await import(
    "../../packages/shared/src/schemas/capability-package.schema.js"
  );
  const networkEntry = capabilityCatalogPackageSchema.parse(rawNetworkEntry);
  const originalFetch = globalThis.fetch;
  const originalDnsLookup = dns.lookup;
  const originalCatalog = capabilityPackageManager.catalog;
  let fetchCalls = 0;
  try {
    dns.lookup = (async () => [{ address: "8.8.8.8", family: 4 }]) as typeof dns.lookup;
    globalThis.fetch = (async (input, init) => {
      fetchCalls += 1;
      assert.equal(String(input), networkEntry.artifact.url);
      assert.equal(init?.redirect, "manual", "Network install must retain safeFetch redirect handling");
      assert.ok((init as RequestInit & { dispatcher?: unknown }).dispatcher, "safeFetch must keep its validated dispatcher");
      return new Response(networkFixture.bytes);
    }) as typeof fetch;
    capabilityPackageManager.catalog = async () => ({ packages: [networkEntry] }) as Awaited<ReturnType<typeof originalCatalog>>;
    await capabilityPackageManager.install("safe-fetch-network", "1.0.0", networkEntry.artifact.sha256);
    assert.equal(fetchCalls, 1, "Network install must still acquire bytes through safeFetch");

    const blockedEntry = capabilityCatalogPackageSchema.parse(
      catalogEntry(networkFixture.manifest, networkFixture.bytes, { url: "http://8.8.8.8/package.zip" }),
    );
    capabilityPackageManager.catalog = async () => ({ packages: [blockedEntry] }) as Awaited<ReturnType<typeof originalCatalog>>;
    await assert.rejects(
      capabilityPackageManager.install("safe-fetch-network", "1.0.0", blockedEntry.artifact.sha256),
      /protocol|https/i,
    );
    assert.equal(fetchCalls, 1, "Disallowed network protocols must be rejected before fetch");
  } finally {
    capabilityPackageManager.catalog = originalCatalog;
    globalThis.fetch = originalFetch;
    dns.lookup = originalDnsLookup;
  }
  expectUnchangedDataAndSettings();
  process.stdout.write("Capability package local install regression passed.\n");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
