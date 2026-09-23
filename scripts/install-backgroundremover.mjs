#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = join(repoRoot, "packages", "server");
const dataDir = resolveDataDir();
const runtimeDir = join(dataDir, "background-remover");
const venvDir = join(runtimeDir, ".venv");
const reinstall = process.argv.includes("--reinstall");
const ifMissing = process.argv.includes("--if-missing");

function resolveDataDir() {
  const raw = process.env.DATA_DIR?.trim();
  if (!raw) return join(serverRoot, "data");
  return isAbsolute(raw) ? raw : resolve(serverRoot, raw);
}

function run(command, args, options = {}) {
  const label = [command, ...args].join(" ");
  console.log(`  [..] ${label}`);
  const result = spawnSync(command, args, {
    windowsHide: true,
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? "unknown"}): ${label}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function pythonCandidates() {
  const envPython = process.env.PYTHON?.trim();
  const candidates = [];
  if (envPython) candidates.push({ command: envPython, argsPrefix: [] });

  if (process.platform === "win32") {
    for (const version of ["3.11", "3.10", "3.9", "3.12"]) {
      candidates.push({ command: "py", argsPrefix: [`-${version}`] });
    }
    candidates.push({ command: "py", argsPrefix: ["-3"] });
  } else {
    candidates.push(
      { command: "python3.11", argsPrefix: [] },
      { command: "python3.10", argsPrefix: [] },
      { command: "python3.9", argsPrefix: [] },
      { command: "python3.12", argsPrefix: [] },
      { command: "python3", argsPrefix: [] },
      { command: "python", argsPrefix: [] },
    );
  }

  return candidates;
}

function parseVersion(value) {
  const [major, minor, patch] = value.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor, patch: Number.isFinite(patch) ? patch : 0 };
}

function versionSupported(version) {
  if (version.major !== 3) return false;
  if (version.minor < 9) return false;
  // backgroundremover pulls numba/llvmlite through pymatting; wheels are much
  // more reliable on Python 3.9-3.11 across macOS/Windows/Linux. Allow newer
  // only when the user explicitly points PYTHON at that interpreter.
  return version.minor <= 11 || !!process.env.PYTHON?.trim();
}

function findPython() {
  for (const candidate of pythonCandidates()) {
    const versionRaw = capture(candidate.command, [
      ...candidate.argsPrefix,
      "-c",
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
    ]);
    if (!versionRaw) continue;

    const version = parseVersion(versionRaw);
    if (!version || !versionSupported(version)) continue;

    return { ...candidate, version: versionRaw };
  }

  throw new Error(
    "Python 3.9-3.11 was not found. Install Python 3.11, or set PYTHON=/path/to/python before running this script.",
  );
}

function venvPythonPath() {
  return process.platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
}

function venvCliPath() {
  return process.platform === "win32"
    ? join(venvDir, "Scripts", "backgroundremover.exe")
    : join(venvDir, "bin", "backgroundremover");
}

function torchInstallArgs() {
  if (process.env.BACKGROUNDREMOVER_SKIP_TORCH === "1") return [];
  if (process.env.BACKGROUNDREMOVER_TORCH_INDEX_URL?.trim()) {
    return ["install", "torch", "torchvision", "--index-url", process.env.BACKGROUNDREMOVER_TORCH_INDEX_URL.trim()];
  }
  if (process.platform === "darwin") {
    return ["install", "torch", "torchvision"];
  }
  return ["install", "torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cpu"];
}

function main() {
  console.log("");
  console.log("  Installing optional Marinara background remover runtime");
  console.log(`  Runtime: ${runtimeDir}`);
  console.log("");

  if (reinstall && existsSync(venvDir)) {
    console.log("  [..] Removing existing background remover venv");
    rmSync(venvDir, { recursive: true, force: true });
  }

  mkdirSync(runtimeDir, { recursive: true });

  if (ifMissing && existsSync(venvPythonPath()) && existsSync(venvCliPath())) {
    console.log("  [OK] backgroundremover runtime is already installed.");
    return;
  }

  const python = findPython();
  console.log(`  [OK] Using Python ${python.version} (${python.command} ${python.argsPrefix.join(" ")})`);

  if (!existsSync(venvPythonPath())) {
    run(python.command, [...python.argsPrefix, "-m", "venv", venvDir]);
  } else {
    console.log("  [OK] Reusing existing venv");
  }

  const py = venvPythonPath();
  run(py, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"]);

  const torchArgs = torchInstallArgs();
  if (torchArgs.length > 0) {
    run(py, ["-m", "pip", ...torchArgs]);
  } else {
    console.log("  [OK] Skipping torch install because BACKGROUNDREMOVER_SKIP_TORCH=1");
  }

  run(py, ["-m", "pip", "install", "--only-binary=:all:", "numpy<2", "numba==0.60.0", "llvmlite==0.43.0"]);
  run(py, ["-m", "pip", "install", "--upgrade", "backgroundremover"]);
  run(py, ["-c", "import backgroundremover; print('backgroundremover import ok')"]);

  writeFileSync(
    join(runtimeDir, "README.txt"),
    [
      "Marinara Engine optional backgroundremover runtime",
      "",
      "This directory is managed by scripts/install-backgroundremover.mjs.",
      "It contains a local Python virtual environment and downloaded U2Net models.",
      "Delete this directory or run `pnpm backgroundremover:reinstall` to rebuild it.",
      "",
    ].join("\n"),
  );

  console.log("");
  console.log("  [OK] backgroundremover is installed.");
  console.log(`       CLI: ${venvCliPath()}`);
  console.log("       Marinara will use it automatically for sprite cleanup.");
  console.log("");
}

try {
  main();
} catch (error) {
  console.error("");
  console.error("  [ERROR] Failed to install backgroundremover");
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  console.error("");
  process.exit(1);
}
