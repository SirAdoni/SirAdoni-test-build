import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Keep package-owned game exports while resolving the base contract from a fresh host. */
export async function createPackageSharedEntry(repoRoot, hostRoot) {
  const capturedEntry = join(repoRoot, "sources/package-shared.ts");
  if (!hostRoot) return { entry: capturedEntry, cleanup: async () => {} };
  const freshIndex = join(resolve(hostRoot), "packages/shared/dist/index.js");
  await readFile(freshIndex);
  const captured = await readFile(capturedEntry, "utf8");
  const base = "./engine/packages/shared/dist/index.js";
  if (!captured.includes(`export * from "${base}";`)) {
    throw new Error("Package shared bridge base changed; reconcile its fresh-host mapping before building");
  }
  const content = captured.replace(/export \* from "([^"]+)";/gu, (_, specifier) => {
    const target =
      specifier === base
        ? freshIndex
        : resolve(dirname(capturedEntry), specifier.replace("/dist/", "/src/").replace(/\.js$/u, ".ts"));
    return `export * from ${JSON.stringify(target.replaceAll("\\", "/"))};`;
  });
  const temporary = await mkdtemp(join(tmpdir(), "marinara-current-shared-"));
  const entry = join(temporary, "package-shared.ts");
  try {
    await writeFile(entry, content);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { entry, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}
