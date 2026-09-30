import { realpathSync, statSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Offline maintenance installer. Run only while the Engine is stopped. Its
 * explicit DATA_DIR must be an existing absolute directory; no runtime default
 * is used. Example:
 * node packages/server/node_modules/tsx/dist/cli.mjs scripts/install-capability-package-local.ts --entry <entry.json> --archive <package.zip> --id <reviewed-id> --version <reviewed-version> --sha256 <reviewed-hash> --data-dir <absolute-data-directory>
 */
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

function parseArguments(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) {
      throw new Error(
        "Usage: node packages/server/node_modules/tsx/dist/cli.mjs scripts/install-capability-package-local.ts --entry <json> --archive <zip> --id <id> --version <version> --sha256 <reviewed hash> --data-dir <absolute existing directory> (Engine must be stopped)",
      );
    }
    values.set(key, value);
  }
  const required = ["--entry", "--archive", "--id", "--version", "--sha256", "--data-dir"];
  if (values.size !== required.length || required.some((key) => !values.has(key))) {
    throw new Error(
      "Usage: node packages/server/node_modules/tsx/dist/cli.mjs scripts/install-capability-package-local.ts --entry <json> --archive <zip> --id <id> --version <version> --sha256 <reviewed hash> --data-dir <absolute existing directory> (Engine must be stopped)",
    );
  }
  return Object.fromEntries(required.map((key) => [key.slice(2), values.get(key)!])) as Record<
    "entry" | "archive" | "id" | "version" | "sha256" | "data-dir",
    string
  >;
}

function resolveExplicitDataDirectory(dataDirectory: string) {
  if (!isAbsolute(dataDirectory)) throw new Error("--data-dir must be an absolute path");
  const actual = realpathSync(resolve(dataDirectory));
  if (!statSync(actual).isDirectory()) throw new Error("--data-dir must be an existing directory");
  return actual;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const dataDirectory = resolveExplicitDataDirectory(args["data-dir"]);
  const entryPath = resolve(args.entry);
  const archivePath = resolve(args.archive);
  const entry = JSON.parse(readFileSync(entryPath, "utf8")) as {
    manifest?: { id?: unknown; version?: unknown };
    artifact?: { sha256?: unknown; bytes?: unknown };
  };
  if (
    entry.manifest?.id !== args.id ||
    entry.manifest?.version !== args.version ||
    entry.artifact?.sha256 !== args.sha256
  ) {
    throw new Error("The supplied catalog entry does not match the reviewed id, version, and SHA-256");
  }
  const archiveStat = statSync(archivePath);
  if (
    !Number.isSafeInteger(entry.artifact?.bytes) ||
    (entry.artifact.bytes as number) <= 0 ||
    (entry.artifact.bytes as number) > MAX_ARTIFACT_BYTES ||
    archiveStat.size > MAX_ARTIFACT_BYTES
  ) {
    throw new Error("Catalog or archive size exceeds the package limit");
  }

  process.env.DATA_DIR = dataDirectory;
  const archive = readFileSync(archivePath);
  const { installLocalCapabilityPackageArchive } = await import(
    "../packages/server/src/services/capability-packages/package-manager.service.js"
  );
  const installed = await installLocalCapabilityPackageArchive(entry, archive);
  process.stdout.write(`Installed ${installed.id}@${installed.version} (${installed.status}).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
