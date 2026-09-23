// ──────────────────────────────────────────────
// Validate a docs-i18n language pack against the English docs in this checkout.
//
// Usage: node scripts/docs-i18n/validate-pack.mjs <pack-dir>
//   <pack-dir> is one language folder of a docs-i18n checkout, e.g. ../docs-i18n/es
//
// Run from the Marinara Engine repo root (it reads docs/ for the English
// source of truth). Fails when the pack has orphan files that no longer exist
// in English, files missing a leading H1, rewritten relative link targets, or
// a stale/missing manifest.json. Missing translations are reported but do not
// fail the build — the app falls back to English per file.
// ──────────────────────────────────────────────
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const EXCLUDED_TOP_DIRS = new Set(["evidence", "pr-evidence", "screenshots", "examples", "i18n"]);
const LINK_RE = /\]\(([^()\s]+\.md(?:#[^)]*)?)\)/gi;

function walkMarkdown(dir, base, skipTopDirs) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full).split(sep).join("/");
    if (entry.isDirectory()) {
      if (!rel.includes("/") && skipTopDirs.has(entry.name)) continue;
      out.push(...walkMarkdown(full, base, skipTopDirs));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(rel);
    }
  }
  return out;
}

const packDir = process.argv[2] ? resolve(process.argv[2]) : null;
if (!packDir || !existsSync(packDir)) {
  console.error("Usage: node scripts/docs-i18n/validate-pack.mjs <pack-dir> (folder must exist)");
  process.exit(1);
}
const docsDir = resolve("docs");
if (!existsSync(docsDir)) {
  console.error("Run from the Marinara Engine repo root — docs/ not found.");
  process.exit(1);
}

const englishDocs = new Set(walkMarkdown(docsDir, docsDir, EXCLUDED_TOP_DIRS));
const packDocs = walkMarkdown(packDir, packDir, new Set()).filter((path) => path !== "manifest.json");
const problems = [];

const orphans = packDocs.filter((path) => !englishDocs.has(path));
for (const orphan of orphans) {
  problems.push(`ORPHAN: ${orphan} has no English counterpart (renamed or deleted upstream? move or remove it)`);
}

for (const path of packDocs) {
  const content = readFileSync(join(packDir, ...path.split("/")), "utf8");
  const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  if (!firstLine.startsWith("# ")) {
    problems.push(`NO-H1: ${path} must keep a leading "# " heading (title extraction depends on it)`);
  }
  if (englishDocs.has(path)) {
    const english = readFileSync(join(docsDir, ...path.split("/")), "utf8");
    const englishTargets = new Set([...english.matchAll(LINK_RE)].map((match) => match[1]));
    for (const match of content.matchAll(LINK_RE)) {
      if (!englishTargets.has(match[1])) {
        problems.push(`LINK: ${path} link target "${match[1]}" does not exist in the English source (translate text, never targets)`);
      }
    }
    // Downloaded packs are less-trusted than in-repo English: an added remote
    // image would leak the reader's IP to a third-party host when the doc opens.
    const IMG_RE = /!\[[^\]]*\]\(([^()\s]+)\)/g;
    const englishImages = new Set([...english.matchAll(IMG_RE)].map((match) => match[1]));
    for (const match of content.matchAll(IMG_RE)) {
      if (!englishImages.has(match[1])) {
        problems.push(`IMAGE: ${path} adds an image "${match[1]}" that the English source does not have`);
      }
    }
  }
}

const manifestPath = join(packDir, "manifest.json");
if (!existsSync(manifestPath)) {
  problems.push("MANIFEST: manifest.json missing — run scripts/docs-i18n/build-manifest.mjs");
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifestPaths = new Set((manifest.files ?? []).map((file) => file.path));
  for (const path of packDocs) {
    if (!manifestPaths.has(path)) problems.push(`MANIFEST: ${path} missing from manifest.json — rebuild it`);
  }
  for (const file of manifest.files ?? []) {
    const full = join(packDir, ...file.path.split("/"));
    if (!existsSync(full)) {
      problems.push(`MANIFEST: ${file.path} listed but absent on disk — rebuild the manifest`);
      continue;
    }
    const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
    if (sha256 !== file.sha256) problems.push(`MANIFEST: ${file.path} hash is stale — rebuild the manifest`);
  }
}

const missing = [...englishDocs].filter((path) => !packDocs.includes(path));
if (missing.length > 0) {
  console.log(`Note: ${missing.length} English docs have no translation yet (they fall back to English in-app):`);
  for (const path of missing.slice(0, 10)) console.log(`  - ${path}`);
  if (missing.length > 10) console.log(`  … and ${missing.length - 10} more`);
}

if (problems.length > 0) {
  console.error(`\nPack validation FAILED with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Pack validation passed: ${packDocs.length} translated docs, ${englishDocs.size} English docs.`);
