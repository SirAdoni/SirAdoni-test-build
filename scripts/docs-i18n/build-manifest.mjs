// ──────────────────────────────────────────────
// Build a language pack's manifest.json for the docs-i18n branch.
//
// Usage: node scripts/docs-i18n/build-manifest.mjs <pack-dir> [--source-commit <sha>]
//   <pack-dir> is one language folder of a docs-i18n checkout, e.g. ../docs-i18n/es
//
// Writes <pack-dir>/manifest.json with a sha256 + byte size for every .md file,
// which the server verifies during Download & Replace. Run this after every
// content change on the docs-i18n branch, before committing.
// ──────────────────────────────────────────────
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

function walkMarkdown(dir, base) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full, base));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(relative(base, full).split(sep).join("/"));
    }
  }
  return out;
}

const args = process.argv.slice(2);
const packDir = args[0] ? resolve(args[0]) : null;
if (!packDir) {
  console.error("Usage: node scripts/docs-i18n/build-manifest.mjs <pack-dir> [--source-commit <sha>]");
  process.exit(1);
}
const sourceCommitIndex = args.indexOf("--source-commit");
const sourceCommit = sourceCommitIndex !== -1 ? args[sourceCommitIndex + 1] : undefined;

const language = basename(packDir);
if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(language)) {
  console.error(`Pack folder name "${language}" is not a valid language code (expected e.g. "es", "pt-br").`);
  process.exit(1);
}

const crlfFiles = [];
const files = walkMarkdown(packDir, packDir)
  .filter((path) => path !== "manifest.json")
  .sort()
  .map((path) => {
    const content = readFileSync(join(packDir, ...path.split("/")));
    // The server verifies downloads against the LF blobs raw.githubusercontent
    // serves. A CRLF-authored file would hash "correctly" here but NEVER match
    // after commit (git normalizes to LF), bricking every install of this pack.
    if (content.includes("\r\n")) crlfFiles.push(path);
    return {
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: statSync(join(packDir, ...path.split("/"))).size,
    };
  });

if (crlfFiles.length > 0) {
  console.error(`Refusing to build: ${crlfFiles.length} file(s) contain CRLF line endings and would fail`);
  console.error("server-side hash verification (git stores LF; the raw CDN serves LF). Convert to LF first:");
  for (const path of crlfFiles.slice(0, 10)) console.error(`  - ${path}`);
  if (crlfFiles.length > 10) console.error(`  … and ${crlfFiles.length - 10} more`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No .md files found under ${packDir} — refusing to write an empty manifest.`);
  process.exit(1);
}

const manifest = {
  language,
  ...(sourceCommit ? { sourceCommit } : {}),
  files,
};

writeFileSync(join(packDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Wrote ${language}/manifest.json: ${files.length} files, ${files.reduce((sum, f) => sum + f.bytes, 0)} bytes total`,
);
