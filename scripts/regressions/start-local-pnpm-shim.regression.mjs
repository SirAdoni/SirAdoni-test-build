import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageManifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const descriptor = packageManifest.packageManager.replace(/^pnpm@/u, "");
const version = descriptor.split("+", 1)[0];
const shim = readFileSync(join(repositoryRoot, "scripts/pnpm.cmd"), "utf8");

for (const launcherName of ["start-local.bat", "start.bat"]) {
  const launcher = readFileSync(join(repositoryRoot, launcherName), "utf8");
  assert.match(launcher, /set "PATH=%~dp0scripts;!PATH!"/u, `${launcherName} must expose the nested pnpm shim`);
  assert.match(launcher, /PNPM_RUNNER!.*corepack/u, `${launcherName} must shim Corepack-backed pnpm`);
  assert.match(launcher, /PNPM_RUNNER!.*npx/u, `${launcherName} must shim npx-backed pnpm`);
}
assert.doesNotMatch(shim, /call\s+pnpm(?:\.cmd)?\b/iu, "the nested shim must not recurse through itself");

if (process.platform !== "win32") {
  console.log("Skipping Windows cmd.exe pnpm shim runtime probe on non-Windows.");
  process.exit(0);
}

const tempRoot = resolve(tmpdir());
const fixture = mkdtempSync(join(tempRoot, "marinara-start-local-pnpm-shim-"));
const resolvedFixture = resolve(fixture);
assert.ok(resolvedFixture.startsWith(`${tempRoot}${sep}`), "the fixture must remain under the OS temp directory");
try {
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "nested-pnpm-probe",
      private: true,
      scripts: { probe: "pnpm --version", fail: 'pnpm --version && node -e "process.exit(7)"' },
    }),
  );
  const nodeDir = dirname(process.execPath);
  const cleanPath = [nodeDir, "C:\\Windows\\System32", "C:\\Windows", join(repositoryRoot, "scripts")].join(";");
  const runNestedScript = (script) =>
    spawnSync("cmd.exe", ["/d", "/c", "call", join(repositoryRoot, "scripts/pnpm.cmd"), "run", script], {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: cleanPath,
        PNPM_RUNNER: "corepack",
        PNPM_DESCRIPTOR: descriptor,
        PNPM_VERSION: version,
      },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
  const result = runNestedScript("probe");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    result.stdout.trim().split(/\r?\n/u).at(-1),
    version,
    "a nested bare pnpm script must resolve the pinned Corepack runner",
  );
  const failed = runNestedScript("fail");
  assert.equal(failed.status, 7, `${failed.stdout}\n${failed.stderr}`);
} finally {
  rmSync(resolvedFixture, { recursive: true, force: true });
}

console.log("start-local pnpm shim regression passed.");
