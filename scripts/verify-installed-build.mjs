#!/usr/bin/env node
// verify-installed-build.mjs: SHA-256 manifest of the installed build output.
//
// Hashes every file under packages/server/dist, packages/client/dist and
// packages/shared/dist (paths relative to the repository root, forward slashes),
// records size + sha256 per file, and a top-level combined hash (sha256 over the
// sorted "path\0size\0sha256\n" lines). Plain Node ESM, no dependencies, never
// runs a build or touches packages/server/data.
//
// Usage:
//   node scripts/verify-installed-build.mjs --record <manifest.json>
//       Write a manifest of the current dist directories.
//   node scripts/verify-installed-build.mjs --verify <manifest.json>
//       Recompute and print added/removed/changed files versus the manifest.
//       Exit 0 when identical, 1 on drift, 2 on usage or IO error.
//   node scripts/verify-installed-build.mjs --compare <a.json> <b.json>
//       Diff two manifests (b relative to a). Accepts this script's format or a
//       plain array of { path, bytes|size, sha256 } (the backup application
//       manifests), so a staged-build manifest can be checked against the
//       rollback point. Paths are compared case-sensitively after normalising
//       separators; sha256 comparison is case-insensitive.
//   Optional: --root <dir> overrides the repository root (default: the parent of
//   the scripts/ directory); --dirs <a,b,c> overrides the scanned directories.
//
// Typical release check:
//   node scripts/verify-installed-build.mjs --record .tmp/v3-execution/installed-manifest.json
//   ... install / promote the staged build ...
//   node scripts/verify-installed-build.mjs --verify .tmp/v3-execution/installed-manifest.json

import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIRS = ["packages/server/dist", "packages/client/dist", "packages/shared/dist"];
const MANIFEST_VERSION = 1;

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: node scripts/verify-installed-build.mjs (--record <out.json> | --verify <manifest.json> | --compare <a.json> <b.json>) [--root <dir>] [--dirs <a,b,c>]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { mode: null, files: [], root: null, dirs: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) usage(`Missing value for ${argument}`);
      index += 1;
      return value;
    };
    if (argument === "--record" || argument === "--verify") {
      if (options.mode) usage("Only one of --record, --verify, --compare may be given");
      options.mode = argument.slice(2);
      options.files.push(takeValue());
    } else if (argument === "--compare") {
      if (options.mode) usage("Only one of --record, --verify, --compare may be given");
      options.mode = "compare";
      options.files.push(takeValue());
      options.files.push(takeValue());
    } else if (argument === "--root") {
      options.root = takeValue();
    } else if (argument === "--dirs") {
      options.dirs = takeValue().split(",").map((item) => item.trim()).filter(Boolean);
    } else {
      usage(`Unknown argument: ${argument}`);
    }
  }
  if (!options.mode) usage();
  return options;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function walk(directory, out) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(entryPath, out);
    else if (entry.isFile()) out.push(entryPath);
  }
}

async function scan(root, dirs) {
  const files = [];
  const missingDirs = [];
  for (const dir of dirs) {
    const absolute = path.resolve(root, dir);
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isDirectory()) throw new Error("not a directory");
    } catch {
      missingDirs.push(dir);
      continue;
    }
    await walk(absolute, files);
  }
  files.sort((left, right) => toPosix(path.relative(root, left)).localeCompare(toPosix(path.relative(root, right))));
  const entries = [];
  for (const file of files) {
    const stat = await fs.stat(file);
    entries.push({ path: toPosix(path.relative(root, file)), size: stat.size, sha256: await sha256File(file) });
  }
  return { entries, missingDirs };
}

function combinedHash(entries) {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(`${entry.path}\0${entry.size}\0${entry.sha256.toLowerCase()}\n`);
  }
  return hash.digest("hex");
}

/** Normalise either this script's manifest or a plain file array into a path -> entry map. */
function entriesOf(manifest, label) {
  const list = Array.isArray(manifest) ? manifest : Array.isArray(manifest?.files) ? manifest.files : null;
  if (!list) throw new Error(`${label}: unrecognised manifest shape (expected { files: [...] } or an array)`);
  const map = new Map();
  for (const item of list) {
    if (!item || typeof item.path !== "string" || typeof item.sha256 !== "string") throw new Error(`${label}: malformed entry ${JSON.stringify(item)}`);
    const size = typeof item.size === "number" ? item.size : typeof item.bytes === "number" ? item.bytes : null;
    map.set(item.path.replace(/\\/gu, "/"), { path: item.path.replace(/\\/gu, "/"), size, sha256: item.sha256.toLowerCase() });
  }
  return map;
}

function diff(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [file, entry] of after) {
    const previous = before.get(file);
    if (!previous) added.push(entry);
    else if (previous.sha256 !== entry.sha256 || (previous.size !== null && entry.size !== null && previous.size !== entry.size)) changed.push({ path: file, before: previous, after: entry });
  }
  for (const [file, entry] of before) if (!after.has(file)) removed.push(entry);
  return { added, removed, changed, unchanged: after.size - added.length - changed.length };
}

function printDiff(result, beforeLabel, afterLabel) {
  const lines = [];
  lines.push(`Comparing ${beforeLabel} -> ${afterLabel}`);
  lines.push(`  unchanged: ${result.unchanged}  added: ${result.added.length}  removed: ${result.removed.length}  changed: ${result.changed.length}`);
  for (const entry of result.added) lines.push(`  + ${entry.path} (${entry.size ?? "?"} bytes)`);
  for (const entry of result.removed) lines.push(`  - ${entry.path} (${entry.size ?? "?"} bytes)`);
  for (const entry of result.changed) lines.push(`  ~ ${entry.path} (${entry.before.size ?? "?"} -> ${entry.after.size ?? "?"} bytes, ${entry.before.sha256.slice(0, 12)} -> ${entry.after.sha256.slice(0, 12)})`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return result.added.length + result.removed.length + result.changed.length === 0;
}

async function readManifest(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const dirs = options.dirs ?? DEFAULT_DIRS;

  if (options.mode === "record") {
    const { entries, missingDirs } = await scan(root, dirs);
    if (missingDirs.length) process.stderr.write(`Warning: missing directories skipped: ${missingDirs.join(", ")}\n`);
    if (!entries.length) {
      process.stderr.write("No files found under the dist directories; refusing to record an empty manifest.\n");
      process.exit(2);
    }
    const manifest = {
      version: MANIFEST_VERSION,
      recordedAt: new Date().toISOString(),
      root: toPosix(root),
      directories: dirs,
      fileCount: entries.length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      combinedSha256: combinedHash(entries),
      files: entries,
    };
    const out = path.resolve(options.files[0]);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`Recorded ${entries.length} files (${manifest.totalBytes} bytes) from ${dirs.join(", ")}\n  combined sha256: ${manifest.combinedSha256}\n  manifest: ${toPosix(out)}\n`);
    return 0;
  }

  if (options.mode === "verify") {
    const manifestPath = path.resolve(options.files[0]);
    const manifest = await readManifest(manifestPath);
    const scanDirs = options.dirs ?? (Array.isArray(manifest.directories) ? manifest.directories : dirs);
    const { entries, missingDirs } = await scan(root, scanDirs);
    if (missingDirs.length) process.stderr.write(`Warning: missing directories skipped: ${missingDirs.join(", ")}\n`);
    const result = diff(entriesOf(manifest, "manifest"), entriesOf(entries, "current"));
    const clean = printDiff(result, toPosix(manifestPath), "current dist");
    const combined = combinedHash(entries);
    process.stdout.write(`  combined sha256: manifest ${manifest.combinedSha256 ?? "(none)"} / current ${combined}\n`);
    const combinedMatches = typeof manifest.combinedSha256 !== "string" || manifest.combinedSha256 === combined;
    process.stdout.write(clean && combinedMatches ? "OK: installed build matches the manifest\n" : "DRIFT: installed build differs from the manifest\n");
    return clean && combinedMatches ? 0 : 1;
  }

  const [left, right] = options.files.map((file) => path.resolve(file));
  const result = diff(entriesOf(await readManifest(left), "a"), entriesOf(await readManifest(right), "b"));
  const clean = printDiff(result, toPosix(left), toPosix(right));
  process.stdout.write(clean ? "OK: manifests are identical\n" : "DIFF: manifests differ\n");
  return clean ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
