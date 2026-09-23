// Empty-catch ratchet: the number of catch blocks under packages/server/src that
// hold no statements (only whitespace and comments) must not grow. A failure that
// is allowed should go through logSuppressed / orFallback / bestEffort from
// lib/best-effort.ts instead (docs/development/logging.md, section 9).
// Baseline recorded 2026-09-23 after the B15 silent-fallback sweep. When the
// count drops, lower EMPTY_CATCH_BASELINE to the new number.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const EMPTY_CATCH_BASELINE = 224;

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const serverSource = join(repositoryRoot, "packages", "server", "src");

// `catch {`, `catch (err) {` or `catch (err: unknown) {`, then only whitespace,
// line comments and block comments up to the closing brace.
const EMPTY_CATCH =
  /\bcatch\s*(?:\(\s*[\w$]*\s*(?::\s*[\w$]+\s*)?\))?\s*\{(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*\}/g;

export function countEmptyCatches(source: string): number {
  return source.match(EMPTY_CATCH)?.length ?? 0;
}

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(path));
    else if (entry.isFile() && /\.(?:ts|tsx|mts|cts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

// The pattern itself.
assert.equal(countEmptyCatches("try { a(); } catch {}"), 1);
assert.equal(countEmptyCatches("try { a(); } catch (err) {\n  /* ignore */\n}"), 1);
assert.equal(countEmptyCatches("try { a(); } catch (err: unknown) {\n  // allowed\n}"), 1);
assert.equal(countEmptyCatches("try { a(); } catch (err) {\n  logSuppressed(err, { event: 'x' });\n}"), 0);
assert.equal(countEmptyCatches("promise.catch(() => {});"), 0);
assert.equal(countEmptyCatches("promise.catch(() => null);"), 0);

const perFile: Array<{ file: string; count: number }> = [];
let total = 0;
for (const file of listSourceFiles(serverSource)) {
  const count = countEmptyCatches(readFileSync(file, "utf8"));
  if (count > 0) perFile.push({ file: relative(repositoryRoot, file).split("\\").join("/"), count });
  total += count;
}

if (total > EMPTY_CATCH_BASELINE) {
  perFile.sort((a, b) => b.count - a.count);
  const top = perFile
    .slice(0, 15)
    .map(({ file, count }) => `  ${count}  ${file}`)
    .join("\n");
  assert.fail(
    `Empty catch blocks under packages/server/src grew to ${total} (baseline ${EMPTY_CATCH_BASELINE}). ` +
      `Log allowed failures with logSuppressed / orFallback / bestEffort from lib/best-effort.ts.\nLargest files:\n${top}`,
  );
}
if (total < EMPTY_CATCH_BASELINE) {
  console.log(
    `empty-catch-ratchet: ${total} empty catches, below baseline ${EMPTY_CATCH_BASELINE}; lower the baseline.`,
  );
}
console.log(`empty-catch-ratchet: ok (${total} of ${EMPTY_CATCH_BASELINE})`);
